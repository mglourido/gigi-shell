#!/bin/sh
# pedir-ags.sh — `ags request` para quien tiene una reserva si AGS no atiende.
#
#   pedir-ags.sh suspend || systemctl suspend
#
# `ags request` a pelo solo falla con AGS caído. Medido: con AGS congelado se queda
# esperando sin límite, y `unknown request` (config más nueva que el AGS en marcha) o
# `error: …` salen con código 0, así que un `||` no se entera de ninguno de los tres.
# Aquí todos dan código 1. Imprime la respuesta tal cual, por si el llamador la quiere.
#
# Un atajo sin reserva no necesita este script. Lo que sí importa es no dejar un proceso
# colgado o una acción sin hacer cuando el shell no contesta.
#
# Límite conocido: si el tiempo se agota, AGS aún puede atender el request al
# descongelarse, porque ya estaba en su socket. Ver «Puente con AGS» en hypr/CLAUDE.md.
ESPERA_SEGUNDOS=2

respuesta=$(timeout "$ESPERA_SEGUNDOS" ags request "$@" 2>/dev/null) || exit 1
printf '%s\n' "$respuesta"

case "$respuesta" in
    "" | "unknown request" | error:*) exit 1 ;;
esac
