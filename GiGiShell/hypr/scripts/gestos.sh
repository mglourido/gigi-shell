#!/usr/bin/env bash
# Interruptor del MODO GESTOS por cámara (SUPER+SHIFT+G).
#
# El trabajo lo hace `gestos/gestos.py`; esto es solo el conmutador: decide si
# hay que encender o apagar, comprueba lo que puede comprobarse ANTES de abrir la
# cámara y traduce cualquier fallo a un aviso que se entienda.
#
#   gestos.sh            alterna
#   gestos.sh on|off     fuerza un sentido
#   gestos.sh estado     imprime "on <pid>" u "off"; no toca nada
#
# ── ESTE MODO NO SE AUTOARRANCA, Y ES LA ÚNICA PIEZA DE CÁMARA QUE NO ────────
# No hay ninguna línea suya en `gigishell/autostart.lua`, al contrario que
# `camara-monitor.sh`. Un monitor de uso en reposo cuesta cero (bloquea en
# inotify); esto enciende la webcam, quema medio core y deja la cámara ocupada
# para cualquier otra app. Un modo así se pide a propósito o no se pide.
#
# ── POR QUÉ EL PID SALE DEL CERROJO Y NO DE `pgrep` ──────────────────────────
# El demonio toma un `flock` sobre `$XDG_RUNTIME_DIR/gigishell-gestos.lock` y
# escribe dentro su PID. Aquí se lee ese PID y se CONFIRMA contra
# `/proc/<pid>/cmdline` antes de creérselo. Un `pgrep -f gestos.py` a secas
# casaría también con el editor que tenga el fichero abierto, con un `tail -f`
# del log o con la propia línea de este script — y matar por ese patrón es
# exactamente cómo se acaba matando algo que no era.

set -uo pipefail

NOTIF_APP="Gestos"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigishell-source:system "${_a[@]}" "$@"
    }
fi

AQUI="$HOME/.config/hypr/scripts/gestos"
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/gigishell/gestos/venv"
MODELO="${XDG_DATA_HOME:-$HOME/.local/share}/gigishell/gestos/hand_landmarker.task"
CERROJO="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gigishell-gestos.lock"
ESTADO="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/gestos-estado.json"
REGISTRO="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell/gestos.log"

# ── ¿Está corriendo? ────────────────────────────────────────────────────────
pid_vivo() {
    local pid
    [[ -r "$CERROJO" ]] || return 1
    pid=$(cat "$CERROJO" 2>/dev/null)
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [[ -d "/proc/$pid" ]] || return 1
    # La confirmación: el cmdline tiene que ser el nuestro. Los PID se reciclan,
    # y sin esto un cerrojo huérfano de una sesión anterior podría señalar a un
    # proceso cualquiera que hubiera heredado el número.
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'gestos/gestos\.py' || return 1
    printf '%s' "$pid"
}

apagar() {
    local pid
    if pid=$(pid_vivo); then
        kill -TERM "$pid" 2>/dev/null
        # Se espera de verdad a que suelte la cámara. Devolver el control antes
        # dejaría el indicador de privacidad encendido un rato largo y, peor, un
        # `off` seguido de un `on` se encontraría el nodo todavía ocupado y
        # fallaría con "la cámara ya la está usando python3".
        for _ in $(seq 1 30); do
            [[ -d "/proc/$pid" ]] || break
            sleep 0.1
        done
        [[ -d "/proc/$pid" ]] && kill -KILL "$pid" 2>/dev/null
    fi
    # El estado lo deja el propio demonio al morir; esto es la red por si lo
    # mataron con -9 y no llegó a escribirlo (un indicador clavado en "activo"
    # sería peor que no tenerlo).
    printf '%s\n' '{"activo":false,"estado":"apagado","mano":false,"motivo":null}' > "$ESTADO" 2>/dev/null
    return 0
}

encender() {
    local motivo=""
    if [[ ! -x "$VENV/bin/python" ]]; then
        motivo="Falta el entorno de gestos. Instálalo con: bash ~/GiGiShell/install.sh --solo gestos"
    elif [[ ! -f "$MODELO" ]]; then
        motivo="Falta el modelo de manos. Instálalo con: bash ~/GiGiShell/install.sh --solo gestos"
    fi
    if [[ -n "$motivo" ]]; then
        notificar gestos.no-disponible -u normal "No se puede activar el modo gestos" "$motivo" -t 9000
        printf '{"activo":false,"estado":"apagado","mano":false,"motivo":%s}\n' \
            "$(printf '%s' "$motivo" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" \
            > "$ESTADO" 2>/dev/null
        return 1
    fi

    mkdir -p "$(dirname "$REGISTRO")"
    # El estado anterior se BORRA antes de lanzar. Es lo que permite que la
    # espera de abajo distinga "ha arrancado" de "quedaba un estado de la vez
    # pasada": sin esto, un `activo:true` huérfano de un demonio muerto a -9
    # daría el arranque por bueno al instante.
    rm -f "$ESTADO"
    # `setsid` + redirección: el demonio tiene que sobrevivir a que muera la
    # shell que lo lanzó. Sale de un `exec_cmd` de Hyprland, cuyo proceso
    # intermedio se va en cuanto este script termina.
    #
    # El registro se TRUNCA en cada encendido en vez de acumularse: aquí lo
    # único que interesa es por qué falló ESTA vez, y un log que crece solo en
    # ~/.cache es basura que nadie va a rotar.
    setsid "$VENV/bin/python" "$AQUI/gestos.py" >"$REGISTRO" 2>&1 < /dev/null &
    disown 2>/dev/null

    # ── La espera mira el ESTADO PUBLICADO, no que el proceso exista ─────────
    # «Existe el PID» NO significa «ha arrancado», y creerlo era un fallo real:
    # el demonio toma el cerrojo (y escribe su PID) ANTES de comprobar el
    # killswitch, si la cámara está libre y si están el modelo y los permisos.
    # O sea que hay una ventana de ~1 s en la que el proceso está vivo y todavía
    # puede rendirse. Medido: el conmutador devolvía éxito en 0,12 s, y si el
    # demonio moría medio segundo después nadie se enteraba por esta vía.
    #
    # La señal buena es `activo:true` en el estado, que el demonio publica justo
    # después de abrir la cámara de verdad. Se sale antes si el proceso muere,
    # para no esperar los 8 s enteros ante un fallo inmediato.
    local intentos=0
    while ((intentos < 80)); do
        sleep 0.1
        intentos=$((intentos + 1))
        if grep -q '"activo": *true' "$ESTADO" 2>/dev/null; then
            return 0
        fi
        pid_vivo >/dev/null || break
    done

    # No cuajó. El demonio publica el motivo y notifica él mismo en los casos
    # que sabe explicar (cámara bloqueada, ocupada, sin permisos, sin modelo).
    # Aquí solo se cubre lo que él NO puede contar: morir antes de llegar a su
    # propio manejo de errores — un fallo de importación del venv, típicamente
    # tras una actualización de Python. Sin esto, ese caso deja SUPER+SHIFT+G mudo.
    if ! grep -q '"motivo": *"' "$ESTADO" 2>/dev/null; then
        notificar gestos.no-disponible -u normal "No se pudo activar el modo gestos" \
            "$(tail -n 3 "$REGISTRO" 2>/dev/null)" -t 9000
    fi
    return 1
}

case "${1:-toggle}" in
    on)     pid_vivo >/dev/null || encender ;;
    off)    apagar ;;
    toggle) if pid_vivo >/dev/null; then apagar; else encender; fi ;;
    estado)
        if pid=$(pid_vivo); then echo "on $pid"; else echo "off"; fi
        ;;
    *)
        echo "uso: gestos.sh {on|off|toggle|estado}" >&2
        exit 2
        ;;
esac
