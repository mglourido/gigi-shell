#!/usr/bin/env bash
# gigishell-guardian: verificación con root de la Fase 2 (daemon y servicio).
#
#   bash ~/GiGiShell/guardian/instalar.sh          # antes, como tu usuario
#   sudo bash ~/GiGiShell/guardian/pruebas/servicio.sh
#
# A. El binario de target/release a mano: arranca, el socket es tuyo y 600,
#    rechaza a un cliente que no es AGS, y SIGTERM lo para limpio (sin BPF
#    anclado ni socket).
# B. El servicio instalado: viene desactivado y parado; arranca; tras un
#    `kill -9` systemd lo levanta solo; `systemctl stop` lo desengancha. Lo deja
#    PARADO, como estaba.
#
# Imprime OK/FALLO por caso y termina con "---- fallos: N" (código de salida N).
set -u

if [ "$(id -u)" -ne 0 ] || [ -z "${SUDO_USER:-}" ]; then
    echo "servicio.sh: ejecútalo con sudo desde tu usuario." >&2
    exit 1
fi

GUARDIAN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$GUARDIAN_DIR/target/release/gigishell-guardian"
UID_USUARIO="$(id -u "$SUDO_USER")"
SOCK=/run/gigishell-guardian.sock
RAIZ=/sys/fs/bpf/gigishell-guardian
SERVICIO=gigishell-guardian.service
LOG="$(mktemp)"
PID=""

fallos=0
ok() { echo "OK    - $1"; }
fallo() { echo "FALLO - $1"; fallos=$((fallos + 1)); }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else fallo "$1"; fi; }

esperar() {
    # esperar <comando...>: hasta 5 s a que el comando tenga éxito.
    local i
    for ((i = 0; i < 50; i++)); do
        "$@" && return 0
        sleep 0.1
    done
    return 1
}

cleanup() {
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill -TERM "$PID" 2>/dev/null
        esperar bash -c "! kill -0 $PID 2>/dev/null" || kill -9 "$PID" 2>/dev/null
    fi
    if [ -e "$RAIZ" ] && ! systemctl is-active --quiet "$SERVICIO"; then
        "$BIN" --tras-parada >/dev/null 2>&1 || true
        rm -rf "$RAIZ"
    fi
    rm -f "$LOG"
}
trap cleanup EXIT

if systemctl is-active --quiet "$SERVICIO"; then
    echo "servicio.sh: el servicio está activo; páralo antes (sudo systemctl stop $SERVICIO)." >&2
    exit 1
fi

echo "== A: el binario a mano =="
if [ ! -x "$BIN" ]; then
    fallo "no existe $BIN (cargo build --release)"
else
    GUARDIAN_UID="$UID_USUARIO" "$BIN" >"$LOG" 2>&1 </dev/null &
    PID=$!
    if esperar grep -q 'activo (' "$LOG"; then
        ok "arranca (${PID})"
        [ "$(stat -c '%u %a' "$SOCK" 2>/dev/null)" = "$UID_USUARIO 600" ]
        check "el socket es del usuario y modo 600" $?

        sudo -u "$SUDO_USER" python3 -c "
import socket; s = socket.socket(socket.AF_UNIX); s.connect('$SOCK'); s.settimeout(2)
s.sendall(b'{\"op\":\"lista\"}\n'); print(repr(s.recv(100)))" >/dev/null 2>&1
        esperar grep -q 'conexión rechazada' "$LOG"
        check "rechaza a un cliente que no es AGS (python3)" $?

        kill -TERM "$PID"
        esperar grep -q '^gigishell-guardian: parado' "$LOG"
        parado=$?
        wait "$PID" 2>/dev/null
        PID=""
        [ "$parado" -eq 0 ] && [ ! -e "$RAIZ" ] && [ ! -e "$SOCK" ]
        check "SIGTERM lo para limpio (sin $RAIZ ni socket)" $?
    else
        fallo "no llega a arrancar"
        cat "$LOG" >&2
    fi
fi

echo "== B: el servicio instalado =="
if [ ! -f /etc/systemd/system/$SERVICIO ]; then
    fallo "no está instalado (bash ~/GiGiShell/guardian/instalar.sh como tu usuario)"
else
    [ "$(systemctl is-enabled "$SERVICIO" 2>/dev/null)" = disabled ]
    check "viene desactivado" $?
    ! systemctl is-active --quiet "$SERVICIO"
    check "viene parado" $?

    systemctl start "$SERVICIO"
    esperar systemctl is-active --quiet "$SERVICIO" && esperar test -S "$SOCK"
    check "arranca con systemctl start" $?

    viejo="$(systemctl show -p MainPID --value "$SERVICIO")"
    kill -9 "$viejo"
    otro_pid() {
        local n
        n="$(systemctl show -p MainPID --value "$SERVICIO")"
        [ "$n" != 0 ] && [ "$n" != "$viejo" ] && systemctl is-active --quiet "$SERVICIO"
    }
    esperar otro_pid
    check "tras kill -9 systemd lo levanta solo" $?

    systemctl stop "$SERVICIO"
    ! systemctl is-active --quiet "$SERVICIO" && [ ! -e "$RAIZ" ] && [ ! -e "$SOCK" ]
    check "systemctl stop lo desengancha (sin $RAIZ ni socket)" $?
fi

echo "---- fallos: $fallos"
exit "$fallos"
