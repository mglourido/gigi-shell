# shellcheck shell=bash
# lib/gaming-gate.sh — "¿estoy jugando?" compartido, para congelar trabajo de
# fondo PRESCINDIBLE mientras hay un juego delante. Se SOURCEA, no se ejecuta.
#
# Reutiliza el flag que ya existe: ~/.config/gigios/runtime-state.json, escrito por
# AGS (servicios/energia/gamingState.ts) reusando a su vez la detección `isGameClient`
# de la barra. Aquí NO se vuelve a detectar nada — bash no sabría hacerlo mejor.
#
# QUÉ SE CONGELA Y QUÉ NO — la lista corta, porque la asimetría es el diseño:
#
#   Se congela (sondeo de mantenimiento: caro, y nada de lo que mira es urgente)
#     · updates-monitor.sh   → red + sincronizar una BD temporal de pacman
#     · oom-monitor monitor_smart → smartctl DESPIERTA cada disco físico
#     · oom-monitor monitor_units → 4 forks de systemctl + awk cada 120 s
#     · oom-monitor monitor_downloads → ya tenía su propia pausa (dlPauseWhileGaming);
#       es la más cara de todas (clamscan recarga ~200 MB de firmas POR invocación)
#
#   NO se congela, y no es un olvido:
#     · monitor_kernel / monitor_system / monitor_files — son SEGUIDORES de eventos
#       (journalctl -f, inotifywait). No recuperan el pasado: leen con `-n 0` a
#       propósito. Congelarlos no ahorraría nada (están bloqueados, ~0 % de CPU) y
#       convertiría un OOM, un sudo fallido o un cambio en /etc/shadow en una
#       VENTANA CIEGA — justo lo que el script existe para evitar.
#     · temp-monitor.sh — jugar es exactamente cuando la CPU y la GPU se cuecen.
#       Congelar el termómetro apaga la alarma en el único momento que importa.
#     · ram-monitor.sh / battery-monitor.sh — bucle de builtins puros, cero forks
#       por tick, y las dos cosas que vigilan importan MÁS con un juego delante.
#     · usb / bt / wifi / screencast — event-driven, baratos y de cara al usuario
#       (y screencast es el que enciende el icono justo cuando retransmites).
#     · disk-monitor.sh — one-shot al arrancar; para cuando juegas ya salió.
#
# SEGUNDO MOTIVO PARA CONGELAR: el MODO AHORRO. La lista de arriba es exactamente la
# misma —sondeo caro y aplazable— y la razón es hermana: al jugar molesta, con la
# batería baja cuesta autonomía (smartctl DESPIERTA discos, updates enciende la radio).
# Lo decide AGS y llega ya combinado como `powerSaveFreeze` en el mismo fichero (ahorro
# activo Y el interruptor de Ajustes > Energía > "Reducir procesos en segundo plano").
# Aquí NO se rederiva: mirar /sys/class/power_supply a mano ya salió mal una vez —lista
# también la pila del ratón, que reporta `Discharging` para siempre; ver _is_system_battery
# en oom-monitor.sh—, y AGS ya tiene la respuesta buena vía upower.
# Ojo: este motivo NO pasa por `gamingFreeze`. Son dos interruptores distintos, cada uno
# con su UI; apagar la congelación al jugar no debe apagar la del ahorro.
#
# APAGAR LA DETECCIÓN ENTERA: Ajustes > Juegos > "Detectar juegos en marcha"
# (`escanerJuegos` en preferences.json) para de raíz el escáner de ventanas del shell. No
# hace falta tocar nada aquí: sin escáner AGS escribe `gaming: false` de forma permanente
# —y `gameScanner: false` al lado, por si algún lector quiere distinguir "ahora no hay
# ninguna partida" de "en este equipo no se juega"—, así que el motivo "juego" no se
# dispara nunca y `gamingFreeze` queda sin efecto. El motivo AHORRO sigue igual: es otro
# interruptor y no pasa por la detección.

# El gate BLOQUEA, no SALTA: el trabajo aplazado se hace en cuanto cierras el juego,
# no se pierde. Por eso va justo ANTES del cuerpo del sondeo y DESPUÉS de la espera
# (así updates-monitor sigue bloqueado en su inotify, que no cuesta nada).

GAMING_STATE_FILE="${GAMING_STATE_FILE:-$HOME/.config/gigios/runtime-state.json}"
GAMING_PREFS_FILE="${GAMING_PREFS_FILE:-$HOME/.config/gigios/preferences.json}"

# Cada cuánto se vuelve a mirar el flag mientras el gate retiene trabajo. Es un SUELO,
# no un periodo fijo: con el juego aparcado la espera se estira hasta el vencimiento de
# la gracia, que es una fecha conocida (ver `_gg_plan_wait`).
GAMING_GATE_POLL="${GAMING_GATE_POLL:-10}"

# Cuánto sigue contando como "jugando" desde que el juego pierde el foco. Cubre el
# alt-tab a Discord o al navegador sin descongelar; pasado el plazo, un juego dejado
# abierto en otro workspace deja de bloquear el mantenimiento.
GAMING_FOCUS_GRACE="${GAMING_FOCUS_GRACE:-300}"   # 5 min

# Margen entre "ya se puede trabajar" y empezar de verdad. Al cerrar un juego el
# sistema todavía está devolviendo RAM y VRAM y rebajando los relojes, y arrancar ahí
# mismo un smartctl o un clamscan es justo el tirón que se nota al volver al
# escritorio. Cinco segundos no le importan a nada de lo que hay detrás de este gate
# (el sondeo más frecuente es de 120 s) y se pagan UNA vez por descongelación.
GAMING_GATE_RESUME_DELAY="${GAMING_GATE_RESUME_DELAY:-5}"

# Cómo dormir. El valor por defecto `sleep` ya NO ejecuta /usr/bin/sleep: lo atiende
# `_gg_sleep` con el builtin `read -t` (ver más abajo), que no forkea y que atiende las
# señales al instante. updates-monitor lo pone a su helper `blocking` porque allí el
# durmiente convive con su propio trap y su toggle maestro (ver `blocking()` en ese
# script); cualquier valor distinto de `sleep` se respeta tal cual.
GAMING_GATE_SLEEP="${GAMING_GATE_SLEEP:-sleep}"

# Durmiente sin forks y que NO difiere señales.
#
# Medido, porque es el motivo entero de que esto exista: con un trap instalado —y los
# sub-monitores de oom-monitor.sh instalan uno (TERM/INT/HUP)— bash APLAZA el handler
# hasta que termina el hijo en primer plano. Un `sleep 15` retrasó el trap 15 s; un
# `read -t 300` lo atendió en cuanto llegó la señal. Con /usr/bin/sleep, alargar la
# espera habría costado exactamente ese retraso en el apagado; con el builtin, la
# duración de la espera y la latencia de señal dejan de estar atadas.
#
# El fifo se abre en lectura-escritura y se desenlaza en el acto: así no hay datos ni
# EOF —`read` se queda hasta agotar el timeout— y no queda nada en /tmp. Un fd por
# proceso, abierto una sola vez.
_gg_fd=""
_gg_sleep() {
    local _gg_void rc
    # Un durmiente puesto por el consumidor manda (updates-monitor: `blocking sleep`).
    if [[ "$GAMING_GATE_SLEEP" != sleep ]]; then
        $GAMING_GATE_SLEEP "$1"
        return
    fi
    if [[ -z "$_gg_fd" ]]; then
        local fifo
        fifo=$(mktemp -u "${TMPDIR:-/tmp}/.gaming-gate.$$.XXXXXX") &&
            mkfifo "$fifo" 2>/dev/null &&
            exec {_gg_fd}<>"$fifo" 2>/dev/null || _gg_fd=""
        [[ -n "$fifo" ]] && rm -f "$fifo"
        # Sin fifo (TMPDIR de solo lectura, sin mkfifo) se cae al sleep de siempre:
        # peor latencia de señal, pero el gate sigue funcionando igual.
        [[ -z "$_gg_fd" ]] && { sleep "$1"; return; }
    fi
    read -r -t "$1" -u "$_gg_fd" _gg_void
    rc=$?
    # rc > 128 es "se agotó el timeout", o sea el caso NORMAL: se durmió lo pedido.
    # Devolverlo tal cual haría que el `|| return 0` de quien llama abortara la espera
    # en la primera vuelta y la congelación no congelaría nada.
    (( rc > 128 )) && return 0
    return $rc
}

# Caché del ajuste maestro: `gamingFreeze` en preferences.json. Se lee EN VIVO (no
# una vez al arrancar, como los toggles de evento) porque es un control de recursos
# y apagarlo debe surtir efecto sin reiniciar nada — pero con TTL, para no forkear
# un jq en cada vuelta del bucle de espera.
_gg_pref=""
_gg_pref_at=0
GAMING_GATE_PREF_TTL="${GAMING_GATE_PREF_TTL:-30}"

# 0 = la congelación está activada (default: sí, clave ausente = activada).
_gg_enabled() {
    local now=$SECONDS
    if [[ -n "$_gg_pref" ]] && (( now - _gg_pref_at < GAMING_GATE_PREF_TTL )); then
        [[ "$_gg_pref" != false ]]
        return
    fi
    _gg_pref_at=$now
    if command -v jq >/dev/null 2>&1; then
        # `.gamingFreeze // true` sería INCORRECTO: el operador // de jq trata un
        # `false` literal como ausente, así que siempre resolvería a true (mismo
        # tropiezo documentado en battery-monitor.sh y temp-monitor.sh).
        _gg_pref=$(jq -r 'if has("gamingFreeze") then (.gamingFreeze|tostring) else "true" end' \
            "$GAMING_PREFS_FILE" 2>/dev/null) || _gg_pref=true
    else
        _gg_pref=true
    fi
    [[ -z "$_gg_pref" ]] && _gg_pref=true
    [[ "$_gg_pref" != false ]]
}

# Lee el fichero de estado en la variable cuyo NOMBRE se pasa en $1, y valida la guarda
# del pid. 0 = hay estado utilizable. La comparten los dos motivos de congelación, y por
# eso `_gg_freeze_now` la llama UNA sola vez por vuelta y reparte el texto leído a los
# dos predicados de abajo: antes cada motivo reabría y releía el fichero por su cuenta.
_gg_read_state() {
    local -n _gg_out=$1          # `_gg_out` y no `_out`: un nameref que coincida con el
    local pid                    # nombre que pasa quien llama es un error circular.
    [[ -r "$GAMING_STATE_FILE" ]] || return 1
    # `read -d ''` sin NUL en el fichero devuelve 1 aunque HAYA leído todo: el
    # `|| true` es para que esto siga siendo seguro si alguien lo sourcea con set -e.
    IFS= read -r -d '' _gg_out < "$GAMING_STATE_FILE" 2>/dev/null || true
    [[ "$_gg_out" =~ \"pid\"[[:space:]]*:[[:space:]]*([0-9]+) ]] || return 1
    pid="${BASH_REMATCH[1]}"
    [[ -d "/proc/$pid" ]]
}

# ── Predicados sobre el texto YA leído ($1) ───────────────────────────────────
# Separarlos de la lectura es lo que permite decidir los dos motivos con una sola
# lectura del fichero. Las funciones públicas de más abajo son la envoltura que lee.

# ¿Está el modo ahorro pidiendo congelar? 0 = sí.
_gg_powersave_from() {
    [[ "$1" =~ \"powerSaveFreeze\"[[:space:]]*:[[:space:]]*true ]]
}

# ¿Hay un juego delante? 0 = sí.
_gg_gaming_from() {
    local raw=$1 last
    [[ "$raw" =~ \"gaming\"[[:space:]]*:[[:space:]]*true ]] || return 1

    # Juego ABIERTO no es lo mismo que juego que ESTÁS JUGANDO. `gaming` vive hasta
    # que la ventana cierra —y eso está bien, irse a otro workspace 30 s no es dejar
    # de jugar— pero por sí solo dejaba el mantenimiento congelado el día entero si
    # aparcabas un juego abierto mientras trabajabas. Con el foco delante congela; sin
    # él, congela solo durante la GRACIA, contada desde que el juego lo perdió.
    #
    # La gracia es lo que evita el efecto contrario, que sería peor: descongelar en
    # cada alt-tab haría que un vistazo de 10 s a Discord lanzara smartctl y clamscan
    # con el juego cargado y a punto de recuperar el foco.
    [[ "$raw" =~ \"gameFocused\"[[:space:]]*:[[:space:]]*true ]] && return 0
    if [[ "$raw" =~ \"lastGameFocus\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
        last="${BASH_REMATCH[1]}"
        (( last > 0 )) || return 0                       # sin sellar aún → como jugando
        (( EPOCHSECONDS - last < GAMING_FOCUS_GRACE )) && return 0
        return 1                                          # aparcado hace rato → a trabajar
    fi
    # Fichero de un AGS anterior (sin las claves de foco): se conserva el
    # comportamiento de antes —congelar mientras el juego viva— en vez de inventar.
    # Se auto-corrige en cuanto AGS reescriba el fichero.
    return 0
}

# ── API ───────────────────────────────────────────────────────────────────────

# ¿Está el modo ahorro pidiendo congelar AHORA? 0 = sí.
#
# El valor ya viene decidido y combinado por AGS (ahorro activo Y el interruptor de
# Ajustes > Energía). Aquí solo se lee, con la misma guarda de pid y el mismo fail-open
# que `gaming_active`: si AGS no está, se trabaja. Una clave ausente (fichero de un AGS
# anterior) es "no congelar", que es el comportamiento de antes de esta función.
powersave_freeze_active() {
    local raw
    _gg_read_state raw || return 1
    _gg_powersave_from "$raw"
}

# ¿Hay un juego delante AHORA? 0 = sí.
#
# Sin forks: el fichero es un JSON diminuto que AGS reescribe entero, así que se lee
# con un redirect builtin y se casa con regex. Un jq cada 10 s durante una partida de
# tres horas sería justo el tipo de coste que este gate existe para quitar.
#
# FAIL-OPEN, y la asimetría es deliberada: sin fichero, con JSON corrupto, sin pid o
# con el pid muerto se responde "no estoy jugando" y el trabajo SE HACE. Un fallo
# aquí debe degradar a "la congelación no funciona" —visible, y lo peor que pasa es
# que un juego pega un tirón— y nunca a "los escáneres no vuelven a correr jamás",
# que es silencioso, permanente y no tiene UI donde notarse.
#
# De ahí la guarda del pid, que es de AGS (el mismo patrón que wakeup.json): si AGS
# MUERE con el flag en true, el fichero se queda en true para siempre y sin ella
# updates/smart/units quedarían congelados el resto de la sesión sin que nada lo
# delatara. La otra mitad de la cadena la pone initGamingState(), que reescribe el
# flag al arrancar el shell — necesaria porque los pid se RECICLAN y el de un AGS
# muerto puede acabar ocupado por otro proceso vivo.
gaming_active() {
    local raw
    _gg_read_state raw || return 1
    _gg_gaming_from "$raw"
}

# Cuánto conviene dormir antes de volver a mirar. Lo deja en `_gg_wait_secs` en vez de
# imprimirlo: un `$(...)` forkearía una subshell en cada vuelta, justo lo que se evita.
#
# El caso que arregla es el del juego APARCADO —abierto, sin foco, dentro de la gracia—.
# Ahí ya se sabe el instante EXACTO en que hay que descongelar (`lastGameFocus` + gracia),
# así que preguntar cada 10 s no aporta nada: se duerme hasta el plazo y se despierta una
# vez en vez de treinta. El plazo se recalcula en cada despertar, que es lo que cubre que
# el juego recupere y vuelva a perder el foco (el sello se mueve y con él la fecha).
#
# Con el foco puesto se mantiene el sondeo normal: ahí no hay plazo que valga —lo que se
# espera es que cierres el juego, y eso no tiene fecha.
_gg_wait_secs=$GAMING_GATE_POLL
_gg_plan_wait() {
    local raw=$1 last restante
    _gg_wait_secs=$GAMING_GATE_POLL
    [[ "$raw" =~ \"gameFocused\"[[:space:]]*:[[:space:]]*true ]] && return 0
    [[ "$raw" =~ \"lastGameFocus\"[[:space:]]*:[[:space:]]*([0-9]+) ]] || return 0
    last="${BASH_REMATCH[1]}"
    (( last > 0 )) || return 0
    restante=$(( last + GAMING_FOCUS_GRACE - EPOCHSECONDS ))
    (( restante > _gg_wait_secs )) && _gg_wait_secs=$restante
    return 0
}

# ¿Hay algún motivo para congelar AHORA? 0 = sí. `gamingFreeze` solo gobierna el motivo
# "juego"; el del ahorro tiene su propio interruptor, ya aplicado por AGS.
#
# Una sola lectura del fichero para los dos motivos, y el juego se evalúa ANTES que la
# preferencia a propósito: `_gg_gaming_from` es regex sobre texto ya leído, mientras que
# `_gg_enabled` puede forkear un jq. Sin juego delante —el caso normal, y el que se
# recorre en cada vuelta del bucle de cada monitor— este camino no forkea NADA.
#
# Deja además en `_gg_wait_secs` cuánto dormir. El plazo largo se calcula SOLO desde el
# motivo "juego": el del ahorro depende de la batería, que no tiene fecha de vencimiento,
# así que ahí se mantiene el sondeo corto.
_gg_freeze_now() {
    local raw
    _gg_wait_secs=$GAMING_GATE_POLL
    _gg_read_state raw || return 1     # fail-open: sin estado utilizable, se trabaja
    if { _gg_gaming_from "$raw" && _gg_enabled; }; then
        _gg_plan_wait "$raw"
        return 0
    fi
    _gg_powersave_from "$raw"
}

# Bloquea mientras haya un juego delante. Devuelve cuando se puede trabajar.
# Sin juego (o con la congelación apagada) vuelve al instante y sin forkear nada.
#
# $1 = etiqueta opcional, solo para depurar con GAMING_GATE_DEBUG=1.
gaming_gate_wait() {
    _gg_freeze_now || return 0

    [[ -n "${GAMING_GATE_DEBUG:-}" ]] && \
        printf '[gaming-gate] congelado: %s\n' "${1:-?}" >&2

    # Apagar cualquiera de los dos interruptores a mitad de espera descongela sin
    # esperar a que el juego cierre ni a que suba la batería: ambos se releen aquí.
    while _gg_freeze_now; do
        _gg_sleep "$_gg_wait_secs" || return 0
    done

    # Respiro antes de volver a la carga (ver GAMING_GATE_RESUME_DELAY). Solo se
    # ejecuta si de verdad hubo congelación: en el camino sin juego ya se salió arriba
    # sin dormir ni forkear nada.
    (( GAMING_GATE_RESUME_DELAY > 0 )) && _gg_sleep "$GAMING_GATE_RESUME_DELAY"

    [[ -n "${GAMING_GATE_DEBUG:-}" ]] && \
        printf '[gaming-gate] reanudado: %s\n' "${1:-?}" >&2
    return 0
}
