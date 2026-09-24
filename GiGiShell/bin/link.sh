#!/usr/bin/env bash
# GiGiShell — instalador/mantenedor de symlinks.
# Enlaza las rutas canónicas XDG a los archivos reales dentro de ~/GiGiShell.
# Idempotente. No pierde datos.
#
# Uso:
#   bin/link.sh            crea/repara symlinks; NO pisa dirs/archivos reales
#   bin/link.sh --check    solo reporta estado (exit 0 si todo OK)
#   bin/link.sh --force    respalda lo que estorbe (a $LINK_BACKUP) y enlaza
#
# Variables:
#   GIGISHELL       raíz (por defecto, el directorio padre de este script)
#   LINK_BACKUP  destino de respaldos en --force (por defecto ~/.dotfiles-backup-<fecha>)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GIGISHELL="${GIGISHELL:-$(cd -- "$script_dir/.." && pwd)}"
LINK_BACKUP="${LINK_BACKUP:-$HOME/.dotfiles-backup-$(date +%Y%m%d-%H%M%S)}"

# "ruta_relativa_en_GiGiShell::ruta_canonica_absoluta"
LINKS=(
  "ags::$HOME/.config/ags"
  "hypr::$HOME/.config/hypr"
  "inicializador::$HOME/.config/inicializador"
  "rofi/config.rasi::$HOME/.config/rofi/config.rasi"
  "rofi/emoji-grid.rasi::$HOME/.config/rofi/emoji-grid.rasi"
  "mimeapps.list::$HOME/.config/mimeapps.list"
  "menus/applications.menu::$HOME/.config/menus/applications.menu"
  "kdeglobals::$HOME/.config/kdeglobals"
  "qt6ct/qt6ct.conf::$HOME/.config/qt6ct/qt6ct.conf"
  "hyprpolkitagent/hyprpolkitagent.conf::$HOME/.config/hyprpolkitagent/hyprpolkitagent.conf"
  "mime/packages/text-x-xresources.xml::$HOME/.local/share/mime/packages/text-x-xresources.xml"
  "mime/packages/text-x-codigo.xml::$HOME/.local/share/mime/packages/text-x-codigo.xml"
)

# Orígenes que son datos de runtime y arrancan vacíos: se crean si faltan,
# en vez de fallar. Evita tener que versionar un .gitkeep sólo para el symlink.
CREATABLE=()

mode=link
case "${1:-}" in
  "")       mode=link ;;
  --check)  mode=check ;;
  --force)  mode=force ;;
  *) echo "uso: link.sh [--check|--force]" >&2; exit 2 ;;
esac

backup() {  # respalda $1 preservando su ruta relativa a $HOME
  local dst="$1" rel="${1#"$HOME"/}"
  mkdir -p "$LINK_BACKUP/$(dirname "$rel")"
  mv "$dst" "$LINK_BACKUP/$rel"
  echo "BACKUP $dst -> $LINK_BACKUP/$rel"
}

gigishell_phys="$(readlink -f "$GIGISHELL")"
GIGISHELL="$gigishell_phys"

# git que versiona GiGiShell: el repo bare de dotfiles (lo normal, ver install.sh)
# o, si el árbol fuera un clon corriente, el repo del propio directorio.
GIT=()
if git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" rev-parse --git-dir >/dev/null 2>&1; then
  GIT=(git --git-dir="$HOME/.dotfiles" --work-tree="$HOME")
elif git -C "$GIGISHELL" rev-parse --show-toplevel >/dev/null 2>&1; then
  GIT=(git -C "$GIGISHELL")
fi

# ¿El destino cae FÍSICAMENTE dentro del repo? Eso sólo pasa si algún ancestro
# suyo es un symlink que apunta a GiGiShell, y es fatal: el kernel resuelve el
# destino a través de ese symlink, así que `ln -sfn` (y peor, el backup() de
# --force) escriben sobre el archivo de ORIGEN.
dst_lands_in_repo() {
  local phys
  phys="$(readlink -f "$(dirname "$1")" 2>/dev/null || true)"
  [[ -n "$phys" && ( "$phys" == "$gigishell_phys" || "$phys" == "$gigishell_phys"/* ) ]]
}

# Symlinks heredados de un mapeo viejo. Cuando una entrada enlazaba un
# directorio entero ("rofi::$HOME/.config/rofi") y después se afinó a un archivo
# suelto ("rofi/config.rasi::$HOME/.config/rofi/config.rasi"), el symlink de
# directorio se quedó en el sistema y convirtió el destino nuevo en una ruta
# dentro del repo: link.sh se comía su propio origen (lo movía al backup y lo
# dejaba como un symlink a sí mismo). Se borran; no se pierde nada, el
# directorio real vive en el repo. Presupone que ninguna entrada de LINKS está
# anidada dentro de otra.
prune_legacy_dirlinks() {
  local dst="$1" src="$2" p phys rel src_rel
  src_rel="${src#"$GIGISHELL"/}"
  p="$(dirname "$dst")"
  while [[ "$p" == "$HOME"/* ]]; do
    # Solo limpiar el antiguo enlace de un subdirectorio que corresponda a un
    # prefijo real del origen de esta entrada. Nunca borrar enlaces generales
    # como ~/.config o ~/.local/share: podrían redirigir otras aplicaciones.
    rel=
    if [[ "$p" == "$HOME/.config/"* ]]; then
      rel="${p#"$HOME/.config/"}"
    elif [[ "$p" == "$HOME/.local/share/"* ]]; then
      rel="${p#"$HOME/.local/share/"}"
    fi
    if [[ -n "$rel" && ( "$src_rel" == "$rel" || "$src_rel" == "$rel/"* ) && -L "$p" ]]; then
      phys="$(readlink -f "$p" 2>/dev/null || true)"
      if [[ "$phys" == "$gigishell_phys/$rel" ]]; then
        if [[ "$mode" == check ]]; then
          echo "HEREDADO $p -> $phys (symlink viejo al repo; $dst caería dentro de GiGiShell)"
          return 1
        fi
        rm -f "$p"
        echo "LIMPIO $p (symlink heredado al repo; impedía enlazar $dst)"
      fi
    fi
    p="$(dirname "$p")"
  done
  return 0
}

# Secuela del bug anterior: el origen quedó machacado por un symlink a sí mismo.
# Los orígenes son siempre archivos/dirs reales, así que un symlink acá es daño,
# no una configuración válida. Se restaura desde git.
repair_clobbered_src() {
  local src="$1"
  [[ -L "$src" ]] || return 0
  if [[ "$mode" == check ]]; then
    echo "DAÑADO $src es un symlink; debería ser un archivo real del repo"; return 1
  fi
  rm -f "$src"
  if (( ${#GIT[@]} )) && "${GIT[@]}" checkout -- "$src" 2>/dev/null && [[ -e "$src" ]]; then
    echo "REPARO $src (restaurado desde git)"
    return 0
  fi
  echo "DAÑADO $src era un symlink corrupto: lo borré, pero no pude restaurarlo desde git."
  echo "      Recuperá el archivo (buscá en $HOME/.dotfiles-backup-*/) y repetí."
  return 1
}

status=0
for entry in "${LINKS[@]}"; do
  src="$GIGISHELL/${entry%%::*}"
  dst="${entry##*::}"

  if ! prune_legacy_dirlinks "$dst" "$src" || ! repair_clobbered_src "$src"; then
    status=1; continue
  fi

  # Red de seguridad: si tras la limpieza el destino sigue cayendo dentro del
  # repo, es un mapeo mal puesto en LINKS. Enlazarlo destruiría el origen.
  if dst_lands_in_repo "$dst"; then
    echo "ABORTO $dst resuelve dentro de $GIGISHELL; no lo enlazo (destruiría el origen)."
    status=1; continue
  fi

  if [[ ! -e "$src" ]]; then
    if [[ " ${CREATABLE[*]} " == *" ${entry%%::*} "* ]]; then
      mkdir -p "$src"; echo "MKDIR $src (dato de runtime)"
    else
      echo "FALTA origen: $src (esperado para $dst)"; status=1; continue
    fi
  fi

  # ¿ya es el symlink correcto?
  if [[ -L "$dst" && "$(readlink -f "$dst")" == "$(readlink -f "$src")" ]]; then
    echo "OK    $dst"; continue
  fi

  # existe algo en el destino que no es el symlink correcto
  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ "$mode" == check ]]; then
      echo "DIFIERE $dst (esperado -> $src)"; status=1; continue
    fi
    if [[ -L "$dst" ]]; then
      # symlink equivocado: ln -sfn lo reemplaza sin respaldar
      :
    elif [[ "$mode" == force ]]; then
      backup "$dst"
    else
      echo "AVISO $dst es dir/archivo real; usá --force para respaldarlo y enlazar. No lo toco."
      status=1; continue
    fi
  fi

  if [[ "$mode" == check ]]; then
    echo "FALTA symlink: $dst -> $src"; status=1; continue
  fi

  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "LINK  $dst -> $src"
done

# ── Migración: gigios -> gigishell (renombrado del proyecto, 2026-09-23) ──────
# Las carpetas de datos de usuario se llamaban ~/.config/gigios,
# ~/.local/share/gigios y ~/.cache/gigios. Se mueven una sola vez a su nombre
# nuevo y en la vieja queda un symlink hacia la nueva: una sesión que ya estaba
# corriendo (AGS, monitores de hypr/scripts) sigue escribiendo en la ruta vieja
# hasta que se reinicie, y sin el enlace esos datos acabarían en un directorio
# que ya nadie lee. Si existen las dos como carpetas reales, no se toca nada y
# se avisa: fusionarlas a ciegas podría pisar datos.
for base in "$HOME/.config" "$HOME/.local/share" "$HOME/.cache"; do
  old="$base/gigios"; new="$base/gigishell"
  [[ -e "$old" && ! -L "$old" ]] || continue
  if [[ -e "$new" ]]; then
    echo "AVISO $old y $new existen a la vez; revísalo a mano"; status=1; continue
  fi
  if [[ "$mode" == check ]]; then
    echo "MIGRAR $old -> $new"; status=1; continue
  fi
  mv "$old" "$new" && ln -s "gigishell" "$old"
  echo "MOVE  $new <- $old (queda symlink de compatibilidad)"
done

# ── Datos de runtime que ya NO viven dentro del repo ─────────────────────────
# power-save y orion se enlazaban antes con un symlink XDG -> GiGiShell (mismo
# esquema que el resto de LINKS), pero eso deja el dato REAL dentro del árbol
# que gestiona git: un `git clean`, un reset del checkout bare o restaurar un
# backup del repo se lo llevaría por delante. Ahora el dato real vive
# directamente en su ruta XDG, sin symlink de por medio; esto solo migra lo
# que quede de instalaciones con el esquema viejo (symlink apuntando al repo,
# o el propio directorio todavía dentro de GiGiShell) y crea la ruta si falta.
MIGRATE_OUT=(
  "cache/power-save::$HOME/.config/power-save"
  "state/orion::$HOME/.local/share/orion"
)
for entry in "${MIGRATE_OUT[@]}"; do
  src="$GIGISHELL/${entry%%::*}"
  dst="${entry##*::}"

  if [[ -L "$dst" ]]; then
    phys="$(readlink -f "$dst" 2>/dev/null || true)"
    if [[ -n "$phys" && ( "$phys" == "$gigishell_phys" || "$phys" == "$gigishell_phys"/* ) ]]; then
      if [[ "$mode" == check ]]; then
        echo "MIGRAR $dst (symlink viejo al repo; debería ser un directorio real)"; status=1; continue
      fi
      rm -f "$dst"
      mkdir -p "$(dirname "$dst")"
      if [[ -e "$src" ]]; then mv "$src" "$dst"; echo "MOVE  $dst <- $src"
      else mkdir -p "$dst"; echo "MKDIR $dst (dato de runtime)"; fi
      rmdir "$(dirname "$src")" 2>/dev/null || true
    fi
  elif [[ ! -e "$dst" && -e "$src" ]]; then
    if [[ "$mode" == check ]]; then
      echo "MIGRAR $dst (datos aún en $src)"; status=1; continue
    fi
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"; echo "MOVE  $dst <- $src"
    rmdir "$(dirname "$src")" 2>/dev/null || true
  elif [[ ! -e "$dst" ]]; then
    if [[ "$mode" == check ]]; then
      echo "FALTA $dst (dato de runtime; se crea vacío)"; status=1; continue
    fi
    mkdir -p "$dst"; echo "MKDIR $dst (dato de runtime)"
  else
    echo "OK    $dst"
  fi
done

# ── Foto de perfil ───────────────────────────────────────────────────────────
# Copia única en el data dir XDG (~/.local/share/gigishell/face.png); la leen AGS
# (modulos/ajustes/cuenta/avatar.ts) y hyprlock. Fuera del repo y sin versionar, porque es
# personal — pero tampoco en ~/.cache: se elige desde Ajustes > Cuenta y no se
# regenera desde ningún master, así que un limpiador de cache la borraría para
# siempre. Aquí solo se migra la ubicación vieja; ponerla es cosa de Ajustes.
face_dst="$HOME/.local/share/gigishell/face.png"
face_old="$HOME/.cache/gigios/face.png"
if [[ -e "$face_dst" ]]; then
  echo "OK    $face_dst"
elif [[ ! -e "$face_old" ]]; then
  echo "OPCIONAL $face_dst no existe; AGS mostrará iniciales y hyprlock omitirá el avatar"
elif [[ "$mode" == check ]]; then
  echo "MIGRAR $face_old -> $face_dst"; status=1
else
  mkdir -p "$(dirname "$face_dst")"
  mv -f "$face_old" "$face_dst"
  echo "MOVE  $face_dst <- $face_old"
fi

# ── Migración: ajustes de AGS -> ~/.config/gigishell ────────────────────────────
# Antes los JSON de usuario/estado de AGS vivían en ~/.config/ags/config/ (dentro
# del symlink al repo, así que caían versionados). Ahora la UI de AGS escribe en
# ~/.config/gigishell/, una carpeta real fuera del repo. Se mueve una sola vez lo que
# quede en la ruta vieja; no se pisa lo ya migrado.
#
# ags/config/ NO desapareció: sigue siendo la carpeta de datos versionados del
# shell (app_icons.json). Solo migran los JSON de usuario, así que KEEP_IN_REPO
# se queda donde está — sin esta lista la migración se lo llevaba a
# ~/.config/gigishell/ y AGS dejaba de encontrarlo (workspaces sin iconos).
#
# NO se migra aquí ~/.config/ags/calendar-events.json (el almacén viejo del
# calendario, que también caía dentro del repo por el symlink). Lo hace el propio
# AGS al arrancar, en modulos/calendario/persistencia/repositorio.ts: solo él sabe
# convertir el formato antiguo al esquema nuevo, y moverlo a ciegas desde aquí
# dejaría un fichero que el panel no entiende.
old_cfg="$HOME/.config/ags/config"
new_cfg="$HOME/.config/gigishell"
KEEP_IN_REPO=(app_icons.json)
if [[ "$mode" != check ]]; then
  mkdir -p "$new_cfg"
fi
if [[ -d "$old_cfg" ]]; then
  shopt -s nullglob
  for f in "$old_cfg"/*; do
    name="$(basename "$f")"
    keep=0
    for k in "${KEEP_IN_REPO[@]}"; do
      [[ "$name" == "$k" ]] && keep=1
    done
    if (( keep )); then
      echo "KEEP  $f (dato versionado del repo)"
    elif [[ -e "$new_cfg/$name" ]]; then
      echo "SKIP  $new_cfg/$name (ya migrado)"
    elif [[ "$mode" == check ]]; then
      echo "PENDIENTE migrar $f -> $new_cfg/$name"; status=1
    else
      mv "$f" "$new_cfg/$name"
      echo "MOVE  $f -> $new_cfg/$name"
    fi
  done
  shopt -u nullglob
  if [[ "$mode" != check ]]; then
    rmdir "$old_cfg" 2>/dev/null || true
  fi
fi

# ── Reparación: [UiSettings] ColorScheme en kdeglobals ───────────────────────
# Cualquier app KDE que guarde ajustes globales (Dolphin > Preferencias)
# reescribe kdeglobals entero con KConfig y borra [UiSettings], el grupo que lee
# KColorSchemeManager: sin él las apps Qt se abren en CLARO sin dar ningún error.
# El porqué completo, y por qué basta con mirarlo de vez en cuando en vez de
# vigilar el fichero, están en la cabecera del script. Lo llama también
# gigishell/autostart.lua una vez por sesión, que es lo que hace que se repare solo
# sin tener que acordarse de correr link.sh.
#
# Se le pasa la ruta del REPO, no la canónica: en una instalación nueva link.sh
# corre antes de que exista el symlink, y dejar ahí un fichero real le estorbaría
# el enlazado de más abajo.
reparador="$GIGISHELL/hypr/scripts/reparar-kdeglobals.sh"
if [[ -x "$reparador" ]]; then
  if [[ "$mode" == check ]]; then
    if "$reparador" --check "$GIGISHELL/kdeglobals"; then
      echo "OK    kdeglobals [UiSettings] ColorScheme=BreezeDark"
    else
      status=1
    fi
  else
    salida="$("$reparador" "$GIGISHELL/kdeglobals")"
    if [[ -n "$salida" ]]; then echo "$salida"
    else echo "OK    kdeglobals [UiSettings] ColorScheme=BreezeDark"; fi
  fi
fi

# ── Ficheros locales de las shells ──────────────────────────────────────────
# ~/.bashrc, $ZDOTDIR/.zshrc|.zshenv y fish/config.fish no se versionan: son de
# cada equipo y cargan la configuración compartida. Una instalación nueva no los
# trae del checkout, así que se crean aquí. Ver docs/shell-local.md.
shell_local="$GIGISHELL/bin/shell-local.sh"
if [[ -x "$shell_local" ]]; then
  case "$mode" in
    check) "$shell_local" --check || status=1 ;;
    force) LINK_BACKUP="$LINK_BACKUP" "$shell_local" --force || status=1 ;;
    *)     "$shell_local" || status=1 ;;
  esac
fi

# ── Git hooks: verificaciones antes de cada push ────────────────────────────
# core.hooksPath es configuración local y no viaja en el repo. GIT ya detectó
# arriba tanto el bare ~/.dotfiles (worktree $HOME) como un clon convencional;
# reutilizarlo es esencial porque `git -C GiGiShell` no reconoce el bare repo.
if ((${#GIT[@]} > 0)) && [[ -d "$GIGISHELL/.githooks" ]]; then
  hooks_path="$GIGISHELL/.githooks"
  current="$("${GIT[@]}" config --local --get core.hooksPath || true)"
  if [[ "$current" != "$hooks_path" ]]; then
    if [[ "$mode" == check ]]; then
      echo "FALTA  core.hooksPath -> $hooks_path"
      status=1
    else
      "${GIT[@]}" config --local core.hooksPath "$hooks_path"
      echo "HOOK  core.hooksPath -> $hooks_path"
    fi
  fi
fi

if [[ "$mode" == force && -d "$LINK_BACKUP" ]]; then
  echo "Respaldos en: $LINK_BACKUP"
fi
exit $status
