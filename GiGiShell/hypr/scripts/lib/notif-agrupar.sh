# shellcheck shell=bash
# lib/notif-agrupar.sh — agrupación de notificaciones en ráfaga. Se SOURCEA, no se
# ejecuta.
#
# EL PROBLEMA: los monitores notifican POR EVENTO, y los eventos no vienen de uno en
# uno. Un `pacman -Syu` toca decenas de ficheros vigilados; una GPU que se atraganta
# escupe la misma línea NVRM cuarenta veces seguidas; un hub con tres pendrives emite
# tres conexiones a la vez; un `sudo` mal tecleado en bucle son cinco fallos en diez
# segundos. Una tarjeta por evento —muchas de ellas críticas con `-t 0`, o sea SIN
# autocierre— convierte el aviso en una pila que se despacha cerrándola en bloque sin
# leer nada. El resultado práctico es el mismo que apagar la categoría, y por la misma
# razón que motivó la allowlist de privEsc: una alerta que satura enseña a ignorarla.
#
# LA SOLUCIÓN: acumular por categoría y emitir UNA notificación por categoría cuando la
# ráfaga se calma. Dos relojes, y los dos hacen falta:
#
#   · NOTIF_CALMA (ventana de calma) — segundos sin eventos nuevos que cierran el grupo.
#     Es lo que hace que un evento AISLADO —el caso que de verdad importa— siga avisando
#     casi al instante.
#   · NOTIF_TOPE (tope de la ventana) — segundos máximos que el grupo permanece abierto
#     aunque los eventos no paren. Sin él, una actualización de sistema que genera
#     eventos durante minutos NUNCA cerraría la ventana y el aviso llegaría cuando ya
#     no sirve de nada. Con él, sale un resumen cada NOTIF_TOPE mientras dure la ráfaga.
#
# EL RECUENTO ES DE EVENTOS, NO DE LÍNEAS ÚNICAS, y esa distinción no es cosmética:
# cinco fallos de sudo producen cinco veces EXACTAMENTE el mismo texto, y colapsarlos a
# uno convertiría un intento de fuerza bruta en un despiste. Se deduplica para la LISTA
# (con su multiplicidad, "· <texto> (×5)") pero el total del título cuenta eventos.
#
# SALVO cuando el texto repetido ES el mismo suceso visto dos veces, que es el otro caso
# real: `inotifywait` emite `create` Y `close_write` por un único cambio de fichero, y
# contarlos como dos anunciaría "3 archivos críticos modificados" habiendo cambiado dos.
# Esas categorías se marcan con `notif_grupo_unico` y ahí un texto repetido cuenta UNA
# vez. La regla para elegir: ¿dos textos iguales son dos sucesos, o uno contado dos
# veces? Sucesos (sudo, SSH, GPU) → por defecto; el mismo (rutas de fichero) → unico.
#
# RELACIÓN CON lib/notif.sh: son capas distintas y ortogonales. Aquella da IDENTIDAD a
# cada aviso (`x-gigios-event`, para que Ajustes > Notificaciones lo pueda configurar);
# esta decide CUÁNDO y CUÁNTOS avisos salen. Un grupo declara su id igual que lo haría
# una llamada suelta, y el resumen de una ráfaga sale con el MISMO id que el aviso
# individual — quien silencia "errores de GPU" quiere callados los dos. Si `notificar`
# no está definido (el script no sourceó lib/notif.sh) se emite con `notify-send` a
# pelo: se pierde la identidad, nunca el aviso.
#
# CÓMO SE USA — el patrón es siempre el mismo: registrar las categorías antes del bucle
# y sustituir el `read` del bucle por `notif_leer`, que es quien implementa la ventana:
#
#     source .../lib/notif-agrupar.sh
#     notif_grupo gpu gpu.error critical 15000 "Error GPU" "errores de GPU"
#     productor_de_eventos | while :; do
#         notif_leer linea; rc=$?
#         if (( rc != 0 )); then          # 2 = ventana vencida, 1 = fin del stream
#             notif_volcar
#             (( rc == 2 )) || break
#             continue
#         fi
#         [[ "$linea" == *gpu* ]] && notif_encolar gpu "$linea"
#     done
#
# CON NADA ENCOLADO, `notif_leer` BLOQUEA SIN TIMEOUT: en reposo el bucle sigue costando
# ~0 % de CPU y no hay ningún temporizador de fondo ni proceso extra. El timeout solo
# existe mientras hay algo pendiente de volcar.
#
# LÍMITE CONOCIDO: lo encolado y aún no volcado se pierde si el proceso muere (un `pkill
# -f <script>` para recargarlo, p. ej.). Es como mucho una ventana de NOTIF_CALMA
# segundos, y no se instala un trap a propósito: en un apagado el bus de notificaciones
# se está cayendo también, así que el volcado de despedida no llegaría a ninguna parte.

# Ajustes. Cada script puede sobrescribirlos ANTES de sourcear (o después: se leen en
# cada uso, no se congelan aquí). Los valores por defecto están pensados para los
# monitores de seguridad; un aviso de cara al usuario querrá una calma más corta.
: "${NOTIF_CALMA:=4}"     # segundos sin eventos que cierran el grupo
: "${NOTIF_TOPE:=20}"     # segundos máximos con la ventana abierta
: "${NOTIF_LISTA:=8}"     # entradas que se listan en el cuerpo antes del "… y N más"
: "${NOTIF_CAP:=300}"     # tope de entradas ÚNICAS retenidas (ver notif_encolar)

# Estado. `_NG_ORDEN` fija el orden de volcado (el de registro), que es el orden en que
# el autor puso las categorías de más a menos grave.
declare -a _NG_ORDEN=()
declare -A _NG_EV=() _NG_URG=() _NG_TMO=() _NG_TIT=() _NG_PLU=() _NG_PRE=() _NG_SUF=() _NG_EXT=()
declare -A _NG_UNI=()      # cat  → 1 si un texto repetido es el MISMO suceso (ver cabecera)
declare -A _NG_ITEMS=()   # cat  → textos únicos, unidos por \n (preserva el orden)
declare -A _NG_CNT=()     # cat\x1ftexto → cuántas veces se ha visto ese texto
declare -A _NG_TOTAL=()   # cat  → eventos encolados (con repeticiones)
declare -A _NG_UNICOS=()  # cat  → cuántos textos únicos hay en la lista
_NG_PEND=0                # ¿hay alguna categoría con cosas dentro?
_NG_LIMITE=0              # epoch en el que vence el tope de la ventana

# Registra una categoría. Todo el formato se decide aquí, una vez, para que el bucle de
# eventos solo tenga que decir "esto es de la categoría X".
#
#   notif_grupo <cat> <evento> <urgencia> <timeout_ms> <título> <plural> [prefijo] [sufijo] [extra]
#
# <extra> son argumentos sueltos para `notify-send` (`--icon=…`, `-c …`) que se parten
# por espacios, así que no vale para valores CON espacios; es para banderas cortas.
#
# <cat> es la clave interna del bucle; <evento> es el id de lib/notif.sh (la identidad
# de cara a AGS). Con UN solo evento se emite <título> + "<prefijo><texto><sufijo>", que
# es palabra por palabra la notificación de siempre: agrupar no debe cambiar el caso de
# un evento. Con varios, el título pasa a "<n> <plural>" y el cuerpo a la lista.
notif_grupo() {
    local cat=$1
    _NG_ORDEN+=("$cat")
    _NG_EV[$cat]=$2 _NG_URG[$cat]=$3 _NG_TMO[$cat]=$4 _NG_TIT[$cat]=$5 _NG_PLU[$cat]=$6
    _NG_PRE[$cat]=${7-} _NG_SUF[$cat]=${8-} _NG_EXT[$cat]=${9-}
    _NG_ITEMS[$cat]="" _NG_TOTAL[$cat]=0 _NG_UNICOS[$cat]=0
}

# Marca una categoría como "un texto repetido es el mismo suceso" (ver cabecera). Se
# llama justo después de su notif_grupo.
notif_grupo_unico() { _NG_UNI[$1]=1; }

# Encola un evento y abre la ventana si no lo estaba.
#
# El texto se recorta a 300 caracteres: las líneas del kernel son larguísimas y en una
# lista de ocho no se leen igual; el detalle completo sigue estando en el journal.
#
# NOTIF_CAP acota las entradas ÚNICAS retenidas, porque la deduplicación es un barrido
# lineal y una ráfaga patológica (miles de rutas distintas) lo volvería cuadrático. Al
# pasarse, el evento SIGUE contando en el total —el recuento del título no miente
# nunca— pero ya no entra en la lista; el "… y N más" del cuerpo lo absorbe.
# PRE-incremento a propósito en los contadores: `(( x++ ))` devuelve el valor VIEJO, o
# sea estado 1 cuando era 0, y bajo `set -e` eso abortaría el script que nos sourcea la
# primera vez que encola algo. `(( ++x ))` devuelve el nuevo, que aquí siempre es ≥1.
notif_encolar() {
    local cat=$1 txt=$2 key
    [[ -n "${_NG_URG[$cat]+x}" ]] || return 1   # categoría no registrada: error de uso
    (( ${#txt} > 300 )) && txt="${txt:0:299}…"
    key="$cat"$'\x1f'"$txt"

    if [[ -n "${_NG_CNT[$key]+x}" ]]; then
        # Repetido: en una categoría "unico" no suma ni al total ni a la multiplicidad.
        [[ -n "${_NG_UNI[$cat]+x}" ]] && return 0
        (( ++_NG_TOTAL[$cat] ))
        (( ++_NG_CNT[$key] ))
    elif (( _NG_UNICOS[$cat] < NOTIF_CAP )); then
        (( ++_NG_TOTAL[$cat] ))
        _NG_CNT[$key]=1
        _NG_ITEMS[$cat]+="$txt"$'\n'
        (( ++_NG_UNICOS[$cat] ))
    else
        (( ++_NG_TOTAL[$cat] ))   # pasado el CAP: cuenta en el total, no en la lista
    fi

    if (( ! _NG_PEND )); then
        _NG_PEND=1
        printf -v _NG_LIMITE '%(%s)T' -1
        (( _NG_LIMITE += NOTIF_TOPE ))
    fi
    return 0
}

# ¿Hay algo encolado? Para bucles que quieran decidir por su cuenta.
notif_pendiente() { (( _NG_PEND )); }

# Lee una línea del stdin del bucle respetando la ventana. Devuelve:
#   0 → línea leída en la variable cuyo NOMBRE se pasa
#   2 → venció la ventana (calma o tope): toca volcar
#   1 → se acabó el stream (o error de lectura): volcar y salir
notif_leer() {
    local -n _ng_destino=$1
    local _espera _ahora _rc
    if (( _NG_PEND )); then
        printf -v _ahora '%(%s)T' -1
        _espera=$(( _NG_LIMITE - _ahora ))
        (( _espera > NOTIF_CALMA )) && _espera=$NOTIF_CALMA
        (( _espera < 1 )) && _espera=1
        IFS= read -r -t "$_espera" _ng_destino; _rc=$?
    else
        IFS= read -r _ng_destino; _rc=$?  # nada pendiente → bloquea, coste cero
    fi
    (( _rc == 0 )) && return 0
    (( _rc > 128 )) && return 2           # bash marca el timeout de `read` con >128
    return 1
}

# Emite lo acumulado (una notificación por categoría no vacía) y vacía el estado.
notif_volcar() {
    local cat titulo cuerpo total mostrados resto n txt
    local -a items
    for cat in "${_NG_ORDEN[@]}"; do
        total=${_NG_TOTAL[$cat]}
        (( total )) || continue

        mapfile -t items <<< "${_NG_ITEMS[$cat]%$'\n'}"
        if (( total == 1 )); then
            titulo="${_NG_TIT[$cat]}"
            cuerpo="${_NG_PRE[$cat]}${items[0]}${_NG_SUF[$cat]}"
        else
            titulo="$total ${_NG_PLU[$cat]}"
            cuerpo=""; mostrados=0
            for txt in "${items[@]:0:NOTIF_LISTA}"; do
                n=${_NG_CNT["$cat"$'\x1f'"$txt"]}
                (( mostrados += n ))
                # Hay categorías cuyo aviso NO lleva dato variable (un fallo de sudo
                # es siempre "Intento fallido de sudo"): encolan texto vacío y lo que
                # informa es el recuento del título, no una lista de viñetas huecas.
                [[ -n "$txt" ]] || continue
                cuerpo+="· $txt"
                (( n > 1 )) && cuerpo+=" (×$n)"
                cuerpo+=$'\n'
            done
            cuerpo="${cuerpo%$'\n'}"
            resto=$(( total - mostrados ))
            (( resto > 0 )) && cuerpo+=${cuerpo:+$'\n'}"… y $resto más"
            [[ -n "$cuerpo" ]] || cuerpo="${_NG_PRE[$cat]}${_NG_SUF[$cat]}"
        fi

        # shellcheck disable=SC2086  # $extra sin comillas A PROPÓSITO: son varios args.
        if declare -F notificar >/dev/null 2>&1; then
            notificar "${_NG_EV[$cat]}" -u "${_NG_URG[$cat]}" ${_NG_EXT[$cat]} \
                "$titulo" "$cuerpo" -t "${_NG_TMO[$cat]}"
        else
            notify-send -h string:x-gigios-source:system -u "${_NG_URG[$cat]}" ${_NG_EXT[$cat]} \
                "$titulo" "$cuerpo" -t "${_NG_TMO[$cat]}"
        fi

        _NG_ITEMS[$cat]="" _NG_TOTAL[$cat]=0 _NG_UNICOS[$cat]=0
    done
    # Se vacía el mapa de recuentos ENTERO, no clave a clave: `unset` con subíndice
    # variable expande el subíndice, y una ruta con `]` o `[` dentro dejaría basura.
    # Es correcto porque un volcado siempre vacía TODAS las categorías a la vez.
    _NG_CNT=()
    _NG_PEND=0
}
