#!/usr/bin/env bash
# WiFi monitor daemon — notifies on disconnect, on reconnect, and when a
# captive portal needs a login. Fully event-driven via `nmcli monitor`
# (blocks on NetworkManager's D-Bus signals): zero polling, zero forks while
# idle — the only work done is when an actual event fires.

# ── ¿Hay wifi que vigilar? Tres desenlaces, y distinguirlos importa ───────────
# Antes esto era una sola línea: si `nmcli` no daba interfaz, aviso CRÍTICO y a la
# calle, sin preguntarse por qué no la daba. Eso juntaba dos situaciones opuestas:
#
#   - En un SOBREMESA sin wifi (este: solo enp4s0 + tailscale0; ni /sys/class/net/
#     */wireless, ni entrada de wifi en rfkill, ni tarjeta PCI, ni dongle USB) era
#     un popup rojo en CADA login para anunciar que un hardware que no existe sigue
#     sin existir. Ruido puro, y del que enseña a ignorar los avisos críticos.
#   - En un PORTÁTIL era una CARRERA que se resolvía mintiendo: este script sale de
#     un `exec-once` a la vez que arranca NetworkManager, así que perder la carrera
#     significaba avisar de que "no hay WiFi" cuando la había, y encima dejar la
#     sesión entera sin monitor porque el script ya había salido.
#
# Ahora se separan:
#   1. nmcli da interfaz             → vigilar (camino normal).
#   2. NO hay hardware wifi          → salir en SILENCIO. No hay nada que vigilar;
#                                      eso no es un fallo. Se mira /sys/class/net/
#                                      <if>/wireless, que lo publica el KERNEL: no
#                                      depende de que NM esté listo, así que no
#                                      reintroduce la carrera por la puerta de atrás.
#   3. HAY antena pero NM no la da   → reintentar hasta WAIT_SECS. Si aun así no
#                                      aparece, ahí sí es un problema real → avisar.
WAIT_SECS=30

NOTIF_APP="WiFi"
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

wifi_hardware_present() {
    local d
    for d in /sys/class/net/*/wireless; do
        [[ -d "$d" ]] && return 0
    done
    return 1   # sin coincidencias el glob queda literal → -d falla → no hay wifi
}

find_iface() {
    nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}'
}

IFACE=$(find_iface)
if [[ -z "$IFACE" ]]; then
    wifi_hardware_present || exit 0        # (2) sin antena: silencio, es lo correcto
    for (( i = 0; i < WAIT_SECS; i++ )); do   # (3) hay antena: dale margen a NM
        sleep 1
        IFACE=$(find_iface)
        [[ -n "$IFACE" ]] && break
    done
fi
if [[ -z "$IFACE" ]]; then
    notificar wifi.sin-interfaz -u critical "wifi-monitor" \
        "Hay hardware WiFi pero NetworkManager no publicó ninguna interfaz en ${WAIT_SECS}s. Saliendo." -t 10000
    exit 0
fi

was_connected=true    # asumimos conectado al arrancar — evita un falso "reconectado" en el boot
portal_notified=false

# Perfil de conexión activo en la interfaz — para NM suele coincidir con el
# SSID en redes WiFi auto-creadas. Sin escaneo, sin forks extra (una sola
# consulta D-Bus vía nmcli, y solo cuando ocurre una reconexión real).
get_ssid() {
    nmcli -g GENERAL.CONNECTION device show "$IFACE" 2>/dev/null
}

notify_disconnected() {
    notificar wifi.desconectado -u critical "WiFi desconectado" "Se perdió la conexión en $IFACE" -t 0
}

notify_reconnected() {
    notificar wifi.reconectado -u normal "WiFi reconectado" "Red: $(get_ssid)" -t 8000
}

notify_portal() {
    notificar wifi.portal-cautivo -u critical "Portal cautivo detectado" \
        "Abre el navegador para iniciar sesión y acceder a internet" -t 0
}

# La línea global "Connectivity is now 'X'" de `nmcli monitor` refleja la
# conectividad general de NetworkManager (la de su conexión primaria), no la
# de $IFACE en concreto — si vas por cable, o tienes wifi + ethernet a la vez,
# ese evento puede venir del cable. Por eso, ante cualquier cambio de
# conectividad consultamos la conectividad POR INTERFAZ de nuestra wifi
# (IP4-CONNECTIVITY de $IFACE) y solo avisamos si el portal es el de wifi.
check_portal() {
    local row state conn
    row=$(nmcli -t -f DEVICE,STATE,IP4-CONNECTIVITY device status 2>/dev/null \
        | awk -F: -v d="$IFACE" '$1==d{print $2":"$3}')
    state=${row%%:*}
    conn=${row##*:}
    if [[ "$state" == "connected" && "$conn" == "portal" ]]; then
        if [[ "$portal_notified" == false ]]; then
            notify_portal
            portal_notified=true
        fi
    else
        portal_notified=false
    fi
}

# Reintenta si `nmcli monitor` muere (p.ej. NetworkManager se reinicia) en
# vez de dejar el daemon colgado para siempre.
while true; do
    while IFS= read -r line; do
        case "$line" in
            "$IFACE: connected")
                if [[ "$was_connected" == false ]]; then
                    notify_reconnected
                    was_connected=true
                fi
                check_portal  # por si el portal ya está activo justo al reconectar
                ;;
            "$IFACE: disconnected")
                if [[ "$was_connected" == true ]]; then
                    notify_disconnected
                    was_connected=false
                fi
                portal_notified=false
                ;;
            "Connectivity is now "*)
                check_portal
                ;;
        esac
    # LC_ALL=C: los mensajes de estado de `monitor` son palabras clave en
    # inglés fijas independientemente del locale — es lo que casamos en el
    # case de arriba. Los textos que sí ve el usuario (notify-send) van en
    # español, definidos en las funciones notify_* de este script.
    done < <(LC_ALL=C nmcli monitor)
    sleep 2
done
