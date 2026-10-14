#!/usr/bin/env bash
# Desactiva el ahorro forzado al arrancar Hyprland, antes de lanzar AGS.
# Las recargas de AGS conservan el estado guardado; este script solo lo llama
# el autostart del compositor. Conserva los ajustes y el apunte de brillo.

set -u

configuracion="${XDG_CONFIG_HOME:-$HOME/.config}/power-save/config.json"
[[ -f "$configuracion" ]] || exit 0
command -v jq >/dev/null 2>&1 || {
    printf '[ahorro] Falta jq; no se pudo desactivar el ahorro forzado.\n' >&2
    exit 1
}

# Resuelve un posible enlace para actualizar el fichero sin sustituirlo.
configuracion=$(readlink -f -- "$configuracion") || exit 1
jq -e 'type == "object" and .forcePowerSave == true' "$configuracion" >/dev/null || exit 0

# El temporal vive junto al destino para que el reemplazo sea atómico.
temporal=$(mktemp "${configuracion}.XXXXXX") || exit 1
trap 'rm -f -- "$temporal"' EXIT
jq '.forcePowerSave = false' "$configuracion" > "$temporal" || exit 1
chmod --reference="$configuracion" "$temporal" || exit 1
mv -f -- "$temporal" "$configuracion"
