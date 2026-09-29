#!/usr/bin/env bash
# abrir-terminal.sh — lo que lanza SUPER+Q: el terminal elegido en
# Ajustes > Apps predeterminadas.
#
# El terminal no es un tipo MIME, así que no hay entrada de mimeapps.list que
# consultar: AGS guarda la elección en ~/.config/gigishell/apps-predeterminadas.json
# ({ terminal: { id, comando } }, ver servicios/aplicaciones/appsPredeterminadas.ts)
# y aquí se lee EN CADA PULSACIÓN. Leerlo al cargar el config (variables.lua)
# obligaría a un `hyprctl reload` tras cada cambio en Ajustes, que recrea los
# nodos de audio HDMI y demás efectos que documenta ags/CLAUDE.md.
#
# Sin JSON, sin jq o con un comando que ya no está instalado: kitty, que es lo
# que SUPER+Q lanzaba siempre. Un error aquí no puede dejar la sesión sin terminal.

conf="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/apps-predeterminadas.json"
cmd=""
if [[ -r "$conf" ]] && command -v jq >/dev/null 2>&1; then
    cmd=$(jq -r '.terminal.comando // empty' "$conf" 2>/dev/null)
fi

if [[ -n "$cmd" ]] && command -v "${cmd%% *}" >/dev/null 2>&1; then
    exec sh -c "$cmd"
fi
exec kitty
