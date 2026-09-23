#!/usr/bin/env bash
# idle-action.sh — la puerta de los listeners de hypridle.
#
# hypridle no sabe de "Wake up" ni de "suspensión falsa": cuando vence un
# timeout dispara su on-timeout y punto. Este script se interpone entre el
# listener y la acción real (apagar pantalla / bloquear / suspender) y la deja
# pasar SALVO que alguna de las dos funciones del shell la esté vetando.
#
# Son DOS ficheros de estado, los dos escritos por AGS, los dos con el mismo
# contrato (active / until absoluto / pid) y la misma guarda:
#
#   ~/.config/gigios/wakeup.json  (ags/servicios/energia/mantenerDespierto.ts)
#     { "active": bool, "until": <epoch seg|null>, "screen": bool, "pid": <pid de AGS> }
#     until = null  → sin límite (el campo de minutos vacío)
#     screen = true → el Wake up también protege la pantalla (no se apaga ni bloquea)
#
#   ~/.config/gigios/suspension-falsa.json  (ags/servicios/energia/suspensionFalsa.ts)
#     { "active": bool, "until": <epoch seg|null>, "pid": <pid de AGS>, "thenSuspend": bool }
#     Sin `screen`: la suspensión falsa APAGA la pantalla ella misma como primer
#     paso de su secuencia de entrada, así que no tiene nada que proteger de
#     hypridle por ese lado (ver el alcance, abajo). `thenSuspend` lo resuelve
#     AGS al vencer el plazo, no este script: aquí solo se responde "¿veto sí o
#     no?".
#
# Alcances:
#   Wake up a secas          → veta SOLO la suspensión. La pantalla se apaga y
#                              bloquea como siempre (decisión del usuario: Wake
#                              up promete "no suspender", no "no bloquear").
#   Wake up + Pantalla       → veta además dpms-off y lock. El bloqueo va con la
#                              pantalla porque hyprlock la taparía, que es justo
#                              lo que la opción trata de evitar.
#   Suspensión falsa         → veta SOLO la suspensión, nunca dpms-off ni lock.
#                              Y no es un descuido: cuando está puesta la
#                              pantalla YA está apagada y la sesión YA está
#                              bloqueada por su propia secuencia de entrada, así
#                              que dejar pasar esas dos acciones no hace daño —
#                              son idempotentes— y evita tener que razonar sobre
#                              quién apagó qué. Lo único intolerable es el S3,
#                              que es exactamente lo que la función existe para
#                              impedir (la descarga a medias, la compilación
#                              larga, el SSH abierto).
#   dpms-on                  → no lo veta NADIE, nunca. Ver dpms_on().
#   hibernate                → se decide EXACTAMENTE igual que la suspensión. No tiene reglas
#                              propias a propósito: hibernar es más fuerte que suspender (apaga
#                              el equipo), así que todo lo que veta un S3 tiene que vetar también
#                              un S4. Una tabla de vetos aparte para hibernar sería una segunda
#                              copia de la regla de oro, y ya sabemos cómo acaban las copias.
#
# Vetan por OR: basta con que UNO de los dos esté vivo para no suspender.
#
# REGLA DE ORO: ante CUALQUIER duda se EJECUTA la acción (fail-open). Solo se
# veta cuando se puede confirmar un estado vivo. Un fallo aquí debe degradar a
# "el Wake up / la suspensión falsa no funciona" (visible, molesto, arreglable),
# nunca a "el PC no se suspende jamás" — que es silencioso, permanente y se come
# la batería sin que nada lo diga. Por eso la lectura de un fichero vive en UNA
# sola función (alcance_vigente) y no copiada por cada estado: dos copias de la
# regla de oro son dos copias que acaban divergiendo, y la que diverja fallará
# hacia el lado cerrado sin que nadie lo note.
#
# Ojo: no vetamos "hasta que expire", solo respondemos a la pregunta de ahora.
# hypridle no repite un on-timeout ya disparado, así que quien apaga el Wake up
# (wakeup.ts) o sale de la suspensión falsa reinicia hypridle para volver a
# armar los contadores desde cero.

set -uo pipefail

CFG="${XDG_CONFIG_HOME:-$HOME/.config}/gigios"
STATE="$CFG/wakeup.json"
STATE_SF="$CFG/suspension-falsa.json"
# Aviso de "hypridle ha querido suspender y se le ha vetado". No es estado: es un epoch
# suelto que solo lee ags/servicios/energia/wakeUpSuspensionFalsa.ts. Ver el `case` de abajo.
SIGNAL_VETO="$CFG/idle-suspend-vetado"
# Ajuste de hibernación escrito por AGS (ags/servicios/energia/hibernacion.ts):
#   { "enabled": bool, "totalSeconds": n, "modo": "retardo"|"listener" }
# Aquí solo se mira para responder a UNA pregunta: al suspender, ¿hay que dejar armada la
# alarma que hibernará luego? Ese es todo el papel de este script en la hibernación.
ESTADO_HIB="$CFG/hibernacion.json"

# Alcance vigente del fichero de estado "$1", por stdout:
#   "off"     → no veta nada (incluido TODO fallo: ver la REGLA DE ORO)
#   "suspend" → veta la suspensión
#   "screen"  → veta además dpms-off y lock (solo lo pide el Wake up)
#
# Nunca devuelve error ni escribe en stderr: quien llama compara la cadena. Un
# `return 1` aquí se confundiría con "no veta" en unos sitios y se propagaría
# en otros; la cadena "off" solo se puede leer de una forma.
alcance_vigente() {
  local estado=$1 scope pid

  [[ -r $estado ]] || { echo off; return; }
  command -v jq >/dev/null 2>&1 || { echo off; return; }

  # Una sola llamada a jq: alcance vigente, con la caducidad resuelta AQUÍ
  # contra el reloj de pared (`now`) y no confiando en que alguien venga a
  # reescribir el fichero — si AGS muere con un Wake up (o una suspensión
  # falsa) de 30 min puesto, a los 30 min deja de vetar solo.
  # Un fichero sin `.screen` —el de la suspensión falsa— cae en la rama
  # "suspend", que es justo su alcance; aun así quien llama lo recorta, para
  # que el alcance de cada función se lea en blocked() y no dependa de una
  # clave ausente.
  scope=$(jq -r '
      if (.active == true) and ((.until == null) or (.until > now))
      then (if .screen == true then "screen" else "suspend" end)
      else "off" end
    ' "$estado" 2>/dev/null) || { echo off; return; }
  [[ $scope == "suspend" || $scope == "screen" ]] || { echo off; return; }

  # AGS caído = estado huérfano. Sin esta comprobación, un cuelgue de AGS con un
  # Wake up (o una suspensión falsa) SIN límite dejaría el PC sin suspenderse
  # para siempre, y encima sin ninguna UI donde apagarlo (la UI se fue con AGS):
  # habría que saber que existe este JSON y borrarlo a mano. El pid lo resuelve
  # en dos líneas.
  pid=$(jq -r '.pid // empty' "$estado" 2>/dev/null) || { echo off; return; }
  [[ $pid =~ ^[1-9][0-9]*$ ]] || { echo off; return; }
  kill -0 "$pid" 2>/dev/null || { echo off; return; }

  echo "$scope"
}

# ¿Está puesto el ajuste "sustituir la suspensión real por la falsa"?
# 0 = sí (no suspender de verdad), 1 = no.
#
# Es la ÚNICA clave de suspension-falsa.json que se mira con `active` en FALSE, y no es una
# excepción caprichosa: el ajuste dice «en este equipo la suspensión real no se usa», así que
# tiene que vetar ya la primera inactividad del día, cuando todavía no hay ninguna suspensión
# falsa puesta. Quien la convierte en una suspensión falsa es AGS, avisado por $SIGNAL_VETO —
# este script sigue sin saber qué es una suspensión falsa.
#
# Misma REGLA DE ORO que todo lo demás de aquí: ante cualquier duda (sin fichero, sin jq,
# JSON roto, pid muerto) NO se sustituye nada y el equipo se suspende de verdad. Con AGS
# caído no hay nadie que pueda entrar en suspensión falsa, así que vetar dejaría un equipo
# que no se suspende JAMÁS y se come la batería en silencio — peor que un S3 que quizá no
# vuelva, porque aquello se ve y esto no.
sustituye_suspension() {
  local pid

  [[ -r $STATE_SF ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  jq -e '.substitute == true' "$STATE_SF" >/dev/null 2>&1 || return 1

  pid=$(jq -r '.pid // empty' "$STATE_SF" 2>/dev/null) || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  return 0
}

# ¿Veta alguien la acción "$1"?  0 = sí (no ejecutar), 1 = no (ejecutar).
blocked() {
  local action=$1 wakeup sf

  wakeup=$(alcance_vigente "$STATE")
  sf=$(alcance_vigente "$STATE_SF")

  # Recorte explícito del alcance de la suspensión falsa a "suspend": su fichero
  # no lleva `screen` hoy, pero si mañana alguien añadiera esa clave por
  # cualquier motivo, el recorte impide que empiece a vetar dpms-off y lock por
  # accidente — y con la pantalla apagada eso se vería como "hypridle dejó de
  # funcionar", sin un solo error.
  [[ $sf == off ]] || sf=suspend

  case $action in
    suspend)       [[ $wakeup != off || $sf != off ]] && return 0
                   sustituye_suspension && return 0
                   return 1 ;;
    dpms-off|lock) [[ $wakeup == "screen" ]] && return 0; return 1 ;;
    *)             return 1 ;;
  esac
}

# Encender/apagar la pantalla, en la forma Lua de Hyprland 0.56.
#
# ⚠️ LA TABLA NO ES DECORATIVA: `hl.dsp.dpms('off')` ES UN TOGGLE. El argumento
# tiene que ser una TABLA. Con un string, `Internal::tableToggleAction()` sale por
# su primera línea (`if (!lua_istable(...)) return TOGGLE_ACTION_TOGGLE`) y el
# 'on'/'off' se descarta entero: el dispatcher invierte el estado actual y
# responde `ok` igual, así que no hay error, ni rc distinto de 0, ni nada que
# mirar. `parseToggleStr` sí acepta "on"/"off"/"enable"/"disable", pero solo se
# llega a él con una tabla.
#
# Lo que costó: el `on-resume` de hypridle mandaba `dpms('on')` al volver de la
# suspensión con la pantalla YA encendida (la enciende antes el propio restore de
# sesión de Hyprland, o el after_sleep_cmd) — y el toggle la APAGABA. Quedaba
# negra con Hyprland convencido de que estaba encendida, y entonces ni una tecla
# la despertaba: `Actions::dpms(ENABLE)` había dejado `m_dpmsStateOn = true`, que
# es justo la condición que mira InputManager para encenderla al teclear
# (`!m_dpmsStateOn`), y `CMonitor::setDPMS()` sale por `if (m_dpmsStatus == on)`.
# Solo volvía forzando un commit nuevo (cambiar de workspace). Intermitente
# porque dependía de en qué orden cayeran los dos toggles del despertar.
#
# Aquí hubo un fallback a la sintaxis legacy (`hyprctl dispatch dpms off`),
# porque durante la migración la sesión viva podía seguir en config hyprlang
# mientras este script en disco ya era el nuevo. Los `.conf` del compositor ya
# no existen en el repo, así que esa rama era código muerto — y de las caras de
# mantener: se decidía por el stdout ("ok") y no por el código de salida, porque
# hyprctl bajo config legacy responde "Invalid dispatcher" con rc=0.
dpms_off() {
  hyprctl dispatch "hl.dsp.dpms({ action = 'off' })" >/dev/null 2>&1
}

# Encender la pantalla NO pasa por blocked(): el Wake up nunca veta encenderla,
# igual que el on-resume del listener de dpms nunca se vetaba. Existe como acción
# del script —y no como comando suelto en hypridle.conf— porque la tabla lleva
# `}` y el parser de Ajustes > Pantalla trocea los listeners con
# `listener\s*\{[^}]*\}`: una llave dentro del bloque lo cortaría antes de
# tiempo y el listener dejaría de ser editable desde la UI EN SILENCIO (ver la
# cabecera de hypridle.conf). Metida aquí, el .conf se queda sin llaves.
dpms_on() {
  hyprctl dispatch "hl.dsp.dpms({ action = 'on' })" >/dev/null 2>&1
}

# El bloqueo no llama a `hyprlock` directo, sino a bloquear.sh: es quien sortea el
# fondo del bloqueo (hyprlock.conf no puede — hyprlang no sustituye comandos) y
# quien lleva la guarda de instancia única, que hyprlock no tiene (0.9.6: ni una
# cadena "already running" en el binario) y hace falta porque duplicar el bloqueo
# pasa solo: este listener bloquea a los 11 min y el before_sleep_cmd de
# hypridle.conf vuelve a bloquear al suspender.
lock_screen() {
  "$(dirname "$(readlink -f "$0")")/bloquear.sh"
}

# Suspender. Con la hibernación en modo "retardo" NO se usa `systemctl suspend` a secas sino
# `suspend-then-hibernate`, que es el mismo S3 de siempre MÁS una alarma RTC armada antes de
# dormirse: al vencer `HibernateDelaySec` (/etc/systemd/sleep.conf.d/99-gigios-hibernacion.conf,
# lo escribe el helper root) el equipo despierta solo y se hiberna.
#
# Por qué no lo decide AGS cambiando este comando: porque suspender no siempre pasa por aquí
# (menu de energía, botón físico, tapa, `systemctl suspend` a mano), y esta es la única ruta
# que SÍ controlamos. Las demás se quedan en S3 puro, que es lo esperable: quien suspende a
# mano está pidiendo suspender.
#
# REGLA DE ORO otra vez: ante cualquier duda (sin fichero, sin jq, JSON roto, modo desconocido)
# se suspende y punto. Fallar hacia "no se suspende" sería silencioso y se comería la batería.
suspender() {
  if [[ -r $ESTADO_HIB ]] && command -v jq >/dev/null 2>&1 \
     && jq -e '(.enabled == true) and (.modo == "retardo")' "$ESTADO_HIB" >/dev/null 2>&1; then
    # Si `suspend-then-hibernate` no estuviera disponible (sin swap, sin resume=), systemctl
    # falla en el acto y sin dormir el equipo: de ahí el repliegue, que aquí sí se puede
    # decidir por código de salida porque systemctl no miente sobre esto.
    systemctl suspend-then-hibernate && return
  fi
  systemctl suspend
}

case ${1:-} in
  dpms-off) blocked dpms-off || dpms_off ;;
  dpms-on)  dpms_on ;;
  lock)     blocked lock     || lock_screen ;;
  # Mismo veto y mismo aviso que `suspend`, por lo dicho en la cabecera. Este camino solo se
  # recorre con el listener de hibernación encendido, que es el caso minoritario (hibernar sin
  # pasar por la suspensión); en el normal quien hiberna es systemd durante el S3 y aquí no
  # vence ningún timeout.
  hibernate)
    if blocked suspend; then
      printf '%s' "$(date +%s)" > "$SIGNAL_VETO" 2>/dev/null || true
    else
      systemctl hibernate
    fi
    ;;
  suspend)
    # Al VETAR se deja un aviso con el epoch del veto. No es una regla nueva y no toca la
    # REGLA DE ORO: el veto se decide exactamente igual que antes y este script sigue sin
    # saber qué es una suspensión falsa. Es solo que este es el único momento en que alguien
    # sabe que "hypridle ha querido suspender", y AGS no tiene forma de enterarse por su
    # cuenta — no hay listener de ext-idle-notify en el shell, hypridle no publica nada en
    # D-Bus y el IdleHint de logind no es fiable en una sesión Wayland. Lo lee el puente
    # ags/servicios/energia/wakeUpSuspensionFalsa.ts, que decide si con este Wake up toca
    # entrar en suspensión falsa. Si el fichero no se puede escribir no pasa nada: esa
    # opción del Wake up deja de actuar, que es el fallo visible, no el silencioso.
    if blocked suspend; then
      printf '%s' "$(date +%s)" > "$SIGNAL_VETO" 2>/dev/null || true
    else
      suspender
    fi
    ;;
  *)
    echo "uso: ${0##*/} {dpms-off|dpms-on|lock|suspend|hibernate}" >&2
    exit 2
    ;;
esac
