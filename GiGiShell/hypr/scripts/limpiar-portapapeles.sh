#!/usr/bin/env bash
#
# Limpia la selección activa de Wayland y el historial persistente de cliphist.
# AGS lo invoca directamente y Hyprland usa `al-iniciar`, que respeta la
# preferencia limpiezaPortapapelesAlIniciar de ~/.config/gigios/preferences.json.

set -u

preferencias="$HOME/.config/gigios/preferences.json"

limpieza_automatica_activa() {
    [[ -f "$preferencias" ]] || return 1

    if command -v jq >/dev/null 2>&1; then
        [[ "$(jq -r '.limpiezaPortapapelesAlIniciar' "$preferencias" 2>/dev/null)" == "true" ]]
        return
    fi

    grep -Eq '"limpiezaPortapapelesAlIniciar"[[:space:]]*:[[:space:]]*true' "$preferencias"
}

limpiar_portapapeles() {
    local estado=0

    # Primero retiramos la selección activa. Si el watcher llegara a observar el
    # cambio, el wipe posterior garantiza que no quede una entrada vacía residual.
    if command -v wl-copy >/dev/null 2>&1; then
        wl-copy --clear || estado=1
    else
        printf 'No se encontró wl-copy; no se pudo vaciar la selección activa.\n' >&2
        estado=1
    fi

    if command -v cliphist >/dev/null 2>&1; then
        cliphist wipe || estado=1
    else
        printf 'No se encontró cliphist; no se pudo borrar el historial.\n' >&2
        estado=1
    fi

    return "$estado"
}

case "${1:-}" in
    limpiar)
        limpiar_portapapeles
        ;;
    al-iniciar)
        limpieza_automatica_activa || exit 0
        limpiar_portapapeles
        ;;
    *)
        printf 'Uso: %s {limpiar|al-iniciar}\n' "$0" >&2
        exit 2
        ;;
esac
