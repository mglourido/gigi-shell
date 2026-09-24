#!/usr/bin/env bash
# GiGiShell — ficheros LOCALES de las shells (bash, zsh, fish).
#
# La configuración de las shells está partida en dos (ver docs/shell-local.md):
#
#   compartida, versionada          local de cada equipo, SIN versionar
#   ~/.config/bash/bashrc           ~/.bashrc
#   ~/.config/zsh/gigishell.zshenv     ~/.config/zsh/.zshenv
#   ~/.config/zsh/gigishell.zshrc      ~/.config/zsh/.zshrc
#   ~/.config/fish/conf.d/gigishell.fish  ~/.config/fish/config.fish
#
# El fichero local es el que la shell lee de verdad y el que tocan los
# instaladores (rustup, bun, fnm, opam...): empieza cargando el compartido y
# debajo acumula lo propio de la máquina. Así nada de eso llega al repo.
#
# Este script crea el fichero local cuando falta. Uno que ya existe y NO carga el
# compartido (el de /etc/skel de una instalación nueva, o el viejo versionado
# entero) no se toca salvo con --force, que lo respalda antes: añadirle la línea
# a ciegas duplicaría toda la configuración si ya la llevaba dentro.
#
# Uso:
#   bin/shell-local.sh            crea los que falten; avisa de los que no cargan el compartido
#   bin/shell-local.sh --check    solo informa (exit 0 si todo OK)
#   bin/shell-local.sh --force    respalda (a $LINK_BACKUP) y reemplaza los que no lo cargan
set -euo pipefail

LINK_BACKUP="${LINK_BACKUP:-$HOME/.dotfiles-backup-$(date +%Y%m%d-%H%M%S)}"

mode=link
case "${1:-}" in
  "")      mode=link ;;
  --check) mode=check ;;
  --force) mode=force ;;
  *) echo "uso: shell-local.sh [--check|--force]" >&2; exit 2 ;;
esac

status=0

# Cabecera común de los ficheros locales.
cabecera() {  # $1 = fichero compartido que carga
  cat <<EOF
# LOCAL de este equipo: NO se versiona (ver ~/GiGiShell/docs/shell-local.md).
#
# La configuración compartida está en $1 y se carga
# aquí primero. Debajo va solo lo propio de esta máquina: rutas de herramientas
# instaladas (cargo, bun, fnm, opam...) y lo que añadan sus instaladores, que
# escriben siempre en este fichero.
EOF
}

plantilla_bashrc() {
  printf '#\n# ~/.bashrc\n#\n'
  cabecera "~/.config/bash/bashrc"
  printf '[[ -r "$HOME/.config/bash/bashrc" ]] && . "$HOME/.config/bash/bashrc"\n'
}
plantilla_zshenv() {
  printf '#!/usr/bin/env zsh\n\n'
  cabecera '$ZDOTDIR/gigishell.zshenv'
  printf 'source "$ZDOTDIR/gigishell.zshenv"\n'
}
plantilla_zshrc() {
  # Tiene que ser lo PRIMERO: el compartido arranca con el prompt instantáneo de
  # Powerlevel10k, que deja de servir si algo se ejecuta antes.
  cabecera '$ZDOTDIR/gigishell.zshrc'
  printf 'source "$ZDOTDIR/gigishell.zshrc"\n'
}
plantilla_fish() {
  # Fish carga conf.d/*.fish por su cuenta antes que config.fish: no hace falta
  # ningún source, el fichero existe solo para que los instaladores lo encuentren.
  cat <<'EOF'
# LOCAL de este equipo: NO se versiona (ver ~/GiGiShell/docs/shell-local.md).
#
# La configuración compartida está en ~/.config/fish/conf.d/gigishell.fish, y Fish
# la carga sola antes que este fichero. Aquí va solo lo propio de esta máquina:
# rutas de herramientas instaladas y lo que añadan sus instaladores, que
# escriben siempre en este fichero.
EOF
}

# "fichero_local::patrón que demuestra que carga el compartido::plantilla"
LOCALES=(
  "$HOME/.bashrc::.config/bash/bashrc::plantilla_bashrc"
  "$HOME/.config/zsh/.zshenv::gigishell.zshenv::plantilla_zshenv"
  "$HOME/.config/zsh/.zshrc::gigishell.zshrc::plantilla_zshrc"
  "$HOME/.config/fish/config.fish::shell-local.md::plantilla_fish"
)

escribir() {  # $1 destino, $2 plantilla — atómico
  local tmp
  mkdir -p "$(dirname "$1")"
  tmp="$(mktemp "$1.XXXXXX")"
  "$2" > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$1"
}

carga_compartida() {  # $1 fichero local, $2 ruta compartida esperada
  local dst="$1" patron="$2"
  if [[ "$dst" == "$HOME/.config/fish/config.fish" ]]; then
    # Fish carga conf.d automáticamente; config.fish no debe hacer source.
    [[ -r "$HOME/.config/fish/conf.d/gigishell.fish" ]]
    return
  fi

  # Busca la ruta después de una orden `source` o `.` activa. Ignora comentarios
  # y no confunde una mención en texto con una carga real.
  awk -v patron="$patron" '
    /^[[:space:]]*#/ { next }
    index($0, patron) {
      prefijo = substr($0, 1, index($0, patron) - 1)
      sub(/^[[:space:]]*/, "", prefijo)
      if (prefijo ~ /^(source|\.)[[:space:]]/ ||
          prefijo ~ /(&&|\|\||;)[[:space:]]*(source|\.)[[:space:]]/) encontrado = 1
    }
    END { exit !encontrado }
  ' "$dst"
}

for entrada in "${LOCALES[@]}"; do
  dst="${entrada%%::*}"; resto="${entrada#*::}"
  patron="${resto%%::*}"; plantilla="${resto#*::}"

  if [[ -L "$dst" ]]; then
    echo "WARN  $dst es un symlink; debería ser un fichero local de este equipo"; status=1
  elif [[ ! -e "$dst" ]]; then
    if [[ "$mode" == check ]]; then
      echo "FALTA $dst"; status=1
    else
      escribir "$dst" "$plantilla"; echo "NEW   $dst"
    fi
  elif carga_compartida "$dst" "$patron"; then
    echo "OK    $dst"
  elif [[ "$mode" == force ]]; then
    rel="${dst#"$HOME"/}"
    mkdir -p "$LINK_BACKUP/$(dirname "$rel")"
    mv "$dst" "$LINK_BACKUP/$rel"
    echo "BACKUP $dst -> $LINK_BACKUP/$rel"
    escribir "$dst" "$plantilla"; echo "NEW   $dst"
  else
    echo "WARN  $dst no carga la configuración compartida ($patron)."
    echo "      Pasa lo propio del equipo a mano o usa --force (lo respalda y lo reemplaza)."
    status=1
  fi
done

exit $status
