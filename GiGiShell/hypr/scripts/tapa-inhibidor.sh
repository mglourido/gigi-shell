#!/usr/bin/env bash
# tapa-inhibidor.sh — le quita a systemd-logind el interruptor de la TAPA
# mientras esta sesión de Hyprland esté viva, para que la acción de cerrarla la
# decida Ajustes > Energía (gigios/tapa.lua) y no logind.
#
# ── Por qué un inhibidor y no `HandleLidSwitch=ignore` en /etc ───────────────
# Al botón de encendido se le cede la tecla desde /etc
# (system/logind.conf.d/99-gigios-powerkey.conf) y ahí es correcto: si el bind no
# responde, lo que se pierde es un botón. Con la tapa, `ignore` es PERMANENTE y
# vale también para el saludador, para los TTY y para una sesión caída: cerrar el
# portátil en la pantalla de login lo dejaría encendido dentro de la mochila, y
# eso no da ningún síntoma hasta que quema.
#
# Un inhibidor `handle-lid-switch` en modo block no necesita privilegios y sólo
# vale mientras alguien lo sostiene. Si esto muere —o si nunca llegó a arrancar—,
# logind recupera la tapa y vuelve a suspender: el fallo degrada a "el portátil se
# duerme al cerrarlo", que es justo lo que hay que hacer cuando el escritorio no
# está delante.
#
# ── Cómo se ata a la vida de Hyprland ───────────────────────────────────────
# `systemd-inhibit` mantiene el bloqueo mientras vive el comando que envuelve, así
# que envuelve un `tail --pid=<Hyprland> -f /dev/null`: bloqueado en el kernel (ni
# un despertar, ni un sondeo) y termina EN EL INSTANTE en que Hyprland muere. No
# se usa el PID de esta shell ni un `sleep infinity`: con KillUserProcesses=no —el
# valor de fábrica— un proceso suelto sobrevive al cierre de sesión, y un
# inhibidor huérfano dejaría la tapa muerta para el usuario siguiente sin que
# nadie pudiera verlo.
#
# Lo lanza gigios/autostart.lua. Relanzarlo a mano es inofensivo: la guarda de
# instancia única de abajo hace que la segunda copia se marche sola.

set -u

readonly QUIEN="GiGiShell"
readonly PORQUE="La acción de cerrar la tapa la decide Ajustes > Energía"

# Instancia única. Sin esto, un `hyprctl reload full-reset` (que sí re-ejecuta el
# autostart) apilaría un inhibidor por recarga: no rompe nada —logind respeta el
# conjunto—, pero deja la lista de `systemd-inhibit --list` ilegible y otros tantos
# procesos colgando.
# (No hay riesgo de que la guarda se cace a sí misma: la línea de órdenes de este
# script es `bash .../tapa-inhibidor.sh` y no contiene "systemd-inhibit".)
if pgrep -f "systemd-inhibit .*handle-lid-switch.*--who=$QUIEN" >/dev/null 2>&1; then
    exit 0
fi

command -v systemd-inhibit >/dev/null 2>&1 || exit 0

# El PID de Hyprland. `pgrep -x` para no cazar a hyprctl/hypridle/hyprpaper por el
# prefijo. Si no aparece (esto no salió de una sesión de Hyprland), no hay a qué
# atar el inhibidor y no se toma: mejor que logind conserve la tapa.
hyprland_pid=$(pgrep -x Hyprland | head -1)
[ -n "$hyprland_pid" ] || exit 0

exec systemd-inhibit \
    --what=handle-lid-switch \
    --who="$QUIEN" \
    --why="$PORQUE" \
    --mode=block \
    tail --pid="$hyprland_pid" -f /dev/null
