#!/usr/bin/env bash
# gigishell-hibernacion-setup — deja la máquina CAPAZ de hibernar. Se ejecuta como root desde
# install.sh o desde Ajustes > Pantalla > Suspensión. No se instala en /usr/local/bin: prepara
# el sistema y también instala el helper de runtime.
#
# Hibernar no es "otro modo de suspender": es volcar la RAM entera a un dispositivo de swap
# PERSISTENTE y apagar. En esta máquina, tal cual venía, era IMPOSIBLE, y de la peor manera: sin
# ningún error a la vista.
#
#   swapon --show  → solo /dev/zram0   ← zram vive EN LA RAM. Volcar la RAM a la RAM no es nada.
#   /proc/cmdline  → sin resume=       ← sin eso el kernel arranca en frío y la imagen se pierde.
#
# `systemctl hibernate` habría respondido "Sleep verb 'hibernate' is not supported" y el timer de
# Ajustes habría sido un interruptor decorativo. Por eso el paso existe y por eso `estado` del
# helper pregunta a logind en vez de fiarse de que esto se haya corrido.
#
# Lo que hace, todo idempotente:
#   1. swapfile persistente (subvolumen propio en btrfs) + entrada en /etc/fstab
#   2. resume= / resume_offset= en la línea de comandos del kernel (GRUB) + grub.cfg
#   3. opciones y servicios de NVIDIA para conservar la VRAM
#   4. initramfs regenerado si cambian las opciones de NVIDIA
#
# Variables: GIGISHELL_SWAP_GIB fuerza el tamaño en GiB (por defecto RAM + 2).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "gigishell-hibernacion-setup: hay que ejecutarlo como root" >&2; exit 1; }

SWAP_SUBVOL=/swap
SWAPFILE="$SWAP_SUBVOL/swapfile"
GRUB_DEFAULT_FILE=/etc/default/grub

info() { printf '\033[1;36m  ::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  xx\033[0m %s\n' "$*" >&2; exit 1; }

# Este script también se puede ejecutar desde Ajustes sin pasar por install.sh. Instala el
# helper y su regla sudoers aquí para que ambas vías de preparación dejen el mismo estado.
DIRECTORIO_SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
USUARIO_GIGISHELL="${SUDO_USER:-}"
[[ -n "$USUARIO_GIGISHELL" && "$USUARIO_GIGISHELL" != root ]] \
  || die "Ejecuta este script con sudo desde la cuenta del usuario que usa GiGiShell."
PLANTILLA_SUDOERS="$DIRECTORIO_SCRIPT/sudoers-gigishell-hibernacion"
HELPER_RUNTIME="$DIRECTORIO_SCRIPT/gigishell-hibernacion.sh"
[[ -r "$PLANTILLA_SUDOERS" && -r "$HELPER_RUNTIME" ]] \
  || die "Faltan los archivos del helper de hibernación en $DIRECTORIO_SCRIPT."
SUDOERS_TEMPORAL="$(mktemp)"
trap 'rm -f "$SUDOERS_TEMPORAL"' EXIT
sed "s/__GIGISHELL_USER__/$USUARIO_GIGISHELL/" "$PLANTILLA_SUDOERS" > "$SUDOERS_TEMPORAL"
chmod 0440 "$SUDOERS_TEMPORAL"
visudo -cf "$SUDOERS_TEMPORAL" >/dev/null \
  || die "La regla sudoers de hibernación no es válida; no se instala."
install -Dm755 "$HELPER_RUNTIME" /usr/local/bin/gigishell-hibernacion
install -o root -g root -m 0440 "$SUDOERS_TEMPORAL" /etc/sudoers.d/gigishell-hibernacion

# ── 1. Swap persistente ─────────────────────────────────────────────────────────────────────
#
# El tamaño es RAM + 2 GiB. La imagen de hibernación son las páginas EN USO, no la RAM entera, pero
# aquí hay zram: sus páginas comprimidas también están en RAM y también viajan en la imagen, así que
# el margen no es supersticioso. Quedarse corto no da un error al configurarlo — da un
# `systemctl hibernate` que falla el día que la RAM está llena, que es justo el día que importa.
ram_kib=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
swap_gib=${GIGISHELL_SWAP_GIB:-$(( (ram_kib + 1048575) / 1048576 + 2 ))}

fs_raiz=$(findmnt -no FSTYPE /)
uuid_raiz=$(findmnt -no UUID /)
[[ -n "$uuid_raiz" ]] || die "No pude averiguar el UUID de la partición raíz."

crear_swapfile_btrfs() {
  # Subvolumen PROPIO, y no un fichero suelto dentro de @, por dos razones que muerden:
  #   • un snapshot de @ (snapper está configurado en esta máquina) capturaría el swapfile entero,
  #     y btrfs se niega a activar un swapfile con más de una referencia: `swapon` empezaría a
  #     fallar el día que se tome el primer snapshot, no hoy;
  #   • los snapshots son de subvolumen y NO son recursivos, así que un subvolumen anidado dentro
  #     de @ queda fuera por construcción. No hace falta montar el nivel superior.
  if ! btrfs subvolume show "$SWAP_SUBVOL" >/dev/null 2>&1; then
    info "Creando el subvolumen $SWAP_SUBVOL ..."
    btrfs subvolume create "$SWAP_SUBVOL" >/dev/null
  fi
  chmod 700 "$SWAP_SUBVOL"
  if [[ ! -f $SWAPFILE ]]; then
    info "Creando el swapfile de ${swap_gib} GiB (puede tardar) ..."
    # `btrfs filesystem mkswapfile` y no fallocate+mkswap: un swapfile en btrfs tiene que ser
    # NOCOW, sin compresión y con las extensiones ya reservadas. Este comando hace las tres cosas;
    # a mano se olvida una y `swapon` responde "swapon failed: Invalid argument" sin decir cuál.
    btrfs filesystem mkswapfile --size "${swap_gib}g" --uuid clear "$SWAPFILE"
  else
    info "El swapfile ya existe; no lo toco."
  fi
}

crear_swapfile_generico() {
  if [[ ! -f $SWAPFILE ]]; then
    mkdir -p "$SWAP_SUBVOL"; chmod 700 "$SWAP_SUBVOL"
    info "Creando el swapfile de ${swap_gib} GiB (puede tardar) ..."
    dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((swap_gib * 1024)) status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  else
    info "El swapfile ya existe; no lo toco."
  fi
}

case "$fs_raiz" in
  btrfs) crear_swapfile_btrfs ;;
  ext4|xfs) crear_swapfile_generico ;;
  *) die "Raíz en '$fs_raiz': no sé crear ahí un swapfile de hibernación. Créalo a mano y vuelve a lanzar el paso." ;;
esac

# El desplazamiento del PRIMER bloque del swapfile dentro de la partición. El kernel resume leyendo
# a pelo del dispositivo, sin sistema de ficheros montado: `resume=` le dice qué partición y
# `resume_offset=` en qué página empieza la imagen. Sin el offset, un swapfile no sirve para
# resumir — y otra vez sin error: arranca en frío y la sesión anterior se pierde.
if [[ $fs_raiz == btrfs ]]; then
  offset=$(btrfs inspect-internal map-swapfile -r "$SWAPFILE")
else
  # filefrag da bloques del sistema de ficheros; resume_offset se cuenta en páginas del kernel.
  bloque=$(stat -f -c %S "$SWAPFILE")
  pagina=$(getconf PAGESIZE)
  primero=$(filefrag -v "$SWAPFILE" | awk 'NR==4{gsub(/\.\./,"",$4); print $4}')
  offset=$(( primero * bloque / pagina ))
fi
[[ $offset =~ ^[0-9]+$ ]] || die "No pude calcular resume_offset del swapfile."
info "resume=UUID=$uuid_raiz  resume_offset=$offset"

# fstab: `pri=-2` para que quede POR DEBAJO de zram (prioridad 100). El orden no afecta a la
# hibernación —quien manda ahí es resume=— pero sí al uso diario: se quiere seguir comprimiendo en
# RAM antes de tocar el disco. El swapfile está para poder hibernar, no para paginar.
if ! grep -qE "^[^#]*[[:space:]]$SWAPFILE[[:space:]]|^$SWAPFILE[[:space:]]" /etc/fstab; then
  info "Añadiendo el swapfile a /etc/fstab ..."
  cp -a /etc/fstab "/etc/fstab.gigishell.bak.$(date +%Y%m%d-%H%M%S)"
  printf '\n# GiGiShell: swap persistente para hibernar (ver system/hibernacion/)\n%s none swap defaults,pri=-2 0 0\n' "$SWAPFILE" >> /etc/fstab
  systemctl daemon-reload || true
fi
swapon --show=NAME --noheadings | grep -qx "$SWAPFILE" || swapon "$SWAPFILE" || warn "No pude activar el swapfile ahora; se activará al reiniciar."

# ── 2. Línea de comandos del kernel ─────────────────────────────────────────────────────────
if [[ -f $GRUB_DEFAULT_FILE ]] && command -v grub-mkconfig >/dev/null 2>&1; then
  grub_changed=0
  actual=$(sed -n 's/^GRUB_CMDLINE_LINUX_DEFAULT=["'"'"']\(.*\)["'"'"']$/\1/p' "$GRUB_DEFAULT_FILE" | tail -1)

  # Patología encontrada en esta máquina: el valor se había ANIDADO dentro de sí mismo —
  #   GRUB_CMDLINE_LINUX_DEFAULT="GRUB_CMDLINE_LINUX_DEFAULT='nowatchdog … loglevel=3' nvidia_drm.modeset=1"
  # y el kernel recibía ese trozo como UN parámetro entrecomillado, así que nowatchdog, splash y
  # loglevel no se aplicaban desde vete a saber cuándo. Hay que deshacerlo antes de añadir nada: si
  # se añade resume= a un valor así, el parámetro cae dentro de las comillas y el kernel lo ignora
  # — el equipo hibernaría y arrancaría en frío, perdiendo la sesión, sin un solo mensaje.
  if [[ $actual == *"GRUB_CMDLINE_LINUX_DEFAULT="* ]]; then
    warn "GRUB_CMDLINE_LINUX_DEFAULT estaba anidado dentro de sí mismo; lo desanido."
    warn "  antes: $actual"
    actual=${actual//GRUB_CMDLINE_LINUX_DEFAULT=/}
    actual=${actual//\'/}
    warn "  ahora: $actual (nowatchdog/splash/loglevel vuelven a aplicarse de verdad)"
  fi

  # Se quitan los resume* previos y se vuelven a poner: así reejecutar el paso tras agrandar el
  # swapfile no deja dos offsets contradictorios (ganaría el último, en silencio).
  limpio=$(printf '%s' "$actual" | sed -E 's/(^| )resume(_offset)?=[^ ]*//g; s/  +/ /g; s/^ //; s/ $//')
  nuevo="$limpio resume=UUID=$uuid_raiz resume_offset=$offset"
  if [[ "$actual" != "$nuevo" ]]; then
    cp -a "$GRUB_DEFAULT_FILE" "$GRUB_DEFAULT_FILE.gigishell.bak.$(date +%Y%m%d-%H%M%S)"
    info "Actualizando GRUB_CMDLINE_LINUX_DEFAULT ..."
    # El delimitador es | porque el valor lleva / (UUID no, pero sí otros parámetros).
    sed -i "s|^GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT=\"$nuevo\"|" "$GRUB_DEFAULT_FILE"
    grub_changed=1
  else
    info "La línea de comandos del kernel ya estaba bien."
  fi
  if (( grub_changed )) || ! grep -Fq "resume=UUID=$uuid_raiz" /boot/grub/grub.cfg 2>/dev/null \
     || ! grep -Fq "resume_offset=$offset" /boot/grub/grub.cfg 2>/dev/null; then
    info "Regenerando grub.cfg ..."
    grub-mkconfig -o /boot/grub/grub.cfg >/dev/null 2>&1 || warn "grub-mkconfig falló; regenera grub.cfg a mano antes de reiniciar."
  else
    info "grub.cfg ya está actualizado; no lo regenero."
  fi
else
  warn "No veo GRUB (/etc/default/grub + grub-mkconfig). Añade a mano a la línea del kernel:"
  warn "    resume=UUID=$uuid_raiz resume_offset=$offset"
fi

# ── 3. NVIDIA ───────────────────────────────────────────────────────────────────────────────
if [[ -e /proc/driver/nvidia/version ]]; then
  origen="$(dirname "$0")/../modprobe.d/gigishell-nvidia-hibernacion.conf"
  nvidia_modprobe_changed=0
  if [[ -r $origen ]]; then
    destino=/etc/modprobe.d/gigishell-nvidia-hibernacion.conf
    if ! cmp -s "$origen" "$destino"; then
      install -Dm644 "$origen" "$destino"
      nvidia_modprobe_changed=1
    else
      info "Las opciones de hibernación de NVIDIA ya están actualizadas."
    fi
  else
    warn "No encuentro gigishell-nvidia-hibernacion.conf; la VRAM no se conservará al hibernar."
  fi
  # Los tres servicios son un juego: sin nvidia-hibernate no se vuelca la VRAM y sin nvidia-resume
  # no se recupera. Vienen con el paquete del driver, DESACTIVADOS de fábrica.
  for unidad in nvidia-suspend.service nvidia-hibernate.service nvidia-resume.service nvidia-suspend-then-hibernate.service; do
    systemctl list-unit-files "$unidad" >/dev/null 2>&1 \
      && systemctl enable "$unidad" >/dev/null 2>&1 \
      || warn "No pude activar $unidad."
  done
  info "NVIDIA: VRAM conservada en /var/tmp y servicios de suspensión/hibernación activados."
fi

# ── 4. initramfs ────────────────────────────────────────────────────────────────────────────
# El hook `resume` de mkinitcpio NO hace falta aquí: HOOKS lleva `systemd`, y en un initramfs
# systemd quien resume es systemd-hibernate-resume-generator leyendo resume= de la cmdline.
# Añadir el hook busybox encima no da error, solo ruido. Lo que SÍ hay que regenerar es el
# initramfs, para que las opciones nuevas de /etc/modprobe.d viajen dentro (hook `modconf`).
initramfs_desactualizado="${nvidia_modprobe_changed:-0}"
if [[ -f ${destino:-/etc/modprobe.d/gigishell-nvidia-hibernacion.conf} ]]; then
  imagen_encontrada=0
  for imagen in /boot/initramfs*.img; do
    [[ -f "$imagen" ]] || continue
    imagen_encontrada=1
    [[ ${destino:-/etc/modprobe.d/gigishell-nvidia-hibernacion.conf} -nt "$imagen" ]] && initramfs_desactualizado=1
  done
  (( imagen_encontrada )) || initramfs_desactualizado=1
fi
if (( initramfs_desactualizado )) && command -v mkinitcpio >/dev/null 2>&1; then
  info "Regenerando el initramfs ..."
  mkinitcpio -P >/dev/null 2>&1 || warn "mkinitcpio falló; ejecútalo a mano (sudo mkinitcpio -P)."
elif command -v mkinitcpio >/dev/null 2>&1; then
  info "No han cambiado opciones de módulos; no regenero el initramfs."
fi

info "Listo. La hibernación NO está disponible hasta REINICIAR: resume= entra por la línea de"
info "comandos del kernel, y la de la sesión actual ya está fijada. Compruébalo luego con:"
info "    gigishell-hibernacion estado    →  disponible=si"
