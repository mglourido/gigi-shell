#!/usr/bin/env bash
# Selecciona y aplica el perfil de rendimiento de Firefox de esta máquina.
# Firefox solo lee user.js dentro del perfil real; este script compone el
# archivo versionado y enlaza el perfil predeterminado sin depender de su
# nombre aleatorio.
set -euo pipefail

CONFIG_DIR="${FIREFOX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/firefox}"
BASE="$CONFIG_DIR/base.js"
PROFILES_DIR="$CONFIG_DIR/profiles"
SELECTOR="$CONFIG_DIR/active-profile.js"
GENERATED="$CONFIG_DIR/user.js"

usage() {
  cat <<'EOF'
uso: firefox-profile.sh [auto|laptop|desktop|status]

  auto     usa laptop si existe una batería real; desktop en caso contrario
  laptop   reduce memoria, procesos y actividad en segundo plano
  desktop  prioriza respuesta, precarga y cachés más amplias
  status   muestra el perfil y el user.js de Firefox que están activos
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

has_battery() {
  local supply type_file type scope
  for type_file in /sys/class/power_supply/*/type; do
    [[ -r "$type_file" ]] || continue
    IFS= read -r type < "$type_file" || continue
    [[ "$type" == Battery ]] || continue
    supply="${type_file%/type}"
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

profile_from_selector() {
  local target laptop_path desktop_path
  [[ -L "$SELECTOR" ]] || return 1
  target="$(readlink -f "$SELECTOR")" || return 1
  laptop_path="$(readlink -f "$PROFILES_DIR/laptop.js")" || return 1
  desktop_path="$(readlink -f "$PROFILES_DIR/desktop.js")" || return 1
  if [[ "$target" == "$laptop_path" ]]; then
    printf 'laptop\n'
  elif [[ "$target" == "$desktop_path" ]]; then
    printf 'desktop\n'
  else
    return 1
  fi
}

validate_fragment() {
  local file="$1" malformed
  [[ -f "$file" ]] || die "falta $file"
  malformed="$(grep -Env \
    '^[[:space:]]*(//.*)?$|^[[:space:]]*user_pref\("[A-Za-z0-9._-]+",[[:space:]]*(true|false|-?[0-9]+)\);([[:space:]]*//.*)?$' \
    "$file" || true)"
  [[ -z "$malformed" ]] || die "sintaxis no válida en $file:\n$malformed"
}

validate_sources() {
  local variant duplicates
  validate_fragment "$BASE"
  validate_fragment "$PROFILES_DIR/laptop.js"
  validate_fragment "$PROFILES_DIR/desktop.js"
  for variant in laptop desktop; do
    duplicates="$({
      sed -n 's/^[[:space:]]*user_pref("\([^"]*\)".*/\1/p' "$BASE"
      sed -n 's/^[[:space:]]*user_pref("\([^"]*\)".*/\1/p' "$PROFILES_DIR/$variant.js"
    } | sort | uniq -d)"
    [[ -z "$duplicates" ]] \
      || die "preferencias duplicadas entre base.js y $variant.js: $duplicates"
  done
}

compose_user_js() {
  local profile="$1"
  printf '%s\n' \
    '// Generado por GiGiShell/bin/firefox-profile.sh; no editar directamente.' \
    "// Perfil de rendimiento activo: $profile" \
    '// Firefox lo vuelve a leer en cada arranque.' \
    ''
  cat "$BASE"
  printf '\n'
  cat "$PROFILES_DIR/$profile.js"
}

choose_profile_store() {
  local xdg_store legacy_store major
  if [[ -n "${FIREFOX_PROFILE_STORE:-}" ]]; then
    printf '%s\n' "$FIREFOX_PROFILE_STORE"
    return
  fi

  xdg_store="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox"
  legacy_store="$HOME/.mozilla/firefox"
  if [[ -f "$xdg_store/profiles.ini" ]]; then
    printf '%s\n' "$xdg_store"
  elif [[ -f "$legacy_store/profiles.ini" ]]; then
    printf '%s\n' "$legacy_store"
  else
    # Firefox 147 migró las instalaciones nuevas de Linux a XDG. Las versiones
    # anteriores siguen usando ~/.mozilla; conservar ambos casos facilita usar
    # el mismo repo con una versión ESR antigua.
    major="$(firefox --version 2>/dev/null | sed -nE 's/.* ([0-9]+)(\..*)?$/\1/p' | head -n1)"
    if [[ -n "$major" && "$major" -lt 147 ]]; then
      printf '%s\n' "$legacy_store"
    else
      printf '%s\n' "$xdg_store"
    fi
  fi
}

profile_record_from_ini() {
  local ini="$1"
  awk -F= '
    function emit() {
      if (in_profile && is_default == "1" && path != "") {
        print (relative == "" ? "1" : relative) "|" path
        found = 1
      }
    }
    /^\[/ {
      if (!found) emit()
      in_profile = ($0 ~ /^\[Profile[0-9]+\]$/)
      path = relative = is_default = ""
      next
    }
    in_profile && $1 == "Path" { path = substr($0, index($0, "=") + 1) }
    in_profile && $1 == "IsRelative" { relative = substr($0, index($0, "=") + 1) }
    in_profile && $1 == "Default" { is_default = substr($0, index($0, "=") + 1) }
    END { if (!found) emit() }
  ' "$ini"
}

default_profile_dir() {
  local store="$1" path record relative
  if [[ -n "${FIREFOX_PROFILE_DIR:-}" ]]; then
    printf '%s\n' "$FIREFOX_PROFILE_DIR"
    return
  fi

  path=
  if [[ -f "$store/installs.ini" ]]; then
    path="$(sed -n 's/^Default=//p' "$store/installs.ini" | head -n1)"
  fi
  if [[ -n "$path" ]]; then
    if [[ "$path" == /* ]]; then
      printf '%s\n' "$path"
    else
      printf '%s\n' "$store/$path"
    fi
    return
  fi

  [[ -f "$store/profiles.ini" ]] || return 1
  record="$(profile_record_from_ini "$store/profiles.ini" | head -n1)"
  [[ -n "$record" ]] || return 1
  relative="${record%%|*}"
  path="${record#*|}"
  if [[ "$relative" == 1 ]]; then
    printf '%s\n' "$store/$path"
  else
    printf '%s\n' "$path"
  fi
}

create_default_profile() {
  local store="$1" profile_dir temporary
  profile_dir="$store/gigishell.default-release"
  mkdir -p "$profile_dir"
  temporary="$store/.profiles.ini.$$"
  trap 'rm -f "$temporary"' EXIT
  cat > "$temporary" <<'EOF'
[Profile0]
Name=default-release
IsRelative=1
Path=gigishell.default-release
Default=1

[General]
StartWithLastProfile=1
Version=2
EOF
  mv -f "$temporary" "$store/profiles.ini"
  trap - EXIT
  printf '%s\n' "$profile_dir"
}

install_profile_link() {
  local profile_dir="$1" target="$profile_dir/user.js" backup temporary stamp
  mkdir -p "$profile_dir"
  if [[ -L "$target" ]] && [[ "$(readlink -f "$target")" == "$(readlink -f "$GENERATED")" ]]; then
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    backup="$profile_dir/user.js.pre-gigishell"
    if [[ -e "$backup" || -L "$backup" ]]; then
      stamp="$(date +%Y%m%d-%H%M%S)"
      backup="$backup.$stamp"
    fi
    mv -- "$target" "$backup"
    printf 'BACKUP %s -> %s\n' "$target" "$backup"
  fi

  temporary="$profile_dir/.user.js.$$"
  trap 'rm -f "$temporary"' EXIT
  ln -s "$GENERATED" "$temporary"
  mv -Tf "$temporary" "$target"
  trap - EXIT
}

action="${1:-auto}"
case "$action" in
  -h|--help)
    usage
    exit 0
    ;;
  status)
    profile="$(profile_from_selector)" \
      || die "no hay un perfil de Firefox válido activo en $SELECTOR"
    validate_sources "$profile"
    [[ -f "$GENERATED" ]] || die "falta el user.js generado: $GENERATED"
    cmp -s <(compose_user_js "$profile") "$GENERATED" \
      || die "$GENERATED no coincide con base.js + profiles/$profile.js"
    store="$(choose_profile_store)"
    profile_dir="$(default_profile_dir "$store")" \
      || die "no pude detectar el perfil predeterminado en $store"
    [[ -L "$profile_dir/user.js" ]] \
      && [[ "$(readlink -f "$profile_dir/user.js")" == "$(readlink -f "$GENERATED")" ]] \
      || die "$profile_dir/user.js no apunta a la configuración generada"
    printf 'Perfil de Firefox activo: %s\n' "$profile"
    printf 'Perfil de usuario: %s\n' "$profile_dir"
    printf 'Configuración aplicada: %s -> %s\n' "$profile_dir/user.js" "$GENERATED"
    exit 0
    ;;
  auto)
    if has_battery; then profile=laptop; else profile=desktop; fi
    ;;
  laptop|desktop)
    profile="$action"
    ;;
  *)
    usage >&2
    die "perfil desconocido: $action"
    ;;
esac

validate_sources "$profile"
if [[ -e "$SELECTOR" && ! -L "$SELECTOR" ]]; then
  die "$SELECTOR existe y no es un symlink; no lo sobrescribo"
fi

mkdir -p "$CONFIG_DIR"
temporary="$CONFIG_DIR/.active-profile.js.$$"
trap 'rm -f "$temporary"' EXIT
ln -s "profiles/$profile.js" "$temporary"
mv -Tf "$temporary" "$SELECTOR"

temporary="$CONFIG_DIR/.user.js.$$"
compose_user_js "$profile" > "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" "$GENERATED"
trap - EXIT

store="$(choose_profile_store)"
mkdir -p "$store"
if ! profile_dir="$(default_profile_dir "$store")"; then
  profile_dir="$(create_default_profile "$store")"
  printf 'CREADO perfil predeterminado de Firefox: %s\n' "$profile_dir"
fi
install_profile_link "$profile_dir"

printf 'Perfil de Firefox activo: %s\n' "$profile"
printf 'Configuración aplicada en: %s/user.js\n' "$profile_dir"
printf 'Cierra Firefox por completo y vuelve a abrirlo para aplicar los cambios.\n'
