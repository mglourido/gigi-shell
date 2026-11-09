#!/usr/bin/env bash
# abrir-en-terminal.sh — ejecuta un comando dentro de un terminal y lo deja abierto al terminar
# para poder leer la salida. Lo lanza `utilidades/abrirTerminal.ts`.
#
# Uso: abrir-en-terminal.sh <comando> <arg-exec> <arg-hold> <terminal> [args del terminal…]
#
# Este script NO sabe qué terminales existen: ni los nombra ni elige entre ellos. Quien lo llama
# (el TS, a partir del terminal elegido en Ajustes > Apps predeterminadas) le da el comando del
# terminal y las dos piezas de sintaxis que cambian de uno a otro, tal como las declara su
# `.desktop` en la especificación xdg-terminal-exec:
#   <arg-exec>  `X-TerminalArgExec`: lo que separa el terminal de lo que ejecuta (`-e`, `--`…).
#   <arg-hold>  `X-TerminalArgHold`: la bandera de «no cierres al terminar». Puede ir vacío.
#
# Sin bandera de «mantener abierto», la ventana se mantiene con un «Pulsa Enter» al final del
# comando: vale para cualquier terminal.

cmd="$1" arg_exec="$2" arg_hold="$3"
shift 3
(( $# )) || exit 127

if [[ -n "$arg_hold" ]]; then
    exec "$@" "$arg_hold" "$arg_exec" sh -lc "$cmd"
fi
exec "$@" "$arg_exec" sh -lc "$cmd; printf '\\nPulsa Enter para cerrar…'; read _"
