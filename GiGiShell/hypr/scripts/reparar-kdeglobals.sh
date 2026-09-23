#!/usr/bin/env bash
# Repone [UiSettings] ColorScheme=BreezeDark en kdeglobals. One-shot: mira, y o
# corrige o se muere. Lo llaman bin/link.sh (en cada pasada) y
# gigios/autostart.lua (una vez por sesión).
#
# ── Por qué hace falta ──────────────────────────────────────────────────────
# kdeglobals está versionado y symlinkeado a ~/.config/kdeglobals, y cualquier
# app KDE que guarde ajustes globales lo reescribe ENTERO con KConfig, dejándose
# por el camino los grupos que ningún proceso vivo vuelve a declarar. El que se
# pierde es [UiSettings], que es justo el que lee KColorSchemeManager: sin él
# Dolphin y compañía se abren en tema CLARO aunque [General] ColorScheme, los
# grupos [Colors:*] materializados y QT_QPA_PLATFORMTHEME=qt6ct sigan intactos.
# Bajo Plasma lo repondría el propio escritorio; aquí no hay nadie, así que se
# repone desde el arranque de la sesión.
#
# Medido con inotifywait: abrir y cerrar Dolphin NO toca el fichero (cero
# escrituras). Lo que lo borra es GUARDAR desde un diálogo de preferencias de
# una app KDE, cosa de una vez cada muchos días — por eso una comprobación por
# sesión basta y no hace falta ningún watcher permanente.
#
# Uso: reparar-kdeglobals.sh [--check] [ruta]
#   --check  solo informa (exit 1 si falta la clave), no escribe
#   ruta     por defecto ~/.config/kdeglobals (la ruta canónica XDG). link.sh
#            pasa la del repo, porque él corre también en instalaciones donde el
#            symlink todavía no existe y crear ahí un fichero real le estorbaría
#            el enlazado.
set -euo pipefail

modo=aplicar
if [[ "${1:-}" == --check ]]; then modo=check; shift; fi
archivo="${1:-$HOME/.config/kdeglobals}"

# Sin fichero no hay nada que reparar, y crearlo desde aquí sería peor: en una
# instalación a medias taparía el symlink que link.sh está a punto de poner.
[[ -f "$archivo" ]] || exit 0

# Resolver el symlink NO es cosmético. La ruta canónica ~/.config/kdeglobals es
# un symlink al fichero del repo, y el `mv` de más abajo sobre esa ruta
# REEMPLAZA EL SYMLINK por un fichero regular: a partir de ahí el repo y lo que
# leen las apps son dos ficheros distintos, y todo parece funcionar (el tema sale
# bien) hasta que un `dotfiles checkout` deja de tener efecto. Comprobado al
# probar este script. Con la ruta resuelta, el mv cae sobre el fichero real y el
# enlace sobrevive.
archivo="$(readlink -f "$archivo")"

# Mismo awk que usa bin/preflight.sh, para que los tres comprueben lo mismo.
if awk '
  /^\[UiSettings\]$/ { en_ajustes = 1; next }
  /^\[/             { en_ajustes = 0 }
  en_ajustes && /^ColorScheme=BreezeDark$/ { encontrado = 1 }
  END { exit !encontrado }
' "$archivo"; then
  exit 0
fi

if [[ "$modo" == check ]]; then
  echo "REPARAR $archivo: falta [UiSettings] ColorScheme=BreezeDark" >&2
  exit 1
fi

# Reescribe SOLO ese grupo: si existe con otro valor lo corrige conservando sus
# demás claves; si no existe lo crea antes de [WM] (el orden alfabético que usa
# KConfig) o, a falta de [WM], al final. Los ajustes que el usuario haya
# cambiado desde los diálogos de las apps se conservan.
tmp="$(mktemp "$archivo.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk '
  function emitir() { print "[UiSettings]"; print "ColorScheme=BreezeDark"; hecho = 1 }
  /^\[UiSettings\]$/ { emitir(); en_ajustes = 1; next }
  /^\[/ {
    if (!hecho && $0 == "[WM]") { emitir(); print "" }
    en_ajustes = 0
  }
  en_ajustes && /^ColorScheme=/ { next }
  { print }
  END { if (!hecho) { print ""; emitir() } }
' "$archivo" > "$tmp"
chmod --reference="$archivo" "$tmp" 2>/dev/null || true
mv -f "$tmp" "$archivo"
trap - EXIT
echo "FIX   $archivo [UiSettings] ColorScheme=BreezeDark restaurado"
