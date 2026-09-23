#!/usr/bin/env bash
# GiGiShell — genera la mitad hyprcursor de un tema de puntero XCursor.
#
# Un tema de puntero aquí es UN directorio con las dos mitades:
#
#   <tema>/cursors/        XCursor (PNG por tamaño) — lo usan XWayland y los
#                          toolkits (GTK/Qt dibujan su propio puntero), así que
#                          no se puede retirar: hyprcursor no les llega.
#   <tema>/hyprcursors/    hyprcursor (SVG) + manifest.hl — lo usa el cursor que
#                          dibuja el COMPOSITOR, y es el que escala sin pixelarse.
#
# Con esa forma, UN solo nombre sirve para XCURSOR_THEME y HYPRCURSOR_THEME, que
# es justo lo que emiten gigios/dispositivos.lua y AGS. Es la forma que ya traen
# los temas con soporte hyprcursor de fábrica (Bibata-Modern-Ice); esto la
# reproduce para cualquier tema XCursor instalado por paquete.
#
# LO QUE ESTO **NO** HACE: no inventa resolución. Un tema XCursor son PNG por
# tamaño, así que el .hlc generado lleva esos mismos PNG con
# `resize_algorithm = none` (verificado destripando un .hlc generado). El salto
# de calidad de hyprcursor —SVG, nítido a cualquier tamaño y escala— solo lo dan
# los temas AUTORADOS en SVG, como Bibata-Modern-Ice, cuyos .hlc sí contienen un
# .svg dentro. Sobre un tema de paquete esto da PARIDAD, no nitidez: sirve para
# que el compositor deje de caer a XCursor, no para mejorar el dibujo.
#
# El resultado va SIEMPRE a ~/.local/share/icons, nunca a /usr/share/icons: ahí
# los ficheros son de un paquete y pacman no los rastrearía, así que una
# actualización dejaría mitades descuadradas sin avisar.
#
# Uso:
#   bin/generar-hyprcursor.sh --list           temas XCursor instalados y su estado
#   bin/generar-hyprcursor.sh --ruta <tema>    imprime su directorio; rc 1 si no está
#   bin/generar-hyprcursor.sh <tema>           genera ~/.local/share/icons/<tema>
#   bin/generar-hyprcursor.sh <tema> <destino> ídem con otro nombre
#
# Idempotente: si el destino ya tiene manifest.hl no hace nada (--force rehace).
#
# CUIDADO CON --force SOBRE UN TEMA SVG: rehacer Bibata-Modern-Ice sustituiría sus
# 328 KB de SVG por el repaquetado en PNG de su propia mitad XCursor, o sea que
# DEGRADARÍA el tema sin decir nada (se recupera reinstalando el paquete). El
# guardián de idempotencia existe sobre todo por eso, no por ahorrar medio segundo.
set -euo pipefail

DESTINO_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/icons"
RUTAS_ICONOS=("$DESTINO_BASE" "$HOME/.icons" /usr/local/share/icons /usr/share/icons)

msg() { printf '%s\n' "$*" >&2; }
die() { msg "error: $*"; exit 1; }

# Primer directorio que contenga el tema, en el mismo orden de precedencia que
# usan XCursor y libhyprcursor.
buscar_tema() {
  local nombre="$1" ruta
  for ruta in "${RUTAS_ICONOS[@]}"; do
    [ -d "$ruta/$nombre" ] && { printf '%s\n' "$ruta/$nombre"; return 0; }
  done
  return 1
}

listar() {
  local ruta dir nombre vistos=()
  # El estado va en la ÚLTIMA columna: "sí" ocupa 3 bytes y printf pad'ea por
  # bytes, así que en una columna intermedia descuadraría todo lo de la derecha.
  printf '%-34s %-42s %s\n' TEMA RUTA ESTADO
  for ruta in "${RUTAS_ICONOS[@]}"; do
    [ -d "$ruta" ] || continue
    for dir in "$ruta"/*/; do
      nombre="$(basename "$dir")"
      # Un tema de PUNTERO tiene cursors/; los de iconos de app no, y listarlos
      # solo llenaría la salida de ruido (hicolor, Adwaita, Tela-circle-*).
      [ -d "$dir/cursors" ] || continue
      [[ " ${vistos[*]-} " == *" $nombre "* ]] && continue
      vistos+=("$nombre")
      printf '%-34s %-42s %s\n' "$nombre" "$dir" \
        "$([ -f "$dir/manifest.hl" ] && echo hyprcursor || echo 'solo XCursor')"
    done
  done
}

[ "${1:-}" = "--list" ] && { listar; exit 0; }

# `--ruta <tema>` existe para que install.sh pueda preguntar "¿está instalado?" sin
# reimplementar el orden de precedencia de XCursor, que es el único sitio donde vive.
if [ "${1:-}" = "--ruta" ]; then
  [ -n "${2:-}" ] || die "--ruta necesita un tema"
  buscar_tema "$2" || exit 1
  exit 0
fi

FUERZA=0
args=()
for a in "$@"; do
  case "$a" in
    --force) FUERZA=1 ;;
    -*) die "opción desconocida: $a" ;;
    *) args+=("$a") ;;
  esac
done
set -- "${args[@]-}"

ORIGEN_NOMBRE="${1:-}"
[ -n "$ORIGEN_NOMBRE" ] || die "falta el tema. Prueba: $0 --list"
DESTINO_NOMBRE="${2:-$ORIGEN_NOMBRE}"

# El nombre acaba en HYPRCURSOR_THEME y en `hyprctl setcursor`; un espacio o una
# comilla lo romperían más adelante y en silencio. Mismo criterio que la
# validación de temaCursor en ags/servicios/dispositivos/service.ts.
[[ "$DESTINO_NOMBRE" =~ ^[A-Za-z0-9._+-]+$ ]] || die "nombre de destino inválido: $DESTINO_NOMBRE"

command -v hyprcursor-util >/dev/null || die "falta hyprcursor-util (paquete hyprcursor)"

# hyprcursor-util NO descomprime los XCursor él mismo: --extract invoca `xcur2png` y, si
# no lo encuentra, aborta con "missing dependency: -x requires xcur2png". El paquete
# hyprcursor no lo arrastra (ni como optdepend), así que en una máquina recién instalada
# esto falla siempre. Se comprueba AQUÍ, antes de extraer, porque el mensaje de
# hyprcursor-util sale por el mismo stderr que install.sh mete en un aviso que dice
# "elige otro tema": el tema no tenía nada que ver y probar otro no arregla nada.
command -v xcur2png >/dev/null \
  || die "falta xcur2png, que es lo que usa 'hyprcursor-util --extract' para leer los XCursor (Arch/CachyOS: sudo pacman -S --needed xcur2png). No es problema del tema: sin él no se puede generar ninguno."

ORIGEN="$(buscar_tema "$ORIGEN_NOMBRE")" || die "no encuentro el tema '$ORIGEN_NOMBRE'. Prueba: $0 --list"
[ -d "$ORIGEN/cursors" ] || die "'$ORIGEN' no tiene cursors/: no es un tema XCursor"

DESTINO="$DESTINO_BASE/$DESTINO_NOMBRE"
if [ -f "$DESTINO/manifest.hl" ] && [ "$FUERZA" -eq 0 ]; then
  msg "'$DESTINO_NOMBRE' ya tiene soporte hyprcursor ($DESTINO). Nada que hacer (--force para rehacer)."
  exit 0
fi

# El ORIGEN también cuenta, no solo el destino. Un tema autorado en SVG (Bibata) ya
# trae su mitad hyprcursor de fábrica en /usr/share/icons, y ahí el destino
# ~/.local/share/icons/<mismo nombre> está vacío: el guardián de arriba no lo veía y
# esto se ponía a repaquetar tan feliz. El resultado era la DEGRADACIÓN que advierte
# la cabecera para --force, pero sin haber pedido --force: los SVG del tema
# sustituidos por los PNG de su propia mitad XCursor, y encima en
# ~/.local/share/icons, que tiene MÁS precedencia que /usr/share/icons — o sea que la
# copia peor TAPA a la buena. Sin ningún error, y con un "Listo: … 47 formas" que
# parecía un éxito. Si el origen ya lo trae, no hay nada que añadir.
if [ -f "$ORIGEN/manifest.hl" ] && [ "$FUERZA" -eq 0 ]; then
  msg "'$ORIGEN_NOMBRE' ya trae soporte hyprcursor de fábrica ($ORIGEN). Nada que hacer."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

msg "Extrayendo $ORIGEN …"
hyprcursor-util --extract "$ORIGEN" -o "$TMP" >/dev/null

EXTRAIDO="$TMP/extracted_$(basename "$ORIGEN")"
[ -d "$EXTRAIDO" ] || die "hyprcursor-util no dejó nada en $EXTRAIDO"

# El manifest extraído se llama siempre "Extracted Theme", y --create nombra el
# directorio de salida a partir de ESE campo: sin reescribirlo saldría un
# `theme_Extracted Theme` (con espacio), un nombre que libhyprcursor casa por
# directorio y que la validación de AGS rechazaría. Se reescribe antes de crear.
sed -i "s/^name = .*/name = $DESTINO_NOMBRE/" "$EXTRAIDO/manifest.hl"

msg "Creando tema hyprcursor …"
hyprcursor-util --create "$EXTRAIDO" -o "$TMP" >/dev/null
CREADO="$TMP/theme_$DESTINO_NOMBRE"
[ -d "$CREADO/hyprcursors" ] || die "hyprcursor-util no generó $CREADO/hyprcursors"

mkdir -p "$DESTINO"
rm -rf "$DESTINO/hyprcursors"
cp -r "$CREADO/hyprcursors" "$DESTINO/hyprcursors"
cp "$CREADO/manifest.hl" "$DESTINO/manifest.hl"

# La mitad XCursor solo se copia si el destino es OTRO directorio: cuando el tema
# ya vivía en ~/.local/share/icons estamos añadiéndole hyprcursors/ en su sitio y
# copiarlo sobre sí mismo no tendría sentido.
if [ "$ORIGEN" != "$DESTINO" ]; then
  rm -rf "$DESTINO/cursors"
  cp -r "$ORIGEN/cursors" "$DESTINO/cursors"
  # index.theme es lo que hace que XCursor reconozca el directorio como tema.
  if [ -f "$ORIGEN/index.theme" ]; then
    sed "s/^Name=.*/Name=$DESTINO_NOMBRE/" "$ORIGEN/index.theme" > "$DESTINO/index.theme"
  else
    printf '[Icon Theme]\nName=%s\n' "$DESTINO_NOMBRE" > "$DESTINO/index.theme"
  fi
fi

msg "Listo: $DESTINO ($(find "$DESTINO/hyprcursors" -name '*.hlc' | wc -l) formas)"
msg "Elígelo en Ajustes > Dispositivos > Puntero > Tema del puntero."
