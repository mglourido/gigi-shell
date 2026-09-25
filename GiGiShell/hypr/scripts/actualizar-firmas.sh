#!/usr/bin/env bash
# actualizar-firmas.sh — actualiza la base de firmas de ClamAV. Es el lado de USUARIO del helper
# root-owned /usr/local/bin/gigishell-clamav-update (ver system/clamav/ y CLAUDE.md, "Firmas de ClamAV").
#
# **NO HAY NINGÚN TEMPORIZADOR DE ACTUALIZACIÓN DE CLAMAV EN TODO EL SISTEMA.** Ni aquí, ni en un
# servicio, ni en los escáneres. Este script se ejecuta exactamente en dos situaciones:
#
#   actualizar-firmas.sh          Lo ha pedido el usuario: el botón del popup "ClamAV no puede
#                                 analizar", o una llamada a mano. Notifica lo que pasa — si nadie
#                                 ve el resultado, el botón no sirve de nada.
#   actualizar-firmas.sh --auto   UNA vez por arranque de Hyprland (`gigishell/autostart.lua`, t=40).
#                                 NO notifica NUNCA —ni al empezar, ni al acabar, ni al fallar— y
#                                 solo descarga si el interruptor está encendido y la base falta o
#                                 tiene más de un día. Cuando no toca sale en ~4 ms sin forkear
#                                 nada más que un `jq` y un `stat`.
#
# POR QUÉ BASTA CON EL ARRANQUE: una sesión de escritorio empieza casi a diario, así que las firmas
# entran al día y se quedan al día toda la sesión. Un reintento a mitad de sesión —por barrido, por
# evento o por reloj— sería un temporizador con otro nombre, y descargar ~200 MB por detrás
# mientras el usuario trabaja es exactamente el trabajo de fondo que se quiere evitar. Si aun así
# ClamAV se queda sin poder analizar, los escáneres ofrecen el botón (`firmas_aviso_con_boton`).
#
# POR QUÉ EXISTE Y NO SE LLAMA AL HELPER DIRECTAMENTE: el helper solo imprime por stdout, que en una
# acción de notify-send no lo lee nadie; y hace falta que no se pueda lanzar dos veces a la vez,
# porque freshclam descarga ~200 MB y dos disparos serían dos descargas peleándose por el mismo lock
# del log. El `flock -n` cubre los dos modos: el del arranque nunca pisa una actualización que el
# usuario acaba de pedir, ni al revés.
#
# El botón de Ajustes › Seguridad › Antivirus NO pasa por aquí: AGS llama al helper directamente
# porque ya tiene su propio estado (`clamavBusy`) y sus propias notificaciones.

set -u

APP="Antivirus"
HELPER=/usr/local/bin/gigishell-clamav-update
LOCK="${XDG_RUNTIME_DIR:-/tmp}/gigishell-clamav-update.lock"

# Edad a partir de la cual la base se considera vieja al arrancar. freshclam publica varias veces
# al día, pero descargar en cada arranque solo gasta red: con firmas de menos de un día ClamAV
# reconoce todo lo que importa. Quien arranca la sesión varias veces al día no descarga varias
# veces.
MAX_EDAD_HORAS=24
# Antirrebote: `hyprctl reload full-reset` vuelve a ejecutar el autostart, y sin esto cada recarga
# reintentaría la descarga cuando el arranque anterior falló (sin red). Un intento por hora como
# mucho, haya salido bien o mal.
REINTENTO_MIN_S=3600

modo_auto=false
[[ "${1:-}" == "--auto" ]] && modo_auto=true

# shellcheck source=lib/firmas.sh
source "$HOME/.config/hypr/scripts/lib/firmas.sh" 2>/dev/null || {
    # Sin la librería no se puede saber si el interruptor está encendido. En modo automático
    # eso significa NO actuar (nadie lo ha pedido explícitamente); a mano se sigue adelante.
    $modo_auto && exit 0
    # A mano se sigue adelante, pero la marca tiene que existir igual (la lee el bloque de
    # abajo y `set -u` no perdona una variable sin definir).
    FIRMAS_MARCA="$HOME/.cache/gigishell/firmas-auto"
}

NOTIF_APP="$APP"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigishell-source:system "${_a[@]}" "$@"
    }
fi

# En modo automático no se notifica nada, jamás. El interruptor promete "que se actualicen
# solas"; una cascada de popups sería exactamente lo contrario de lo que se ha pedido.
avisar() { $modo_auto || notificar "$@"; }

# La marca se escribe desde dos sitios (aquí abajo y tras el helper), así que su directorio se
# asegura una vez, antes del primero.
mkdir -p "$(dirname "$FIRMAS_MARCA")" 2>/dev/null

if [[ ! -x "$HELPER" ]]; then
    # Sin el helper root-owned no hay forma de hacerlo sin contraseña, y pedirla desde una
    # notificación no es posible. Se dice qué ejecutar en vez de fallar en silencio.
    avisar antivirus.falta-ayudante -u critical "Falta el ayudante de firmas" \
        "Ejecuta ~/GiGiShell/install.sh (o 'sudo freshclam' a mano) para poder actualizar desde aquí." -t 0
    # Se apunta el intento fallido igual que abajo: es lo que impide que cada `hyprctl reload
    # full-reset` —que vuelve a ejecutar el autostart— reintente esto en una instalación a la que
    # le falta el paso 9 de install.sh.
    printf '%s %s\n' "$(date +%s)" 3 > "$FIRMAS_MARCA" 2>/dev/null
    exit 3
fi

# ── Modo automático: ¿toca? ───────────────────────────────────────────────────────────
# Tres preguntas, en orden de coste creciente, y todas se contestan sin red ni sudo.
if $modo_auto; then
    firmas_auto_activa || exit 0

    # 1) Antirrebote. Antes que la edad de la base: es lo que evita el bucle sin red, donde
    #    la base sigue vieja después de cada intento fallido.
    ahora=$(date +%s)
    if [[ -f "$FIRMAS_MARCA" ]]; then
        read -r ultimo _rc < "$FIRMAS_MARCA" 2>/dev/null || ultimo=0
        [[ "$ultimo" =~ ^[0-9]+$ ]] || ultimo=0
        (( ahora - ultimo < REINTENTO_MIN_S )) && exit 0
    fi

    # 2) Edad de la base. `daily` es la que se mueve a diario; sin ninguna de las dos no hay
    #    base y hay que bajarla sí o sí.
    nuevo=0
    for db in /var/lib/clamav/daily.cld /var/lib/clamav/daily.cvd; do
        [[ -f "$db" ]] || continue
        m=$(stat -c %Y "$db" 2>/dev/null) || continue
        (( m > nuevo )) && nuevo=$m
    done
    (( nuevo > 0 && ahora - nuevo < MAX_EDAD_HORAS * 3600 )) && exit 0
fi

# Un solo intento a la vez. `flock -n` falla en el acto si ya hay uno corriendo, en vez de
# encolarse: el usuario ha pulsado dos veces el mismo botón, no ha pedido dos actualizaciones.
exec 9>"$LOCK"
if ! flock -n 9; then
    avisar antivirus.actualizacion-en-curso -u low "Actualización en curso" "Las firmas ya se están actualizando." -t 5000
    exit 0
fi

avisar antivirus.actualizando -u low "Actualizando firmas…" "Descargando la base de ClamAV; puede tardar un minuto." -t 8000

# `sudo -n`: sin la regla sudoers falla en el acto en vez de colgarse pidiendo una contraseña que
# nadie puede teclear (esto sale de un clic en una notificación, sin terminal donde escribir).
#
# El helper respeta el estado de `clamav-freshclam`; el automático se gestiona por separado desde
# el booleano de AGS y no se convierte en un temporizador del sistema.
err=$(sudo -n "$HELPER" update 2>&1 >/dev/null); rc=$?

# La marca la escriben LOS DOS modos: una actualización manual reciente también cuenta como
# intento a efectos de antirrebote, y si salió bien borra el "está fallando" que leen los
# escáneres para decidir si el arreglo automático merece un aviso.
printf '%s %s\n' "$(date +%s)" "$rc" > "$FIRMAS_MARCA" 2>/dev/null

if (( rc == 0 )); then
    avisar antivirus.firmas-actualizadas -u normal "Firmas actualizadas" \
        "ClamAV ya puede analizar. Lo pendiente se revisa en el siguiente barrido de Descargas." -t 10000
else
    # `sudo -n` no está: el helper existe pero la regla sudoers no, o freshclam falló (sin red,
    # espejo caído). Se distingue porque el mensaje de sudo es inconfundible.
    if [[ "$err" == *"password is required"* || "$err" == *"sudo:"* ]]; then
        err="falta la regla /etc/sudoers.d/gigishell-clamav (ejecuta ~/GiGiShell/install.sh)"
    fi
    avisar antivirus.fallo-actualizacion -u critical "No se pudieron actualizar las firmas" \
        "${err:-freshclam falló (código $rc)}" -t 0
fi
exit "$rc"
