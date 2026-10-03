#!/usr/bin/env bash
# esperar-arranque.sh <mínimo_s> <máximo_s> — espera a que el arranque haya terminado.
#
# Sustituye a un `sleep N` fijo delante de `boot-healthcheck.sh` en
# `gigishell/autostart.lua`. Aquel `sleep 8` era el peor caso pagado SIEMPRE: medido en
# este equipo, systemd termina el arranque a t+1 s y la red tiene ruta a t+3 s, así que
# el diagnóstico (y sus avisos) salía cinco segundos más tarde de lo que podía.
#
# Vuelve en cuanto se cumplen las DOS condiciones que el healthcheck necesita para no
# dar un falso positivo, nunca antes de <mínimo> ni después de <máximo>:
#
#   1. systemd ha terminado el arranque. Mientras está en `initializing`/`starting`,
#      `systemd-analyze` falla ("Bootup is not yet finished") y se pierde el aviso de
#      arranque lento; además las unidades aún activándose no cuentan como fallidas.
#   2. Hay ruta por defecto. El healthcheck hace un ping a 1.1.1.1, y lanzado antes de
#      que llegue el DHCP avisaría de «Sin conectividad» en un equipo sano.
#
# El <máximo> es lo que impide que esto sea peor que el `sleep` de antes: un equipo sin
# red (o con una wifi que tarda) nunca cumple la 2, y entonces sale al vencer el tope,
# que es exactamente lo que hacía el retardo fijo. El <mínimo> mantiene el diagnóstico
# fuera del pico de t=0, cuando se está pintando el escritorio.
#
# Siempre sale con 0: es una espera, no una comprobación. Quien decide si algo está mal
# es el healthcheck que viene detrás.

minimo=${1:-3}
maximo=${2:-8}

arranque_terminado() {
    case "$(systemctl is-system-running 2>/dev/null)" in
        initializing|starting) return 1 ;;
    esac
    return 0
}

hay_ruta() { [[ -n "$(ip route show default 2>/dev/null)" ]]; }

sleep "$minimo"

# Décimas de segundo, para no arrastrar aritmética en coma flotante.
restante=$(( (maximo - minimo) * 10 ))
while (( restante > 0 )); do
    arranque_terminado && hay_ruta && break
    sleep 0.5
    restante=$(( restante - 5 ))
done
exit 0
