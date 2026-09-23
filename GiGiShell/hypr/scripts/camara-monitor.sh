#!/usr/bin/env bash
# Detector de USO de la cámara — el equivalente para vídeo del indicador de
# micrófono de la barra. Escribe `~/.config/gigios/camara-uso.json`, que AGS lee
# con un Gio.FileMonitor (`ags/servicios/camara/uso.ts`).
#
# ── POR QUÉ ESTO NO PUEDE VIVIR DENTRO DE AGS, Y POR QUÉ NO SONDEA ───────────
# El micro lo tiene resuelto de fábrica: PipeWire gestiona todas las capturas de
# audio y AstalWp emite `recorder-added` al momento. La cámara NO pasa por
# PipeWire: Firefox, Chrome, Zoom y OBS abren `/dev/videoN` directamente por
# V4L2, así que no hay ninguna señal a la que suscribirse.
#
# Lo evidente sería sondear quién tiene el nodo abierto. Se midió en esta
# máquina: recorrer `/proc/*/fd` con 435 procesos cuesta **28 ms**. A 2 s de
# intervalo es más del 1% de una CPU quemado durante toda la sesión. Descartado.
#
# La salida es que **inotify entrega `IN_OPEN` e `IN_CLOSE` también sobre nodos
# de dispositivo**, no solo sobre ficheros normales — comprobado con
# `inotifywait -m -e open -e close /dev/null`, que efectivamente imprime OPEN y
# CLOSE en cada `cat`. Así que este script se BLOQUEA en el kernel y solo hace
# algo cuando alguien abre o cierra de verdad la cámara. En reposo: cero CPU,
# cero forks, cero timers.
#
# ── INOTIFY DISPARA, `fuser` DICE LA VERDAD ─────────────────────────────────
# No se lleva la cuenta de OPEN menos CLOSE, y no es por pereza: contar falla en
# los dos sentidos. Una app puede abrir el mismo nodo varias veces (Chromium
# abre y cierra al ENUMERAR las cámaras, antes de usar ninguna: eso encendería
# el indicador cada vez que alguien entra en una web con videollamada), y un
# proceso que muere de golpe cierra sus descriptores sin que llegue un CLOSE que
# case con nada. Por eso inotify solo sirve de DISPARADOR: cada evento provoca
# una comprobación real con `fuser`, que pregunta al kernel quién tiene el nodo
# abierto AHORA. Es la misma disciplina que el resto de monitores del repo:
# el evento avisa, el estado se confirma.
#
# El retardo `ASENTADO` antes de comprobar es justo lo que descarta el sondeo de
# Chromium: para cuando se mira, ese abrir-y-cerrar ya terminó y `fuser` no
# encuentra a nadie, así que el indicador no llega a parpadear.
#
# ── HOTPLUG ─────────────────────────────────────────────────────────────────
# Los nodos a vigilar hay que rearmarlos cuando se enchufa una webcam USB. Un
# segundo inotifywait vigila `/dev` (solo create/delete) y, al ver un `video*`,
# tumba al primero para que el bucle vuelva a enumerar. NO se vigila `/dev`
# entero con `-e open`: eso reportaría cada apertura de CUALQUIER hijo del
# directorio — `/dev/null`, `/dev/urandom`, los `/dev/dri/*` — o sea miles de
# eventos por minuto para filtrarlos casi todos.

NOTIF_APP="Cámara"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigios-source:system "${_a[@]}" "$@"
    }
fi

ESTADO="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/camara-uso.json"
# Margen entre el evento y la comprobación. Cubre el abrir-y-cerrar del sondeo
# de dispositivos de Chromium/Firefox sin que se note al empezar una llamada.
ASENTADO=0.4

# ── Enumeración ─────────────────────────────────────────────────────────────
# Solo los nodos de CAPTURA. Una webcam UVC registra además uno o dos nodos de
# metadatos que ninguna app usa para ver, y vigilarlos daría falsos positivos.
# El criterio es el mismo que en `ags/servicios/camara/dispositivos.ts`: la
# propiedad de udev `ID_V4L_CAPABILITIES`, que trae `:capture:` solo en los que
# capturan imagen. Se pregunta a udev y no a `v4l2-ctl` para no depender de que
# `v4l-utils` esté instalado: la detección de uso debe funcionar igual.
nodos_captura() {
    local nodo caps
    for nodo in /dev/video*; do
        [[ -c $nodo ]] || continue
        caps=$(udevadm info --query=property --name="$nodo" 2>/dev/null \
               | sed -n 's/^ID_V4L_CAPABILITIES=//p')
        # Sin la propiedad no se descarta: udev antiguo o regla desactivada. Es
        # preferible vigilar de más que dejar una cámara sin indicador.
        [[ -z $caps || $caps == *:capture:* ]] && printf '%s\n' "$nodo"
    done
}

nombre_de() {
    local nodo=$1 n
    n=$(udevadm info --query=property --name="$nodo" 2>/dev/null \
        | sed -n 's/^ID_V4L_PRODUCT=//p' | head -1)
    [[ -z $n ]] && n=$(cat "/sys/class/video4linux/${nodo##*/}/name" 2>/dev/null)
    printf '%s' "${n:-Cámara}"
}

# ── ¿Quién la tiene abierta? ────────────────────────────────────────────────
# `fuser` imprime los PID en stdout y su ruido en stderr. Se traduce cada PID a
# su `comm`, que es lo que el usuario reconoce ("firefox", "obs"). Los PID de
# procesos de otros usuarios no se ven sin root, pero eso no importa aquí: una
# cámara la abren apps de la sesión, que son nuestras.
apps_de() {
    local nodo=$1 pid comm
    for pid in $(fuser "$nodo" 2>/dev/null); do
        [[ $pid =~ ^[0-9]+$ ]] || continue
        comm=$(cat "/proc/$pid/comm" 2>/dev/null) || continue
        printf '%s\n' "$comm"
    done | sort -u
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

escribir() {
    local contenido=$1 tmp
    mkdir -p "${ESTADO%/*}" 2>/dev/null
    tmp="$ESTADO.tmp.$$"
    # Escritura atómica por rename(2): el Gio.FileMonitor de AGS vigila el
    # DIRECTORIO justo por esto, así que nunca llega a leer un JSON a medias.
    printf '%s\n' "$contenido" > "$tmp" && mv -f "$tmp" "$ESTADO"
}

escribir_libre() { escribir '{"enUso":false,"desde":null,"camaras":[]}'; }

if ! command -v inotifywait >/dev/null 2>&1; then
    # Sin inotify-tools no hay detección posible por esta vía. Se sale en
    # SILENCIO pero dejando el estado en LIBRE: un indicador de privacidad
    # clavado en "te están grabando" es peor que no tener indicador. La guarda
    # va aquí, y no arriba del todo, porque necesita `escribir_libre` ya
    # definida — llamarla antes no fallaba con error, simplemente no escribía.
    escribir_libre
    exit 0
fi

# ── El estado real, comprobado ──────────────────────────────────────────────
ultimo_uso=0     # 0 libre / 1 en uso — para avisar solo en la TRANSICIÓN
desde=null

comprobar() {
    local -a entradas=() apps
    local nodo app lista primera_nombre=""
    for nodo in "${NODOS[@]}"; do
        mapfile -t apps < <(apps_de "$nodo")
        ((${#apps[@]})) || continue
        lista=""
        for app in "${apps[@]}"; do
            lista+="${lista:+,}\"$(json_escape "$app")\""
        done
        local nombre; nombre=$(nombre_de "$nodo")
        [[ -z $primera_nombre ]] && primera_nombre=$nombre
        entradas+=("{\"nodo\":\"$(json_escape "$nodo")\",\"nombre\":\"$(json_escape "$nombre")\",\"apps\":[$lista]}")
    done

    if ((${#entradas[@]})); then
        [[ $ultimo_uso -eq 0 ]] && desde=$(date +%s)
        local unidas; unidas=$(IFS=,; printf '%s' "${entradas[*]}")
        escribir "{\"enUso\":true,\"desde\":$desde,\"camaras\":[$unidas]}"
        if ((ultimo_uso == 0)); then
            # Solo en el encendido. El apagado no se avisa: no es un suceso de
            # privacidad y duplicaría el ruido de cada videollamada.
            notificar camara.en-uso -u low "Cámara en uso" "$primera_nombre" -t 4000
        fi
        ultimo_uso=1
    else
        escribir_libre
        desde=null
        ultimo_uso=0
    fi
}

# ── Bucle principal ─────────────────────────────────────────────────────────
FIFO=$(mktemp -u "${TMPDIR:-/tmp}/camara-monitor.$$.XXXX")
mkfifo "$FIFO" || exit 0
# La FIFO y los hijos se limpian pase lo que pase: este script muere por
# `pkill -f camara-monitor.sh` cuando AGS lo reinicia en caliente, no solo al
# cerrar sesión.
limpiar() { rm -f "$FIFO"; kill "${PID_USO:-}" "${PID_DEV:-}" 2>/dev/null; }
trap 'limpiar; exit 0' EXIT INT TERM

escribir_libre

while :; do
    mapfile -t NODOS < <(nodos_captura)

    exec 3<>"$FIFO"
    PID_USO=""
    if ((${#NODOS[@]})); then
        inotifywait -q -m -e open -e close --format 'USO' "${NODOS[@]}" >&3 2>/dev/null &
        PID_USO=$!
        # Puede que ya hubiera una cámara abierta antes de arrancar nosotros
        # (reinicio de AGS a mitad de una videollamada): el primer estado se
        # siembra de lo vivo, no del primer evento que llegue.
        comprobar
    else
        escribir_libre
    fi
    # Hotplug. `--format '%f'` da solo el nombre del hijo dentro de /dev.
    inotifywait -q -m -e create -e delete --format 'DEV %f' /dev >&3 2>/dev/null &
    PID_DEV=$!

    while read -r etiqueta resto <&3; do
        case $etiqueta in
            USO)
                # Un solo asentado por ráfaga: al empezar una llamada llegan
                # varios OPEN seguidos (un nodo por formato) y no hace falta
                # comprobar una vez por cada uno.
                sleep "$ASENTADO"
                while read -r -t 0 <&3; do read -r _ <&3 || break; done
                comprobar
                ;;
            DEV)
                [[ $resto == video* ]] || continue
                # Rearmar: udev tarda unos ms en poner las propiedades del nodo
                # nuevo, y enumerar antes de eso lo dejaría fuera de la vigilancia.
                sleep 0.5
                break
                ;;
        esac
    done

    kill "$PID_USO" "$PID_DEV" 2>/dev/null
    wait "$PID_USO" "$PID_DEV" 2>/dev/null
    exec 3<&-
done
