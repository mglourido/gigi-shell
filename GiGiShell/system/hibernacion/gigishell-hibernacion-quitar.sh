#!/usr/bin/env bash
# gigishell-hibernacion-quitar — deshace `gigishell-hibernacion-setup.sh`: apaga el swap
# persistente y devuelve el arranque a como estaba. Se lanza a mano, en una terminal, con
# `sudo` (así pide la contraseña ahí mismo; NO hay regla sudoers para esto, a propósito —
# borrar un swapfile de varios GiB y reescribir la línea de comandos del kernel no es algo
# que un botón de la UI deba poder hacer sin que alguien teclee la contraseña delante).
#
# Efecto en el tiempo, y por qué NO es simétrico con la preparación:
#   • `swapoff` deja la hibernación INUTILIZABLE en el acto: `CanHibernate` de logind mira
#     el swap ACTIVO ahora mismo (no lo que diga fstab), así que Ajustes lo nota sin
#     esperar a reiniciar. Al revés, preparar la hibernación SÍ necesita reiniciar (resume=
#     solo lo procesa el kernel al arrancar) — no es descuido, son mecanismos distintos.
#   • lo que SÍ espera al próximo arranque es la limpieza cosmética: `resume=` sale de la
#     línea de comandos del kernel para el PRÓXIMO arranque (GRUB ya regenerado), y el
#     módulo nvidia sigue cargado con las opciones viejas hasta que se recargue.
#
# Qué se deja EN PIE a propósito: el helper `/usr/local/bin/gigishell-hibernacion` y su regla
# sudoers. El ajuste de retardo sí se elimina para que una configuración anterior no afecte a
# futuras llamadas a `suspend-then-hibernate`. Conservar el helper permite volver a preparar el
# sistema sin reinstalarlo. Este script deshace el DISCO, el ARRANQUE y el retardo runtime.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "gigishell-hibernacion-quitar: hay que ejecutarlo como root (sudo)" >&2; exit 1; }

SWAP_SUBVOL=/swap
SWAPFILE="$SWAP_SUBVOL/swapfile"
GRUB_DEFAULT_FILE=/etc/default/grub
DROPIN=/etc/systemd/sleep.conf.d/99-gigishell-hibernacion.conf

info() { printf '\033[1;36m  ::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }

# ── 1. Apagar el swap YA ────────────────────────────────────────────────────────────────
# Primero, y sin condiciones: es el único paso cuyo efecto se nota en el acto (Ajustes deja
# de anunciar hibernación disponible), así que si algo de lo que sigue falla, esta parte —la
# que de verdad importa— ya ha quedado hecha.
if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then
  info "Desactivando el swap ($SWAPFILE) ..."
  swapoff "$SWAPFILE" || warn "No pude desactivar el swap ahora mismo; seguirá activo hasta reiniciar."
fi

# Evita que el retardo de GiGiShell siga habilitando una hibernación automática posterior.
if [[ -f $DROPIN ]]; then
  info "Quitando el retardo de hibernación de GiGiShell ..."
  rm -f "$DROPIN"
fi

# ── 2. fstab ─────────────────────────────────────────────────────────────────────────────
if grep -qF "$SWAPFILE" /etc/fstab 2>/dev/null; then
  info "Quitando la entrada de /etc/fstab ..."
  cp -a /etc/fstab "/etc/fstab.gigishell.bak.$(date +%Y%m%d-%H%M%S)"
  # Se quita también el comentario que puso el setup, si es la línea justo anterior: sin
  # esto cada ciclo preparar/quitar dejaría un comentario huérfano más en el fichero.
  sed -i -e '/^# GiGiShell: swap persistente para hibernar/{N;/'"${SWAPFILE//\//\\/}"'/d}' \
         -e "\|^${SWAPFILE//\//\\/}[[:space:]]|d" /etc/fstab
  systemctl daemon-reload || true
fi

# ── 3. Borrar el swapfile y, si es un subvolumen propio y vacío salvo por él, el subvolumen
fs_raiz=$(findmnt -no FSTYPE / 2>/dev/null)
if [[ $fs_raiz == btrfs ]] && btrfs subvolume show "$SWAP_SUBVOL" >/dev/null 2>&1; then
  # Comprobación de seguridad: si alguien ha metido algo más ahí dentro, no nos lo llevamos
  # por delante sin avisar. El setup solo pone `swapfile`, así que esto solo debería
  # dispararse si el subvolumen se ha usado para otra cosa después.
  resto=$(find "$SWAP_SUBVOL" -mindepth 1 -not -name swapfile -print -quit 2>/dev/null)
  if [[ -n "$resto" ]]; then
    warn "$SWAP_SUBVOL contiene algo más aparte del swapfile ($resto); borro solo el swapfile."
    rm -f "$SWAPFILE"
  else
    info "Borrando el subvolumen $SWAP_SUBVOL (~$(du -sh --apparent-size "$SWAPFILE" 2>/dev/null | cut -f1)) ..."
    btrfs subvolume delete "$SWAP_SUBVOL" >/dev/null 2>&1 \
      || warn "No pude borrar el subvolumen $SWAP_SUBVOL; bórralo a mano (sudo btrfs subvolume delete $SWAP_SUBVOL)."
  fi
elif [[ -f $SWAPFILE ]]; then
  info "Borrando el swapfile ..."
  rm -f "$SWAPFILE"
  rmdir "$SWAP_SUBVOL" 2>/dev/null || true   # solo si queda vacío; rmdir no falla el script
else
  info "No había swapfile que borrar."
fi

# ── 4. Línea de comandos del kernel ─────────────────────────────────────────────────────
if [[ -f $GRUB_DEFAULT_FILE ]] && command -v grub-mkconfig >/dev/null 2>&1; then
  actual=$(sed -n 's/^GRUB_CMDLINE_LINUX_DEFAULT=["'"'"']\(.*\)["'"'"']$/\1/p' "$GRUB_DEFAULT_FILE" | tail -1)
  if [[ "$actual" == *resume* ]]; then
    cp -a "$GRUB_DEFAULT_FILE" "$GRUB_DEFAULT_FILE.gigishell.bak.$(date +%Y%m%d-%H%M%S)"
    limpio=$(printf '%s' "$actual" | sed -E 's/(^| )resume(_offset)?=[^ ]*//g; s/  +/ /g; s/^ //; s/ $//')
    info "Quitando resume=/resume_offset= de GRUB_CMDLINE_LINUX_DEFAULT ..."
    sed -i "s|^GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT=\"$limpio\"|" "$GRUB_DEFAULT_FILE"
    info "Regenerando grub.cfg ..."
    grub-mkconfig -o /boot/grub/grub.cfg >/dev/null 2>&1 || warn "grub-mkconfig falló; regenera grub.cfg a mano."
  else
    info "La línea de comandos del kernel ya no tenía resume=."
  fi
fi

# ── 5. NVIDIA ────────────────────────────────────────────────────────────────────────────
# Se desactivan SOLO los dos servicios que son puramente de hibernación. nvidia-suspend y
# nvidia-resume se dejan encendidos: conservan la VRAM en CUALQUIER suspensión (S3), no
# solo en la hibernación, así que apagarlos aquí quitaría algo que nada tiene que ver con
# lo que se está desinstalando.
for unidad in nvidia-hibernate.service nvidia-suspend-then-hibernate.service; do
  systemctl is-enabled --quiet "$unidad" 2>/dev/null \
    && { systemctl disable "$unidad" >/dev/null 2>&1 || warn "No pude desactivar $unidad."; }
done
if [[ -f /etc/modprobe.d/gigishell-nvidia-hibernacion.conf ]]; then
  info "Quitando las opciones de conservación de VRAM para hibernación ..."
  rm -f /etc/modprobe.d/gigishell-nvidia-hibernacion.conf
fi

# ── 6. initramfs ─────────────────────────────────────────────────────────────────────────
if command -v mkinitcpio >/dev/null 2>&1; then
  info "Regenerando el initramfs ..."
  mkinitcpio -P >/dev/null 2>&1 || warn "mkinitcpio falló; ejecútalo a mano (sudo mkinitcpio -P)."
fi

info "Listo. La hibernación ya NO FUNCIONA (el swap se desactivó al principio de este"
info "script). El arranque dejará de esperar el resume desde el PRÓXIMO reinicio."
info "Para volver a habilitarla: sudo bash ~/GiGiShell/system/hibernacion/gigishell-hibernacion-setup.sh"
