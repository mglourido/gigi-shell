#!/usr/bin/env bash
# Battery monitor daemon — notifies on charging/discharging transitions,
# on entering power-save mode (mirrors ags' threshold), on low-battery
# steps every 2% from 10% to 0% while discharging, and on reaching 100%
# while charging. No battery/power-save warnings are ever sent while charging.
#
# Perf notes: everything in the hot path uses bash builtins only (no forks).
# The only external process spawned during steady state is notify-send, and only
# when an actual notification fires. jq (to read the power-save threshold) is
# invoked at most once every THRESHOLD_REFRESH_SECS.
#
# ── Dirigido por eventos, no por polling ──────────────────────────────────────
# El kernel emite un uevent de `change` en el subsistema `power_supply` cada vez
# que la batería cambia de estado o de capacidad (`power_supply_changed()`), que
# es EXACTAMENTE lo que este script quiere saber. Así que el reloj del bucle es
# `udevadm monitor`, el mismo truco que usb-monitor.sh usa para los pendrives:
# cero sondeos en reposo, y una comprobación por cambio real.
#
# Dos matices, ambos con precedente en este repo:
#
#  · COALESCENCIA. Un enchufe del cargador dispara varios uevents casi a la vez
#    (el AC y la batería son dispositivos distintos, y el driver suele emitir
#    status y capacidad por separado). Sin agrupar saldrían varias pasadas por un
#    solo hecho, y con ellas el riesgo de leer sysfs a medio actualizar — el
#    status ya en "Charging" pero power_now todavía en cero, o sea un "tiempo
#    desconocido" en el popup. Tras el primer evento se espera COALESCE_SECS
#    recogiendo el resto y se comprueba UNA vez, con sysfs ya asentado.
#
#  · RED DE SEGURIDAD. Los uevents de batería los emite el driver, y cuánto de
#    fino los emite depende del firmware ACPI: hay portátiles que avisan de cada
#    1% y otros que se saltan tramos. Un aviso de batería baja que no llega es
#    justo el fallo que no se puede permitir, así que el `read` va con timeout y
#    la comprobación se hace igual si no ha llegado nada. Sigue siendo adaptativo
#    (más corto cerca de un umbral), pero ahora son minutos, no segundos: es una
#    red, no el mecanismo.
#
# Si `udevadm` no está o su stream muere, se cae al bucle de sondeo de siempre
# (poll_loop): degradar a polling es peor, pero quedarse sin monitor es mucho peor.

BATTERY=/sys/class/power_supply/BAT0
POWER_SAVE_CONFIG="$HOME/.config/power-save/config.json"
AGS_PREFS_CONFIG="$HOME/.config/gigios/preferences.json"
LOW_THRESHOLDS=(10 8 6 4 2 0)
DEFAULT_POWER_SAVE_THRESHOLD=15
THRESHOLD_REFRESH_SECS=600   # re-read power-save config at most every 10min

# Red de seguridad del bucle por eventos (ver cabecera). Solo entra en juego si el
# driver no emitió el uevent que tocaba; en marcha normal nunca vence.
SAFETY_ACTIVE=180  # discharging and near/under a threshold — keep it responsive
SAFETY_IDLE=600    # discharging but comfortably above every threshold
SAFETY_CHARGING=900 # charging (not yet full) or already full — nothing urgent
COALESCE_SECS=2    # ventana para agrupar la ráfaga de uevents de un mismo hecho

# Sondeo del modo degradado, cuando no hay udevadm o su stream se cerró.
POLL_ACTIVE=30
POLL_IDLE=60
POLL_CHARGING=90

declare -A notified
charged_notified=false
powersave_notified=false
prev_status=""
power_save_threshold=$DEFAULT_POWER_SAVE_THRESHOLD
last_threshold_check=-$THRESHOLD_REFRESH_SECS

# Ajuste "Monitor de batería" en Personalización (ags). Se lee UNA sola vez
# aquí al arrancar — nada de polling — así que activar/desactivar el ajuste
# solo surte efecto reiniciando este script (o en el próximo login).
if command -v jq >/dev/null 2>&1; then
    # NB: plain `.batteryMonitor // "true"` would be wrong — jq's `//` treats a
    # literal `false` as absent too, so it'd always resolve to "true".
    enabled=$(jq -r 'if has("batteryMonitor") then (.batteryMonitor|tostring) else "true" end' \
        "$AGS_PREFS_CONFIG" 2>/dev/null)
    [[ "$enabled" == "false" ]] && exit 0
fi

# [A] Read every sysfs value once per tick with bash built-in redirects —
#     no subprocess forks; get_capacity and get_time_label use these globals.
read_battery() {
    read -r energy_now  < "$BATTERY/energy_now"  2>/dev/null || energy_now=0
    read -r energy_full < "$BATTERY/energy_full" 2>/dev/null || energy_full=1
    read -r power_now   < "$BATTERY/power_now"   2>/dev/null || power_now=0
    read -r status      < "$BATTERY/status"      2>/dev/null || status=Unknown
}

# Ceiling-rounded percentage using globals from read_battery, matching AGS.
# Sets global $capacity — no echo/command-substitution, no subshell fork.
get_capacity() {
    if (( energy_full <= 0 )); then
        read -r capacity < "$BATTERY/capacity" 2>/dev/null || capacity=0
        return
    fi
    capacity=$(( (energy_now * 100 + energy_full - 1) / energy_full ))
}

# Human-readable time estimate using globals from read_battery (no I/O, no fork).
# Sets global $time_label.
get_time_label() {
    if (( power_now == 0 )); then
        time_label="tiempo desconocido"; return
    fi
    local delta seconds h m
    if [[ "$1" == "Discharging" ]]; then
        delta=$energy_now
    else
        delta=$(( energy_full - energy_now ))
    fi
    seconds=$(( delta * 3600 / power_now ))
    h=$(( seconds / 3600 ))
    m=$(( (seconds % 3600) / 60 ))
    if (( h > 0 )); then time_label="${h}h ${m}min"; else time_label="${m}min"; fi
}

# Mirrors ags' powerSaveActive threshold (~/.config/power-save/config.json).
# Only forks jq at most once every THRESHOLD_REFRESH_SECS — updates global
# $power_save_threshold in place, config changes are rare so this is plenty fresh.
refresh_power_save_threshold() {
    (( SECONDS - last_threshold_check < THRESHOLD_REFRESH_SECS )) && return
    last_threshold_check=$SECONDS
    local thr
    thr=$(jq -e '.thresholdPct' "$POWER_SAVE_CONFIG" 2>/dev/null) || thr=$DEFAULT_POWER_SAVE_THRESHOLD
    [[ "$thr" =~ ^[0-9]+$ ]] && power_save_threshold=$thr
}

# [C] Sets globals $urgency and $icon for the given threshold level.
threshold_urgency() {
    if (( $1 <= 8 )); then
        urgency=critical; icon=battery-empty
    else
        urgency=normal;   icon=battery-caution
    fi
}

NOTIF_APP="Batería"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigios-source:system "${_a[@]}" "$@"
    }
fi

send_notif() {
    local evento=$1 urgency=$2 icon=$3 title=$4 body=$5
    notificar "$evento" \
        --urgency="$urgency" \
        --icon="$icon" \
        --expire-time=12000 \
        "$title" "$body"
}

# Una pasada completa: lee sysfs y dispara lo que haya que disparar. Sin efectos
# más allá de las notificaciones y de los globales de latcheo ($notified,
# $prev_status, …), así que da igual quién la llame — el evento o la red de
# seguridad — y da igual que se llame de más: todo aviso está latcheado.
# Deja en $near_threshold si conviene vigilar de cerca (lo leen ambos bucles).
check_battery() {
    read_battery
    get_capacity

    # ── Status transitions ────────────────────────────────────────────────────
    # [E] Treating prev_status="" as a valid prior state lets the first-boot
    #     Discharging reset fall through the same path without a separate elif.
    if [[ "$status" != "$prev_status" ]]; then
        case "$status" in
            Charging)
                if [[ -n "$prev_status" ]]; then
                    get_time_label Charging
                    send_notif bateria.cargando normal battery-good \
                        "Cargando batería" \
                        "${capacity}% — tiempo para carga completa: ~${time_label}"
                fi
                powersave_notified=false  # charging never shows power-save warnings
                ;;
            Discharging)
                if [[ -n "$prev_status" ]]; then
                    get_time_label Discharging
                    send_notif bateria.descargando normal battery-good \
                        "Desconectado cargador" \
                        "${capacity}% — tiempo restante: ~${time_label}"
                fi
                notified=()           # [B]
                charged_notified=false
                powersave_notified=false
                ;;
        esac
    fi

    # [D] Full-charge check unified — covers both Full status and Charging@100%.
    if [[ "$charged_notified" == false ]] && \
       [[ "$status" == "Full" || ("$status" == "Charging" && "$capacity" -ge 100) ]]; then
        send_notif bateria.completa normal battery-full \
            "Carga completada"
        charged_notified=true
    fi

    # ── Discharge-only checks: power-save mode + low-battery steps ────────────
    # Prevención: mientras carga (o está llena) no se avisa ni de modo ahorro
    # ni de batería baja.
    near_threshold=false
    if [[ "$status" == "Discharging" ]]; then
        refresh_power_save_threshold

        if [[ "$powersave_notified" == false ]] \
                && (( capacity > 0 && capacity <= power_save_threshold )); then
            powersave_notified=true
            send_notif bateria.modo-ahorro normal power-profile-power-saver-symbolic \
                "Modo ahorro de energía activado" \
                "Batería ${capacity}% (umbral: ${power_save_threshold}%)"
        elif (( capacity > power_save_threshold )); then
            powersave_notified=false
        fi

        get_time_label Discharging
        for thr in "${LOW_THRESHOLDS[@]}"; do
            if (( capacity <= thr )) && [[ -z "${notified[$thr]}" ]]; then
                notified[$thr]=1
                threshold_urgency "$thr"  # [C]
                send_notif bateria.baja "$urgency" "$icon" \
                    "Batería ${capacity}%" \
                    "Tiempo restante ~${time_label}"
            fi
        done

        # Within 10 points of the power-save threshold (or already under any
        # low-battery threshold) → keep the finer poll interval for accuracy.
        (( capacity <= power_save_threshold + 10 )) && near_threshold=true
    fi

    prev_status=$status
}

# ── Modo degradado: el sondeo adaptativo de siempre ──────────────────────────
# Solo se llega aquí sin udevadm o si su stream se cierra. No retorna.
poll_loop() {
    while :; do
        check_battery
        if [[ "$status" == "Discharging" ]]; then
            if [[ "$near_threshold" == true ]]; then
                sleep "$POLL_ACTIVE"
            else
                sleep "$POLL_IDLE"
            fi
        else
            sleep "$POLL_CHARGING"
        fi
    done
}

# Espera hasta la próxima comprobación forzosa, según lo cerca que ande de un
# umbral. Es la red de seguridad, no el mecanismo: ver cabecera.
# Deja el valor en el global $espera en vez de imprimirlo: un `$(...)` aquí sería
# un fork por vuelta del bucle, y este script no forkea salvo para notificar.
safety_wait() {
    if [[ "$status" == "Discharging" ]]; then
        if [[ "$near_threshold" == true ]]; then espera=$SAFETY_ACTIVE
        else espera=$SAFETY_IDLE; fi
    else
        espera=$SAFETY_CHARGING
    fi
}

command -v udevadm >/dev/null 2>&1 || poll_loop

# Foto inicial: fija $prev_status (que estrena vacío, así que esta pasada no
# notifica ninguna transición) y de paso deja $near_threshold para el primer
# timeout. Sin esto el primer `read` esperaría con los valores de fábrica.
check_battery

# ── Bucle por eventos ─────────────────────────────────────────────────────────
# `read` marca el timeout con un código >128; cualquier otro no-cero es fin del
# stream de udevadm → se degrada a sondeo. `pendiente` distingue los dos motivos
# por los que podemos estar esperando: recoger el resto de una ráfaga (ventana
# corta, y al vencer se comprueba) o la red de seguridad (ventana larga).
pendiente=0
while :; do
    if (( pendiente )); then espera=$COALESCE_SECS; else safety_wait; fi
    IFS= read -r -t "$espera" line; rc=$?
    if (( rc == 0 )); then
        # Solo la línea de cabecera del evento cuenta como "algo se movió": no
        # hace falta --property ni parsear nada, porque el dato bueno se relee de
        # sysfs igualmente. El patrón lleva los dos espacios y el corchete
        # (`UDEV  [123.456] change …`) para no comerse la BANDERA de arranque que
        # udevadm imprime — «UDEV - the event which udev sends out…» también
        # empieza por UDEV, y con `UDEV*` disparaba una comprobación de más en
        # cada arranque.
        [[ "$line" == "UDEV  ["* ]] && pendiente=1
        continue
    fi
    (( rc > 128 )) || break   # stream cerrado
    pendiente=0
    check_battery
done < <(udevadm monitor --udev --subsystem-match=power_supply 2>/dev/null)

# Solo se sale del bucle si udevadm murió: seguir avisando importa más que cómo.
poll_loop
