#!/usr/bin/env bash
# Expulsión segura de un disco USB — invocado desde el botón "Expulsar" de la
# notificación de usb-monitor.sh, o a mano: usb-eject.sh sdb
#
# Desmonta TODAS las particiones montadas del disco y luego lo apaga. El unmount
# de udisks hace el flush de la caché sucia y espera a que termine: cuando esto
# vuelve con éxito, los datos están físicamente en el pendrive. Ese es justo el
# paso que se salta arrancarlo a pelo (ver 99-gigios-usb-writeback.rules).
#
# Va por udisksctl (no `umount`) porque los montajes de /run/media/$USER son de
# udisks y son del usuario: no hace falta sudo. power-off corta la alimentación
# del puerto, que es el equivalente real a "es seguro retirar el hardware".
set -uo pipefail

APP="USB"
NOTIF_APP="$APP"
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

disk=${1:-}
[[ -z "$disk" ]] && { echo "uso: $0 <disco>  (p.ej. sdb)" >&2; exit 2; }
disk=$(basename "$disk")          # tolera que nos pasen /dev/sdb

if [[ ! -e /sys/block/$disk ]]; then
    notificar usb.expulsar-sin-dispositivo -u critical "Expulsar: dispositivo no encontrado" "/dev/$disk ya no existe."
    exit 1
fi
if ! command -v udisksctl >/dev/null 2>&1; then
    notificar usb.expulsar-falta-udisks -u critical "Expulsar: falta udisks2" "Instala udisks2 para poder expulsar."
    exit 1
fi

label=$(lsblk -dno MODEL "/dev/$disk" 2>/dev/null | sed 's/[[:space:]]*$//')
: "${label:=/dev/$disk}"

# --- Desmontar cada partición montada -----------------------------------------
# Leemos los montajes reales de /proc/mounts en vez de fiarnos de lsblk, que
# puede traer el MOUNTPOINT vacío en montajes hechos por otro namespace.
failed=""
while read -r part; do
    [[ -z "$part" ]] && continue
    grep -q "^/dev/$part " /proc/mounts || continue    # no montada: nada que hacer
    if ! err=$(udisksctl unmount -b "/dev/$part" --no-user-interaction 2>&1); then
        # Lo normal aquí es "target is busy": algo tiene un fichero abierto.
        failed+="/dev/$part: ${err##*: }"$'\n'
    fi
done < <(lsblk -lno NAME "/dev/$disk" 2>/dev/null | tail -n +2)

if [[ -n "$failed" ]]; then
    busy=$(lsof +D /run/media 2>/dev/null | awk 'NR>1{print $1}' | sort -u | paste -sd', ')
    notificar usb.expulsar-fallo -u critical -t 15000 "No se pudo expulsar" \
        "${failed}${busy:+\nEn uso por: $busy}\nCierra lo que esté usando el disco y reintenta."
    exit 1
fi

# --- Apagar el disco ----------------------------------------------------------
# Si power-off falla (hubs que no lo soportan) NO es un error grave: ya está todo
# desmontado y volcado, que es lo que protege los datos. Lo decimos sin alarmar.
if err=$(udisksctl power-off -b "/dev/$disk" --no-user-interaction 2>&1); then
    notificar usb.expulsado -u normal -t 8000 "Expulsado" "$label — ya puedes retirarlo con seguridad."
else
    notificar usb.desmontado -u normal -t 10000 "Desmontado" \
        "$label — datos volcados, es seguro retirarlo. (No se pudo cortar la alimentación: ${err##*: })"
fi
