#!/usr/bin/env bash
#
# Selector de emojis para Hyprland. Reutiliza el tema de Rofi del lanzador y
# del portapapeles, pero presenta los resultados en cuadrícula.
#
# `clipboard` copia el emoji, simula Shift+Insert y restaura después tanto el
# portapapeles como la selección primaria. Es más fiable que escribir Unicode
# directamente en aplicaciones como Firefox y no destruye lo que había copiado.

set -uo pipefail

NOTIF_APP="Escritorio"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigishell-source:system "${_a[@]}" "$@"
    }
fi

# Cómo se reconoce el rofi de ESTE selector entre los demás (lanzador de apps,
# portapapeles). Su línea de comando la arma rofimoji y no empieza por nada
# nuestro, pero lleva el tema propio `emoji-grid.rasi`: ese nombre es contrato.
patron_rofi_emojis="^rofi .*emoji-grid\.rasi"

# Mismo comportamiento que los demás selectores: una segunda pulsación del atajo
# cierra este selector, y con OTRO rofi abierto se cambia a este en vez de solo
# cerrarlo.
if pgrep -f "$patron_rofi_emojis" >/dev/null; then
    pkill -f "$patron_rofi_emojis"
    exit 0
fi

for comando in rofimoji rofi wl-copy wl-paste wtype; do
    if ! command -v "$comando" >/dev/null 2>&1; then
        notificar emojis.no-disponible \
            "Selector de emojis no disponible" \
            "Falta '$comando'. Ejecuta bin/preflight.sh --installed para revisar la instalación." \
            2>/dev/null || true
        exit 1
    fi
done

# Cerrar el otro rofi después de comprobar dependencias: si falta algo, no se
# cierra nada. Hay que esperar a que salga: rofi tiene un pidfile con cerrojo y,
# con el anterior vivo, el nuevo se niega ("Rofi already running?") y sale con 1.
if pgrep -x rofi >/dev/null; then
    pkill -x rofi
    for _ in {1..20}; do  # hasta 1 s; rofi sale en milisegundos
        pgrep -x rofi >/dev/null || break
        sleep 0.05
    done
fi

# El nombre del fichero es la marca de `patron_rofi_emojis`.
ruta_tema="${XDG_CONFIG_HOME:-"$HOME/.config"}/rofi/emoji-grid.rasi"
# Rofimoji separa esta cadena con shlex y ejecuta Rofi sin pasar por un shell:
# `~` no se expande aquí. La ruta debe llegar ya resuelta o Rofi cae en su tema
# blanco predeterminado, aunque la cuadrícula sí parezca haberse aplicado.
# Las descripciones permanecen ocultas pero forman parte de la búsqueda mediante
# los metadatos de Rofi. `fuzzy` también aceptaría letras no contiguas y mezclaría
# resultados sin relación; `normal` exige palabras o subcadenas reales.
argumentos_selector="-matching normal -case-smart -l 5 -fixed-num-lines -kb-row-left Left -kb-row-right Right -kb-move-char-back Control+b -kb-move-char-forward Control+f -theme \"$ruta_tema\""

# Cada entrada y lo que se inserta son caracteres Unicode de texto. La fuente
# Noto Color Emoji solo controla cómo los dibuja Rofi.
rofimoji \
    --selector rofi \
    --clipboarder wl-copy \
    --typer wtype \
    --action clipboard \
    --files emojis \
    --skin-tone ask \
    --hidden-descriptions \
    --max-recent 0 \
    --prompt "Buscar emojis" \
    --selector-args="$argumentos_selector"
