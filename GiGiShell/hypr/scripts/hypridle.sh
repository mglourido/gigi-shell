#!/usr/bin/env bash
# hypridle.sh — arranca (o rearma) hypridle con los tiempos que el usuario puso en Ajustes.
#
# Es la ÚNICA forma de lanzar hypridle en esta sesión: lo llaman gigishell/autostart.lua al
# iniciar y AGS (servicios/pantalla/reinicioHypridle.ts) cada vez que cambian los tiempos o hay
# que rearmar los listeners. Un `hypridle` a pelo arranca con los valores POR DEFECTO de
# hypridle.conf, no con los del usuario.
#
# ── Por qué existe ───────────────────────────────────────────────────────────
# Antes AGS reescribía los `timeout =` de hypr/hypridle.conf, que está versionado: cada cambio
# de Ajustes (y cada entrada/salida del modo ahorro) salía en `gigishell status` como un cambio
# sin commitear. hypridle no tiene intérprete Lua (es hyprlang puro), así que no puede leer el
# JSON por su cuenta como hace el config del compositor. El reparto queda así:
#
#   ~/.config/gigishell/inactividad.json  ← LA AUTORIDAD. Lo escribe AGS
#                                           (servicios/pantalla/inactividadAhorro.ts).
#   ~/.cache/gigishell/hypridle.conf      ← DERIVADO: solo variables `$IDLE_*`, lo genera este
#                                           script en cada arranque. Borrarlo no pierde nada.
#   ~/.config/hypr/hypridle.conf          ← ESTÁTICO y versionado: hace `source =` del derivado
#                                           y usa las variables. Nadie lo edita en ejecución.
#
# Formato del JSON (todas las claves opcionales; lo que falte o no sea válido se queda con el
# valor por defecto del .conf — el mismo criterio que normalizarInactividad() de
# ags/servicios/pantalla/hypridle.ts, para que Ajustes enseñe lo que hypridle usa de verdad):
#   { "dpms":      { "timeout": 600,  "enabled": true },
#     "lock":      { "timeout": 660,  "enabled": false },
#     "suspend":   { "timeout": 2400, "enabled": true },
#     "hibernate": { "timeout": 3000, "enabled": false },
#     "bloqueoAlSuspender": false }
#
# Un listener apagado se traduce a `timeout = -1`: hypridle 0.1.8 lo descarta ("Category has a
# missing timeout setting … Proceeding ignoring faulty entries"), igual que hacía la línea
# comentada con GIGISHELL-OFF. Medido, no supuesto.
set -uo pipefail

JSON="$HOME/.config/gigishell/inactividad.json"
# Ruta FIJA, sin XDG_CACHE_HOME: hypridle.conf la escribe literal en su `source =` (hyprlang
# expande `~`, no variables de entorno), así que las dos tienen que coincidir siempre.
DERIVADO="$HOME/.cache/gigishell/hypridle.conf"

mkdir -p "${DERIVADO%/*}"
tmp="$(mktemp "${DERIVADO}.XXXXXX")" || exit 1

# JSON ausente o roto → derivado VACÍO: el `source` sigue encontrando el fichero y mandan los
# valores por defecto de hypridle.conf. Un fichero viejo con tiempos que ya no son los del usuario
# sería peor que ninguno.
if [[ -r "$JSON" ]]; then
  jq -r '
    def tiempo($clave; $var):
      .[$clave] as $l
      | if ($l | type) == "object" and ($l.timeout | type) == "number" and $l.timeout >= 1
           and ($l.enabled | type) == "boolean"
        then "$\($var) = \(if $l.enabled == true then ($l.timeout | floor) else -1 end)"
        else empty end;
    tiempo("dpms"; "IDLE_DPMS"),
    tiempo("lock"; "IDLE_LOCK"),
    tiempo("suspend"; "IDLE_SUSPEND"),
    tiempo("hibernate"; "IDLE_HIBERNATE"),
    (if (.bloqueoAlSuspender | type) == "boolean"
     then "$IDLE_ANTES_DE_DORMIR = \(if .bloqueoAlSuspender then "loginctl lock-session" else "" end)"
     else empty end)
  ' "$JSON" > "$tmp" 2>/dev/null || : > "$tmp"
fi
mv -f "$tmp" "$DERIVADO"

# Rearmar = matar el anterior y ESPERAR a que suelte org.freedesktop.ScreenSaver en el bus: si el
# nuevo llega antes, registra el error "Another service is already providing…" y se queda sin
# servir los inhibidores de las apps. `-x` para no cazar a este mismo script (su nombre de
# proceso es hypridle.sh).
if pkill -x hypridle; then
  for _ in {1..40}; do
    pgrep -x hypridle >/dev/null || break
    sleep 0.05
  done
fi

exec hypridle "$@"
