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

TX_COMMIT=0
TX_SELECTOR_PREVIOUS=
TX_SELECTOR_EXISTED=0
TX_SELECTOR_CHANGED=0
TX_GENERATED_BACKUP=
TX_GENERATED_BACKUP_DIR=
TX_GENERATED_INSTALLED=0
TX_PROFILE_BACKUP=
TX_PROFILE_INSTALLED=0
TX_PROFILES_INI_TEMP=
TX_PROFILES_INI_INSTALLED=0
TX_CREATED_STORE=0
TX_CREATED_PROFILE_DIR=0
TX_GENERATED_TEMP=
TX_SELECTOR_TEMP=
TX_PROFILE_TEMP=

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

install_default_records_from_ini() {
  local ini="$1"
  awk -F= '
    /^\[/ {
      in_install = ($0 ~ /^\[Install[^]]+\]$/)
      next
    }
    in_install && $1 == "Default" {
      path = substr($0, index($0, "=") + 1)
      if (path != "") print path
    }
  ' "$ini"
}

default_profile_dir() {
  local store="$1" path record relative
  local -a install_defaults=()
  if [[ -n "${FIREFOX_PROFILE_DIR:-}" ]]; then
    printf '%s\n' "$FIREFOX_PROFILE_DIR"
    return
  fi

  path=
  if [[ -f "$store/installs.ini" ]]; then
    mapfile -t install_defaults < <(install_default_records_from_ini "$store/installs.ini")
    if (( ${#install_defaults[@]} > 1 )); then
      local first
      first="${install_defaults[0]}"
      for path in "${install_defaults[@]:1}"; do
        if [[ "$path" != "$first" ]]; then
          return 2
        fi
      done
    fi
    path="${install_defaults[0]:-}"
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

contenido_perfiles_inicial() {
  cat <<'EOF'
[Profile0]
Name=default-release
IsRelative=1
Path=gigishell.default-release
Default=1

[General]
StartWithLastProfile=1
Version=2
EOF
}

nombre_respaldo_user_js() {
  local directorio="$1" respaldo sello sufijo
  respaldo="$directorio/user.js.pre-gigishell"
  if [[ -e "$respaldo" || -L "$respaldo" ]]; then
    sello="$(date +%Y%m%d-%H%M%S)"
    respaldo="$respaldo.$sello"
    sufijo=0
    while [[ -e "$respaldo" || -L "$respaldo" ]]; do
      sufijo=$((sufijo + 1))
      respaldo="$directorio/user.js.pre-gigishell.$sello.$sufijo"
    done
  fi
  printf '%s\n' "$respaldo"
}

restaurar_symlink() {
  local ruta="$1" temporal="$2" destino="$3"
  ln -s -- "$destino" "$temporal" && mv -Tf -- "$temporal" "$ruta"
}

limpiar_transaccion() {
  local resultado=$? fallo=0 temporal_restauracion
  trap - EXIT HUP INT TERM
  set +e

  if (( TX_COMMIT == 0 )); then
    if (( TX_SELECTOR_CHANGED )); then
      if (( TX_SELECTOR_EXISTED )); then
        temporal_restauracion="$CONFIG_DIR/.active-profile.rollback.$$"
        restaurar_symlink "$SELECTOR" "$temporal_restauracion" "$TX_SELECTOR_PREVIOUS" \
          || { printf 'ERROR: no pude restaurar el selector; conserva el destino anterior: %s\n' "$TX_SELECTOR_PREVIOUS" >&2; fallo=1; }
      else
        rm -f -- "$SELECTOR"
      fi
    fi

    if [[ -n "$TX_GENERATED_BACKUP" && ( -e "$TX_GENERATED_BACKUP" || -L "$TX_GENERATED_BACKUP" ) ]]; then
      rm -f -- "$GENERATED"
      mv -- "$TX_GENERATED_BACKUP" "$GENERATED" || { printf 'ERROR: no pude restaurar %s; respaldo en %s\n' "$GENERATED" "$TX_GENERATED_BACKUP" >&2; fallo=1; }
    elif (( TX_GENERATED_INSTALLED )); then
      rm -f -- "$GENERATED"
    fi

    target="${TX_PROFILE_DIR:-}/user.js"
    if (( TX_PROFILE_INSTALLED )); then
      if [[ -L "$target" ]] && [[ "$(readlink -m "$target")" == "$(readlink -m "$GENERATED")" ]]; then
        rm -f -- "$target"
      elif [[ -e "$target" || -L "$target" ]]; then
        printf 'ERROR: no retiré %s porque ya no es el enlace instalado por esta ejecución\n' "$target" >&2
        fallo=1
      fi
    fi
    if [[ -n "$TX_PROFILE_BACKUP" && ( -e "$TX_PROFILE_BACKUP" || -L "$TX_PROFILE_BACKUP" ) ]]; then
      if [[ -e "$target" || -L "$target" ]]; then
        printf 'ERROR: no pude restaurar %s porque ya existe; respaldo conservado en %s\n' "$target" "$TX_PROFILE_BACKUP" >&2
        fallo=1
      else
        mv -- "$TX_PROFILE_BACKUP" "$target" || { printf 'ERROR: no pude restaurar %s; respaldo en %s\n' "$target" "$TX_PROFILE_BACKUP" >&2; fallo=1; }
      fi
    fi

    if (( TX_PROFILES_INI_INSTALLED )); then rm -f -- "${TX_STORE:-}/profiles.ini"; fi
    if (( TX_CREATED_PROFILE_DIR )); then rmdir -- "${TX_PROFILE_DIR:-}" 2>/dev/null || true; fi
    if (( TX_CREATED_STORE )); then rmdir -- "${TX_STORE:-}" 2>/dev/null || true; fi
  fi

  [[ -z "$TX_GENERATED_TEMP" ]] || rm -f -- "$TX_GENERATED_TEMP"
  [[ -z "$TX_SELECTOR_TEMP" ]] || rm -f -- "$TX_SELECTOR_TEMP"
  [[ -z "$TX_PROFILE_TEMP" ]] || rm -f -- "$TX_PROFILE_TEMP"
  [[ -z "$TX_PROFILES_INI_TEMP" ]] || rm -f -- "$TX_PROFILES_INI_TEMP"
  if (( TX_COMMIT == 1 )); then
    [[ -z "$TX_GENERATED_BACKUP_DIR" ]] || rm -rf -- "$TX_GENERATED_BACKUP_DIR"
  elif [[ -z "$TX_GENERATED_BACKUP" || ! -e "$TX_GENERATED_BACKUP" ]]; then
    [[ -z "$TX_GENERATED_BACKUP_DIR" ]] || rmdir -- "$TX_GENERATED_BACKUP_DIR" 2>/dev/null || true
  fi
  (( fallo == 0 )) || resultado=1
  exit "$resultado"
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
if [[ -e "$GENERATED" && ! -f "$GENERATED" && ! -L "$GENERATED" ]]; then
  die "$GENERATED existe y no es un archivo; no lo sobrescribo"
fi

TX_STORE="$(choose_profile_store)"
TX_PROFILE_DIR=
crear_perfil=0
if TX_PROFILE_DIR="$(default_profile_dir "$TX_STORE")"; then
  [[ -d "$TX_PROFILE_DIR" ]] \
    || die "el perfil predeterminado de Firefox no existe: $TX_PROFILE_DIR"
else
  if [[ -e "$TX_STORE/profiles.ini" || -L "$TX_STORE/profiles.ini" || \
        -e "$TX_STORE/installs.ini" || -L "$TX_STORE/installs.ini" ]]; then
    die "hay metadatos de Firefox en $TX_STORE, pero no pude identificar su perfil predeterminado; no los sobrescribo"
  fi
  TX_PROFILE_DIR="$TX_STORE/gigishell.default-release"
  [[ ! -e "$TX_PROFILE_DIR" && ! -L "$TX_PROFILE_DIR" ]] \
    || die "existe $TX_PROFILE_DIR sin metadatos de Firefox; no lo reutilizo"
  crear_perfil=1
fi

[[ -d "$CONFIG_DIR" ]] || die "falta el directorio de configuración: $CONFIG_DIR"
trap limpiar_transaccion EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Todos los archivos nuevos se preparan antes de activar ninguno de ellos.
TX_GENERATED_TEMP="$(mktemp "$CONFIG_DIR/.user.js.XXXXXX")"
compose_user_js "$profile" > "$TX_GENERATED_TEMP"
chmod 0644 "$TX_GENERATED_TEMP"

TX_SELECTOR_TEMP="$(mktemp "$CONFIG_DIR/.active-profile.js.XXXXXX")"
rm -f -- "$TX_SELECTOR_TEMP"
ln -s "profiles/$profile.js" "$TX_SELECTOR_TEMP"

if (( crear_perfil )); then
  if [[ ! -d "$TX_STORE" ]]; then
    mkdir -p -- "$TX_STORE"
    TX_CREATED_STORE=1
  fi
  mkdir -- "$TX_PROFILE_DIR"
  TX_CREATED_PROFILE_DIR=1
  TX_PROFILES_INI_TEMP="$(mktemp "$TX_STORE/.profiles.ini.XXXXXX")"
  contenido_perfiles_inicial > "$TX_PROFILES_INI_TEMP"
fi

target="$TX_PROFILE_DIR/user.js"
perfil_ya_enlazado=0
if [[ -L "$target" ]] && [[ "$(readlink -m "$target")" == "$(readlink -m "$GENERATED")" ]]; then
  perfil_ya_enlazado=1
else
  if [[ -e "$target" || -L "$target" ]]; then
    TX_PROFILE_BACKUP="$(nombre_respaldo_user_js "$TX_PROFILE_DIR")"
  fi
  TX_PROFILE_TEMP="$(mktemp "$TX_PROFILE_DIR/.user.js.XXXXXX")"
  rm -f -- "$TX_PROFILE_TEMP"
  ln -s "$GENERATED" "$TX_PROFILE_TEMP"
fi

if [[ -e "$GENERATED" || -L "$GENERATED" ]]; then
  TX_GENERATED_BACKUP="$(mktemp "$CONFIG_DIR/.user.js.rollback.XXXXXX")"
fi

if (( crear_perfil )); then
  [[ ! -e "$TX_STORE/profiles.ini" && ! -L "$TX_STORE/profiles.ini" ]] \
    || die "aparecieron metadatos de Firefox en $TX_STORE; cancelo sin sobrescribirlos"
  TX_PROFILES_INI_INSTALLED=1
  mv -- "$TX_PROFILES_INI_TEMP" "$TX_STORE/profiles.ini"
  TX_PROFILES_INI_TEMP=
  printf 'CREADO perfil predeterminado de Firefox: %s\n' "$TX_PROFILE_DIR"
fi

if [[ -n "$TX_PROFILE_BACKUP" ]]; then
  mv -- "$target" "$TX_PROFILE_BACKUP"
fi
if (( perfil_ya_enlazado == 0 )); then
  TX_PROFILE_INSTALLED=1
  mv -Tf -- "$TX_PROFILE_TEMP" "$target"
  TX_PROFILE_TEMP=
fi

if [[ -e "$GENERATED" || -L "$GENERATED" ]]; then
  TX_GENERATED_BACKUP_DIR="$(mktemp -d "$CONFIG_DIR/.firefox-profile-rollback.XXXXXX")"
  TX_GENERATED_BACKUP="$TX_GENERATED_BACKUP_DIR/user.js"
  mv -- "$GENERATED" "$TX_GENERATED_BACKUP"
fi
TX_GENERATED_INSTALLED=1
mv -- "$TX_GENERATED_TEMP" "$GENERATED"
TX_GENERATED_TEMP=

if [[ -L "$SELECTOR" ]]; then
  TX_SELECTOR_EXISTED=1
  TX_SELECTOR_PREVIOUS="$(readlink "$SELECTOR")"
fi
TX_SELECTOR_CHANGED=1
mv -Tf -- "$TX_SELECTOR_TEMP" "$SELECTOR"
TX_SELECTOR_TEMP=

TX_COMMIT=1
if [[ -n "$TX_PROFILE_BACKUP" ]]; then
  printf 'BACKUP %s -> %s\n' "$target" "$TX_PROFILE_BACKUP"
fi

printf 'Perfil de Firefox activo: %s\n' "$profile"
printf 'Configuración aplicada en: %s/user.js\n' "$TX_PROFILE_DIR"
printf 'Cierra Firefox por completo y vuelve a abrirlo para aplicar los cambios.\n'
