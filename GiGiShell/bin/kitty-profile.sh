#!/usr/bin/env bash
# Selecciona el perfil de rendimiento de Kitty para esta máquina.
# Los perfiles se versionan; active-profile.conf es un symlink local ignorado.
set -euo pipefail

KITTY_DIR="${KITTY_CONFIG_DIRECTORY:-${XDG_CONFIG_HOME:-$HOME/.config}/kitty}"
PROFILES_DIR="$KITTY_DIR/profiles"
SELECTOR="$KITTY_DIR/active-profile.conf"
CONFIG="$KITTY_DIR/kitty.conf"

usage() {
  cat <<'EOF'
uso: kitty-profile.sh [auto|laptop|desktop|status]

  auto     usa laptop si existe una batería real; desktop en caso contrario
  laptop   conserva el perfil de bajo consumo
  desktop  activa el perfil de baja latencia para sobremesa
  status   muestra el perfil activo
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

profile_from_selector() {
  local target laptop_path desktop_path
  [[ -L "$SELECTOR" ]] || return 1
  target="$(readlink -f "$SELECTOR")" || return 1
  laptop_path="$(readlink -f "$PROFILES_DIR/laptop.conf")" || return 1
  desktop_path="$(readlink -f "$PROFILES_DIR/desktop.conf")" || return 1
  if [[ "$target" == "$laptop_path" ]]; then
    printf 'laptop\n'
  elif [[ "$target" == "$desktop_path" ]]; then
    printf 'desktop\n'
  else
    return 1
  fi
}

has_battery() {
  local supply type_file type scope
  for type_file in /sys/class/power_supply/*/type; do
    [[ -r "$type_file" ]] || continue
    IFS= read -r type < "$type_file" || continue
    [[ "$type" == Battery ]] || continue
    supply="${type_file%/type}"
    # Ratones, mandos y otros periféricos también aparecen como Battery, pero
    # su scope es Device. Solo una batería del sistema define un portátil.
    if [[ -r "$supply/scope" ]]; then
      IFS= read -r scope < "$supply/scope" || continue
      [[ "$scope" == Device ]] && continue
    fi
    if [[ -r "$supply/present" ]] && [[ "$(<"$supply/present")" != 1 ]]; then
      continue
    fi
    return 0
  done
  return 1
}

validate_config() {
  command -v kitty >/dev/null 2>&1 || die "falta el comando kitty"
  KITTY_VALIDATE_CONFIG="$CONFIG" kitty +runpy '
import os
from kitty.config import load_config

bad_lines = []
load_config(os.environ["KITTY_VALIDATE_CONFIG"], accumulate_bad_lines=bad_lines)
if bad_lines:
    for bad_line in bad_lines:
        print(bad_line, file=__import__("sys").stderr)
    raise SystemExit(1)
' >/dev/null
}

action="${1:-auto}"
case "$action" in
  -h|--help)
    usage
    exit 0
    ;;
  status)
    if profile="$(profile_from_selector)"; then
      printf 'Perfil de Kitty activo: %s (%s)\n' "$profile" "$SELECTOR"
      exit 0
    fi
    die "no hay un perfil de Kitty válido activo en $SELECTOR"
    ;;
  auto)
    if has_battery; then
      profile=laptop
    else
      profile=desktop
    fi
    ;;
  laptop|desktop)
    profile="$action"
    ;;
  *)
    usage >&2
    die "perfil desconocido: $action"
    ;;
esac

[[ -f "$CONFIG" ]] || die "falta $CONFIG"
[[ -f "$PROFILES_DIR/$profile.conf" ]] || die "falta $PROFILES_DIR/$profile.conf"
if [[ -e "$SELECTOR" && ! -L "$SELECTOR" ]]; then
  die "$SELECTOR existe y no es un symlink; no lo sobrescribo"
fi

mkdir -p "$KITTY_DIR"
temporary="$KITTY_DIR/.active-profile.conf.$$"
trap 'rm -f "$temporary"' EXIT
ln -s "profiles/$profile.conf" "$temporary"
mv -Tf "$temporary" "$SELECTOR"
validate_config
trap - EXIT

printf 'Perfil de Kitty activo: %s\n' "$profile"
printf 'Recarga Kitty con Ctrl+Shift+F5 o abre una ventana nueva.\n'
