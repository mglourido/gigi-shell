#!/usr/bin/env bash
# Bluetooth connection-loss monitor — notifies only on an UNEXPECTED loss:
# not when you disconnect the device yourself (bluetoothctl, GNOME/KDE
# settings, blueman — anything that calls the standard BlueZ D-Bus API), and
# not when you turn Bluetooth off. Grace period: if the device reconnects
# within GRACE seconds, nothing is sent (covers brief dropouts/auto-reconnect).
#
# Single always-on dbus-monitor subscription — cheap while blocked, so there's
# no separate process to start/stop. What IS gated dynamically is the actual
# work: bluetoothctl queries and the grace-period timer only ever run when a
# device just became unexpectedly disconnected; a manual disconnect or a
# powered-off adapter is recognized and skipped before any of that runs.

NOTIF_APP="Bluetooth"
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

GRACE=10                     # segundos de gracia antes de dar la pérdida por real
MANUAL_DISCONNECT_WINDOW=5   # ventana tras un Disconnect() propio para no avisar
COALESCE=2                   # ver "Agrupación" abajo

# ── Agrupación: apagar el adaptador es UN suceso, no cinco ────────────────────
# Los dispositivos Bluetooth no se pierden de uno en uno. Salirte del alcance,
# quedarte sin batería en el adaptador o un fallo del controlador tumban a la vez
# los cascos, el ratón y el mando, y eso eran tres criticals con `-t 0` (sin
# autocierre) diciendo lo mismo. Al revés igual: al encender el Bluetooth los
# dispositivos emparejados se reconectan en cascada en un par de segundos.
#
# Los dos avisos ya salían diferidos o eran instantáneos por motivos ajenos a esto:
#   · PERDIDO   → ya esperaba GRACE segundos para descartar un microcorte. Ese
#                 vencimiento es el lote: lo que caiga en la misma tanda sale junto,
#                 sin retrasar nada respecto a antes.
#   · CONECTADO → era inmediato; se retiene COALESCE segundos, lo justo para que la
#                 cascada de reconexiones quepa en un solo aviso. Son 2 s en un popup
#                 informativo que dura 6.
if ! source "$HOME/.config/hypr/scripts/lib/notif-agrupar.sh" 2>/dev/null; then
    declare -A _NGF_EV=() _NGF_URG=() _NGF_TMO=() _NGF_TIT=() _NGF_PRE=()
    notif_grupo()   { _NGF_EV[$1]=$2 _NGF_URG[$1]=$3 _NGF_TMO[$1]=$4 _NGF_TIT[$1]=$5 _NGF_PRE[$1]=${7-}; }
    notif_encolar() { notificar "${_NGF_EV[$1]}" -u "${_NGF_URG[$1]}" "${_NGF_TIT[$1]}" "${_NGF_PRE[$1]}$2" -t "${_NGF_TMO[$1]}"; }
    notif_volcar()  { :; }
fi
notif_grupo bperd bluetooth.perdido   critical 0    "Bluetooth perdido"   "dispositivos Bluetooth perdidos"  "Se perdió la conexión con: "
notif_grupo bconn bluetooth.conectado normal   6000 "Bluetooth conectado" "dispositivos Bluetooth conectados"

declare -A manual_disconnect_time
current_mac=""

# Avisos pendientes de vencer. La clave lleva el tipo delante ("perdido:MAC" /
# "conectado:MAC") para que un mismo dispositivo pueda tener uno de cada sin
# pisarse, y `pend_orden` conserva el orden de llegada (recorrer un array
# asociativo da un orden de hash, y en una lista de tres nombres eso se nota).
declare -A pend_at=() pend_name=()
declare -a pend_orden=()

pend_add() {   # $1=clave  $2=nombre a mostrar  $3=segundos de espera
    [[ -n "${pend_at[$1]+x}" ]] || pend_orden+=("$1")
    pend_at[$1]=$(( EPOCHSECONDS + $3 ))
    pend_name[$1]=$2
}

# Segundos hasta el próximo vencimiento; rc=1 (y nada impreso) si no hay ninguno,
# que es cuando el bucle vuelve a bloquear sin timeout como hacía siempre.
pend_wait() {
    local k menor=""
    for k in "${!pend_at[@]}"; do
        [[ -z "$menor" || ${pend_at[$k]} -lt $menor ]] && menor=${pend_at[$k]}
    done
    [[ -n "$menor" ]] || return 1
    (( menor <= EPOCHSECONDS )) && { printf 1; return 0; }
    printf '%s' "$(( menor - EPOCHSECONDS ))"
}

# Dispara lo vencido. La comprobación de "sigue perdido" se hace AQUÍ y no al
# encolar: es exactamente la que hacía el subshell tras su `sleep`, y es lo que
# distingue un microcorte de una pérdida real.
pend_fire() {
    local k mac
    local -a quedan=()
    for k in "${pend_orden[@]}"; do
        [[ -n "${pend_at[$k]+x}" ]] || continue
        if (( pend_at[$k] > EPOCHSECONDS )); then quedan+=("$k"); continue; fi
        mac="${k#*:}"
        case "$k" in
            perdido:*)   is_still_lost "$mac" && adapter_powered && notif_encolar bperd "${pend_name[$k]}" ;;
            conectado:*) notif_encolar bconn "${pend_name[$k]}" ;;
        esac
        unset 'pend_at[$k]' 'pend_name[$k]'
    done
    pend_orden=("${quedan[@]}")
    notif_volcar
}

get_device_name() {
    bluetoothctl info "$1" 2>/dev/null | awk -F': ' '/^\s+Name:/{print $2; exit}'
}

is_still_lost() {
    local mac=$1 info
    info=$(bluetoothctl info "$mac" 2>/dev/null)
    grep -q "Connected: no" <<< "$info" && grep -q "Paired: yes" <<< "$info"
}

adapter_powered() {
    bluetoothctl show 2>/dev/null | grep -q "Powered: yes"
}

dbus-monitor --system \
    "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',arg0='org.bluez.Device1'" \
    "type='method_call',interface='org.bluez.Device1',member='Disconnect'" \
    2>/dev/null | while :; do

    # El bucle es también el reloj de los pendientes: sin ninguno bloquea sin
    # timeout (coste cero, igual que antes); con alguno, despierta a su
    # vencimiento. `read` marca el timeout con un código >128.
    if wait_secs=$(pend_wait); then
        IFS= read -r -t "$wait_secs" line; rc=$?
    else
        IFS= read -r line; rc=$?
    fi
    if (( rc != 0 )); then
        pend_fire
        (( rc > 128 )) && continue
        break
    fi

    # Extract device MAC from the signal/method-call path line
    # path=/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF → AA:BB:CC:DD:EE:FF
    if [[ "$line" =~ path=/org/bluez/hci[0-9]+/dev_([0-9A-F_]+) ]]; then
        current_mac="${BASH_REMATCH[1]//_/:}"
    fi

    # Alguien (bluetoothctl, GUI, script propio) pidió desconectar este
    # dispositivo por D-Bus — lo que sigue no es una pérdida inesperada.
    if [[ "$line" == "method call "* && "$line" == *"member=Disconnect"* ]] && [[ -n "$current_mac" ]]; then
        manual_disconnect_time["$current_mac"]=$EPOCHSECONDS
        continue
    fi

    # Detect "Connected" property — next line has the boolean value
    if [[ "$line" == *'"Connected"'* ]] && [[ -n "$current_mac" ]]; then
        IFS= read -r val_line
        mac="$current_mac"

        if [[ "$val_line" == *"boolean false"* ]]; then
            t=${manual_disconnect_time[$mac]:-0}
            if (( EPOCHSECONDS - t <= MANUAL_DISCONNECT_WINDOW )); then
                unset 'manual_disconnect_time[$mac]'
                continue  # desconexión manual — no avisar
            fi
            adapter_powered || continue  # se está apagando el bluetooth — no avisar

            # Snapshot the name now (device still in btd cache)
            name=$(get_device_name "$mac")
            pend_add "perdido:$mac" "${name:-$mac}" "$GRACE"

        elif [[ "$val_line" == *"boolean true"* ]]; then
            unset 'manual_disconnect_time[$mac]'
            # Se reconectó dentro de la gracia: la pérdida pendiente se cae. Antes
            # lo resolvía el `is_still_lost` del subshell al despertar; anularla
            # aquí es lo mismo pero sin pagar dos consultas a bluetoothctl.
            unset 'pend_at[perdido:$mac]' 'pend_name[perdido:$mac]'
            name=$(get_device_name "$mac")
            pend_add "conectado:$mac" "${name:-$mac}" "$COALESCE"
        fi
    fi

done
