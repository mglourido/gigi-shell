#!/usr/bin/env bash
# RAM monitor daemon — notifies only when free RAM gets genuinely low, with
# hysteresis so it doesn't flap. Uses MemAvailable (kernel's own "usable
# without swapping" estimate — accounts for reclaimable cache, unlike a raw
# used-% figure) and absolute thresholds, since a fixed used-% (e.g. 85%) means
# very different things on a 4GB laptop vs. a 32GB workstation.
#
# Perf: /proc/meminfo is parsed with a bash builtin read loop — no awk fork
# per tick. The poll interval is adaptive: it widens when RAM is comfortably
# above the warning line, and only tightens up when getting close to it.

WARN_AVAILABLE_MB=2048   # avisar cuando lo disponible cae a esto o menos
COOL_AVAILABLE_MB=3072   # no re-armar el aviso hasta que suba a esto o más (histéresis)
NEAR_MARGIN_MB=1024      # a <= WARN+este margen, sondear más seguido

POLL_ACTIVE=10   # cerca del umbral — responsivo
POLL_IDLE=30     # con margen de sobra — menos despertares, nada agresivo

ram_alerted=false

# Sets globals $mem_total_mb and $mem_avail_mb. Bash builtin loop over
# /proc/meminfo — no subprocess fork (MemAvailable is always among the first
# few lines, so the early `break` keeps this effectively O(1)).
read_meminfo() {
    local key val kb
    mem_total_mb=0
    while IFS=':' read -r key val; do
        case "$key" in
            MemTotal)
                kb=${val%kB}; kb=${kb// /}
                mem_total_mb=$(( kb / 1024 ))
                ;;
            MemAvailable)
                kb=${val%kB}; kb=${kb// /}
                mem_avail_mb=$(( kb / 1024 ))
                break
                ;;
        esac
    done < /proc/meminfo
}

NOTIF_APP="RAM"
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
    notificar "$1" \
        --urgency="$2" \
        --icon="$3" \
        --expire-time=15000 \
        "$4" "$5"
}

while true; do
    read_meminfo
    used_pct=$(( (mem_total_mb - mem_avail_mb) * 100 / mem_total_mb ))

    if (( mem_avail_mb <= WARN_AVAILABLE_MB )) && [[ "$ram_alerted" == false ]]; then
        send_notif ram.baja critical dialog-warning \
            "RAM muy baja: ${mem_avail_mb}MB disponibles" \
            "$(( mem_total_mb / 1024 ))GB totales, ${used_pct}% en uso. Considera cerrar aplicaciones."
        ram_alerted=true
    elif (( mem_avail_mb >= COOL_AVAILABLE_MB )) && [[ "$ram_alerted" == true ]]; then
        send_notif ram.normalizada normal dialog-information \
            "RAM normalizada" \
            "${mem_avail_mb}MB disponibles (${used_pct}% en uso)."
        ram_alerted=false
    fi

    if (( mem_avail_mb <= WARN_AVAILABLE_MB + NEAR_MARGIN_MB )); then
        sleep "$POLL_ACTIVE"
    else
        sleep "$POLL_IDLE"
    fi
done
