#!/bin/bash
#
# ~/.config/inicializador/apps-inicio.sh — abre las apps que el usuario haya
# puesto en la lista de inicio.
#
# ── Por qué vive en el inicializador y no en autostart.lua ────────────────────
# La lista es DATO, no código: la escribe AGS (Ajustes > Apps al inicio) en
# ~/.config/gigios/apps-inicio.json y la lee este script. Añadir Spotify al
# arranque no puede obligar a editar Lua — un error de sintaxis ahí deja la
# sesión sin atajos salvo SUPER+Q (ver docs/hyprland-lua-migracion.md), que es
# un precio absurdo por una línea de configuración personal. En autostart.lua
# queda UNA sola línea, la que llama aquí, y no se vuelve a tocar.
#
# Ojo con la expectativa: esto NO corre "antes de Hyprland". No existe tal
# momento para una app gráfica — hasta que el compositor no está en pie no hay
# WAYLAND_DISPLAY al que conectarse, así que cualquier cosa con ventana nace
# necesariamente dentro de la sesión. Lo que sí ocurre es que la lista es
# independiente del config del compositor.
#
# ── El retardo entre apps ─────────────────────────────────────────────────────
# Se lanzan de una en una con RETARDO_ENTRE segundos por medio. Media docena de
# apps de escritorio arrancando a la vez (cada una con su runtime, su GL y su
# lectura de configuración) es exactamente la avalancha que autostart.lua se
# pasa entero evitando; aquí el usuario puede crearla con tres clics. El primer
# lanzamiento no espera: el retardo va ENTRE apps, no delante de la primera —
# el retardo del arranque global ya lo pone el `sleep` del punto de llamada.
#
# ── Una sola vez por sesión ───────────────────────────────────────────────────
# `hyprctl reload full-reset` REPITE el autostart (es su razón de ser), y sin
# guarda eso significaría un segundo Spotify cada vez que se recarga el
# compositor mientras se afina algo. La marca va en $XDG_RUNTIME_DIR (tmpfs, se
# vacía al apagar) y lleva el HYPRLAND_INSTANCE_SIGNATURE, que cambia con cada
# arranque del compositor: así una sesión nueva sí lanza, y una recarga de la
# misma sesión no. `--forzar` se la salta para poder probar a mano.
#
#   apps-inicio.sh                 # arranque normal (una vez por sesión)
#   apps-inicio.sh --forzar        # lanza todo aunque ya se hiciera
#   apps-inicio.sh --probar <id>   # lanza SOLO esa entrada, activa o no
#
# ── Cómo se lanza cada app ────────────────────────────────────────────────────
# Por `hl.dsp.exec_cmd(cmd, {workspace='N silent'})`, no por un `sh -c` a secas,
# porque la regla se aplica AL MAPEAR la ventana: la app nace ya en su
# escritorio en vez de aparecer en el activo y ser movida después (ver la
# cabecera de hypr/scripts/lanzar-anclado.py, que documenta ese parpadeo). Y
# porque `silent` —no llevarte al escritorio de destino— solo existe como regla
# de exec; probado, `[noinitialfocus]` NO es una regla de exec y la ventana roba
# el foco igual.
#
# Detrás quedan DOS reservas, y las dos hacen falta:
#   1. la sintaxis legacy `dispatch exec "[reglas] cmd"`, por si la sesión viva
#      todavía viniera de un config hyprlang;
#   2. `setsid sh -c`, sin regla ninguna, porque degradar a "la app se abre
#      donde sea" es infinitamente mejor que "la app no se abre".
# `hyprctl` NO señala un dispatch rechazado en su código de salida —responde en
# stdout y sale 0 igualmente—, así que las cadenas de reserva miran la SALIDA.

set -u

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/apps-inicio.json"
RETARDO_ENTRE=2

modo="arranque"
id_probar=""
case "${1-}" in
  --forzar) modo="forzar" ;;
  --probar) modo="probar"; id_probar="${2-}"; [ -n "$id_probar" ] || exit 2 ;;
  "") ;;
  *) echo "uso: apps-inicio.sh [--forzar | --probar <id>]" >&2; exit 2 ;;
esac

[ -r "$CONFIG" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Marca de "ya lanzado en esta sesión". Sin runtime dir no hay dónde ponerla:
# se sigue lanzando (mejor un duplicado improbable que no arrancar nunca).
marca=""
if [ "$modo" = "arranque" ] && [ -n "${XDG_RUNTIME_DIR-}" ]; then
    mkdir -p "$XDG_RUNTIME_DIR/gigios" 2>/dev/null
    marca="$XDG_RUNTIME_DIR/gigios/apps-inicio-${HYPRLAND_INSTANCE_SIGNATURE:-sin-sesion}.done"
    [ -e "$marca" ] && exit 0
fi

# El comando, como literal de cadena Lua entre comillas simples. Un `Exec=` de
# .desktop trae comillas de los dos tipos y barras invertidas; se escapa lo que
# rompería el literal en vez de usar corchetes largos [[…]], que fallarían con
# un `]]` dentro del comando (mismo razonamiento que lanzar-anclado.py).
literal_lua() {
    printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")"
}

# ¿Respondió hyprctl "ok"? Ver la nota sobre el código de salida en la cabecera.
dispatch_ok() {
    local salida
    salida=$(hyprctl dispatch "$@" 2>/dev/null) || return 1
    case "$salida" in ok*) return 0 ;; *) return 1 ;; esac
}

lanzar() {
    local cmd=$1 escritorio=$2 silencioso=$3
    local reglas="" literal
    literal=$(literal_lua "$cmd")

    if [ "$escritorio" -gt 0 ] 2>/dev/null; then
        reglas="$escritorio"
        [ "$silencioso" = "true" ] && reglas="$reglas silent"
    fi

    if [ -n "$reglas" ]; then
        dispatch_ok "hl.dsp.exec_cmd($literal, {workspace='$reglas'})" && return 0
        dispatch_ok exec "[workspace $reglas] $cmd" && return 0
    else
        dispatch_ok "hl.dsp.exec_cmd($literal)" && return 0
        dispatch_ok exec "$cmd" && return 0
    fi

    setsid sh -c "$cmd" >/dev/null 2>&1 &
}

# Cada entrada viaja en base64 y se vuelve a parsear con jq. Con `@tsv` habría
# bastado hasta el primer comando con una barra invertida o una tabulación
# dentro: jq las emite escapadas y el comando llegaría alterado, sin un solo
# error por medio.
if [ "$modo" = "probar" ]; then
    filtro='(.apps // [])[] | select((.id // "") == $id) | @base64'
else
    filtro='(.apps // [])[] | select(.activo != false) | @base64'
fi

primera=1
while IFS= read -r fila; do
    [ -n "$fila" ] || continue
    entrada=$(printf '%s' "$fila" | base64 -d 2>/dev/null) || continue

    cmd=$(printf '%s' "$entrada" | jq -r '.comando // ""')
    [ -n "$cmd" ] || continue
    escritorio=$(printf '%s' "$entrada" | jq -r 'if (.escritorio | type) == "number" then (.escritorio | floor) else 0 end')
    silencioso=$(printf '%s' "$entrada" | jq -r 'if .silencioso == true then "true" else "false" end')

    [ "$primera" -eq 1 ] || sleep "$RETARDO_ENTRE"
    primera=0
    lanzar "$cmd" "$escritorio" "$silencioso"
done < <(jq -r --arg id "$id_probar" "$filtro" "$CONFIG" 2>/dev/null)

# La marca se pone al final y solo si de verdad se recorrió la lista: dejarla
# antes convertiría un JSON ilegible en "esta sesión ya lanzó sus apps".
[ -n "$marca" ] && : > "$marca"

exit 0
