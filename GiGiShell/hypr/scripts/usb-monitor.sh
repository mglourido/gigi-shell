#!/usr/bin/env bash
# USB monitor — avisa de conexión/desconexión de dispositivos y, si son de
# almacenamiento, ofrece expulsarlos con seguridad y reparar el volumen si viene
# sucio.
#
# Totalmente dirigido por eventos: `udevadm monitor` bloquea en el socket de
# uevents del kernel/udev, cero polling. Con --property las propiedades llegan
# dentro del propio evento, así que no hay un `udevadm info` extra por dispositivo;
# el único fork por evento real es notify-send (y los subshells de los botones).
#
# ── Dos subsistemas, un solo stream ───────────────────────────────────────────
# Escuchamos `usb` (el dispositivo físico) y `block` (el disco/particiones que
# expone si es almacenamiento). Un pendrive genera AMBOS, así que sin cuidado
# saldrían dos popups por enchufe. Regla: si el dispositivo USB es de la clase
# "mass storage", el aviso genérico se CALLA y habla el evento de bloque, que
# sabe el modelo, el sistema de ficheros y puede ofrecer "Expulsar".
#
# La clase se lee de ID_USB_INTERFACES (p.ej. ":080650:"), donde cada interfaz son
# 6 dígitos y 08 es mass-storage. Como las entradas son de largo fijo y van entre
# ':', buscar ":08" solo puede casar al principio de una entrada.
#
# DEVTYPE=usb_device (vs. usb_interface) es la forma canónica de udev de distinguir
# el dispositivo físico de sus sub-nodos por interfaz.
#
# ── Por qué el aviso genérico se DIFIERE en vez de decidirse en el acto ───────
# Adivinar la clase desde el evento del usb_device es una heurística que falla en
# los dos sentidos, y cuando falla salen DOS popups por un solo enchufe: primero
# "USB conectado — dispositivo desconocido" y acto seguido el de almacenamiento
# con el nombre bueno. Casos vistos: la propiedad no viene en el bloque (llega un
# evento con las propiedades a medias), o el dispositivo se engancha a usb-storage
# por una interfaz de clase PROPIETARIA (ff…, típico de lectores de tarjetas y
# algunas carcasas) y por tanto sin ningún ":08" que mirar.
#
# La señal fiable no es la clase declarada: es el hecho OBSERVADO de que el
# dispositivo acabe exponiendo un dispositivo de bloque. Eso solo se sabe unos
# instantes después, así que el aviso genérico se retiene DEFER_SECS y se cancela
# si en esa ventana llega un evento de bloque de ESE mismo dispositivo. El enlace
# entre ambos es DEVPATH: el del bloque cuelga del árbol del usb_device
# (…/usb1/1-5 → …/usb1/1-5/1-5:1.0/host…/block/sdb), o sea que el del padre es
# PREFIJO del hijo. Es una relación exacta, no una correlación por tiempo: dos
# dispositivos enchufados a la vez no se cancelan el uno al otro.
#
# El coste es que un teclado tarda DEFER_SECS en anunciarse. Es un popup
# informativo y pasivo, así que se prefiere eso a un falso "dispositivo
# desconocido". Los dos atajos (ID_USB_INTERFACES y sysfs) siguen ahí para el
# camino común: un pendrive normal se calla YA, sin pagar la espera ni tocar
# disco.

EJECT="$HOME/.config/hypr/scripts/usb-eject.sh"
OPEN="$HOME/.config/hypr/scripts/usb-open.sh"
REPAIR="$HOME/.config/hypr/scripts/usb-repair.sh"

NOTIF_APP="USB"
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

# ── Agrupación: un enchufe, un aviso; varios a la vez, TAMBIÉN un aviso ───────
# La fusión por parentesco de más abajo arregla "un dispositivo, varios eventos",
# pero deja pasar el caso HERMANOS: enchufar (o retirar) un hub con tres pendrives
# son tres dispositivos distintos, ninguno antecesor de otro, y salían tres popups
# seguidos diciendo lo mismo. Como todos vencen su espera en el mismo instante, el
# volcado del temporizador es el lote natural: se encolan y sale un único
# "3 dispositivos USB conectados" con los tres nombres en el cuerpo. Ver
# lib/notif-agrupar.sh; aquí NO se usa su ventana de calma (la espera ya la marca
# DEFER_SECS), solo el formateo del grupo.
if ! source "$HOME/.config/hypr/scripts/lib/notif-agrupar.sh" 2>/dev/null; then
    declare -A _NGF_EV=() _NGF_URG=() _NGF_TMO=() _NGF_TIT=()
    notif_grupo()   { _NGF_EV[$1]=$2 _NGF_URG[$1]=$3 _NGF_TMO[$1]=$4 _NGF_TIT[$1]=$5; }
    notif_encolar() { notificar "${_NGF_EV[$1]}" -u "${_NGF_URG[$1]}" "${_NGF_TIT[$1]}" "$2" -t "${_NGF_TMO[$1]}"; }
    notif_volcar()  { :; }
fi
notif_grupo uconn usb.conectado    normal 8000 "USB conectado"    "dispositivos USB conectados"
notif_grupo udisc usb.desconectado normal 8000 "USB desconectado" "dispositivos USB desconectados"

# Avisos genéricos retenidos a la espera de que se confirme (o no) que el
# dispositivo es almacenamiento. Un fichero por aviso pendiente, con su DEVPATH
# dentro. Se limpia al arrancar porque un proceso anterior muerto a mitad deja
# pendientes huérfanos que nadie reclamaría.
PENDING_DIR="${GIGIOS_USB_PENDING_DIR:-${XDG_RUNTIME_DIR:-/tmp}/gigios-usb-pending}"
DEFER_SECS=3
rm -rf "$PENDING_DIR"
mkdir -p -m 700 "$PENDING_DIR" || exit 1
trap 'rm -rf "$PENDING_DIR"' EXIT

# ── Caché de identidad: quién era el que se acaba de ir ──────────────────────
# El `remove` de un usb_device NO trae ID_MODEL de forma fiable (el del nodo padre
# casi nunca), y udev tampoco puede consultarlo: el dispositivo ya no está en
# sysfs. De ahí el «dispositivo desconocido» que solo aparecía al DESCONECTAR,
# mientras que al conectar el nombre salía bien. La única forma de saberlo es
# haberlo guardado al ENCHUFAR, indexado por lo único que el remove sí trae
# siempre: el DEVPATH (o sea, el puerto).
#
# A DIFERENCIA de los pendientes, este directorio NO se borra al arrancar ni en el
# trap de salida, y es deliberado: recargar el monitor es `pkill` + relanzar (o
# `hyprctl reload full-reset`), y borrar aquí dejaría sin nombre la futura
# desconexión de todo lo que ya estuviera enchufado — justo el caso que esto
# existe para arreglar. Un pendiente huérfano es un aviso que nadie reclamará
# (basura activa); una entrada de caché huérfana es solo un nombre que quizá no
# haga falta (basura pasiva). De las huérfanas se encarga prune_cache(), no un
# `rm -rf`. Vive en XDG_RUNTIME_DIR y no en ~/.cache a propósito: los DEVPATH se
# reutilizan entre arranques, así que sobrevivir al reboot sería nombrar el
# puerto en vez del dispositivo.
CACHE_DIR="${GIGIOS_USB_CACHE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/gigios-usb-cache}"
# Sin caché se sigue: esto es mejor texto, no un requisito de funcionamiento — de
# ahí que aquí no haya el `|| exit 1` que sí lleva PENDING_DIR.
mkdir -p -m 700 "$CACHE_DIR" 2>/dev/null || CACHE_DIR=""

# Vencimiento de cada pendiente, en epoch y EN MEMORIA del proceso principal.
#
# Antes cada pendiente llevaba su propio `( sleep DEFER_SECS; … ) &`: el reloj vivía
# en un subshell, y por eso el aviso tenía que salir DESDE el subshell, donde no hay
# forma de saber que hay otros dos hermanos a punto de notificar lo mismo. Ahora el
# reloj es el `read -t` del bucle principal (que ya estaba bloqueado ahí sin hacer
# nada) y quien notifica es el proceso que lo sabe TODO. Ventajas de propina: cero
# subshells por evento y ninguna carrera entre reclamar y cancelar, porque solo hay
# un actor tocando los pendientes.
declare -A pending_at=()
# Los arrays asociativos de bash NO conservan el orden de inserción (recorrerlos da
# un orden de hash), y en un aviso agrupado eso se ve: los tres dispositivos del hub
# salían listados en orden arbitrario. `pending_orden` guarda el orden de llegada,
# que es el único que le significa algo a quien lee el popup.
declare -a pending_orden=()

subsystem=""; action=""; devtype=""; devname=""; devpath=""
vendor=""; model=""; ifaces=""; bus=""; fstype=""; fslabel=""
pending_n=0
cache_n=0

reset_event() {
    subsystem=""; action=""; devtype=""; devname=""; devpath=""
    vendor=""; model=""; ifaces=""; bus=""; fstype=""; fslabel=""
}

# El id va explícito y no derivado del verbo (`usb.$verb`): así `usb.conectado` y
# `usb.desconectado` se encuentran con un grep desde el catálogo de AGS.
notify_usb() {
    local evento=$1 verb=$2 label=$3
    notificar "$evento" -u normal "USB $verb" "$label" -t 8000
}

# Respaldo para cuando el evento no trae ID_USB_INTERFACES: las interfaces del
# dispositivo son subdirectorios suyos en sysfs. No siempre existen todavía
# cuando llega el 'add' del usb_device — de ahí que esto sea un atajo y no la
# garantía; quien garantiza es el diferido. Sin forks: glob + read builtin.
sysfs_is_storage() {
    local dev=$1 f cls
    [[ -n "$dev" ]] || return 1
    for f in /sys"$dev"/*/bInterfaceClass; do
        [[ -r "$f" ]] || continue
        read -r cls < "$f" || continue
        [[ "$cls" == "08" ]] && return 0
    done
    return 1
}

# Etiqueta del evento en curso. `ev_known` distingue "sé cómo se llama" de la
# cadena de relleno: al fusionar avisos hay que poder preferir un nombre real
# sobre un "dispositivo desconocido", y comparar contra el literal sería frágil.
ev_label=""; ev_known=0
event_label() {
    if [[ -n "$vendor$model" ]]; then
        ev_label="${vendor:+$vendor }${model}"; ev_label="${ev_label% }"; ev_known=1
    else
        ev_label="dispositivo desconocido"; ev_known=0
    fi
}

# ── Caché: fichero, alta, búsqueda, baja y poda ───────────────────────────────
# Formato del fichero (una línea por campo, como los pendientes, para leerlo con
# `read` builtin y sin forks):
#   1 DEVPATH  2 etiqueta  3 known(0|1)  4 idVendor:idProduct  5 disco (sdb)
# El nombre del fichero es el DEVPATH codificado ('%'→%25, '/'→%2F): así el mismo
# dispositivo siempre pisa su propia entrada y el acierto EXACTO no necesita
# barrer el directorio. Los temporales llevan '.' delante, fuera del glob '*' —
# el mismo truco que `.fired.*` en los pendientes; si no, se leerían como
# entradas a medias.
cache_file() { local d=${1//%/%25}; printf '%s' "$CACHE_DIR/${d//\//%2F}"; }

# Alta (o mejora) de la identidad de un usb_device. Fusiona con lo que hubiera:
# un nombre bueno ya guardado NUNCA se degrada a relleno.
cache_put() {   # $1 devpath  $2 etiqueta  $3 known  [$4 disco]
    local dev=$1 label=$2 known=${3:-0} disk=${4-} f tmp
    local odev olabel oknown ovid odisk vid="" v="" p=""
    [[ -n "$CACHE_DIR" && -n "$dev" ]] || return 0
    f=$(cache_file "$dev")
    if [[ -f "$f" ]]; then
        { read -r odev; read -r olabel; read -r oknown; read -r ovid; read -r odisk; } < "$f"
        [[ "$oknown" == 1 && "$known" != 1 ]] && { label=$olabel; known=1; }
        vid=$ovid; [[ -n "$disk" ]] || disk=$odisk
    fi
    if [[ -z "$vid" ]]; then
        # Sirve para detectar en el arranque que OTRO dispositivo ocupa este puerto
        # (ver prune_cache). Solo existe en nodos usb_device; si no se puede leer,
        # se degrada a comprobar únicamente que el path siga vivo.
        [[ -r "/sys$dev/idVendor"  ]] && read -r v < "/sys$dev/idVendor"
        [[ -r "/sys$dev/idProduct" ]] && read -r p < "/sys$dev/idProduct"
        [[ -n "$v$p" ]] && vid="$v:$p"
    fi
    tmp="$CACHE_DIR/.tmp.$$.$((++cache_n))"
    printf '%s\n%s\n%s\n%s\n%s\n' "$dev" "$label" "$known" "$vid" "$disk" > "$tmp" \
        && mv "$tmp" "$f"
}

# Mejor identidad cacheada para un DEVPATH. Devuelve por globales; 0 = hubo
# acierto. `cache_hit` es el DEVPATH de la entrada que acertó (lo usa el evento de
# bloque para saber A QUIÉN enriquecer).
#
# El remove puede llegar por el nodo PADRE o por un HIJO, así que se casa por
# prefijo en AMBAS direcciones, con esta precedencia:
#   1. EXACTA.
#   2. ANTECESOR más profundo — el evento llega por un nodo que nunca cacheamos.
#      Sin ambigüedad: los antecesores de un path forman una cadena.
#   3. DESCENDIENTE, y SOLO SI ES ÚNICO — el evento llega por el padre. Con dos o
#      más, los candidatos son HERMANOS (hub con tres pendrives) y quedarse con
#      uno sería ponerle a un dispositivo el nombre de otro, sin ningún error
#      visible. Con ≥2 no se devuelve nada, y no se pierde nada: ese pendiente del
#      padre lo descarta igualmente la fusión de defer_usb_removal.
cache_label=""; cache_known=0; cache_hit=""
cache_lookup() {
    local dev=$1 f sdev slabel sknown
    local best="" blabel="" bknown=0 desc=0 ddev="" dlabel="" dknown=0
    cache_label=""; cache_known=0; cache_hit=""
    [[ -n "$CACHE_DIR" && -n "$dev" ]] || return 1
    for f in "$CACHE_DIR"/*; do
        [[ -f "$f" ]] || continue
        { read -r sdev; read -r slabel; read -r sknown; } < "$f" || continue
        [[ -n "$sdev" ]] || continue
        if [[ "$dev" == "$sdev" ]]; then
            cache_label=$slabel; cache_known=$sknown; cache_hit=$sdev; return 0
        elif [[ "$dev" == "$sdev"/* ]]; then
            (( ${#sdev} > ${#best} )) && { best=$sdev; blabel=$slabel; bknown=$sknown; }
        elif [[ "$sdev" == "$dev"/* ]]; then
            (( ++desc )); ddev=$sdev; dlabel=$slabel; dknown=$sknown
        fi
    done
    if [[ -n "$best" ]]; then
        cache_label=$blabel; cache_known=$bknown; cache_hit=$best; return 0
    fi
    (( desc == 1 )) && { cache_label=$dlabel; cache_known=$dknown; cache_hit=$ddev; return 0; }
    return 1
}

# Baja de ESTE devpath y de NADA MÁS. Borrar el subárbol sería el bug: si el
# `remove` del hub llega antes que el de sus pendrives (el orden no está
# garantizado), se llevaría por delante los nombres de los tres. Como el kernel
# emite un remove por CADA usb_device, cada entrada se borra sola con el suyo.
cache_drop() {
    local dev=$1
    [[ -n "$CACHE_DIR" && -n "$dev" ]] || return 0
    rm -f "$(cache_file "$dev")"
}

# Poda, UNA sola vez al arrancar. Lo único que puede dejar huérfanas es un monitor
# parado mientras se desenchufaba algo, y el directorio tiene tantas entradas como
# dispositivos USB haya (decenas como mucho). Dos criterios: el path ya no existe,
# o existe pero lo ocupa OTRO dispositivo — mismo puerto, pendrive distinto,
# enchufado con el monitor parado; su `add` tampoco se vio, así que sin este
# chequeo se anunciaría el nombre del anterior.
prune_cache() {
    local f dev vid v p
    [[ -n "$CACHE_DIR" ]] || return 0
    for f in "$CACHE_DIR"/*; do
        [[ -f "$f" ]] || continue
        { read -r dev; read -r _; read -r _; read -r vid; } < "$f" || { rm -f "$f"; continue; }
        [[ -n "$dev" && -d "/sys$dev" ]] || { rm -f "$f"; continue; }
        [[ -n "$vid" ]] || continue          # sin vid:pid no hay con qué comparar
        v=""; p=""
        [[ -r "/sys$dev/idVendor"  ]] && read -r v < "/sys$dev/idVendor"
        [[ -r "/sys$dev/idProduct" ]] && read -r p < "/sys$dev/idProduct"
        [[ "$vid" == "$v:$p" ]] || rm -f "$f"
    done
}
prune_cache

# Los pendientes se claman con un `mv` a `.fired.*`, un nombre que NO casa con
# los globs `c.*`/`r.*`: así un aviso ya reclamado no puede volver a aparecer
# como pendiente vivo y falsear una cancelación o una fusión.
claim_pending() {   # $1 = fichero; éxito = es mío y nadie lo canceló
    mv "$1" "$PENDING_DIR/.fired.${1##*/}" 2>/dev/null || return 1
    rm -f "$PENDING_DIR/.fired.${1##*/}"
}

# Retiene el aviso genérico de CONEXIÓN. La ETIQUETA se guarda ahora en el fichero
# (segunda línea): antes la capturaba el subshell al nacer, y sin subshell hace
# falta que el pendiente se baste a sí mismo cuando lo dispare el bucle principal.
# `cancel_usb_notice` solo lee la primera línea, así que no le afecta.
defer_usb_notice() {
    local dev=$1 label=$2 f
    f="$PENDING_DIR/c.$$.$((++pending_n))"
    printf '%s\n%s\n' "$dev" "$label" > "$f" || return
    pending_at[$f]=$(( $(printf '%(%s)T' -1) + DEFER_SECS ))
    pending_orden+=("$f")
}

# Cancela los avisos de CONEXIÓN pendientes de este dispositivo o de cualquier
# antecesor suyo. Se llama con el DEVPATH de un evento de bloque (el hijo) y
# también al desconectar (mismo DEVPATH), para que enchufar y tirar del pendrive
# antes de DEFER_SECS no saque un "conectado" DESPUÉS del "desconectado".
cancel_usb_notice() {
    local dev=$1 f stored
    [[ -n "$dev" ]] || return
    for f in "$PENDING_DIR"/c.*; do
        [[ -f "$f" ]] || continue
        read -r stored < "$f" || continue
        [[ -n "$stored" ]] || continue
        [[ "$dev" == "$stored" || "$dev" == "$stored"/* ]] && { rm -f "$f"; unset 'pending_at[$f]'; }
    done
}

# ── Desconexión: un tirón físico, un aviso ───────────────────────────────────
# Un dispositivo compuesto o detrás de un hub expone VARIOS usb_device anidados,
# y al retirarlo el kernel emite un `remove` por cada uno. Como el aviso colgaba
# de ese evento, salían dos popups por un solo tirón — y el del nodo padre suele
# no traer ID_MODEL, de ahí el "dispositivo desconocido" que acompañaba al bueno.
# Es la misma causa que en la conexión (ahí el padre es el que se cuela), así que
# el arreglo es el espejo: retener el aviso DEFER_SECS y fusionar los removes
# emparentados por DEVPATH en uno solo, con el mejor nombre disponible.
#
# La regla de fusión es asimétrica a propósito, y esa asimetría es lo que hace
# que funcione llegue el padre antes o después que los hijos (el kernel suele
# emitir hijo→padre, pero no se depende de ello):
#
#   · el entrante DESCIENDE de un pendiente → lo absorbe y se queda con SU
#     devpath (el más profundo, que es la función real y la que tiene nombre);
#   · el entrante es ANTECESOR de un pendiente → se descarta, porque el hijo ya
#     cubre ese tirón. Solo cede su etiqueta si el hijo no tenía nombre.
#
# Guardar el devpath MÁS PROFUNDO es lo que evita colapsar hermanos: al retirar
# un hub con tres pendrives, los tres son hermanos entre sí (ninguno desciende de
# otro) → tres avisos, uno por dispositivo, y el remove del hub se descarta. Si
# se guardara el del hub, los tres se fusionarían en un único aviso.
defer_usb_removal() {
    local dev=$1 label=$2 known=$3 f stored slabel sknown covered=0 tmp
    [[ -n "$dev" ]] || { notify_usb usb.desconectado "desconectado" "$label"; return; }

    for f in "$PENDING_DIR"/r.*; do
        [[ -f "$f" ]] || continue
        { read -r stored; read -r slabel; read -r sknown; } < "$f" || continue
        [[ -n "$stored" ]] || continue

        if [[ "$dev" == "$stored"/* ]]; then
            # Entrante más profundo: absorbe al antecesor.
            [[ "$known" == 1 ]] || { label=$slabel; known=$sknown; }
            rm -f "$f"; unset 'pending_at[$f]'
        elif [[ "$stored" == "$dev"/* || "$dev" == "$stored" ]]; then
            # El pendiente ya cubre este tirón. Solo le pasamos el nombre si él
            # no lo tenía. La escritura sigue siendo atómica (tmp + mv) aunque ya
            # no haya subshell que pueda leerlo a medias: el fichero es el registro
            # y dejarlo a medias por un fallo de disco costaría el aviso entero.
            # El VENCIMIENTO no se toca: lo marca el primer evento del tirón, para
            # que mejorar el nombre no retrase el aviso otros DEFER_SECS.
            if [[ "$known" == 1 && "$sknown" != 1 ]]; then
                tmp="$PENDING_DIR/.tmp.$$.$((++pending_n))"
                printf '%s\n%s\n1\n' "$stored" "$label" > "$tmp" && mv "$tmp" "$f"
            fi
            covered=1
        fi
    done
    [[ "$covered" == 1 ]] && return

    f="$PENDING_DIR/r.$$.$((++pending_n))"
    printf '%s\n%s\n%s\n' "$dev" "$label" "$known" > "$f" || return
    pending_at[$f]=$(( $(printf '%(%s)T' -1) + DEFER_SECS ))
    pending_orden+=("$f")
}

# ── Disparo de los pendientes vencidos ────────────────────────────────────────
# Lo llama el bucle principal cuando se le agota el `read -t`. Todo lo que vence en
# la misma pasada sale en UNA notificación por verbo (ver notif_grupo arriba).
#
# La etiqueta se relee del fichero y no de lo que se guardó al crearlo: un `remove`
# posterior ha podido mejorar el nombre («dispositivo desconocido» → el bueno)
# reescribiendo el pendiente, y usar el valor viejo era el bug que la fusión existe
# para evitar.
fire_due_pendings() {
    local ahora f stored slabel
    local -a quedan=()
    printf -v ahora '%(%s)T' -1
    for f in "${pending_orden[@]}"; do
        # Ya cancelado o absorbido por una fusión: fuera de la lista sin más.
        [[ -n "${pending_at[$f]+x}" ]] || continue
        if (( pending_at[$f] > ahora )); then
            quedan+=("$f")
            continue
        fi
        unset 'pending_at[$f]'
        stored=""; slabel=""
        [[ -f "$f" ]] && { read -r stored; read -r slabel; } < "$f"
        claim_pending "$f" || continue   # cancelado entre medias
        case "${f##*/}" in
            c.*) notif_encolar uconn "${slabel:-dispositivo desconocido}" ;;
            r.*) notif_encolar udisc "${slabel:-dispositivo desconocido}" ;;
        esac
    done
    pending_orden=("${quedan[@]}")   # se poda aquí: si no, crecería toda la sesión
    notif_volcar
}

# Segundos hasta el próximo vencimiento (mínimo 1, para no hacer espera activa con
# `read -t 0`). Vacío si no hay pendientes: entonces el bucle bloquea sin timeout,
# que es como se comportaba antes de existir todo esto.
next_deadline_wait() {
    local f menor="" ahora
    printf -v ahora '%(%s)T' -1
    for f in "${!pending_at[@]}"; do
        [[ -z "$menor" || ${pending_at[$f]} -lt $menor ]] && menor=${pending_at[$f]}
    done
    [[ -n "$menor" ]] || return 1
    (( menor <= ahora )) && { printf 1; return 0; }
    printf '%s' "$(( menor - ahora ))"
}

# Aviso de almacenamiento conectado, con botón de expulsión segura.
# notify-send --wait -A bloquea hasta el clic/cierre → subshell en 2º plano, mismo
# idiom que download_alert() en oom-monitor.sh.
notify_storage() {
    local disk=$1 name=$2
    # "Abrir" va PRIMERA a propósito: el shell trata la primera acción visible como
    # la principal, que es la que se ejecuta al hacer clic derecho sobre el popup —
    # y abrir el USB es lo que se quiere hacer nada más enchufarlo; expulsar viene
    # después. notify-send --wait imprime en stdout el id de la acción pulsada, de
    # ahí el `case` (con dos acciones un `[[ == ]]` ya no vale).
    ( act=$(notificar usb.almacenamiento --wait -t 20000 \
              -u normal -A "open=Abrir" -A "eject=Expulsar" \
              "Almacenamiento USB conectado" \
              "$name")
      case "$act" in
          open)  [[ -x "$OPEN"  ]] && "$OPEN"  "$disk" ;;
          eject) [[ -x "$EJECT" ]] && "$EJECT" "$disk" ;;
      esac ) &
}

# ¿Viene el volumen sucio (se retiró sin expulsar, aquí o en otra máquina)?
# Si lo está, SE REPARA SOLO. No hay botón que pulsar en el camino normal.
#
# Preguntamos a udisks (Filesystem.Check), no a fsck: el trabajo privilegiado lo
# hace udisksd y polkit lo autoriza sin prompt en dispositivos que no son del
# sistema (modify-device → allow_active=yes). Es de solo lectura.
#
# Check exige el volumen DESMONTADO, así que si algo ya lo montó nos callamos: no
# hay forma segura de comprobarlo y no vamos a desmontar por la cara. Cualquier
# error (fs no soportado, falta la herramienta —NTFS necesita ntfsprogs—) también es
# silencio: esto es una comodidad, no puede convertirse en una fuente de ruido.
#
# ── «Check» NO es leer un flag: es un fsck completo que SECUESTRA el USB ──────
# Y ese es el fallo silencioso que hay que tener presente aquí. udisks no consulta
# el bit de "sucio" del superbloque: lanza la herramienta del fs (`fsck.exfat -n`,
# `e2fsck -fn`, `fsck.fat -n`…), que recorre TODA la metainformación del volumen y
# lo deja ocupado mientras tanto. Medido en este equipo con un pendrive exFAT de
# 239 GB: `fsck.exfat -n /dev/sda1` pasaba de 1 min 40 s y seguía. Durante todo ese
# rato el USB NO SE PUEDE MONTAR —ni por el botón «Abrir», ni desde Dolphin— y
# desde fuera eso se ve exactamente como «el gestor de archivos se queda pensando
# para siempre», sin un error, sin un log, sin nada que señale a este script.
#
# De ahí las dos guardas de abajo (tope de tamaño y ventana de asentamiento). La
# clave para entender por qué hacen falta las dos: un volumen sucio SE MONTA
# PERFECTAMENTE (exFAT escupe un "Volume was not properly unmounted" al log y
# sigue adelante), así que comprobar es una comodidad y montar es el trabajo. Si
# las dos cosas compiten, gana montar.
#
# ── Por qué reparar sin preguntar ────────────────────────────────────────────
# Porque la operación es conservadora, no destructiva: para NTFS, udisks ejecuta
# `ntfsfix`, y su propio man deja claro que NO es un chkdsk de Linux — "repara
# inconsistencias fundamentales, resetea el journal y PROGRAMA una comprobación de
# consistencia en el primer arranque de Windows". O sea que auto-reparar no esconde
# el problema: Windows lo revisa igual. Y el momento de hacerlo es EXACTAMENTE este,
# el enchufe: es la única ventana en la que el volumen está sucio y aún sin montar,
# que es lo que Repair exige. Preguntar aquí solo servía para que la ventana se
# cerrara mientras el usuario decidía.

# Tope por encima del cual no se comprueba sola (64 GiB). Cubre de sobra el
# pendrive normal, que es donde la comodidad se nota, y deja fuera los discos
# externos grandes, que es donde el fsck se hace eterno.
CHECK_MAX_BYTES=${GIGIOS_USB_CHECK_MAX_BYTES:-$((64 * 1024 * 1024 * 1024))}
# Segundos que se le conceden al montaje antes de plantearse comprobar nada.
CHECK_SETTLE_SECS=${GIGIOS_USB_CHECK_SETTLE_SECS:-25}

# ¿Está montado este dispositivo? Sin forks: /proc/mounts con el builtin `read`.
# Se compara el campo 1 ENTERO y no por prefijo: "/dev/sda1" no debe casar con una
# línea de "/dev/sda10". El `grep "^/dev/$part "` de antes era correcto solo por
# ese espacio final, que es justo lo que se pierde al editar sin darse cuenta.
esta_montado() {
    local d
    while read -r d _; do
        [[ "$d" == "/dev/$1" ]] && return 0
    done < /proc/mounts
    return 1
}

check_volume() {
    local part=$1 name=$2 fs=$3

    # ── Guarda 1: tamaño ──────────────────────────────────────────────────────
    # Por encima del tope no se comprueba sola. El coste del fsck crece con el
    # volumen y el beneficio no: bloquear el dispositivo minutos para averiguar
    # algo que no impide usarlo es un mal cambio. A mano sigue estando entero:
    # `usb-repair.sh /dev/sdXN`. Se mira ANTES de la espera para no dejar un
    # subshell vivo 25 s por un disco que ya sabemos que no vamos a tocar.
    # /sys/.../size va SIEMPRE en sectores de 512 B, sea cual sea el tamaño de
    # bloque lógico del dispositivo (es la unidad de la clase, no del hardware).
    local sectores=0
    [[ -r "/sys/class/block/$part/size" ]] && read -r sectores < "/sys/class/block/$part/size"
    (( sectores * 512 > CHECK_MAX_BYTES )) && return 0

    ( # ── Guarda 2: montar tiene preferencia, y se ESPERA a que ocurra ────────
      # Esto era `sleep 2` y UN vistazo a /proc/mounts. La guarda era la correcta
      # —si ya está montado no se puede comprobar— pero mirar UNA SOLA VEZ la
      # convierte en una carrera que se pierde por un segundo. Medido:
      #
      #   · 1ª vez que se enchufa un pendrive en la sesión → hay que cargar el
      #     módulo usb-storage EN FRÍO, la partición tarda ~2 s en aparecer y el
      #     montaje llega sobre t=4 s. A los 2 s todavía no está → arrancábamos
      #     el fsck y el USB quedaba secuestrado.
      #   · 2ª vez, con el módulo ya caliente → el montaje llega a t=1 s. A los
      #     2 s ya está → nos apartábamos y todo iba bien.
      #
      # O sea que el «la primera vez Dolphin se queda en bucle y la segunda lo
      # abre sin problema» no era azar: era ese único segundo de diferencia. La
      # ventana cubre de sobra la vida del popup con el botón «Abrir» (20 s), que
      # es el tiempo real que tiene el usuario para decidir; si pulsa, montamos y
      # ya no hay nada que comprobar.
      #
      # Se sondea con el builtin `read` sobre /proc/mounts en vez de con `grep`:
      # son ~25 vueltas y este script presume de no forkear por evento. El único
      # fork que queda es el `sleep`.
      local i
      for (( i = 0; i < CHECK_SETTLE_SECS; i++ )); do
          esta_montado "$part" && exit 0
          sleep 1
      done
      esta_montado "$part" && exit 0

      local obj="/org/freedesktop/UDisks2/block_devices/$part" out
      # --timeout EXPLÍCITO. El de DBus por defecto son 25 s y un fsck los pasa de
      # largo; al vencer, busctl devuelve error, eso caía en el `|| exit 0` de esta
      # misma línea y el volumen se daba por LIMPIO… mientras udisksd seguía
      # fsckeando con el dispositivo bloqueado y sin nadie mirando. Comprobado en
      # vivo: sin un solo `busctl` en la tabla de procesos, un `fsck.exfat -n
      # /dev/sda1` llevaba más de minuto y medio corriendo. Con el tope de tamaño
      # de arriba esto ya no debería vencer nunca; el timeout largo está para que,
      # si vence, sea porque de verdad pasa algo raro y no por el reloj de DBus.
      out=$(busctl --system --timeout=900 call org.freedesktop.UDisks2 "$obj" \
              org.freedesktop.UDisks2.Filesystem Check 'a{sv}' 0 2>/dev/null) || exit 0
      [[ "$out" == *"true"* ]] && exit 0             # limpio

      # Sucio. Camino normal: repararlo ya. usb-repair.sh avisa de lo que hace y de
      # cómo acaba, así que aquí no hace falta notificar nada más.
      #
      # Se recomprueba el montaje justo antes: entre el Check y esta línea el gestor
      # de archivos ha podido montarlo, y en modo automático NO vamos a desmontarle un
      # volumen que quizá ya está usando. En ese caso (y solo en ese) se cae al aviso
      # con botón, donde el desmontaje lo autoriza él con el clic.
      if [[ -x "$REPAIR" ]] && ! esta_montado "$part"; then
          "$REPAIR" "/dev/$part"
          exit 0
      fi

      act=$(notificar usb.volumen-con-errores --wait -t 30000 \
              -u critical -A "repair=Reparar" \
              "Volumen con errores" \
              "«$name» ($fs) no está limpio y ya está montado — repáralo cuando dejes de usarlo.")
      [[ "$act" == "repair" ]] && [[ -x "$REPAIR" ]] && "$REPAIR" "/dev/$part" ) &
}

reset_event
while :; do
    # El bucle es el reloj de los pendientes: bloquea sin timeout cuando no hay
    # ninguno (coste cero, como siempre) y con timeout hasta el próximo
    # vencimiento cuando sí. `read` marca el timeout con un código >128; cualquier
    # otro código no-cero es fin del stream de udevadm → se vuelca y se sale.
    if wait_secs=$(next_deadline_wait); then
        IFS= read -r -t "$wait_secs" line; rc=$?
    else
        IFS= read -r line; rc=$?
    fi
    if (( rc != 0 )); then
        fire_due_pendings
        (( rc > 128 )) && continue
        break
    fi

    case "$line" in
        "UDEV  ["*)                 reset_event ;;
        "SUBSYSTEM="*)              subsystem=${line#SUBSYSTEM=} ;;
        "ACTION="*)                 action=${line#ACTION=} ;;
        "DEVTYPE="*)                devtype=${line#DEVTYPE=} ;;
        "DEVNAME="*)                devname=${line#DEVNAME=} ;;
        "DEVPATH="*)                devpath=${line#DEVPATH=} ;;
        "ID_BUS="*)                 bus=${line#ID_BUS=} ;;
        "ID_USB_INTERFACES="*)      ifaces=${line#ID_USB_INTERFACES=} ;;
        "ID_FS_TYPE="*)             fstype=${line#ID_FS_TYPE=} ;;
        "ID_FS_LABEL="*)            fslabel=${line#ID_FS_LABEL=} ;;
        "ID_VENDOR_FROM_DATABASE="*) vendor=${line#ID_VENDOR_FROM_DATABASE=} ;;
        "ID_VENDOR="*)              [[ -z "$vendor" ]] && vendor=${line#ID_VENDOR=} ;;
        "ID_MODEL_FROM_DATABASE="*) model=${line#ID_MODEL_FROM_DATABASE=} ;;
        "ID_MODEL="*)               [[ -z "$model" ]] && model=${line#ID_MODEL=} ;;
        "")
            # Línea en blanco = fin del bloque de propiedades de este evento.
            vendor="${vendor//_/ }"
            model="${model//_/ }"

            if [[ "$subsystem" == "usb" && "$devtype" == "usb_device" ]]; then
                # ":08" = mass storage → que hable el evento de bloque. Los dos
                # atajos solo sirven para AHORRARSE la espera cuando la respuesta
                # ya se sabe; si dicen que no, no se concluye nada: se difiere.
                is_storage=false
                [[ "$ifaces" == *":08"* ]] && is_storage=true
                [[ "$is_storage" == false ]] && sysfs_is_storage "$devpath" && is_storage=true
                event_label
                case "$action" in
                    add)
                        # Se cachea SIEMPRE, sea o no almacenamiento y aunque el
                        # aviso se calle: esto no alimenta el popup de conexión,
                        # alimenta el de DESCONEXIÓN, que es el que no tiene de
                        # dónde sacar el nombre.
                        cache_put "$devpath" "$ev_label" "$ev_known"
                        [[ "$is_storage" == false ]] && \
                            defer_usb_notice "$devpath" "$ev_label"
                        ;;
                    remove)
                        # El nombre se recupera ANTES de encolar el pendiente, no
                        # al vencer: así la fusión ve un `known=1` de entrada y no
                        # le cuela al primer pendrive la etiqueta del HUB cuando el
                        # remove del hub llega primero (rama «el entrante desciende
                        # de un pendiente» de defer_usb_removal, que rellena el
                        # nombre del entrante con el del pendiente si venía sin él).
                        # Al vencer tampoco se podría: fire_due_pendings ya no
                        # conoce los DEVPATH de los eventos absorbidos.
                        #
                        # El EVENTO manda si trae nombre: la caché es una foto de un
                        # PUERTO y el evento es el dato vivo. Y una entrada con
                        # known=0 no se usa: sería cambiar relleno por relleno.
                        if [[ "$ev_known" != 1 ]] && cache_lookup "$devpath" \
                           && [[ "$cache_known" == 1 ]]; then
                            ev_label=$cache_label; ev_known=1
                        fi
                        cache_drop "$devpath"
                        cancel_usb_notice "$devpath"
                        defer_usb_removal "$devpath" "$ev_label" "$ev_known"
                        ;;
                esac

            elif [[ "$subsystem" == "block" && "$bus" == "usb" && "$action" == "add" ]]; then
                # Prueba observada de que sí era almacenamiento: mata el aviso
                # genérico que estuviera en vuelo para este mismo dispositivo.
                cancel_usb_notice "$devpath"
                case "$devtype" in
                    disk)
                        # Un disco siempre aparece, aunque no tenga particiones ni fs
                        # legible — por eso el aviso cuelga de aquí y no de la partición.
                        blabel="${vendor:+$vendor }${model:-Disco USB}"
                        # Se enriquece la caché del usb_device del que cuelga este
                        # bloque: es el antecesor cacheado MÁS PROFUNDO, y por
                        # construcción hay uno solo — no hace falta parsear el path
                        # (`${d%/*:*.*/*}` es la tentación y está MAL: en expansión
                        # de parámetros `*` cruza `/`, así que `pci0000:00/...`
                        # también casa y el corte se va al puente PCI). Cubre el
                        # caso que ya documenta la cabecera: el `add` del usb_device
                        # puede llegar con las propiedades a medias y sin ID_MODEL,
                        # y el del bloque sí trae modelo.
                        if cache_lookup "$devpath" && [[ -n "$cache_hit" ]]; then
                            if [[ "$cache_known" == 1 ]]; then
                                cache_put "$cache_hit" "$cache_label" 1 "${devname##*/}"
                            elif [[ -n "$model" ]]; then
                                # Con el usb_device ya nombrado NO se pisa: el
                                # ID_MODEL del bloque sale de un INQUIRY SCSI
                                # truncado a 16 caracteres y es peor nombre.
                                cache_put "$cache_hit" "$blabel" 1 "${devname##*/}"
                            fi
                        fi
                        notify_storage "$(basename "$devname")" "$blabel"
                        ;;
                    partition)
                        [[ -n "$fstype" ]] && \
                            check_volume "$(basename "$devname")" \
                                         "${fslabel:-$(basename "$devname")}" "$fstype"
                        ;;
                esac
            fi
            reset_event
            ;;
    esac
done < <(udevadm monitor --udev --subsystem-match=usb --subsystem-match=block --property 2>/dev/null)
