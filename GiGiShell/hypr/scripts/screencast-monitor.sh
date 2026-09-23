#!/usr/bin/env bash
# Monitor de captura de pantalla (compartir + grabar).
#
# Escribe ~/.config/gigios/screencast.json; `CapturaPantalla` en la barra lo
# observa con un FileMonitor y muestra un icono rojo
# mientras algo esté capturando. Mismo patrón que updates-monitor.sh.
#
# Un único coordinador conserva por separado los dos estados:
#   - portal: `pw-mon` filtra eventos de vídeo, agrupa cada ráfaga y solo entonces
#             ejecuta `pw-dump`; los cambios de audio no provocan consultas.
#   - grabadores: sondea únicamente `pgrep` cada 3 s; cubre los que usan
#                 wlr-screencopy (wf-recorder y cía.) y NO tocan PipeWire.
# El coordinador combina ambos estados en memoria, sin archivos temporales ni
# carreras entre subprocesos.
#
# Preferencia (preferences.json), leída UNA sola vez al arrancar — patrón
# updatesMonitor: el setter maestro de AGS aplica el cambio en caliente vía
# pkill + relanzar.
#   screencastIndicator (bool, ausente=true)  maestro; false => borra json y sale

PREFERENCIAS="$HOME/.config/gigios/preferences.json"
SALIDA="$HOME/.config/gigios/screencast.json"

# Grabadores locales (no pasan por el portal): se detectan por proceso.
GRABADORES=(wf-recorder gpu-screen-recorder wl-screenrec obs)
INTERVALO=3       # segundos entre sondeos de grabadores
ESPERA_EVENTOS=0.3 # calma tras un evento de PipeWire antes de recalcular

# jq construye el JSON (escapa bien los nombres); pw-dump es la fuente del estado.
command -v jq      >/dev/null 2>&1 || { echo "[screencast-monitor] falta jq" >&2; exit 0; }
command -v pw-dump >/dev/null 2>&1 || { echo "[screencast-monitor] falta pw-dump" >&2; exit 0; }

# ── Preferencia (una sola lectura) ────────────────────────────────────────────
habilitado=true
if [[ -r "$PREFERENCIAS" ]]; then
    # `.k // true` sería incorrecto para un false literal (jq trata false como
    # ausente), de ahí el has()/tostring explícito.
    habilitado=$(jq -r 'if has("screencastIndicator") then (.screencastIndicator|tostring) else "true" end' "$PREFERENCIAS" 2>/dev/null) || habilitado=true
fi
[[ "$habilitado" == "false" ]] && { rm -f "$SALIDA"; exit 0; }

mkdir -p "$(dirname "$SALIDA")"

# ── Apagado limpio ────────────────────────────────────────────────────────────
# El toggle maestro apaga esto con `pkill -f screencast-monitor.sh`. Matamos el
# coproceso de eventos Y sus hijos (pw-mon, awk) y borramos el JSON, para no dejar
# el icono encendido tras apagar la función.
pids=()
_al_terminar() {
    for p in "${pids[@]}"; do
        pkill -P "$p" 2>/dev/null
        kill "$p" 2>/dev/null
        wait "$p" 2>/dev/null
    done
    rm -f "$SALIDA" "$SALIDA".tmp.*
    exit 0
}
trap _al_terminar TERM INT

# ── Estado: quién está capturando ─────────────────────────────────────────────
# Imprime una línea `kind<TAB>app` por captura activa. Sin capturas, no imprime nada.

# Screencasts del portal. Un cast activo = nodo PipeWire Video/Source creado por
# xdg-desktop-portal-* que esté `running` O tenga un link `active` hacia un
# consumidor. Exigir actividad es importante: Discord/Electron puede dejar un
# nodo `idle` huérfano al cerrar la sesión y su mera existencia no significa que
# siga capturando. Se excluyen las cámaras (v4l2/libcamera) para que la webcam no
# encienda el icono. Cuando se puede, se resuelve la app consumidora siguiendo el
# link hasta su nodo Stream/Input/Video; si no, la etiqueta cae a "Pantalla".
# Patrones fijados con datos reales en la Task 1 (Discord compartiendo):
#   nodo del portal   -> media.class=Video/Source, node.name="xdg-desktop-portal-hyprland"
#   webcam (a excluir)-> media.class=Video/Source, node.name="v4l2_input.*"
#   consumidor        -> media.class=Stream/Input/Video, node.name="Discord"
#                        (application.name viene VACÍO: el nombre está en node.name)
#   enlace            -> link.output.node=<portal> / link.input.node=<consumidor>, NÚMEROS
fuentes_portal() {
    pw-dump 2>/dev/null | jq -r '
      ([ .[]
         | select(.type == "PipeWire:Interface:Node")
         | (.info.props // {}) as $props
         | select(($props["media.class"] // "") == "Video/Source")
         | select((($props["node.name"] // "") | test("^v4l2_|^libcamera"; "i")) | not)
         | select(($props["node.name"] // "") | test("xdg-desktop-portal|xdpw"; "i"))
         | { id: ($props["object.id"] // empty),
             running: ((.info.state // "") == "running") } ]) as $sources
      | ($sources | map(.id)) as $source_ids
      | if ($sources | length) == 0 then empty else
          # id del nodo consumidor -> nombre a mostrar
          ([ .[]
             | select(.type == "PipeWire:Interface:Node")
             | (.info.props // {}) as $props
             | select(($props["media.class"] // "") | test("Stream/Input/Video"))
             | { key: (($props["object.id"] // 0) | tostring),
                 value: ([$props["application.name"], $props["node.name"], $props["application.process.binary"]]
                         | map(select(type == "string" and length > 0))
                         | .[0] // "Pantalla") } ]
           | from_entries) as $consumers
          | ([ .[]
               | select(.type == "PipeWire:Interface:Link")
               | select((.info.state // "") == "active")
               | (.info.props // {}) as $props
               | select(($source_ids | index($props["link.output.node"])) != null)
               | ($consumers[($props["link.input.node"] | tostring)] // "Pantalla") ]
             | unique) as $apps
          | (if ($apps | length) > 0 then $apps
             elif ($sources | any(.running)) then ["Pantalla"]
             else [] end)
          | .[]
          | "share\t" + .
        end'
}

# Grabadores locales, por proceso.
fuentes_grabadores() {
    local grabador
    for grabador in "${GRABADORES[@]}"; do
        # `comm` está limitado a 15 caracteres: `pgrep -x gpu-screen-recorder`
        # nunca casa. El argv completo con límites de ejecutable cubre nombres
        # cortos y largos sin confundir argumentos de otros procesos.
        pgrep -f "(^|/)${grabador}([[:space:]]|$)" >/dev/null 2>&1 && printf 'record\t%s\n' "$grabador"
    done
}

# ── Escritura atómica, solo si cambió ─────────────────────────────────────────
# Se compara el conjunto de fuentes (no el JSON entero: checkedAt siempre difiere),
# así una sesión de 2 h compartiendo no reescribe el fichero ni despierta al widget.
# El memo arranca con un centinela que NO puede ser un conjunto de fuentes válido:
# si arrancara vacío, el primer emitir() con nada capturando se compararía consigo
# mismo, decidiría "no ha cambiado" y NO escribiría — dejando en pie un
# screencast.json rancio de la sesión anterior (p. ej. un "Discord compartiendo"
# que sobrevive a un reboot). El icono se quedaba encendido para siempre.
estado_portal=""
estado_grabadores=""
ultimo="__unset__"
emitir() {
    local fuentes="$estado_portal"
    if [[ -n "$estado_grabadores" ]]; then
        [[ -n "$fuentes" ]] && fuentes+=$'\n'
        fuentes+="$estado_grabadores"
    fi
    [[ "$fuentes" == "$ultimo" ]] && return 0
    ultimo="$fuentes"

    local temporal="$SALIDA.tmp.$$"
    if [[ -z "$fuentes" ]]; then
        jq -n --argjson t "$(date +%s)" '{active:false, checkedAt:$t, sources:[]}' > "$temporal" || { rm -f "$temporal"; return 1; }
    else
        printf '%s\n' "$fuentes" | jq -R -s --argjson t "$(date +%s)" '
          split("\n") | map(select(length > 0) | split("\t") | {kind: .[0], app: .[1]})
          | {active: (length > 0), checkedAt: $t, sources: .}' > "$temporal" || { rm -f "$temporal"; return 1; }
    fi
    mv -f "$temporal" "$SALIDA"
}

# ── Eventos relevantes de PipeWire ───────────────────────────────────────────
# `pw-mon -p` separa cada evento con una línea vacía. awk conserva los ids de los
# nodos de screencast y sus links para reconocer también eventos parciales y
# eliminaciones, que ya no traen todas las propiedades. Solo emite una señal por
# cambio de ese subgrafo; volumen, micrófono y el resto del audio se ignoran.
eventos_video_pipewire() {
    LC_ALL=C pw-mon -N -a -p 2>/dev/null | awk '
      BEGIN { RS = ""; ORS = "" }

      function object_id(block, lines, count, i, line) {
        count = split(block, lines, "\n")
        for (i = 1; i <= count; i++) {
          line = lines[i]
          if (line ~ /^[[:space:]]*id:[[:space:]]*[0-9]+/) {
            sub(/^[[:space:]]*id:[[:space:]]*/, "", line)
            sub(/[^0-9].*$/, "", line)
            return line + 0
          }
        }
        return -1
      }

      function property_id(block, key, lines, count, i, line, pos, value) {
        count = split(block, lines, "\n")
        for (i = 1; i <= count; i++) {
          line = lines[i]
          pos = index(line, key " = ")
          if (pos > 0) {
            value = substr(line, pos + length(key) + 3)
            gsub(/["[:space:]]/, "", value)
            if (value ~ /^[0-9]+$/)
              return value + 0
          }
        }
        return -1
      }

      {
        block = $0
        id = object_id(block)
        is_node = block ~ /type: PipeWire:Interface:Node/
        is_link = block ~ /type: PipeWire:Interface:Link/
        is_removed = block ~ /(^|\n)removed:/

        if (is_node &&
            ((block ~ /media.class = "Stream\/Input\/Video"/) ||
             (block ~ /media.class = "Video\/Source"/ &&
              block ~ /node.name = "(xdg-desktop-portal|xdpw)/)))
          video_nodes[id] = 1

        if (is_link) {
          output_node = property_id(block, "link.output.node")
          input_node = property_id(block, "link.input.node")
          if ((output_node in video_nodes) || (input_node in video_nodes))
            video_links[id] = 1
        }

        relevant = (id in video_nodes) || (id in video_links)
        if (is_removed) {
          delete video_nodes[id]
          delete video_links[id]
        }

        if (relevant) {
          print "video\n"
          fflush()
        }
      }
    '
}

actualizar_portal() {
    estado_portal=$(fuentes_portal)
    emitir
}

actualizar_grabadores() {
    estado_grabadores=$(fuentes_grabadores)
    emitir
}

iniciar_monitor_pipewire() {
    # El toggle usa `pkill -f screencast-monitor.sh`. Un coproceso Bash normal
    # heredaría ese argv y recibiría TERM a la vez que el padre, pudiendo dejar
    # pw-mon huérfano antes de que el trap lo limpiara. El argv independiente
    # hace que solo el coordinador reciba la señal y cierre sus hijos en orden.
    export -f eventos_video_pipewire
    coproc EVENTOS_PIPEWIRE { exec -a gigios-screencast-events bash -c eventos_video_pipewire; }
    fd_eventos_pipewire=${EVENTOS_PIPEWIRE[0]}
    pid_eventos_pipewire=$EVENTOS_PIPEWIRE_PID
    pids=("$pid_eventos_pipewire")
}

# ── Coordinador ───────────────────────────────────────────────────────────────
# El coproceso se inicia antes del estado inicial para no perder un alta/baja
# entre el primer pw-dump y la suscripción. El pequeño margen permite que pw-mon
# termine de registrar el grafo actual; sus señales quedan esperando en el pipe.
if command -v pw-mon >/dev/null 2>&1; then
    iniciar_monitor_pipewire
    sleep "$ESPERA_EVENTOS"
fi

estado_portal=$(fuentes_portal)
estado_grabadores=$(fuentes_grabadores)
emitir

if ! command -v pw-mon >/dev/null 2>&1; then
    # Sin pw-mon degradamos a un único sondeo combinado: peor, pero funcional.
    while :; do
        sleep "$INTERVALO"
        estado_portal=$(fuentes_portal)
        estado_grabadores=$(fuentes_grabadores)
        emitir
    done
fi

proxima_revision_grabadores=$((SECONDS + INTERVALO))
while :; do
    ahora=$SECONDS
    if (( ahora >= proxima_revision_grabadores )); then
        actualizar_grabadores
        proxima_revision_grabadores=$((SECONDS + INTERVALO))
        continue
    fi

    segundos_espera=$((proxima_revision_grabadores - ahora))
    if IFS= read -r -t "$segundos_espera" -u "$fd_eventos_pipewire" _evento; then
        # Debounce real: cada señal reinicia el plazo; se recalcula una sola vez
        # cuando pasan ESPERA_EVENTOS segundos sin otro evento de vídeo.
        while IFS= read -r -t "$ESPERA_EVENTOS" -u "$fd_eventos_pipewire" _evento; do :; done
        actualizar_portal
    elif ! kill -0 "$pid_eventos_pipewire" 2>/dev/null; then
        # Si PipeWire se reinicia, no dejamos morir el indicador: sincronizamos
        # el estado, recogemos el coproceso anterior y volvemos a suscribirnos.
        wait "$pid_eventos_pipewire" 2>/dev/null
        actualizar_portal
        iniciar_monitor_pipewire
    fi
done
