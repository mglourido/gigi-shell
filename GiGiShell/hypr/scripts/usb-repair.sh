#!/usr/bin/env bash
# Reparación de un volumen extraíble sucio — invocado desde el botón "Reparar" de
# la notificación de usb-monitor.sh, o a mano: usb-repair.sh /dev/sdb1
#
# NO llamamos a fsck/ntfsfix nosotros. Van a un dispositivo root:disk 660, así que
# harían falta privilegios, y escalarlos desde aquí sería un agujero: este script
# vive en ~/.config (escribible por el usuario), y hacerlo vía pkexec para una
# ruta escribible por el usuario es exactamente la escalada silenciosa contra la
# que avisa CLAUDE.md. En su lugar usamos org.freedesktop.UDisks2.Filesystem.Repair: el
# trabajo privilegiado lo hace udisksd (servicio del sistema, ya auditado) y
# polkit lo autoriza — modify-device es allow_active=yes para dispositivos que no
# son del sistema, así que en un USB no hay prompt; en un disco interno sí lo
# habría (modify-device-system: auth_admin_keep), que es justo lo que queremos.
#
# Repair delega en la herramienta de cada fs (e2fsck, fsck.fat, fsck.exfat,
# ntfsfix…). Si falta la del fs en cuestión, udisks devuelve error y lo decimos:
# en esta máquina NTFS necesita el paquete `ntfs-3g`, que no está instalado.
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

dev=${1:-}
[[ -z "$dev" ]] && { echo "uso: $0 /dev/sdXN" >&2; exit 2; }
part=$(basename "$dev")
dev="/dev/$part"

[[ -b "$dev" ]] || { notificar usb.reparar-sin-dispositivo -u critical "Reparar: no existe $dev" "El volumen ya no está conectado."; exit 1; }

obj="/org/freedesktop/UDisks2/block_devices/$part"
fstype=$(lsblk -dno FSTYPE "$dev" 2>/dev/null)
label=$(lsblk -dno LABEL "$dev" 2>/dev/null); : "${label:=$part}"

# Si lo desmontamos NOSOTROS, hay que dejarlo como estaba pase lo que pase. Antes
# no se remontaba en ningún camino de error: una reparación que fallaba (o que se
# quedaba a medias) dejaba al usuario con el pendrive enchufado y SIN MONTAR, que
# es exactamente el síntoma —«Dolphin no me lo abre»— que esto viene a evitar. Y
# como el aviso que sale es el del fallo de la reparación, nada apuntaba a que
# además se había quedado desmontado.
#
# Solo se remonta si el desmontaje fue nuestro: en el camino automático (lo llama
# check_volume con el volumen aún sin montar) no se monta nada que el usuario no
# hubiera montado ya, que sería cambiarle el estado del escritorio sin pedirlo.
desmontado=0
remontar() {
    (( desmontado )) || return 0
    udisksctl mount -b "$dev" --no-user-interaction >/dev/null 2>&1
    desmontado=0
}

# Reparar exige el volumen desmontado. Lo desmontamos si hace falta (sin -f: si
# hay ficheros abiertos preferimos fallar y que el usuario cierre, no arriesgar).
if grep -q "^$dev " /proc/mounts; then
    if ! err=$(udisksctl unmount -b "$dev" --no-user-interaction 2>&1); then
        notificar usb.reparar-en-uso -u critical -t 15000 "No se pudo reparar" \
            "Hay que desmontar «$label» y está en uso: ${err##*: }"
        exit 1
    fi
    desmontado=1
fi

notificar usb.reparando -u low -t 5000 "Reparando «$label»…" "Se retiró sin expulsar. Sistema de ficheros: ${fstype:-desconocido}"

# --timeout EXPLÍCITO: el de DBus por defecto son 25 s, y una reparación de verdad
# los pasa de largo — udisks lanza el fsck del sistema de ficheros, que recorre
# todo el volumen (medido: `fsck.exfat` sobre un pendrive de 239 GB va por encima
# del minuto y medio). Al vencer, busctl devolvía error y este script daba la
# reparación por FALLIDA y avisaba de ello, mientras udisksd seguía reparando
# tranquilamente por debajo: el aviso mentía, y encima el volumen se quedaba
# desmontado. El timeout largo es la parte que hace honesto ese mensaje.
if out=$(busctl --system --timeout=1800 call org.freedesktop.UDisks2 "$obj" \
            org.freedesktop.UDisks2.Filesystem Repair 'a{sv}' 0 2>&1); then
    # Devuelve "b true" si el fs quedó consistente.
    if [[ "$out" == *"true"* ]]; then
        # En NTFS no mentimos: `ntfsfix` (lo que udisks ejecuta) NO es un chkdsk. Su
        # propio man dice que repara inconsistencias fundamentales, resetea el journal
        # y PROGRAMA la comprobación de verdad para el primer arranque de Windows. El
        # volumen queda usable ya; conviene saber que Windows lo revisará.
        extra="Ya puedes usarlo."
        [[ "$fstype" == ntfs* ]] && extra="Ya puedes usarlo. Windows hará una comprobación completa la próxima vez que lo montes ahí."
        remontar
        notificar usb.reparado -u normal -t 10000 "Volumen reparado" "«$label» ($fstype). $extra"
    else
        remontar
        notificar usb.reparacion-incompleta -u critical -t 15000 "Reparación incompleta" \
            "«$label» sigue con errores. Haz copia de lo que puedas leer y considera formatearlo."
    fi
    exit 0
fi

# --- Error de udisks: el caso común es que falte la herramienta del fs ---------
hint=""
case "$fstype" in
    # OJO: el paquete es «ntfsprogs», NO «ntfs-3g» — el segundo hoy solo trae el
    # driver FUSE; las utilidades (ntfsfix) se separaron a ntfsprogs.
    ntfs*) command -v ntfsfix >/dev/null 2>&1 || hint="\nInstala «ntfsprogs» para poder reparar NTFS." ;;
    vfat|fat*) command -v fsck.fat  >/dev/null 2>&1 || hint="\nInstala «dosfstools»." ;;
    exfat) command -v fsck.exfat >/dev/null 2>&1 || hint="\nInstala «exfatprogs»." ;;
esac
remontar
notificar usb.reparar-fallo -u critical -t 20000 "No se pudo reparar «$label»" "${out##*: }${hint}"
exit 1
