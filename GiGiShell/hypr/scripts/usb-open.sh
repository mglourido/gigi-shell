#!/usr/bin/env bash
# Abrir un disco USB en el gestor de archivos — invocado desde el botón "Abrir" de
# la notificación de usb-monitor.sh, o a mano: usb-open.sh sdb
#
# El aviso salta AL ENCHUFAR, así que el caso normal es que el volumen todavía no
# esté montado: este script monta primero y abre después. El montaje va por
# `udisksctl mount` y NO por `mount`/`sudo`/`pkexec`, por el mismo motivo que
# documenta usb-repair.sh: este script vive en ~/.config, escribible por el
# usuario, y escalar privilegios desde aquí sería la escalada silenciosa contra la
# que avisa CLAUDE.md. Con udisks el trabajo privilegiado lo hace udisksd (servicio
# del sistema, ya auditado) y polkit lo autoriza sin prompt en dispositivos que no
# son del sistema (filesystem-mount → allow_active=yes); de propina el punto de
# montaje queda bajo /run/media/$USER y pertenece al usuario, que es lo que luego
# permite a usb-eject.sh desmontarlo sin privilegios.
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
    notificar usb.abrir-sin-dispositivo -u critical "Abrir: dispositivo no encontrado" "/dev/$disk ya no existe."
    exit 1
fi

# Punto de montaje REAL de un dispositivo, leído de /proc/mounts y no del
# MOUNTPOINT de lsblk — misma cautela que usb-eject.sh: lsblk puede traerlo vacío
# en montajes hechos desde otro namespace. /proc/mounts escapa los caracteres
# problemáticos en octal (\040 = espacio, muy común en etiquetas de pendrive), así
# que hay que deshacerlo o la ruta que le pasemos a Dolphin no existirá.
punto_de_montaje() {
    awk -v dev="$1" '$1 == dev { print $2; exit }' /proc/mounts |
        sed -e 's/\\040/ /g' -e 's/\\011/\t/g' -e 's/\\012/\n/g' -e 's/\\134/\\/g'
}

# ── Elegir QUÉ partición abrir ────────────────────────────────────────────────
# Criterio, en este orden:
#   1. Si alguna partición ya está montada, esa (el usuario espera ir a donde ya
#      está su contenido, y montar una segunda no le aporta nada).
#   2. Si no, la partición MONTABLE (con sistema de ficheros reconocido, y que no
#      sea swap ni un contenedor cifrado/LVM sin abrir) de MAYOR TAMAÑO. En un
#      pendrive de una sola partición es trivialmente la correcta; en discos con
#      varias, la grande es la de datos — las pequeñas suelen ser ESP/recuperación.
# Se usa la salida -P (pares clave=valor) porque con columnas sueltas un FSTYPE
# vacío desplaza los campos y se elige cualquier cosa. Se incluye el propio disco
# porque un pendrive puede venir sin tabla de particiones (fs directamente sobre
# /dev/sdb, el llamado "superfloppy").
elegir_particion() {
    local name size fstype type mejor="" mejor_size=-1
    while read -r linea; do
        name=""; size=0; fstype=""; type=""
        eval "$linea"                       # NAME="sdb1" SIZE="123" FSTYPE="vfat" TYPE="part"
        [[ -z "$name" ]] && continue
        [[ "$type" == "disk" || "$type" == "part" ]] || continue
        case "$fstype" in
            ""|swap|crypto_LUKS|LVM2_member|linux_raid_member|isw_raid_member) continue ;;
        esac
        # Ya montada → decisión tomada, no seguimos mirando.
        [[ -n "$(punto_de_montaje "/dev/$name")" ]] && { printf '%s' "$name"; return 0; }
        if (( size > mejor_size )); then mejor=$name; mejor_size=$size; fi
    done < <(lsblk -Pbno NAME,SIZE,FSTYPE,TYPE "/dev/$disk" 2>/dev/null |
                 sed -e 's/NAME=/name=/' -e 's/SIZE=/size=/' -e 's/FSTYPE=/fstype=/' -e 's/TYPE=/type=/')
    [[ -n "$mejor" ]] || return 1
    printf '%s' "$mejor"
}

part=$(elegir_particion)
if [[ -z "$part" ]]; then
    notificar usb.abrir-sin-volumen -u critical -t 12000 "No hay nada que abrir" \
        "/dev/$disk no expone ningún volumen con sistema de ficheros reconocido."
    exit 1
fi

# ── Montar si hace falta ──────────────────────────────────────────────────────
ruta=$(punto_de_montaje "/dev/$part")
if [[ -z "$ruta" ]]; then
    if ! command -v udisksctl >/dev/null 2>&1; then
        notificar usb.abrir-falta-udisks -u critical "Abrir: falta udisks2" "Instala udisks2 para poder montar el USB."
        exit 1
    fi
    if ! out=$(udisksctl mount -b "/dev/$part" --no-user-interaction 2>&1); then
        # Casos vistos: fs no soportado (falta el driver), volumen sucio que udisks
        # se niega a montar, o polkit denegando en un dispositivo del sistema.
        notificar usb.abrir-fallo-montaje -u critical -t 15000 "No se pudo abrir el USB" \
            "No se pudo montar /dev/$part: ${out##*: }"
        exit 1
    fi
    # La ruta se relee de /proc/mounts en vez de parsearse del "Mounted … at …":
    # ese texto ha cambiado de forma entre versiones de udisks (con y sin punto
    # final) y aquí un carácter de más deja una ruta que no existe.
    ruta=$(punto_de_montaje "/dev/$part")
    [[ -z "$ruta" ]] && ruta=$(sed -e 's/\.$//' -e 's/^.* at //' <<<"$out")
fi

if [[ -z "$ruta" || ! -d "$ruta" ]]; then
    notificar usb.abrir-fallo-montaje -u critical -t 15000 "No se pudo abrir el USB" \
        "/dev/$part quedó montado en una ruta que no se pudo determinar."
    exit 1
fi

# ── Abrir el gestor de archivos ───────────────────────────────────────────────
# Dolphin es el gestor de esta máquina; xdg-open es el plan B si no está (respeta
# lo que diga mimeapps.list). Se lanza DESACOPLADO: este script se ejecuta desde un
# subshell de usb-monitor.sh, y sin setsid + redirecciones el gestor de archivos
# quedaría colgando del monitor durante toda la sesión.
if command -v dolphin >/dev/null 2>&1; then
    setsid dolphin "$ruta" >/dev/null 2>&1 </dev/null &
elif command -v xdg-open >/dev/null 2>&1; then
    setsid xdg-open "$ruta" >/dev/null 2>&1 </dev/null &
else
    notificar usb.abrir-sin-gestor -u critical -t 12000 "No hay gestor de archivos" \
        "Ni «dolphin» ni «xdg-open» están disponibles. El USB está montado en $ruta."
    exit 1
fi
disown 2>/dev/null
exit 0
