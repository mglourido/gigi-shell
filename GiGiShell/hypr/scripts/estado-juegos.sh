#!/usr/bin/env bash
# Consulta puntual para cualquier consumidor. Para bucles Bash, sourcear
# lib/gaming-gate.sh y llamar a sus predicados evita crear procesos por consulta.
# Imprime true/false; salida 0 = sí, 1 = no, 2 = uso incorrecto.

case "${1:-abiertos}" in
    abiertos) consulta=hay_juegos_abiertos ;;
    foco) consulta=juego_en_foco ;;
    reciente) consulta=gaming_active ;;
    escaner) consulta=escaner_juegos_activo ;;
    *) printf 'Uso: estado-juegos.sh [abiertos|foco|reciente|escaner]\n' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
    printf 'Uso: estado-juegos.sh [abiertos|foco|reciente|escaner]\n' >&2
    exit 2
fi

directorio="${BASH_SOURCE[0]%/*}"
[[ "$directorio" == "${BASH_SOURCE[0]}" ]] && directorio=.
if source "$directorio/lib/gaming-gate.sh" && "$consulta"; then
    printf 'true\n'
else
    printf 'false\n'
    exit 1
fi
