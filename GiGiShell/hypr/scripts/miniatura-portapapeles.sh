#!/usr/bin/env bash

# Genera en la ruta administrada por Rofi una miniatura de una imagen binaria
# guardada por cliphist. No crea archivos intermedios ni una caché propia.
set -euo pipefail

entrada="${1:-}"
salida="${2:-}"
tamano_solicitado="${3:-48}"

[[ "$entrada" =~ ^cliphist:([0-9]+)$ ]] || exit 1
[[ -n "$salida" ]] || exit 1
identificador="${BASH_REMATCH[1]}"

if [[ "$tamano_solicitado" =~ ^([0-9]+) ]]; then
    tamano="${BASH_REMATCH[1]}"
else
    tamano=48
fi
((tamano < 16)) && tamano=16
((tamano > 256)) && tamano=256

# cliphist necesita una segunda columna, aunque para decodificar solo use el ID.
# ImageMagick recibe los píxeles por stdin y escribe directamente en {output}.
printf '%s\t\n' "$identificador" | cliphist decode | \
    magick -limit memory 128MiB -limit map 0 -limit disk 0 \
        - -auto-orient -thumbnail "${tamano}x${tamano}>" -strip "png:$salida"
