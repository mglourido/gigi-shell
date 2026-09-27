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
HOME_USUARIO="$(getent passwd "$SUDO_USER" | cut -d: -f6)"

TMPDIR_PROP="$(mktemp -d)"
chown "$SUDO_USER":"$GRUPO_USUARIO" "$TMPDIR_PROP"

ARCHIVO="$TMPDIR_PROP/protegido.txt"
sudo -u "$SUDO_USER" bash -c "printf 'contenido original\n' > '$ARCHIVO'"

PID_DEP=""
LOG_ACTIVO=""
DIR_BTRFS=""

# Parada ordenada de $PID_DEP: SIGTERM y esperar (acotado, ~3s en pasos de
# 0.1s) a que aparezca PARADO en el log activo o a que el proceso termine
# solo; si no lo consigue, kill -9 + wait. SIEMPRE deja PID_DEP="" al salir —
# es lo que impide que un caso posterior confunda un depurador ya muerto con
# uno vivo, o arranque uno nuevo mientras el anterior sigue en pie (dos
# depuradores a la vez competirían por el mismo anclaje de bpffs). Cada caso
# que arranca un depurador con `iniciar_depurador` debe llamar a esta función
# antes de que el SIGUIENTE caso arranque el suyo — la única excepción a
# propósito es R2 "caída", que simula un crash y por eso mata en seco sin
# pasar por aquí (ver su comentario).
parar_depurador() {
    if [ -z "$PID_DEP" ]; then
        return 0
    fi
    if kill -0 "$PID_DEP" 2>/dev/null; then
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
        fi
        wait "$PID_DEP" 2>/dev/null || true
    fi
    PID_DEP=""
}

# Limpieza final. IMPORTANTE: `rm -rf "$TMPDIR_PROP"` no vale por sí solo si
# queda un depurador vivo (o recién matado con -9): el fichero protegido sigue
# denegando incluso a root, que esta BPF no exime — ni siquiera vale parar en
# seco y confiar en que "ya no hay quien lo aplique", porque un `kill -9` deja
# los programas LSM enganchados y ANCLADOS en bpffs, todavía enforzando. Orden
# obligatorio: `parar_depurador` (SIGTERM/espera/kill -9 de reserva) y SOLO
# ENTONCES desactivar/desanclar a mano (`--tras-parada` + `rm -r` del propio
# bpffs, el ÚNICO sitio fuera del `mktemp -d`/HOME real que este script toca)
# antes de poder borrar los directorios temporales. Con la disciplina de que
# cada caso ya para su propio depurador antes de que el siguiente arranque el
# suyo, esto es normalmente un no-op — pero si algo aborta el script a medias
# (Ctrl-C, un `check`/`grep` inesperado) sigue siendo la única red de
# seguridad, así que se ejecuta siempre.
cleanup() {
    parar_depurador
    "$BIN" --tras-parada >/dev/null 2>&1 || true
    rm -rf /sys/fs/bpf/gigishell-guardian 2>/dev/null || true
    # El directorio del caso btrfs vive bajo el HOME real del usuario, fuera
    # de $TMPDIR_PROP (que es el único sitio donde `mktemp -d` a secas cae por
    # defecto) — se borra aparte, y solo después de la parada limpia de arriba
    # (con el BPF desanclado, el fichero ya no tiene por qué seguir denegando).
    if [ -n "$DIR_BTRFS" ]; then
        rm -rf "$DIR_BTRFS" 2>/dev/null || true
    fi
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

    # Parada ORDENADA: ningún caso posterior debe encontrarse este depurador
    # todavía vivo (dos depuradores a la vez competirían por el mismo anclaje
    # de bpffs) — R2 "caída", justo debajo, arranca y mata el SUYO propio.
    parar_depurador
fi

echo "== R2: caída del proceso =="
# Caso AUTÓNOMO: arranca su propio depurador (nunca reutiliza el de un caso
# anterior — Fase A ya paró el suyo de forma limpia arriba) y lo mata en seco
# con kill -9 A PROPÓSITO, sin pasar por `parar_depurador`: esta es la ÚNICA
# excepción a esa disciplina, porque lo que hay que comprobar es justo lo
# contrario de una parada limpia — el BPF sigue anclado y "activo" en bpffs
# tras la caída. `--tras-parada` es lo único que systemd correría antes de
# reiniciar el daemon, y solo apaga el interruptor (`Control.activo = 0`);
# con el programa inactivo, `exigir()`/`g_file_open` fallan CERRADOS
# (deniegan), no abiertos.
LOG_CAIDA="$TMPDIR_PROP/depurador_caida.log"
iniciar_depurador "$LOG_CAIDA" "$ARCHIVO" --auto denegar
if ! esperar_patron '^LISTO' "$LOG_CAIDA"; then
    fallo "R2 caída: no se pudo arrancar el depurador que se iba a matar"
    matar_depurador_atascado
else
    kill -9 "$PID_DEP" 2>/dev/null
    wait "$PID_DEP" 2>/dev/null
    PID_DEP=""

    "$BIN" --tras-parada
    como_usuario cat "$ARCHIVO" >/dev/null 2>&1
    caida_fallo=$?
    check "R2 caída: --tras-parada deja fallo cerrado (cat falla)" \
        $([ "$caida_fallo" -ne 0 ] && echo 0 || echo 1)
fi

echo "== R2: reenganche =="
LOG2="$TMPDIR_PROP/depurador2.log"
iniciar_depurador "$LOG2" "$ARCHIVO" --auto denegar
esperar_patron '^LISTO' "$LOG2"
check "R2 reenganche (sale LISTO reutilizando el anclaje)" $?

echo "== R2: parada limpia =="
parar_depurador
grep -q '^PARADO' "$LOG2"
parado_ok=$?
como_usuario cat "$ARCHIVO" >/dev/null 2>&1
cat_ok=$?
[ -e /sys/fs/bpf/gigishell-guardian ]
bpffs_queda=$?
check "R2 parada limpia (PARADO en el log, cat funciona sin guardián, /sys/fs/bpf/gigishell-guardian no existe)" \
    $([ "$parado_ok" -eq 0 ] && [ "$cat_ok" -eq 0 ] && [ "$bpffs_queda" -ne 0 ] && echo 0 || echo 1)

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

# Parada ORDENADA antes de que el caso btrfs, justo debajo, arranque el suyo —
# sin esto, este depurador (con el permiso de python3 concedido) sobrevivía
# a todo el script: `PID_DEP` quedaba pisado por el del caso btrfs y nadie
# volvía a pararlo, dejando el `rm -rf` final del directorio temporal
# denegado por su propia BPF (EPERM) y R5 sin depurador que medir.
parar_depurador

echo "== btrfs: fichero protegido bajo el \$HOME real del usuario (no tmpfs) =="
# El caso que se le escapó a todo lo de arriba: $TMPDIR_PROP (de `mktemp -d`
# a secas) suele caer en tmpfs, donde por casualidad el `dev` de `stat()`
# coincide con el del superbloque. Bajo el HOME real del usuario (btrfs en
# esta máquina, con subvolúmenes) NO coincide — es justo el bug que hizo
# fallar R3 con `os.replace` (EPERM inesperado, `EVENTO tipo=1 op=2`): la
# clave construida con `st_dev` nunca casaba con la que ve el BPF
# (`inode->i_sb->s_dev`). Este caso repite la comprobación más básica —
# proteger y denegar una lectura— pero sobre un fichero de verdad bajo
# `$HOME`, no bajo un directorio de pruebas que puede estar en un filesystem
# distinto del que usan los ficheros reales que este daemon protegerá.
if [ -z "$HOME_USUARIO" ] || [ ! -d "$HOME_USUARIO" ]; then
    fallo "btrfs: no se pudo resolver el HOME de $SUDO_USER (getent passwd)"
else
    if [ ! -d "$HOME_USUARIO/.cache" ]; then
        sudo -u "$SUDO_USER" mkdir -p "$HOME_USUARIO/.cache"
    fi
    DIR_BTRFS="$(sudo -u "$SUDO_USER" mktemp -d "$HOME_USUARIO/.cache/guardian-riesgos.XXXXXX")"
    ARCHIVO_BTRFS="$DIR_BTRFS/protegido.txt"
    sudo -u "$SUDO_USER" bash -c "printf 'contenido bajo HOME real\n' > '$ARCHIVO_BTRFS'"

    LOG4="$TMPDIR_PROP/depurador4.log"
    iniciar_depurador "$LOG4" "$ARCHIVO_BTRFS" --auto denegar
    if ! esperar_patron '^LISTO' "$LOG4"; then
        fallo "btrfs: arranque del depurador sobre un fichero de \$HOME"
        matar_depurador_atascado
    else
        ok "btrfs: arranque del depurador sobre un fichero de \$HOME"

        como_usuario cat "$ARCHIVO_BTRFS" >/dev/null 2>&1
        btrfs_cat_fallo=$?
        grep -q 'pendiente=Some((1, 0))' "$LOG4"
        btrfs_pend_ok=$?
        check "btrfs: fichero bajo \$HOME real se protege igual que en tmpfs (cat falla, pendiente=Some((1, 0)))" \
            $([ "$btrfs_cat_fallo" -ne 0 ] && [ "$btrfs_pend_ok" -eq 0 ] && echo 0 || echo 1)
    fi
fi

# Parada ORDENADA (no-op si ya se paró en el `matar_depurador_atascado` de
# arriba): antes de que R5 arranque el suyo propio, justo debajo.
parar_depurador

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

# R5 arranca su PROPIO depurador para la mitad "con guardián" en vez de fiarse
# de que algún caso anterior haya dejado uno vivo — con la disciplina de
# `parar_depurador` al final de cada caso, a estas alturas nunca lo hay (y
# antes de esa disciplina, este "si por casualidad queda uno vivo" era
# justo el síntoma del bug: nunca medía nada porque el de R3 se había perdido
# de vista, no porque de verdad no hubiera ningún guardián que medir).
LOG5="$TMPDIR_PROP/depurador5.log"
iniciar_depurador "$LOG5" "$ARCHIVO" --auto denegar
if esperar_patron '^LISTO' "$LOG5"; then
    coste_con="$(medir_coste)"
    info "find /usr/share -name '*.desktop' -exec cat {} + CON guardián activo: ${coste_con}s"
    parar_depurador
else
    info "no se pudo arrancar un depurador propio para medir 'con guardián'; se omite esa mitad"
    matar_depurador_atascado
fi

if [ ! -e /sys/fs/bpf/gigishell-guardian ]; then
    coste_sin="$(medir_coste)"
    info "find /usr/share -name '*.desktop' -exec cat {} + SIN guardián: ${coste_sin}s"
else
    info "quedó un anclaje BPF sin limpiar; se omite la medición 'sin guardián'"
fi

echo "---- fallos: $fallos"
exit "$fallos"
