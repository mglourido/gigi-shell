#!/usr/bin/env bash
# bloquear.sh — el ÚNICO camino para poner hyprlock en GiGiShell.
#
# Hace dos cosas y en este orden: inicia la cola de fondos y lanza hyprlock
# (con `exec`, para que el proceso que quede sea hyprlock y no esta shell — de
# lo contrario `pidof hyprlock` no vería nada y la guarda de instancia única de
# más abajo dejaría de funcionar para el siguiente).
#
# POR QUÉ UN SCRIPT Y NO UNA LÍNEA EN hyprlock.conf: hyprlock.conf es hyprlang y
# NO tiene sustitución de comandos (el `cmd[update:N]` de las etiquetas es cosa
# del widget `label`, no del parser, y `background` no lo admite). La ruta del
# fondo tiene que estar ya escrita cuando hyprlock lee su config, así que alguien
# la tiene que decidir ANTES. Ese alguien es este script.
#
# EL FONDO INICIAL ES UN SYMLINK SIN EXTENSIÓN, y no es un descuido: los wallpapers son
# .jpg/.jpeg/.png/.webp mezclados, así que un enlace con extensión fija mentiría
# la mitad de las veces. hyprlock 0.9.6 carga las imágenes por hyprgraphics, que
# enlaza libmagic y decide el formato por los BYTES del fichero, no por el
# nombre (`ldd /usr/lib/libhyprgraphics.so.4` → libmagic.so.1). Un enlace pelado
# funciona igual con cualquiera de los cuatro formatos.
#
# Vive en la caché y no en `~/.config/gigishell/`: es regenerable en cada bloqueo y
# no es una preferencia del usuario. Si alguien lo borra, el siguiente bloqueo lo
# repone solo.
#
# FAIL-OPEN, y aquí es SERIO: si el selector falla (carpeta vacía, sin Python, sin
# permisos) se bloquea IGUAL, con el fondo anterior o sin fondo. Un bloqueo de
# pantalla que no llega a ponerse porque no encontró una imagen bonita es un
# agujero de seguridad, no un fallo estético.

set -uo pipefail

# hyprlock NO tiene guarda de instancia única (0.9.6: ni una cadena "already
# running" en el binario), así que llamarlo con uno ya puesto arranca un SEGUNDO
# proceso encima del bloqueo. La guarda vive AQUÍ, una sola vez, y por eso todos
# los llamadores (hypridle.conf, idle-action.sh, el botón de encendido, el menú
# de energía de AGS) entran por este script en vez de repetirla cada uno.
pidof hyprlock >/dev/null 2>&1 && exit 0

SCRIPTS="$(dirname "$(readlink -f "$0")")"
"$SCRIPTS/fondo-bloqueo.py" iniciar >/dev/null 2>&1 || true

# El permiso de ubicación decide si hay tarjeta meteorológica. Se comprueba
# sin red; el widget no existe cuando falta una ubicación válida.
if "$SCRIPTS/tiempo-bloqueo.py" disponible >/dev/null 2>&1; then
    exec hyprlock --config "$HOME/.config/hypr/hyprlock-tiempo.conf" "$@"
fi

exec hyprlock "$@"
