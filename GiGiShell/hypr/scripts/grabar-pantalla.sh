#!/usr/bin/env bash
set -uo pipefail

# Toggle de grabación del monitor activo o de una ventana seleccionada, siempre
# con el audio interno del sistema.
# La primera invocación arranca wf-recorder y espera a que termine; la segunda
# valida su PID y le envía SIGINT para que cierre correctamente el contenedor MP4.

umask 077

directorio_estado="${XDG_RUNTIME_DIR:-/tmp}/gigios"
archivo_estado="$directorio_estado/grabacion-pantalla.estado"
archivo_bloqueo="$directorio_estado/grabacion-pantalla.lock"
archivo_log="$directorio_estado/grabacion-pantalla.log"

NOTIF_APP="GiGiShell"
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

avisar() {
    local evento="$1" urgencia="$2" titulo="$3" cuerpo="$4"

    command -v notify-send >/dev/null 2>&1 || return 0
    notificar "$evento" -u "$urgencia" "$titulo" "$cuerpo" 2>/dev/null || true
}

fallar() {
    avisar grabacion.error critical "Grabación de pantalla" "$1"
    printf 'grabar-pantalla: %s\n' "$1" >&2
    exit 1
}

mkdir -p "$directorio_estado" || fallar "No se pudo crear el directorio de estado."
exec 9>"$archivo_bloqueo"
flock -x 9 || fallar "No se pudo bloquear el estado de la grabación."

pid_grabador=""
ruta_grabacion=""

grabacion_activa() {
    local argumento=""
    local ruta_encontrada=false

    [[ -r "$archivo_estado" ]] || return 1
    {
        IFS= read -r pid_grabador || true
        IFS= read -r ruta_grabacion || true
    } < "$archivo_estado"

    [[ "$pid_grabador" =~ ^[0-9]+$ ]] || return 1
    [[ -n "$ruta_grabacion" ]] || return 1
    kill -0 "$pid_grabador" 2>/dev/null || return 1
    [[ -r "/proc/$pid_grabador/comm" ]] || return 1
    [[ "$(<"/proc/$pid_grabador/comm")" == "wf-recorder" ]] || return 1
    [[ -r "/proc/$pid_grabador/cmdline" ]] || return 1

    while IFS= read -r -d '' argumento; do
        if [[ "$argumento" == "$ruta_grabacion" ]]; then
            ruta_encontrada=true
            break
        fi
    done < "/proc/$pid_grabador/cmdline"

    [[ "$ruta_encontrada" == true ]]
}

if grabacion_activa; then
    kill -INT "$pid_grabador" 2>/dev/null \
        || fallar "No se pudo detener la grabación activa."
    flock -u 9
    exit 0
fi

# El estado puede quedar obsoleto tras un cierre forzado. Solo se borra después
# de comprobar que no señala a nuestro wf-recorder y a su fichero exacto.
rm -f "$archivo_estado"

command -v wf-recorder >/dev/null 2>&1 || fallar "Falta wf-recorder."
command -v hyprctl >/dev/null 2>&1 || fallar "Falta hyprctl."
command -v jq >/dev/null 2>&1 || fallar "Falta jq."
command -v pactl >/dev/null 2>&1 || fallar "Falta pactl."

modo="${1:-monitor}"
prefijo_archivo="grabacion"
argumentos_captura=()

case "$modo" in
    monitor)
        monitor="$(hyprctl monitors -j 2>/dev/null \
            | jq -r 'first(.[] | select(.focused == true) | .name) // empty' 2>/dev/null)"
        [[ -n "$monitor" ]] || fallar "No se pudo determinar el monitor activo."
        argumentos_captura=(-o "$monitor")
        ;;
    ventana)
        command -v slurp >/dev/null 2>&1 || fallar "Falta slurp."

        workspaces_visibles="$(hyprctl monitors -j 2>/dev/null \
            | jq -c '[.[].activeWorkspace.id]' 2>/dev/null)"
        [[ -n "$workspaces_visibles" && "$workspaces_visibles" != "[]" ]] \
            || fallar "No se pudieron determinar los workspaces visibles."

        geometrias_ventanas="$(hyprctl clients -j 2>/dev/null \
            | jq -r --argjson visibles "$workspaces_visibles" '.[]
                | .workspace.id as $workspace
                | select($visibles | index($workspace))
                | select(.mapped == true and .hidden == false)
                | select(.size[0] > 0 and .size[1] > 0)
                | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"' 2>/dev/null)"
        [[ -n "$geometrias_ventanas" ]] \
            || fallar "No hay ventanas seleccionables en los workspaces visibles."

        geometria_ventana="$(printf '%s\n' "$geometrias_ventanas" \
            | slurp -r -f '%x,%y %wx%h')" || {
            # Escape cancela la selección; no es un error ni debe notificar.
            flock -u 9
            exit 0
        }

        [[ -n "$geometria_ventana" ]] || {
            flock -u 9
            exit 0
        }
        prefijo_archivo="grabacion_ventana"
        argumentos_captura=(-g "$geometria_ventana")
        ;;
    *)
        fallar "Modo desconocido: $modo. Usa monitor o ventana."
        ;;
esac

salida_audio="$(pactl get-default-sink 2>/dev/null)"
[[ -n "$salida_audio" ]] || fallar "No se pudo determinar la salida de audio."
fuente_audio="${salida_audio}.monitor"

if ! pactl list short sources 2>/dev/null \
    | awk '{ print $2 }' \
    | grep -Fxq "$fuente_audio"; then
    fallar "No se encontró la fuente de audio interno $fuente_audio."
fi

directorio_videos="$(xdg-user-dir VIDEOS 2>/dev/null || true)"
if [[ -z "$directorio_videos" || "$directorio_videos" == "$HOME" ]]; then
    directorio_videos="$HOME/Videos"
fi
directorio_grabaciones="${GIGIOS_GRABACION_DIRECTORIO:-$directorio_videos/Grabaciones_Pantalla}"
mkdir -p "$directorio_grabaciones" \
    || fallar "No se pudo crear $directorio_grabaciones."

ruta_grabacion="$directorio_grabaciones/${prefijo_archivo}_$(date +%Y%m%d_%H%M%S).mp4"
: > "$archivo_log"

# Codificación por hardware primero. El bloque NVENC de la GPU es silicio aparte
# de los núcleos de render, así que grabar deja de competir con la composición
# del escritorio: con el libx264 por defecto una grabación de monitor costaba
# ~175% de CPU y dejaba toda la sesión a tirones (Hyprland compone cada frame,
# y el codificador le robaba los núcleos). El encoder por software se mantiene
# como respaldo — sin GPU NVIDIA, con un driver que no expone NVENC o con las
# sesiones concurrentes de NVENC agotadas, la grabación arranca igual en vez de
# no arrancar. La cadena termina en "" (sin -c), que es el defecto de
# wf-recorder, para que el respaldo sea exactamente el comportamiento anterior.
codecs_grabacion=(h264_nvenc "")

iniciar_grabador() {
    local codec="$1"
    local -a argumentos_codec=()

    [[ -n "$codec" ]] && argumentos_codec=(-c "$codec")

    wf-recorder \
        "${argumentos_captura[@]}" \
        "${argumentos_codec[@]}" \
        --audio="$fuente_audio" \
        -f "$ruta_grabacion" \
        >"$archivo_log" 2>&1 &
    pid_grabador=$!

    printf '%s\n%s\n' "$pid_grabador" "$ruta_grabacion" > "$archivo_estado"

    # Una pausa corta permite detectar fallos inmediatos de salida, audio o codec
    # sin anunciar una grabación que realmente no llegó a empezar. Es además la
    # ventana en la que se decide el respaldo: un NVENC que no inicializa muere
    # aquí, al abrir el dispositivo, no a mitad de la grabación. 0,25 s bastaba
    # para un fallo de audio o de fichero; abrir el codificador de la GPU es más
    # lento, y quedarse corto haría fallar la grabación en vez de degradarla.
    sleep 0.5
    if kill -0 "$pid_grabador" 2>/dev/null; then
        return 0
    fi

    wait "$pid_grabador" 2>/dev/null || true
    rm -f "$archivo_estado"
    pid_grabador=""
    return 1
}

for codec_grabacion in "${codecs_grabacion[@]}"; do
    iniciar_grabador "$codec_grabacion" && break

    detalle="$(tail -n 1 "$archivo_log" 2>/dev/null)"
    # Degradar a software no es un error para el usuario: la grabación va a
    # ocurrir igual. Queda en el log de la sesión, no en una notificación.
    [[ -n "$codec_grabacion" ]] && printf \
        'grabar-pantalla: %s no disponible%s; se recurre al codec por software\n' \
        "$codec_grabacion" "${detalle:+: $detalle}" >&2
done

[[ -n "$pid_grabador" ]] \
    || fallar "No se pudo iniciar la grabación${detalle:+: $detalle}"

flock -u 9

# Si el wrapper recibe una señal, pide también un cierre limpio del grabador.
trap 'kill -INT "$pid_grabador" 2>/dev/null || true' INT TERM HUP

estado_salida=0
wait "$pid_grabador" || estado_salida=$?
trap - INT TERM HUP

flock -x 9 || true
pid_estado=""
if [[ -r "$archivo_estado" ]]; then
    IFS= read -r pid_estado < "$archivo_estado" || true
fi
if [[ "$pid_estado" == "$pid_grabador" ]]; then
    rm -f "$archivo_estado"
fi
flock -u 9 || true

if [[ -s "$ruta_grabacion" ]]; then
    avisar grabacion.guardada normal "Grabación guardada" "$ruta_grabacion"
    exit 0
fi

detalle="$(tail -n 1 "$archivo_log" 2>/dev/null)"
fallar "La grabación terminó sin generar vídeo${detalle:+: $detalle} (código $estado_salida)."
