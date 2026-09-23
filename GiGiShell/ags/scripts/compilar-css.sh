#!/usr/bin/env bash
# Compila ags/estilos/out.css desde los .scss, SOLO si hace falta.
#
# out.css es una caché: no se versiona ni se edita a mano. Lo regenera este script,
# que se llama antes de cada `ags run` (gigishell/autostart.lua) y desde install.sh.
# Si ningún .scss es más nuevo que out.css, sale sin hacer nada (cuesta un `find`),
# así que se puede llamar en cada arranque sin pagar sass.
#
#   compilar-css.sh           compila si out.css falta o algún .scss es más nuevo
#   compilar-css.sh --forzar  compila siempre
#
# Se compila a un temporal y solo se publica si sass salió bien: un error a media
# escritura dejaría un out.css truncado y AGS arrancaría con medio CSS. Si falla, se
# conserva el out.css anterior (aunque esté desfasado) y se avisa por notify-send.
set -uo pipefail

AGS="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SCSS="$AGS/estilos/style.scss"
CSS="$AGS/estilos/out.css"
MAPA="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell/out.css.map"

if [[ "${1:-}" != "--forzar" && -s "$CSS" ]] \
  && [[ -z "$(find "$AGS" -path "$AGS/node_modules" -prune -o -name '*.scss' -newer "$CSS" -print -quit)" ]]; then
  exit 0
fi

avisar() {
  echo "compilar-css: $1" >&2
  command -v notify-send >/dev/null && notify-send -u critical "CSS de AGS" "$1"
}

command -v sass >/dev/null || { avisar "falta 'sass' (sudo pacman -S --needed dart-sass)"; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/gigishell-css.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT

# --no-charset: GTK CSS rechaza el @charset de Sass. El mapa va a la caché con rutas
# absolutas (ver "Styling" en ags/CLAUDE.md).
if ! err="$(sass --no-charset --source-map-urls=absolute "$SCSS" "$tmp/out.css" 2>&1)"; then
  avisar "sass no pudo compilar; se conserva el out.css anterior. ${err%%$'\n'*}"
  echo "$err" >&2
  exit 1
fi

mkdir -p "$(dirname "$MAPA")"
mv "$tmp/out.css.map" "$MAPA"
sed -i "s#sourceMappingURL=out.css.map#sourceMappingURL=file://$MAPA#" "$tmp/out.css"
mv "$tmp/out.css" "$CSS"
