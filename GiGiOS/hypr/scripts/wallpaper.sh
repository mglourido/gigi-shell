#!/bin/bash
# Gestor de wallpaper de GiGiOS. Aplica fondos; NO decide cuál.
#
#   wallpaper.sh              -> arranque: respeta randomOnStart
#   wallpaper.sh --random     -> sorteo forzado ahora (botón "Aleatorio" de Orion)
#   wallpaper.sh --auto       -> reevaluar la franja horaria actual (planificador de AGS)
#   wallpaper.sh --grupo <id> -> aplicar la variante que toque de ese grupo (Orion)
#   wallpaper.sh <ruta>       -> aplicar ese archivo (clic en una miniatura suelta)
#
# QUIÉN DECIDE: `wallpaper-select.py`, y este script solo aplica lo que le diga.
# La elección tiene DOS disparadores —el arranque (aquí, en t=0, antes de que AGS
# exista) y el cambio de franja (AGS)— así que vive en un solo sitio o acaban
# discrepando en silencio. El modelo de franjas y grupos está documentado en
# `lib/seleccion_fondos.py`.
#
# Config de franjas/grupos: ~/.config/gigios/wallpapers.json (la escribe Orion).
# Estado: ~/.config/gigios/wallpaper.json -> { randomOnStart, current, currentGroup }
#   - randomOnStart: lo escribe AGS (toggle). Ausente => true.
#   - current / currentGroup: los escribe este script cada vez que aplica.
# El reparto (bash es dueño de lo aplicado, AGS del toggle) evita que uno pise el
# campo del otro: ambos hacen read-modify-write preservando lo ajeno.
#
# `currentGroup` es lo que permite que un grupo CONSERVE SU IDENTIDAD al cambiar
# de franja: sin él, al reevaluar solo se vería una ruta suelta y no habría forma
# de saber que hay que mudar de variante en vez de sortear un fondo nuevo.
#
# FAIL-OPEN: si el selector falla (falta python, JSON corrupto, un bug), se cae
# al sorteo plano de toda la vida. El fondo del escritorio no puede depender de
# que esta función esté sana.

WALLPAPER_DIR="$HOME/GiGiOS/Wallpapers"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/wallpaper.json"
SELECT="$(dirname "$(readlink -f "$0")")/wallpaper-select.py"

pick_random_plano() {
    ls "$WALLPAPER_DIR"/*.{jpg,jpeg,png,webp} 2>/dev/null | shuf -n 1
}

# ⚠️ UN ESTADO VACÍO O CORRUPTO SE REESCRIBE ENTERO, no se parchea. `jq` con un
# fichero de 0 bytes NO falla: no lee ningún valor, no emite nada y SALE 0, así
# que la rama de parcheo daba por bueno un `$tmp` vacío y lo movía encima — el
# fichero se quedaba a 0 bytes para siempre y cada aplicación posterior lo
# reconfirmaba. Visto en vivo: el fondo se aplicaba bien (awww lo mostraba) pero
# `current` no se guardaba nunca, y AGS —que lee este fichero— se quedaba sin
# saber qué fondo hay puesto, con lo que el acento adaptativo dejaba de teñir el
# shell sin un solo error por ningún lado. De ahí que se compruebe que el
# original parsea Y que la salida no viene vacía antes de mover.
save_current() {
    local wp="$1" grupo="$2"
    command -v jq >/dev/null 2>&1 || return 0
    mkdir -p "$(dirname "$CONFIG")"
    # ⚠️ EL TEMPORAL VA EN LA MISMA CARPETA QUE EL DESTINO, no en /tmp. /tmp es
    # tmpfs y ~/.config otro sistema de ficheros, así que el `mv` no podía ser un
    # rename(): borraba wallpaper.json y lo creaba de nuevo (inode nuevo, medido
    # con inotifywait: DELETE + CREATE + MODIFY). Eso deja una ventana sin fichero
    # y obliga al Gio.FileMonitor de AGS a re-engancharse a otro inode — de ese
    # monitor dependen el acento adaptativo y el resaltado de Orion. En la misma
    # carpeta el mv es un rename atómico (MOVED_TO) y el fichero nunca falta.
    if [[ -s "$CONFIG" ]] && jq -e 'type == "object"' "$CONFIG" >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp -p "$(dirname "$CONFIG")" .wallpaper.json.XXXXXX)" || return 0
        if jq --arg c "$wp" --arg g "$grupo" \
              '.current = $c | .currentGroup = $g' "$CONFIG" > "$tmp" 2>/dev/null \
           && [[ -s "$tmp" ]]; then
            mv "$tmp" "$CONFIG"
        else
            rm -f "$tmp"
        fi
    else
        local tmp
        tmp="$(mktemp -p "$(dirname "$CONFIG")" .wallpaper.json.XXXXXX)" || return 0
        if jq -n --arg c "$wp" --arg g "$grupo" \
              '{randomOnStart: true, current: $c, currentGroup: $g}' > "$tmp" \
           && [[ -s "$tmp" ]]; then
            mv "$tmp" "$CONFIG"
        else
            rm -f "$tmp"
        fi
    fi
}

apply() {
    local wp="$1" grupo="$2"
    [[ -z "$wp" || ! -f "$wp" ]] && return 1
    awww img "$wp" \
        --transition-type random \
        --transition-duration 1 \
        --transition-fps 60 \
        --transition-step 90
    save_current "$wp" "$grupo"
}

# Ejecuta el selector y aplica su decisión.
#   rc 0 sin línea  -> no hay nada que cambiar (solo lo produce `auto`). Es
#                      deliberado: reaplicar el mismo fondo dispararía la
#                      transición de awww, un parpadeo en cada comprobación.
#   rc != 0         -> no se pudo decidir; el llamador decide si se repliega.
seleccionar_y_aplicar() {
    local salida grupo ruta
    salida="$(python3 "$SELECT" "$@" 2>/dev/null)" || return 1
    [[ -z "$salida" ]] && return 0
    IFS=$'\t' read -r grupo ruta <<< "$salida"
    apply "$ruta" "$grupo"
}

case "$1" in
    --random)
        seleccionar_y_aplicar pick || apply "$(pick_random_plano)" ""
        ;;
    --auto)
        # Sin repliegue: si el selector falla no sabemos qué franja rige, y
        # sortear un fondo cualquiera sería un cambio a destiempo y sin motivo
        # visible. Que no pase nada es el fallo correcto aquí.
        seleccionar_y_aplicar auto
        ;;
    --grupo)
        [[ -n "$2" ]] && seleccionar_y_aplicar grupo "$2"
        ;;
    "")
        # Modo arranque: espera a que awww-daemon esté listo.
        sleep 0.5
        seleccionar_y_aplicar boot || apply "$(pick_random_plano)" ""
        ;;
    *)
        # Ruta específica: el usuario ha elegido un fondo suelto, así que deja de
        # haber grupo vigente. Sin limpiarlo, la próxima reevaluación creería que
        # sigue dentro del grupo anterior y le devolvería una de sus variantes.
        apply "$1" ""
        ;;
esac
