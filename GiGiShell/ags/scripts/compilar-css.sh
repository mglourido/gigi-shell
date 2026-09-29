#!/usr/bin/env bash
# Compila ~/.cache/gigishell/out.css desde los .scss de ags/estilos/, SOLO si hace falta.
#
# out.css es una caché: no vive en el repo ni se edita a mano. app.ts no lo importa
# (eso lo metería en el bundle y obligaría a tenerlo junto a las fuentes): le pasa su
# RUTA a app.start({ css }), que Astal carga con load_from_path. Lo regenera este script,
# que se llama antes de cada `ags run` (gigishell/autostart.lua) y desde install.sh.
# Sass compila `style.scss` como entrada y sigue su grafo de `@use`; el `find`
# detecta cambios en cualquier parcial `.scss` de AGS sin mantener una lista aparte.
# Si ningún .scss es más nuevo que out.css, sale sin hacer nada (cuesta un `find`),
# así que se puede llamar en cada arranque sin pagar sass.
#
#   compilar-css.sh           compila si out.css falta o algún .scss es más nuevo
#   compilar-css.sh --forzar  compila siempre
#
# Se compila a un temporal junto a out.css (misma caché, así el `mv` es un rename del
# mismo sistema de ficheros) y solo se publica si todas las etapas
# salieron bien. El renombrado final es atómico y conserva la versión anterior si
# falla Sass o el mapa; además se avisa por notify-send.
set -euo pipefail

AGS="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SCSS="$AGS/estilos/style.scss"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell"
CSS="$CACHE/out.css"
MAPA="$CACHE/out.css.map"

# Resto del sitio antiguo (ags/estilos/out.css, dentro del repo): ya no lo lee nadie.
rm -f "$AGS/estilos/out.css"

if [[ "${1:-}" != "--forzar" && -s "$CSS" ]] \
  && [[ -z "$(find "$AGS" -path "$AGS/node_modules" -prune -o -name '*.scss' -newer "$CSS" -print -quit)" ]]; then
  exit 0
fi

avisar() {
  echo "compilar-css: $1" >&2
  command -v notify-send >/dev/null && notify-send -u critical "CSS de AGS" "$1"
}

command -v sass >/dev/null || { avisar "falta 'sass' (sudo pacman -S --needed dart-sass)"; exit 1; }

mkdir -p "$CACHE"
tmp="$(mktemp -d "$CACHE/.css.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT

# --no-charset: GTK CSS rechaza el @charset de Sass. Rutas absolutas en el mapa para
# que apunte a los .scss del repo desde la caché (ver "Styling" en ags/CLAUDE.md).
if ! err="$(sass --no-charset --source-map-urls=absolute "$SCSS" "$tmp/out.css" 2>&1)"; then
  avisar "sass no pudo compilar; se conserva el out.css anterior. ${err%%$'\n'*}"
  echo "$err" >&2
  exit 1
fi

mv "$tmp/out.css.map" "$MAPA"
mv "$tmp/out.css" "$CSS"
