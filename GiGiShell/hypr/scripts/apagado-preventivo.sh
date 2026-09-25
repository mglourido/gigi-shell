#!/usr/bin/env bash
# apagado-preventivo.sh — apaga el equipo LIMPIAMENTE antes de que la batería se agote.
#
# Lo lanza battery-monitor.sh cuando la batería, descargándose, llega al porcentaje
# de Ajustes > Energía (`apagadoPreventivoPct` en preferences.json, 3 % de fábrica).
# Uso: apagado-preventivo.sh <porcentaje-actual> [apagar|hibernar]
#
# La acción la elige el usuario (`apagadoPreventivoAccion`). HIBERNAR es la que no
# pierde nada —todo sigue abierto al volver—, pero depende de que el equipo esté
# preparado (swap + resume=, `install.sh --solo hibernacion`). Por eso se pregunta
# ANTES del aviso, para que la notificación diga lo que de verdad va a pasar, y si
# `systemctl hibernate` falla igualmente se cae al apagado ordenado: quedarse sin
# hacer nada con la batería al 3 % es lo único que no puede pasar.
#
# ── Por qué no basta con lo que ya hay ────────────────────────────────────────
# UPower ya tiene su propia acción crítica (`PercentageAction`, 2 % de fábrica), pero
# es un corte a secas: logind apaga o hiberna sin avisar ni dar tiempo, y cualquier
# ventana con cambios sin guardar muere con ellos. Y si la lectura del porcentaje
# salta (las baterías gastadas lo hacen cerca del 0 %) ni siquiera llega a tiempo.
# Este script actúa ANTES que UPower —por eso el mínimo del ajuste es 3 %— y en tres
# tiempos:
#
#   1. AVISO + CUENTA ATRÁS (CUENTA_SECS). Notificación crítica con un botón
#      «Cancelar». Enchufar el cargador también cancela: se relee sysfs cada segundo
#      con builtins, sin forks.
#   2. CIERRE ORDENADO de todas las ventanas por Hyprland (el mismo `window.close`
#      que SUPER+SHIFT+C). Es lo que da a cada app la ocasión de guardar su sesión
#      —un navegador guarda las pestañas, un editor pregunta por lo no guardado—, a
#      diferencia del SIGTERM que reparte systemd al apagar. Se espera a que se
#      cierren hasta CIERRE_SECS: un diálogo de «¿guardar cambios?» se queda abierto
#      ese tiempo, que es justo para contestarlo.
#   3. `systemctl poweroff`, que ya no encuentra nada que perder.
#
# Con HIBERNAR el paso 2 se salta (cerrar las ventanas es justo lo que hibernar
# evita) y el 3 es `systemctl hibernate`.
#
# Si en cualquier punto antes del paso 3 el equipo pasa a cargar, se aborta: las
# ventanas cerradas se pueden volver a abrir; un apagado con el cargador puesto era
# innecesario.
#
# Una sola instancia (flock): battery-monitor ya latchea el disparo, pero un
# relanzado del monitor durante la cuenta atrás lo dispararía otra vez.

BATTERY=/sys/class/power_supply/BAT0
CUENTA_SECS=60
CIERRE_SECS=20

pct=${1:-?}
accion=${2:-apagar}

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/apagado-preventivo.lock"
flock -n 9 || exit 0

NOTIF_APP="Batería"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    notificar() {
        shift
        notify-send -h string:x-gigishell-source:system -a "$NOTIF_APP" "$@"
    }
fi

cargando() {
    local status
    read -r status < "$BATTERY/status" 2>/dev/null || return 1
    [[ "$status" != "Discharging" ]]
}

# El aviso de cancelación REEMPLAZA (-r) al de la cuenta atrás, si se llegó a saber
# su id: si no, un «apagando en 60 s» seguiría en pantalla con el apagado ya anulado.
reemplazo() {
    local id
    read -r id < "$marca_id" 2>/dev/null
    [[ "$id" =~ ^[0-9]+$ ]] && printf '%s\n' -r "$id"
}

# Misma pregunta que hace Ajustes (servicios/energia/hibernacion.ts): el helper
# consulta a logind. Sin helper, se le pregunta a logind directamente.
puede_hibernar() {
    local helper=/usr/local/bin/gigishell-hibernacion
    if [[ -x "$helper" ]]; then
        "$helper" estado 2>/dev/null | grep -qx 'disponible=si'
    else
        busctl call org.freedesktop.login1 /org/freedesktop/login1 \
            org.freedesktop.login1.Manager CanHibernate 2>/dev/null | grep -q '"yes"'
    fi
}

if [[ "$accion" == hibernar ]] && ! puede_hibernar; then
    accion=apagar
    aviso_extra=" (la hibernación no está disponible en este equipo)"
fi
if [[ "$accion" == hibernar ]]; then
    verbo="hibernando"
    detalle="Todo lo abierto seguirá igual al volver a encender. Conecta el cargador para cancelarlo."
else
    verbo="apagando"
    detalle="Guarda lo que tengas abierto o conecta el cargador para cancelarlo. Las ventanas se cerrarán antes de apagar${aviso_extra:-}."
fi

cancelar_si_carga() {
    cargando || return 0
    # shellcheck disable=SC2046
    notificar bateria.apagado-cancelado $(reemplazo) --urgency=normal --icon=battery-good \
        --expire-time=6000 \
        "Apagado preventivo cancelado" "El equipo está cargando."
    exit 0
}

# ── 1. Aviso y cuenta atrás ───────────────────────────────────────────────────
# `--wait` bloquea hasta que la notificación se cierra y, con `-A`, imprime la
# acción pulsada (`-p` imprime antes su id, para poder reemplazarla). Va en segundo
# plano y deja marcas en ficheros: la cuenta atrás no puede quedarse esperando a que
# el usuario haga algo.
#
# `exec 9>&-` NO es adorno: sin él el notify-send hereda el descriptor del flock y
# retiene el cerrojo hasta que la notificación caduca, así que un apagado cancelado
# al enchufar bloqueaba el siguiente disparo durante ese rato sin decir nada.
marca_cancelar="${XDG_RUNTIME_DIR:-/tmp}/apagado-preventivo.cancelar"
marca_id="${XDG_RUNTIME_DIR:-/tmp}/apagado-preventivo.id"
rm -f "$marca_cancelar" "$marca_id"
(
    exec 9>&-
    notificar bateria.apagado-preventivo --urgency=critical --icon=battery-empty \
        --expire-time=$(( CUENTA_SECS * 1000 )) \
        -p -A cancelar=Cancelar --wait \
        "Batería al ${pct} %: ${verbo} en ${CUENTA_SECS} s" \
        "$detalle" |
    {
        read -r id && printf '%s\n' "$id" > "$marca_id"
        read -r accion && [[ "$accion" == "cancelar" ]] && : > "$marca_cancelar"
    }
) &
aviso_pid=$!

for (( s = 0; s < CUENTA_SECS; s++ )); do
    sleep 1
    if [[ -e "$marca_cancelar" ]]; then
        rm -f "$marca_cancelar"
        notificar bateria.apagado-cancelado --urgency=normal --icon=battery-caution \
            --expire-time=8000 \
            "Apagado preventivo cancelado" \
            "No se volverá a intentar hasta que el equipo cargue. Sin cargador, el sistema apagará igualmente al agotarse."
        exit 0
    fi
    cancelar_si_carga
done
kill "$aviso_pid" 2>/dev/null

# ── Hibernar ──────────────────────────────────────────────────────────────────
# `systemctl hibernate` vuelve con 0 al DESPERTAR, así que ahí se termina: seguir
# apagaría el equipo recién restaurado. Si falla, se sigue hacia el apagado.
if [[ "$accion" == hibernar ]]; then
    sync
    systemctl hibernate && exit 0
    notificar bateria.apagado-preventivo --urgency=critical --icon=battery-empty \
        --expire-time=10000 \
        "No se pudo hibernar" "Se cierran las ventanas y se apaga el equipo."
fi

# ── 2. Cierre ordenado de las ventanas ───────────────────────────────────────
# Forma Lua del dispatcher (la sintaxis legacy `dispatch closewindow` no existe
# con config Lua). Un cliente que no se cierre no frena a los demás.
direcciones() {
    hyprctl clients -j 2>/dev/null | jq -r '.[].address' 2>/dev/null
}

if command -v hyprctl >/dev/null && command -v jq >/dev/null; then
    while read -r dir; do
        [[ -n "$dir" ]] || continue
        hyprctl dispatch "hl.dsp.window.close({ window = 'address:${dir}' })" >/dev/null 2>&1
    done < <(direcciones)

    for (( s = 0; s < CIERRE_SECS; s++ )); do
        [[ -z "$(direcciones)" ]] && break
        sleep 1
        cancelar_si_carga
    done
fi

# ── 3. Apagado ────────────────────────────────────────────────────────────────
cancelar_si_carga
sync
systemctl poweroff
