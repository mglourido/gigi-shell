# shellcheck shell=bash
# Marcas de «volumen USB sucio sin reparar», para que el menú USB de la barra de AGS ofrezca
# «Reparar» solo cuando hace falta (ags/servicios/usb/udisks.ts las lee).
#
# udisks no publica si un volumen está sucio: saberlo exige un fsck (Filesystem.Check), y el único
# que lo hace es usb-monitor.sh al enchufar. Así que el estado lo apunta quien lo averigua:
#   · usb-monitor.sh marca cuando Check dice que está sucio;
#   · usb-repair.sh desmarca si la reparación lo deja limpio y marca si queda incompleta.
#
# Un fichero vacío por volumen, con el UUID del sistema de ficheros como nombre y NO el nombre del
# dispositivo: sdb1 se reutiliza con el siguiente pendrive, el UUID no. Vive en XDG_RUNTIME_DIR
# (tmpfs): el monitor vuelve a comprobar al siguiente arranque, no hace falta que sobreviva.
#
# El UUID sale del propio pendrive, así que se valida antes de usarlo como nombre de fichero.
# Cualquier fallo es silencio: esto es una pista para el menú, nunca puede tumbar el script.

USB_SUCIOS_DIR="${XDG_RUNTIME_DIR:-/tmp}/gigishell-usb-sucios"

_usb_sucio_ruta() {   # $1 = /dev/sdXN → ruta de la marca, o falla
    local uuid
    uuid=$(lsblk -dno UUID "$1" 2>/dev/null) || return 1
    [[ "$uuid" =~ ^[A-Za-z0-9-]+$ ]] || return 1
    printf '%s/%s' "$USB_SUCIOS_DIR" "$uuid"
}

usb_marcar_sucio() {
    local f
    f=$(_usb_sucio_ruta "$1") || return 0
    mkdir -p -m 700 "$USB_SUCIOS_DIR" 2>/dev/null && : > "$f" 2>/dev/null
    return 0
}

usb_desmarcar_sucio() {
    local f
    f=$(_usb_sucio_ruta "$1") || return 0
    rm -f "$f" 2>/dev/null
    return 0
}
