#!/bin/sh
# captura-pantalla.sh <carpeta> — captura del monitor activo SIN los popups de notificaciones.
#
# Lo lanza SUPER+X (gigishell/keybinds.lua). AGS oculta la pila de popups, se hace la
# captura y se vuelven a mostrar. No se usa la regla de capa `no_screen_share`: Hyprland
# no omite la capa, pinta un rectángulo negro en su sitio (medido con grim).
#
# Va por pedir-ags.sh: con AGS congelado, `ags request` esperaría sin límite y la captura
# no llegaría a hacerse. Si AGS no contesta, se captura igual (con lo que haya en pantalla).
# Si este script muere a medias, AGS devuelve los popups solo (tope de 5 s).
carpeta=${1:?falta la carpeta de destino}
pedir=$HOME/.config/hypr/scripts/pedir-ags.sh

mkdir -p "$carpeta" || exit 1

if "$pedir" ocultar-popups-captura >/dev/null; then
    trap '"$pedir" mostrar-popups-captura >/dev/null' EXIT
    # Un frame para que GTK desmapee la capa y Hyprland pinte sin ella (la capa no se
    # anima: `animation = "none"` en gigishell/reglas.lua).
    sleep 0.1
fi

hyprshot -m output -m active -o "$carpeta"
