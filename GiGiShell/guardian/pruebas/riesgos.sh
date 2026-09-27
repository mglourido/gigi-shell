#!/usr/bin/env bash
# gigishell-guardian: verificación de riesgos del modo --depurar (Tarea 4).
#
# Se ejecuta con sudo, como el dueño de la máquina, DESDE guardian/:
#
#   sudo bash pruebas/riesgos.sh
#
# Necesita root porque adjunta programas LSM/BPF, pero todo lo que actúa
# "como si fuera el usuario que abre/borra/mueve el fichero" lo hace con
# `sudo -u "$SUDO_USER"` sobre ficheros de un `mktemp -d` propiedad de ese
# usuario — nunca como root, que es lo que en este BPF cuenta como "cualquier
# proceso normal", no un caso especial.
#
# Comprueba, en el orden de la tabla de la Tarea 4:
#   - Lectura denegada + R1 (orden LSM -> fanotify, en lectura y escritura)
#   - Borrar/mover/chmod/truncate/ln deniegan directamente en el LSM
#   - ls -l no se ve afectado (no abre el contenido)
#   - R2 (caída del proceso: falla cerrado; reenganche; parada limpia)
#   - R3 (guardado atómico: la protección sigue al inodo nuevo)
#   - R5 (coste: solo informativo, no cuenta para el resultado)
#
# Imprime OK/FALLO por caso y termina con "---- fallos: N" (código de salida N).

set -u

if [ "$(id -u)" -ne 0 ]; then
    echo "gigishell-guardian: riesgos.sh necesita sudo (root)." >&2
    exit 1
fi
if [ -z "${SUDO_USER:-}" ]; then
    echo "gigishell-guardian: falta \$SUDO_USER — ejecutar con 'sudo bash pruebas/riesgos.sh', nunca como root a secas." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARDIAN_DIR="$(dirname "$SCRIPT_DIR")"
BIN="$GUARDIAN_DIR/target/release/gigishell-guardian"

if [ ! -x "$BIN" ]; then
    echo "gigishell-guardian: no existe $BIN — compilar antes con 'cargo build --release'." >&2
    exit 1
fi

PYTHON3="$(command -v python3 || true)"
if [ -z "$PYTHON3" ]; then
    echo "gigishell-guardian: no se encuentra python3, necesario para el caso R3." >&2
    exit 1
fi
PYTHON3="$(readlink -f "$PYTHON3")"

GRUPO_USUARIO="$(id -gn "$SUDO_USER")"

TMPDIR_PROP="$(mktemp -d)"
chown "$SUDO_USER":"$GRUPO_USUARIO" "$TMPDIR_PROP"

ARCHIVO="$TMPDIR_PROP/protegido.txt"
sudo -u "$SUDO_USER" bash -c "printf 'contenido original\n' > '$ARCHIVO'"

PID_DEP=""
LOG_ACTIVO=""

# Limpieza final. IMPORTANTE: `rm -rf "$TMPDIR_PROP"` no vale por sí solo si
# queda un depurador vivo (o recién matado con -9): el fichero protegido sigue
# denegando incluso a root, que esta BPF no exime — ni siquiera vale parar en
# seco y confiar en que "ya no hay quien lo aplique", porque un `kill -9` deja
# los programas LSM enganchados y ANCLADOS en bpffs, todavía enforzando. Orden
# obligatorio: SIGTERM y esperar (acotado) a que él mismo haga su parada
# limpia; si no lo consigue, matarlo con -9 y entonces desactivar/desanclar a
# mano (`--tras-parada` + `rm -r` del propio bpffs, el ÚNICO sitio fuera del
# `mktemp -d` que este script toca) ANTES de poder borrar el directorio
# temporal. Los tres pasos son idempotentes (no pasa nada si ya estaban
# hechos), así que se ejecutan siempre, haya hecho falta el -9 o no.
cleanup() {
    if [ -n "$PID_DEP" ] && kill -0 "$PID_DEP" 2>/dev/null; then
        kill -TERM "$PID_DEP" 2>/dev/null || true
        local intentos=0
        while kill -0 "$PID_DEP" 2>/dev/null && [ "$intentos" -lt 30 ]; do
            if [ -n "$LOG_ACTIVO" ] && grep -q '^PARADO' "$LOG_ACTIVO" 2>/dev/null; then
                break
            fi
            sleep 0.1
            intentos=$((intentos + 1))
        done
        if kill -0 "$PID_DEP" 2>/dev/null; then
            kill -9 "$PID_DEP" 2>/dev/null || true
            wait "$PID_DEP" 2>/dev/null || true
        fi
    fi
    "$BIN" --tras-parada >/dev/null 2>&1 || true
    rm -rf /sys/fs/bpf/gigishell-guardian 2>/dev/null || true
    rm -rf "$TMPDIR_PROP"
}
trap cleanup EXIT

fallos=0

ok() { echo "OK    - $1"; }
fallo() { echo "FALLO - $1"; fallos=$((fallos + 1)); }
check() {
    # check <descripcion> <0-si-paso-1-si-fallo>
    if [ "$2" -eq 0 ]; then ok "$1"; else fallo "$1"; fi
}
info() { echo "INFO  - $1"; }

# Bucle acotado (por defecto 5 s, en pasos de 0.1 s) esperando a que aparezca
# `patron` en `log`. Si nunca aparece, vuelca el log para poder diagnosticar
# por qué (p.ej. el propio --depurar falló al cargar el BPF).
esperar_patron() {
    local patron="$1" log="$2" intentos="${3:-50}"
    local i
    for ((i = 0; i < intentos; i++)); do
        grep -q "$patron" "$log" 2>/dev/null && return 0
        sleep 0.1
    done
    echo "---- (nunca apareció «$patron» en $log; contenido) ----" >&2
    cat "$log" >&2
    echo "---- fin del log ----" >&2
    return 1
}

iniciar_depurador() {
    # iniciar_depurador <log> <args-de---depurar...>
    local log="$1"
    shift
    "$BIN" --depurar "$@" >"$log" 2>&1 </dev/null &
    PID_DEP=$!
    LOG_ACTIVO="$log"
}

matar_depurador_atascado() {
    # Si esperar_patron '^LISTO' se agotó, el proceso puede seguir vivo (y
    # ocupando el anclaje de bpffs) aunque nunca haya llegado a arrancar del
    # todo: hay que matarlo ANTES de seguir, no dejarlo para el trap de salida
    # — un segundo `iniciar_depurador` mientras el primero sigue vivo
    # competiría por el mismo `RAIZ` de bpffs.
    if [ -n "$PID_DEP" ] && kill -0 "$PID_DEP" 2>/dev/null; then
        kill -9 "$PID_DEP" 2>/dev/null || true
        wait "$PID_DEP" 2>/dev/null || true
    fi
    PID_DEP=""
}

esperar_fin() {
    # Bucle acotado esperando a que el proceso depurador termine solo.
    local intentos="${1:-50}" i
    for ((i = 0; i < intentos; i++)); do
        kill -0 "$PID_DEP" 2>/dev/null || return 0
        sleep 0.1
    done
    return 1
}

como_usuario() {
    timeout 5 sudo -u "$SUDO_USER" "$@"
}

echo "== Fase A: --auto denegar, sin concesiones =="
LOG1="$TMPDIR_PROP/depurador1.log"
iniciar_depurador "$LOG1" "$ARCHIVO" --auto denegar
if ! esperar_patron '^LISTO' "$LOG1"; then
    fallo "arranque del depurador (Fase A)"
    matar_depurador_atascado
else
    ok "arranque del depurador (Fase A)"

    # Lectura denegada.
    como_usuario cat "$ARCHIVO" >/dev/null 2>&1
    lectura_fallo=$?
    check "lectura denegada (cat falla)" $([ "$lectura_fallo" -ne 0 ] && echo 0 || echo 1)

    # R1: el orden LSM -> fanotify se ve en que la petición de lectura quedó
    # pendiente ANTES de responder (pedido=1 LEER, permitido=0 todavía).
    grep -q 'pendiente=Some((1, 0))' "$LOG1"
    check "R1 orden LSM->fanotify (lectura, pendiente=Some((1, 0)))" $?

    # R1 en escritura: mismo orden, pedido=2 MODIFICAR.
    como_usuario bash -c "echo x >> '$ARCHIVO'" >/dev/null 2>&1
    esc_fallo=$?
    grep -q 'pendiente=Some((2, 0))' "$LOG1"
    pend_ok=$?
    check "R1 orden LSM->fanotify (escritura, pendiente=Some((2, 0)))" \
        $([ "$esc_fallo" -ne 0 ] && [ "$pend_ok" -eq 0 ] && echo 0 || echo 1)

    # Borrar / mover / chmod / truncate / ln: los deniega el LSM directamente,
    # sin pasar por fanotify (no hay decisión interactiva posible para estas
    # operaciones). Ninguna debe tener éxito, y debe quedar constancia de al
    # menos una denegación (rm) con EVENTO tipo=1 (EV_DENEGADO) op=4 (BORRAR).
    destructivo_ok=0
    como_usuario rm -f "$ARCHIVO" >/dev/null 2>&1 && destructivo_ok=1
    como_usuario mv "$ARCHIVO" "$TMPDIR_PROP/movido.txt" >/dev/null 2>&1 && destructivo_ok=1
    como_usuario chmod 600 "$ARCHIVO" >/dev/null 2>&1 && destructivo_ok=1
    como_usuario truncate -s0 "$ARCHIVO" >/dev/null 2>&1 && destructivo_ok=1
    como_usuario ln "$ARCHIVO" "$TMPDIR_PROP/enlazado.txt" >/dev/null 2>&1 && destructivo_ok=1
    # El ring buffer se consume de forma asíncrona en el bucle del depurador:
    # que `rm` ya haya devuelto EPERM no garantiza que el evento correspondiente
    # ya esté escrito en el log en ESTE instante — un `grep` inmediato aquí es
    # una carrera. Se usa el mismo bucle acotado que para `LISTO`/`PARADO`.
    esperar_patron 'EVENTO tipo=1 op=4' "$LOG1" 20
    evento_ok=$?
    check "borrar/mover/chmod/truncate/ln deniegan (EVENTO tipo=1 op=4)" \
        $([ "$destructivo_ok" -eq 0 ] && [ "$evento_ok" -eq 0 ] && echo 0 || echo 1)

    # ls -l: hace stat(), no abre el contenido — no debería verse afectado.
    como_usuario ls -l "$ARCHIVO" >/dev/null 2>&1
    check "ls -l funciona" $?

    kill -9 "$PID_DEP" 2>/dev/null
    wait "$PID_DEP" 2>/dev/null
fi

echo "== R2: caída del proceso =="
# El BPF sigue anclado y "activo" tras el kill -9 (no fue una parada limpia):
# --tras-parada es lo único que systemd correría antes de reiniciar el daemon,
# y solo apaga el interruptor (`Control.activo = 0`). Con el programa inactivo,
# `exigir()`/`g_file_open` fallan CERRADOS (deniegan), no abiertos.
"$BIN" --tras-parada
como_usuario cat "$ARCHIVO" >/dev/null 2>&1
caida_fallo=$?
check "R2 caída: --tras-parada deja fallo cerrado (cat falla)" \
    $([ "$caida_fallo" -ne 0 ] && echo 0 || echo 1)

echo "== R2: reenganche =="
LOG2="$TMPDIR_PROP/depurador2.log"
iniciar_depurador "$LOG2" "$ARCHIVO" --auto denegar
esperar_patron '^LISTO' "$LOG2"
check "R2 reenganche (sale LISTO reutilizando el anclaje)" $?

echo "== R2: parada limpia =="
if kill -0 "$PID_DEP" 2>/dev/null; then
    kill -TERM "$PID_DEP"
    esperar_fin
    esperar_patron '^PARADO' "$LOG2" 20
fi
como_usuario cat "$ARCHIVO" >/dev/null 2>&1
cat_ok=$?
[ -e /sys/fs/bpf/gigishell-guardian ]
bpffs_queda=$?
check "R2 parada limpia (cat funciona sin guardián y /sys/fs/bpf/gigishell-guardian no existe)" \
    $([ "$cat_ok" -eq 0 ] && [ "$bpffs_queda" -ne 0 ] && echo 0 || echo 1)
PID_DEP=""

echo "== R3: guardado atómico =="
LOG3="$TMPDIR_PROP/depurador3.log"
iniciar_depurador "$LOG3" "$ARCHIVO" --auto denegar --conceder "$PYTHON3:3"
if ! esperar_patron '^LISTO' "$LOG3"; then
    fallo "arranque del depurador (R3)"
    matar_depurador_atascado
else
    ok "arranque del depurador (R3)"

    INODO_VIEJO="$(stat -c %i "$ARCHIVO")"

    # python3 (con permiso LEER|MODIFICAR = 3 concedido explícitamente) escribe
    # en un fichero temporal aparte y lo reemplaza atómicamente con os.replace
    # (rename(2)) — el patrón de guardado "seguro" de cualquier editor.
    como_usuario "$PYTHON3" -c "
import os
tmp = '$ARCHIVO.tmp'
with open(tmp, 'w') as f:
    f.write('reemplazado atomicamente\n')
os.replace(tmp, '$ARCHIVO')
"
    replace_ok=$?

    esperar_patron 'HEREDADO_MARCADO' "$LOG3" 30
    heredado_ok=$?

    INODO_NUEVO="$(stat -c %i "$ARCHIVO" 2>/dev/null)"

    grep -q 'EVENTO tipo=3' "$LOG3"
    evento_ok=$?

    check "R3 guardado atómico ejecuta y hereda (rename ok, EVENTO tipo=3, HEREDADO_MARCADO, inodo cambia)" \
        $([ "$replace_ok" -eq 0 ] && [ "$heredado_ok" -eq 0 ] && [ "$evento_ok" -eq 0 ] && [ "$INODO_VIEJO" != "$INODO_NUEVO" ] && echo 0 || echo 1)

    # Un cat corriente (sin la concesión de python3) sobre el inodo heredado
    # debe seguir denegado: la protección viajó con el fichero, no se perdió
    # en el reemplazo, y "denegar" sigue siendo la respuesta por defecto.
    como_usuario cat "$ARCHIVO" >/dev/null 2>&1
    r3_cat_fallo=$?
    check "R3: cat posterior sigue denegado sobre el inodo heredado" \
        $([ "$r3_cat_fallo" -ne 0 ] && echo 0 || echo 1)
fi

echo "== R5: coste (informativo) =="
medir_coste() {
    local inicio fin
    inicio=$(date +%s.%N)
    find /usr/share -name '*.desktop' -exec cat {} + >/dev/null 2>&1
    fin=$(date +%s.%N)
    awk -v a="$inicio" -v b="$fin" 'BEGIN { printf "%.3f", b - a }'
}

# Una pasada de calentamiento, descartada: sin ella, la caché de páginas
# estaría fría solo para la PRIMERA de las dos medidas (típicamente "con
# guardián", que se mide primero) y el resultado compararía E/S de disco
# contra E/S de caché en vez de guardián contra guardián, sesgando la
# comparación a favor de la segunda medida sin que tenga nada que ver con el
# coste del propio BPF/fanotify.
info "calentando la caché de páginas (una pasada descartada)..."
find /usr/share -name '*.desktop' -exec cat {} + >/dev/null 2>&1

if [ -n "$PID_DEP" ] && kill -0 "$PID_DEP" 2>/dev/null; then
    coste_con="$(medir_coste)"
    info "find /usr/share -name '*.desktop' -exec cat {} + CON guardián activo: ${coste_con}s"
    kill -TERM "$PID_DEP" 2>/dev/null
    esperar_fin
    PID_DEP=""
else
    info "no había un depurador vivo para medir 'con guardián'; se omite esa mitad"
fi

if [ ! -e /sys/fs/bpf/gigishell-guardian ]; then
    coste_sin="$(medir_coste)"
    info "find /usr/share -name '*.desktop' -exec cat {} + SIN guardián: ${coste_sin}s"
else
    info "quedó un anclaje BPF sin limpiar; se omite la medición 'sin guardián'"
fi

echo "---- fallos: $fallos"
exit "$fallos"
