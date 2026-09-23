#!/usr/bin/env bash
# analizar-almacenamiento.sh — inventario de disco para Ajustes > Almacenamiento.
#
# Emite JSON por stdout y NO borra nada: es la mitad de solo-lectura de la
# función. Lo que borra es `limpiar-almacenamiento.sh`, y son dos ficheros a
# propósito — el analizador lo invoca la UI cada vez que se abre la sección y el
# limpiador solo cuando el usuario pulsa algo o salta la autolimpieza.
#
#   analizar-almacenamiento.sh discos      → montajes reales con su uso
#   analizar-almacenamiento.sh categorias  → qué ocupa, por concepto
#   analizar-almacenamiento.sh apps        → catálogo de aplicaciones por tamaño
#   analizar-almacenamiento.sh todo        → los tres, en un solo objeto
#
# ── Cada categoría lleva DOS cifras ──────────────────────────────────────────
# `bytes` es lo que ocupa; `liberable` es lo que se liberaría al limpiarla. Ver el comentario largo
# sobre `_cat`: son distintas casi siempre, y sumar `bytes` para prometer espacio libre era el
# fallo que motivó la versión 2 de este formato.
#
# ── Por qué `du` y no una cifra exacta del sistema de ficheros ────────────────
# Btrfs con compresión y snapshots no tiene un "tamaño de esta carpeta" que
# signifique lo que la gente espera: `btrfs filesystem usage` da el total real
# del volumen (y ese sí sale en `discos`), pero repartirlo por carpetas exigiría
# qgroups habilitados y root. `du -sxb` da el tamaño lógico, que es la cifra que
# se corresponde con "si borro esto, dejo de tener estos bytes".
#
# ── Todo es opcional, y ese es el contrato ───────────────────────────────────
# Cada sonda va envuelta: sin `snapper`, sin `flatpak`, sin `/var/log/journal` o
# sin permiso de lectura, la entrada sale con `bytes: null` en vez de romper el
# JSON. `null` significa "no se ha podido medir" y la UI lo pinta distinto de un
# 0, que significa "medido y vacío". Confundirlos haría que una carpeta
# inaccesible pareciera limpia.
#
# ── El timeout no es paranoia ────────────────────────────────────────────────
# `du` sobre un ~/.cache con cientos de miles de ficheros y la caché de inodos
# fría tarda decenas de segundos. Esta salida alimenta un panel: una sonda lenta
# no puede dejar la sección entera esperando, así que cada `du` corre bajo
# `timeout` y lo que no llega a tiempo sale como `null`.
set -uo pipefail

export LC_ALL=C

DU_TIMEOUT=${GIGISHELL_DU_TIMEOUT:-20}
CACHE_HOME=${XDG_CACHE_HOME:-$HOME/.cache}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/almacenamiento.json"

command -v jq >/dev/null 2>&1 || { echo '{"error":"falta jq"}'; exit 1; }

# La lista única de qué borra cada acción, compartida con `limpiar-almacenamiento.sh`. Sin ella la
# columna `liberable` volvería a ser una suposición sobre lo que hace el otro script.
# shellcheck source=lib/limpieza-rutas.sh
source "$HOME/.config/hypr/scripts/lib/limpieza-rutas.sh"

# ── Preferencias de limpieza ─────────────────────────────────────────────────
# El analizador las necesita porque varias acciones borran CANTIDADES DISTINTAS según cómo estén
# configuradas: el journal se recorta a `retenerJournal`, papelera y descargas solo se llevan lo
# anterior a N días, y `rutasPersonalizadas` depende enteramente de lo que haya escrito el usuario.
# Estimar sin leerlas es lo que hacía que la sección prometiera espacio que no existía.
#
# La lectura vive en `lib/limpieza-rutas.sh` y la comparte con el limpiador: tenerla duplicada, con
# sus valores por defecto escritos dos veces, es el reparto que ya causó esa avería.
leer_preferencias_limpieza

# "200M" → bytes. Unidades de systemd, que son binarias (`journalctl --vacuum-size=200M` deja 200
# MiB, no 200 MB); usar 1000 aquí dejaría la estimación corta justo en el borde en que decide si
# recortar libera algo o no.
_retencion_bytes() {
    local n=${RETENER_JOURNAL%[KMG]} u=${RETENER_JOURNAL: -1}
    case "$u" in
        K) echo $((n * 1024)) ;;
        M) echo $((n * 1024 * 1024)) ;;
        G) echo $((n * 1024 * 1024 * 1024)) ;;
        *) echo "$n" ;;
    esac
}

# ── Utilidades ───────────────────────────────────────────────────────────────

# Tamaño lógico de una o varias rutas, en bytes. Vacío = no medible.
#
# `-x` (no cruzar sistemas de ficheros) importa de verdad aquí: /tmp es un
# tmpfs, ~/.local/share puede colgar de otro disco y sin `-x` una sonda sobre el
# hogar se llevaría por delante los montajes de dentro, contando dos veces lo
# que ya sale en `discos`.
_du() {
    local -a rutas=()
    local r
    for r in "$@"; do [[ -e "$r" ]] && rutas+=("$r"); done
    ((${#rutas[@]} == 0)) && return 1
    # `du` avisa por stderr de cada subdirectorio sin permiso y sigue contando el
    # resto: se silencia el ruido pero NO se descarta la cifra, porque una
    # medida parcial de /var/log es más útil que ninguna.
    timeout "$DU_TIMEOUT" du -scxb --  "${rutas[@]}" 2>/dev/null | awk 'END{print $1}'
}

# Igual, pero solo cuenta ficheros con más de N días sin modificar. Es lo que
# necesita la limpieza por antigüedad (papelera, descargas) para poder decir
# cuánto liberaría antes de borrar nada.
#
# `-mindepth 1 -maxdepth 1` + tamaño recursivo de cada entrada, y no un `-type f` plano: papelera y
# descargas se limpian por ELEMENTO DE PRIMER NIVEL (`find -maxdepth 1 -mtime +N -exec rm -rf`),
# así que una carpeta antigua se va entera aunque contenga ficheros tocados ayer. Contar solo los
# ficheros antiguos de dentro dejaba la estimación por debajo de lo que se borra de verdad.
_du_antiguo() {
    local dias=$1; shift
    local -a rutas=()
    local r
    for r in "$@"; do [[ -d "$r" ]] && rutas+=("$r"); done
    ((${#rutas[@]} == 0)) && return 1
    timeout "$DU_TIMEOUT" find "${rutas[@]}" -xdev -mindepth 1 -maxdepth 1 -mtime "+$dias" \
        -exec du -sxb -- {} + 2>/dev/null | awk '{t+=$1} END{print t+0}'
}

# Acumulador de categorías. Se emite al final de una vez para que un fallo a
# mitad no deje un JSON truncado.
#
# ── `bytes` y `liberable` son DOS cifras distintas, y confundirlas era el fallo ──────────────
# `bytes` = lo que la categoría OCUPA. `liberable` = lo que quedaría libre si pulsas su botón.
# Casi nunca coinciden, y las diferencias no son de redondeo:
#
#   registros      el journal se recorta a `retenerJournal`; por debajo de ese tamaño libera 0
#   temporales     mide /tmp + /var/tmp, pero /tmp es tmpfs (RAM) y no se toca → solo /var/tmp
#   cacheUsuario   el borrado respeta las cachés de GPU, las de GiGiShell y lo que tiene botón propio
#   cachePaquetes  se conserva la última versión de cada paquete instalado
#   descargas      con 0 días no borra NADA, aunque la carpeta ocupe 50 GB
#   papelera       con N días, solo lo anterior a N
#
# La sección sumaba `bytes` para prometer espacio libre. Medido en este equipo: 28,2 GiB
# prometidos contra 26,7 GiB reales, y con «Descargas» marcada la mentira habría sido mucho mayor.
#
# `liberable` vacío = NO SE HA PODIDO SABER (sale `null`), que no es 0. Se usa para lo que no tiene
# una sonda barata y fiable —los runtimes de Flatpak sin usar— y la UI lo dice en vez de callarlo.
CATS=""
_cat() {  # id  bytes  detalle  limpiable  liberable
    local bytes=${2:-} liberable=${5:-}
    [[ "$bytes"     =~ ^[0-9]+$ ]] || bytes=""
    [[ "$liberable" =~ ^[0-9]+$ ]] || liberable=""
    # Tope duro: nada puede liberar más de lo que ocupa. Es una red, no la lógica —cada sonda ya
    # calcula bien su cifra—, pero las dos medidas se toman en instantes distintos sobre un blanco
    # móvil, y un «se liberarían 24,9 GB» sobre una carpeta de 23,2 GB desacredita el panel entero.
    if [[ -n "$bytes" && -n "$liberable" ]] && ((liberable > bytes)); then liberable=$bytes; fi
    CATS+="${1}"$'\t'"${bytes}"$'\t'"${3:-}"$'\t'"${4:-no}"$'\t'"${liberable}"$'\n'
}

_emitir_categorias() {
    printf '%s' "$CATS" | jq -R -s '
        split("\n") | map(select(length > 0)) | map(split("\t")) |
        map({
            id: .[0],
            bytes: (if .[1] == "" then null else (.[1] | tonumber) end),
            detalle: .[2],
            limpiable: (.[3] == "si"),
            liberable: (if (.[4] // "") == "" then null else (.[4] | tonumber) end)
        })'
}

# Resta acotada a 0 sobre cifras que pueden venir vacías. Se usa para todo `liberable` derivado de
# «lo que ocupa menos lo que se conserva»: sin la cota, un `du` que falle a mitad daría un
# liberable negativo y el JSON llevaría una promesa absurda hasta la interfaz.
_resta() {
    local a=${1:-} b=${2:-0}
    [[ "$a" =~ ^[0-9]+$ ]] || { echo ""; return 0; }
    [[ "$b" =~ ^[0-9]+$ ]] || b=0
    ((a > b)) && echo $((a - b)) || echo 0
}

# Bytes de lo que el usuario ha marcado como INTOCABLE dentro de estos directorios. Se descuenta de
# `liberable`, nunca de `bytes`: lo protegido sigue ocupando disco (y tiene que seguir saliendo en
# el desglose, que es donde se ve dónde está el espacio), simplemente ya no se va a liberar.
#
# Sin esto la sección prometería el espacio de lo que la limpieza ya no se lleva — el mismo tipo de
# mentira que motivó que existan dos cifras por categoría.
_du_protegido() {  # dir… → bytes (0 si no hay nada protegido ahí dentro)
    local -a p=()
    mapfile -t p < <(protegidos_bajo "$@")
    ((${#p[@]} == 0)) && { echo 0; return 0; }
    local b; b=$(_du "${p[@]}") || b=0
    echo "${b:-0}"
}

# ── Discos ───────────────────────────────────────────────────────────────────
# Solo montajes de VERDAD: se excluyen los pseudo-sistemas de ficheros y los
# bind mounts de contenedores, que multiplicarían la misma partición por seis.
#
# `df` da el uso desde el punto de vista del sistema de ficheros, que en btrfs
# con snapshots es lo correcto (un snapshot ocupa espacio real y `du` no lo ve).
# Por eso la barra de uso sale de aquí y no de la suma de categorías.
discos() {
    df -B1 --output=source,target,fstype,size,used,avail,pcent -x tmpfs -x devtmpfs \
        -x squashfs -x overlay -x efivarfs -x ramfs 2>/dev/null \
        | tail -n +2 \
        | awk 'NF >= 7 { printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5, $6, $7 }' \
        | jq -R -s '
            split("\n") | map(select(length > 0)) | map(split("\t")) |
            map(select(length >= 7)) |
            map({
                dispositivo: .[0], punto: .[1], fs: .[2],
                total: (.[3] | tonumber), usado: (.[4] | tonumber),
                libre: (.[5] | tonumber),
                porcentaje: (.[6] | rtrimstr("%") | tonumber)
            }) |
            # UN disco por SISTEMA DE FICHEROS, no por punto de montaje. En una
            # instalación btrfs como la de CachyOS, `/`, `/home`, `/var/log`,
            # `/var/cache`… son subvolúmenes del MISMO dispositivo: `df` los
            # lista por separado con cifras idénticas y la sección enseñaba
            # siete veces el mismo disco de 1 TB, como si hubiera siete. Se
            # ordena por longitud del punto de montaje para quedarse con el más
            # corto (`/` antes que `/var/cache`), que es el que la gente
            # reconoce como "el disco".
            sort_by(.punto | length) | unique_by(.dispositivo) |
            sort_by(.punto)'
}

# ── Categorías ───────────────────────────────────────────────────────────────

_dir_usuario() {  # XDG user dir con fallback al nombre inglés
    local clave=$1 fallback=$2 ruta=""
    command -v xdg-user-dir >/dev/null 2>&1 && ruta=$(xdg-user-dir "$clave" 2>/dev/null)
    [[ -n "$ruta" && "$ruta" != "$HOME" && -d "$ruta" ]] && { echo "$ruta"; return 0; }
    [[ -d "$HOME/$fallback" ]] && { echo "$HOME/$fallback"; return 0; }
    return 1
}

# Volcado ÚNICO del inventario de paquetes, compartido por todo el script.
#
# Formato TSV, una línea por paquete y SIEMPRE el mismo salga de donde salga:
#
#     nombre \t bytes \t explicit|dependency \t fecha de instalación \t descripción
#
# ── Por qué `expac` y no `pacman -Qi` ────────────────────────────────────────
# Antes se volcaba `pacman -Qi` entero y los tres consumidores (total instalado, huérfanos y
# catálogo de aplicaciones) parseaban esas ~60 000 líneas con awk. Medido en este equipo, sobre
# 1632 paquetes: `pacman -Qi` cuesta ~285 ms y `expac -Q` ~18 ms — quince veces menos — porque
# expac lee la base de datos local y emite solo los cinco campos que se piden, en vez de formatear
# veinte campos por paquete para que awk descarte quince.
#
# Y el tamaño llega YA EN BYTES (`%m`). El volcado de `pacman -Qi` lo da formateado ("12,34 MiB"),
# así que cada consumidor tenía que deshacer la unidad y multiplicar; eso era, además de trabajo,
# una conversión con redondeo a dos decimales sobre la que se sumaban 1600 paquetes.
#
# `pacman -Qi` sigue como respaldo (expac es opcional, no viene con pacman): produce el MISMO TSV,
# así que la conversión de unidades vive ahí y nada aguas abajo sabe de dónde salió el volcado.
#
# ── El volcado SE CREA EN EL PADRE, y esto no es un detalle de estilo ────────
# La versión perezosa (crear el fichero la primera vez que alguien lo pide, desde `$(_volcado_qi)`)
# estaba ROTA en los verbos `categorias` y `apps`: una sustitución de órdenes corre en un subshell,
# el subshell creaba el temporal Y SU PROPIO trap EXIT, y ese trap lo borraba al terminar la
# sustitución — o sea justo antes de que el padre intentara leerlo. Efecto medido:
#
#     $ analizar-almacenamiento.sh categorias
#     grep: /tmp/gigishell-qi.OjK6sR: No such file or directory
#     awk: fatal: cannot open file `/tmp/gigishell-qi.M5T47Z' for reading
#
# y las categorías `paquetes` y `huerfanos` salían con `bytes: null` (la UI las pintaba «—») y
# `apps` devolvía una lista VACÍA. No se notó antes porque el verbo que usa la interfaz es `todo`,
# que ya llamaba a `_volcado_qi` desde el padre por otro motivo (compartirlo entre los tres
# sondeos paralelos) y por eso sí funcionaba.
#
# Ahora la creación es explícita y siempre desde el padre: `_preparar_qi` la hace, y `_volcado_qi`
# se limita a devolver la ruta. Una función que solo imprime es segura dentro de `$( )`.
VOLCADO_QI=""
_preparar_qi() {
    [[ -n "$VOLCADO_QI" ]] && return 0
    command -v pacman >/dev/null 2>&1 || return 1
    VOLCADO_QI=$(mktemp -t gigishell-qi.XXXXXX)
    # El trap se instala aquí y no arriba para no borrar un fichero que no existe en las rutas
    # que nunca llegan a preguntar por paquetes (`discos`).
    trap 'rm -f "$VOLCADO_QI"' EXIT

    if command -v expac >/dev/null 2>&1; then
        # `-l` fija el separador de REGISTRO a \n, que es lo que ya asume el formato; sin él una
        # descripción vacía no cambiaría nada, pero deja explícito que aquí una línea es un paquete.
        expac -Q -l '\n' '%n\t%m\t%w\t%l\t%d' >"$VOLCADO_QI" 2>/dev/null
        [[ -s "$VOLCADO_QI" ]] && return 0
        # expac instalado pero sin salida (base de datos ilegible, versión incompatible): se cae al
        # respaldo en vez de dejar el análisis sin paquetes.
    fi

    # Respaldo: el mismo TSV a partir de `pacman -Qi`. Aquí es donde se deshace la unidad de
    # "Installed Size" — el único sitio del script que sigue sabiendo que existe.
    pacman -Qi 2>/dev/null | awk -F': *' '
        function emitir() {
            if (nombre == "") return
            u = tam; sub(/^[0-9.,]+ */, "", u)
            m = (u ~ /^KiB/) ? 1024 : (u ~ /^MiB/) ? 1048576 : (u ~ /^GiB/) ? 1073741824 : 1
            sub(/,/, ".", tam)
            printf "%s\t%d\t%s\t%s\t%s\n", nombre, (tam + 0) * m, \
                (razon ~ /Explicitly/ ? "explicit" : "dependency"), fecha, descripcion
            nombre = ""; tam = 0; razon = ""; fecha = ""; descripcion = ""
        }
        /^Name/            { nombre = $2 }
        /^Description/     { descripcion = $2 }
        /^Installed Size/  { tam = $2 }
        /^Install Reason/  { razon = $2 }
        # La fecha lleva dos puntos DENTRO ("Tue Jul 14 15:17:03 2026"), así que `$2` con este FS
        # la cortaba en la hora. Se recorta la etiqueta sobre la línea entera.
        /^Install Date/    { fecha = $0; sub(/^[^:]*: */, "", fecha) }
        /^$/               { emitir() }
        END                { emitir() }
    ' >"$VOLCADO_QI"
}

_volcado_qi() {
    printf '%s' "$VOLCADO_QI"
}

# Suma los tamaños del volcado. Sin argumentos suma TODO; con `--filtrar` y una lista de nombres
# por stdin, solo esos.
#
# El filtrado se hace dentro de awk contra un conjunto, no con `pacman -Qi -- pkg…`: así los
# huérfanos salen del mismo volcado que ya está en disco en vez de forkear un pacman más.
_tam_paquetes() {
    local dump; dump=$(_volcado_qi)
    local nombres=""
    if [[ "${1:-}" == "--filtrar" ]]; then
        nombres=$(cat)
        [[ -z "${nombres//[[:space:]]/}" ]] && { echo 0; return 0; }
    fi
    awk -F'\t' -v filtrar="${1:-}" -v lista="$nombres" '
        BEGIN {
            if (filtrar == "--filtrar") {
                n = split(lista, a, "\n")
                for (i = 1; i <= n; i++) if (a[i] != "") quiero[a[i]] = 1
            }
        }
        filtrar != "--filtrar" || ($1 in quiero) { t += $2 }
        END { printf "%d\n", t }' "$dump"
}

# Cuánto liberaría de verdad `paccache -rk1` + `paccache -ruk0`, que es lo que ejecuta el helper.
#
# NO es el tamaño de la caché: se conserva la última versión de cada paquete instalado. Con 3054
# ficheros y 1619 paquetes en este equipo la diferencia es de gigabytes.
#
# Se pide la lista de candidatos en modo simulación (`-d`) y se suman sus tamaños, en vez de leer
# el «disk space saved: 13.08 GiB» que paccache imprime: esa cifra viene redondeada a dos decimales
# de GiB, o sea con un error de hasta 10 MB por invocación, y son dos invocaciones. `-v` imprime
# nombres de fichero a secas, así que hay que anteponerles el directorio de caché.
#
# EL `sort -u` NO ES COSMÉTICO. Las dos listas SE SOLAPAN: `-k1` propone borrar las versiones
# viejas de todo paquete que tenga más de una, y `-uk0` propone borrar todas las versiones de lo
# que ya no está instalado — un paquete desinstalado con dos versiones en caché sale en las dos
# listas. Sumando sin deduplicar salían 24,94 GB liberables sobre un directorio que ocupa 23,23 GB:
# la estimación prometía MÁS espacio del que existe, que es la forma más vistosa de perder la
# confianza en la cifra. Es también por qué no vale leer los dos «disk space saved» que imprime
# paccache y sumarlos: 13,08 + 10,15 GiB = 23,23 GiB, más que el directorio entero.
_liberable_paccache() {
    local dir=/var/cache/pacman/pkg
    command -v paccache >/dev/null 2>&1 || { echo ""; return 0; }
    [[ -d "$dir" ]] || { echo ""; return 0; }
    { paccache -dvk1 2>/dev/null; paccache -dvuk0 2>/dev/null; } \
        | grep -F '.pkg.tar' \
        | sort -u \
        | awk -v d="$dir" '{ print d "/" $0 }' \
        | timeout "$DU_TIMEOUT" xargs -r -d '\n' stat -c '%s' -- 2>/dev/null \
        | awk '{t+=$1} END{print t+0}'
}

categorias() {
    local bytes detalle liberable ruta

    # ── Paquetes instalados ──────────────────────────────────────────────────
    if command -v pacman >/dev/null 2>&1; then
        # El número de paquetes sale de contar los `Name:` del volcado, no de un `pacman -Qq | wc`:
        # es la misma cifra sin dos procesos más.
        local total_pkgs
        # Una línea = un paquete en el volcado TSV, así que contar líneas es contar paquetes.
        total_pkgs=$(wc -l <"$(_volcado_qi)")
        bytes=$(_tam_paquetes)
        _cat paquetes "$bytes" "$total_pkgs" no ""

        # Caché de paquetes descargados. Es lo primero que hay que mirar cuando
        # falta espacio: crece sin techo si paccache.timer no está activo.
        bytes=$(_du /var/cache/pacman/pkg)
        detalle=$(find /var/cache/pacman/pkg -maxdepth 1 -name '*.pkg.tar*' 2>/dev/null | wc -l)
        _cat cachePaquetes "${bytes:-}" "$detalle" si "$(_liberable_paccache)"

        # Huérfanos: dependencias que instaló otro paquete y que ya no necesita
        # nadie. Es literalmente "bibliotecas que no se usan".
        #
        # Aquí `liberable` SÍ es igual a `bytes`: la acción desinstala exactamente los paquetes que
        # se acaban de medir, ni uno más.
        local orfanos
        orfanos=$(pacman -Qtdq 2>/dev/null)
        bytes=$(printf '%s\n' "$orfanos" | _tam_paquetes --filtrar)
        detalle=$(printf '%s' "$orfanos" | grep -c . || true)
        _cat huerfanos "$bytes" "$detalle" si "$bytes"
    fi

    # Caché del helper de AUR: clones de git y paquetes compilados. pacman no la
    # conoce, así que `paccache` no la toca y crece por su cuenta.
    #
    # `liberable` = todo: la acción hace `-Sc --noconfirm` y además vacía `clone/`, y lo que `-Sc`
    # conserva (los paquetes construidos de lo que sigue instalado) es marginal frente a los clones
    # de git, que son la mayor parte del directorio.
    local -a aur=()
    local h
    for h in paru yay; do [[ -d "$CACHE_HOME/$h" ]] && aur+=("$CACHE_HOME/$h"); done
    if ((${#aur[@]})); then
        bytes=$(_du "${aur[@]}")
        detalle=$(find "${aur[@]}" -maxdepth 2 -name clone -prune -o -maxdepth 1 -type d -print 2>/dev/null | wc -l)
        _cat cacheAur "${bytes:-}" "$detalle" si "${bytes:-}"
    fi

    # ── Registros del sistema ────────────────────────────────────────────────
    # Se mide el directorio y no `journalctl --disk-usage`: esa orden imprime la
    # cifra ya formateada y redondeada ("43.8M"), y reconvertirla pierde
    # precisión justo en el rango en que importa decidir si limpiar.
    #
    # Recortar deja `retenerJournal`, así que libera lo que SOBRE de ese tamaño. Con el journal ya
    # por debajo del umbral —el caso normal en un equipo que autolimpia— la respuesta correcta es
    # 0, y antes la sección prometía el journal entero.
    bytes=$(_du /var/log/journal)
    _cat registros "${bytes:-}" "" si "$(_resta "${bytes:-}" "$(_retencion_bytes)")"

    # ── Temporales ───────────────────────────────────────────────────────────
    # /tmp suele ser tmpfs (o sea RAM): sale igualmente porque llenarlo cuelga
    # aplicaciones, pero no descuenta del disco. /var/tmp sí es disco.
    #
    # Y por eso `liberable` mide SOLO /var/tmp, y encima solo lo anterior a un día: es literalmente
    # lo que borra el helper (`find /var/tmp -mtime +1 -delete`). Contar /tmp aquí era prometer
    # espacio en disco a cambio de vaciar RAM.
    bytes=$(_du /tmp /var/tmp)
    _cat temporales "${bytes:-}" "" si "$(_du_antiguo 1 /var/tmp)"

    # ── Instantáneas Btrfs ───────────────────────────────────────────────────
    # Se informa del NÚMERO, no de los bytes, y es deliberado: el espacio
    # exclusivo de un snapshot solo lo sabe `btrfs qgroup show`, que exige
    # qgroups habilitados y root. Dar aquí la suma de sus `du` sería una cifra
    # enorme y falsa (todo lo compartido contado una vez por snapshot).
    #
    # Y CONTARLOS TAMBIÉN ES DE ROOT: `snapper list` responde «Sin permisos» y
    # `btrfs subvolume list /` un «Operation not permitted» — los dos con
    # **código de salida 0** en el caso de snapper, así que el `grep -c` daba 0
    # y la fila desaparecía como si no hubiera instantáneas. Por eso la cuenta
    # sale del helper root-owned vía `sudo -n`; sin el helper instalado la fila
    # simplemente no se enseña, que es honesto — no sabemos.
    if [[ -x /usr/local/bin/gigishell-limpieza ]]; then
        local n
        n=$(sudo -n /usr/local/bin/gigishell-limpieza instantaneas 2>/dev/null)
        [[ "$n" =~ ^[0-9]+$ && "$n" != 0 ]] && _cat instantaneas "" "$n" no ""
    fi

    # ── Flatpak ──────────────────────────────────────────────────────────────
    # `liberable` sale VACÍO (→ `null`) a propósito, y es el único caso de la lista.
    #
    # La acción quita los runtimes que ya no usa ninguna app, y flatpak no ofrece ninguna
    # simulación de eso: `flatpak uninstall --unused` no tiene `--dry-run`, y reconstruir su
    # criterio a mano (cruzar `flatpak list --columns=ref` contra los runtimes que declara cada
    # app, con sus extensiones y sus versiones) sería una segunda implementación que se desviaría
    # de la real en la primera actualización de flatpak. Antes se contaba la instalación ENTERA
    # —apps incluidas—, que es la sobrestimación más grande que había aquí.
    #
    # `null` significa «no se ha podido medir», la UI lo dice, y la estimación se marca como
    # incompleta en vez de inventarse un número.
    if command -v flatpak >/dev/null 2>&1; then
        bytes=$(_du /var/lib/flatpak "$DATA_HOME/flatpak")
        detalle=$(flatpak list --app --columns=application 2>/dev/null | grep -c . || true)
        _cat flatpak "${bytes:-}" "$detalle" si ""
    fi

    # ── Caché del usuario ────────────────────────────────────────────────────
    # `bytes` es ~/.cache ENTERO, porque es lo que ocupa y es lo que hay que enseñar en el
    # desglose. `liberable` descuenta lo que el borrado respeta (ver lib/limpieza-rutas.sh): las
    # cachés de shaders de la GPU, las de GiGiShell, y lo que tiene su propio botón —AUR, miniaturas,
    # desarrollo—. Sin ese descuento, marcar las tres casillas de caché contaba `thumbnails` dos
    # veces y regalaba el gigabyte de `~/.cache/nvidia` que nunca se borra.
    #
    # Se calcula restando en vez de con un segundo `du` filtrado: las exclusiones son diez
    # directorios de primer nivel y medirlos cuesta una fracción de recorrer el árbol otra vez.
    bytes=$(_du "$CACHE_HOME")
    local -a preservado=()
    # `CACHE_PRESERVADO` son PATRONES (`mesa_shader_cache*`, `qtshadercache-*`), así que las rutas
    # las resuelve la lib con un `find` de primer nivel. El bucle que había aquí concatenaba
    # `$CACHE_HOME/$h` y solo acertaba con los nombres literales: lo que casaba por patrón se
    # quedaba SIN descontar, o sea prometido como liberable cuando el borrado no lo toca.
    mapfile -t preservado < <(cache_preservado_rutas)
    # Lo que el usuario haya protegido dentro de ~/.cache se descuenta igual que la lista fija, y
    # por el mismo motivo: el borrado no se lo lleva. Se añade a `preservado` en vez de restarse
    # aparte para no contarlo dos veces cuando cae dentro de algo que ya estaba excluido
    # (`~/.cache/paru/algo`) — `du` con rutas anidadas sumaría la de dentro por partida doble.
    local prot cubierta
    while read -r prot; do
        [[ -n "$prot" ]] || continue
        cubierta=0
        for h in "${preservado[@]}"; do [[ "$prot" == "$h" || "$prot" == "$h"/* ]] && { cubierta=1; break; }; done
        ((cubierta)) || preservado+=("$prot")
    done < <(protegidos_bajo "$CACHE_HOME")
    liberable=""
    ((${#preservado[@]})) && liberable=$(_resta "${bytes:-}" "$(_du "${preservado[@]}")") || liberable="${bytes:-}"
    _cat cacheUsuario "${bytes:-}" "" si "$liberable"

    # Miniaturas y cachés de desarrollo: el borrado se lleva exactamente lo medido, así que las dos
    # cifras coinciden. Desde que `cacheUsuario` las respeta, además, no se solapan con nadie.
    #
    # Con rutas protegidas dentro, las dos dejan de coincidir: `bytes` sigue siendo lo que ocupa y
    # `liberable` descuenta lo intocable. Y si lo protegido es el directorio entero, no se libera
    # nada.
    bytes=$(_du "$CACHE_HOME/thumbnails")
    if protegido_cubre "$CACHE_HOME/thumbnails"; then
        liberable=0
    else
        liberable=$(_resta "${bytes:-}" "$(_du_protegido "$CACHE_HOME/thumbnails")")
    fi
    _cat miniaturas "${bytes:-}" "" si "${liberable:-}"

    # npm, pip, Go y Cargo: reconstruibles enteras desde la red, nunca contienen
    # nada que el usuario haya escrito.
    #
    # OJO a Cargo: se mide `registry/cache` y no `registry/` entero, que es lo que se medía antes.
    # `registry/src/` es el código fuente descomprimido del que dependen las compilaciones ya
    # hechas; la acción no lo toca, así que contarlo doblaba la cifra de esta fila.
    mapfile -t dev < <(rutas_desarrollo)
    bytes=$(_du "${dev[@]}")
    # Lo protegido no se libera: una ruta protegida entera sale de la lista y lo protegido de dentro
    # de las demás se descuenta. (`npm cache clean` y `pip cache purge` borran por su cuenta y no
    # aceptan exclusiones — está dicho en la UI; go-build y Cargo van por `_vaciar`, que sí las
    # respeta.)
    local -a devLibre=()
    local d
    for d in "${dev[@]}"; do protegido_cubre "$d" || devLibre+=("$d"); done
    if ((${#devLibre[@]} == 0)); then
        liberable=0
    else
        liberable=$(_resta "$(_du "${devLibre[@]}")" "$(_du_protegido "${devLibre[@]}")")
    fi
    _cat cacheDesarrollo "${bytes:-}" "" si "${liberable:-}"

    # ── Sombreadores ─────────────────────────────────────────────────────────
    # Mesa, NVIDIA, AMDVLK, Qt y el `shadercache` de Steam. La lista, sus tres ubicaciones posibles
    # de Steam y la canonicalización que evita medir la misma carpeta dos veces están en
    # `rutas_shaders`. Se expande con `objetivos_de_ruta` y se filtra con `filtrar_protegidos`, o
    # sea exactamente lo que el limpiador va a borrar: aquí la paridad no es una aproximación.
    #
    # La fila NO sale si no hay ninguna caché (ni drivers que las escriban, ni Steam), como el resto
    # de sondas opcionales.
    local -a shaders=()
    mapfile -t shaders < <(rutas_shaders)
    if ((${#shaders[@]})); then
        local -a objShaders=()
        local rutaShader
        for rutaShader in "${shaders[@]}"; do
            objetivos_de_ruta "$rutaShader"
            objShaders+=("${OBJETIVOS_RUTA[@]}")
        done
        filtrar_protegidos "${objShaders[@]}"
        objShaders=("${OBJETIVOS_FILTRADOS[@]}")
        bytes=0
        ((${#objShaders[@]})) && bytes=$(_du "${objShaders[@]}")
        _cat cacheSombreadores "${bytes:-0}" "${#shaders[@]}" si "${bytes:-0}"
    fi

    # ── Papelera ─────────────────────────────────────────────────────────────
    # Con `diasPapelera > 0` la acción solo se lleva lo anterior a esos días, así que eso es lo
    # liberable; con 0 se vacía entera. Con la papelera a 30 días —la configuración de este
    # equipo— la diferencia entre las dos cifras es todo lo que has borrado este mes.
    bytes=$(_du "$DATA_HOME/Trash")
    detalle=$(find "$DATA_HOME/Trash/files" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
    if ((DIAS_PAPELERA > 0)); then
        liberable=$(_du_antiguo "$DIAS_PAPELERA" "$DATA_HOME/Trash/files")
    else
        liberable="${bytes:-}"
    fi
    # Descontar lo protegido puede quedarse CORTO por abajo con `diasPapelera > 0`: se resta todo lo
    # protegido que haya en la papelera aunque parte no fuera a borrarse todavía por no ser lo
    # bastante antiguo. Es la dirección segura del error —prometer de menos, nunca de más— y el
    # caso es raro de por sí: proteger algo que ya tiraste a la papelera.
    liberable=$(_resta "${liberable:-}" "$(_du_protegido "$DATA_HOME/Trash")")
    _cat papelera "${bytes:-}" "$detalle" si "${liberable:-}"

    # ── Rutas personalizadas ─────────────────────────────────────────────────
    # Lo que el usuario haya añadido en Ajustes, ya filtrado por `leer_preferencias_limpieza`. Cada
    # ruta se expande con `objetivos_de_ruta` —el CONTENIDO si es carpeta, el fichero si es
    # fichero—, que es la misma función que usa el limpiador: medir con un criterio y borrar con
    # otro es el origen exacto de la avería que motivó la columna `liberable`.
    #
    # `bytes` y `liberable` coinciden aquí y es correcto: se borra todo lo que se mide, sin
    # exclusiones ni antigüedad.
    if ((${#RUTAS_PERSONALIZADAS[@]})); then
        local -a objetivos=()
        for ruta in "${RUTAS_PERSONALIZADAS[@]}"; do
            objetivos_de_ruta "$ruta"
            objetivos+=("${OBJETIVOS_RUTA[@]}")
        done
        # Aquí la paridad con el borrado es EXACTA y sin aproximaciones: se aplica el mismo
        # `filtrar_protegidos` que usa `_borrar_medido`, sobre la misma lista, así que lo medido es
        # literalmente lo que se va a borrar.
        filtrar_protegidos "${objetivos[@]}"
        objetivos=("${OBJETIVOS_FILTRADOS[@]}")
        bytes=0
        ((${#objetivos[@]})) && bytes=$(_du "${objetivos[@]}")
        _cat rutasPersonalizadas "${bytes:-0}" "${#RUTAS_PERSONALIZADAS[@]}" si "${bytes:-0}"
    fi

    # ── Carpetas del usuario (informativas) ──────────────────────────────────
    # No se limpian desde aquí: son documentos, no residuos. Salen porque en un
    # equipo normal son la mayor parte del disco y sin ellas el desglose no
    # explica dónde está el espacio.
    #
    # Descargas es la excepción, y la que más mentía: SIN días configurados la acción no borra
    # nada —así se diseñó, es la única carpeta con ficheros que el usuario puso a mano—, pero la
    # estimación contaba la carpeta entera. Con un Descargas de 50 GB eso era prometer 50 GB por
    # una limpieza que no iba a tocar un solo fichero.
    #
    # Y con `descargasAPapelera` encendido tampoco libera nada, por otro motivo: `gio trash` MUEVE
    # los ficheros a `~/.local/share/Trash`, que está en el mismo sistema de ficheros. El disco no
    # baja ni un byte hasta que se vacíe la papelera —que tiene su propia acción y su propia
    # cifra—, así que contarlo aquí sería prometer el mismo espacio dos veces.
    local ruta
    if ruta=$(_dir_usuario DOWNLOAD Descargas); then
        bytes=$(_du "$ruta")
        if ((DIAS_DESCARGAS > 0)) && [[ "$A_PAPELERA" != true ]]; then
            # Mismo descuento —y misma reserva— que en la papelera: lo protegido dentro de Descargas
            # se resta entero aunque no todo fuera a caducar todavía.
            liberable=$(_resta "$(_du_antiguo "$DIAS_DESCARGAS" "$ruta")" "$(_du_protegido "$ruta")")
        else
            liberable=0
        fi
        _cat descargas "${bytes:-}" "$ruta" si "${liberable:-}"
    fi
    for par in "DOCUMENTS:Documentos:documentos" "PICTURES:Imágenes:imagenes" \
               "VIDEOS:Vídeos:videos" "MUSIC:Música:musica" "DESKTOP:Escritorio:escritorio"; do
        IFS=: read -r clave fallback id <<<"$par"
        if ruta=$(_dir_usuario "$clave" "$fallback"); then
            bytes=$(_du "$ruta")
            _cat "$id" "${bytes:-}" "$ruta" no ""
        fi
    done

    _emitir_categorias
}

# ── Catálogo de aplicaciones ─────────────────────────────────────────────────
# Un registro por paquete: nombre, tamaño instalado, origen (repo/AUR), si lo
# pidió el usuario o entró como dependencia, y la fecha de instalación.
#
# `explicito` + `origen` son lo que convierte la lista en accionable: lo que
# entró como dependencia y ya nadie necesita son los huérfanos (categoría
# aparte), y lo explícito es lo único que tiene sentido ofrecerse a desinstalar.
apps() {
    # Sin volcado no hay catálogo, y hay que salir con una lista vacía en vez de seguir: `awk … ""`
    # trata la cadena vacía como «lee de stdin» y el análisis se quedaría colgado para siempre en
    # un `read` que nadie va a satisfacer.
    command -v pacman >/dev/null 2>&1 || { echo '[]'; return 0; }
    [[ -s "$(_volcado_qi)" ]] || { echo '[]'; return 0; }

    local aur_list
    aur_list=$(pacman -Qmq 2>/dev/null)

    # Lee el volcado compartido (ver `_preparar_qi`): invocar `pacman -Qi` por paquete serían ~1600
    # forks, y volver a invocarlo entero aquí eran los ~285 ms que ya pagó `categorias`. El volcado
    # ya trae los bytes y la razón de instalación en su forma final, así que aquí solo queda cruzar
    # con la lista de AUR y renombrar las dos columnas al vocabulario de la interfaz.
    awk -F'\t' -v OFS='\t' -v aur="$aur_list" '
        BEGIN {
            n = split(aur, a, "\n")
            for (i = 1; i <= n; i++) if (a[i] != "") esAur[a[i]] = 1
        }
        NF >= 5 {
            print $1, $2, ($1 in esAur ? "aur" : "repo"), ($3 == "explicit" ? "si" : "no"), $4, $5
        }
    ' "$(_volcado_qi)" | jq -R -s '
        split("\n") | map(select(length > 0)) | map(split("\t")) |
        map(select(length >= 6)) |
        map({
            nombre: .[0], bytes: (.[1] | tonumber), origen: .[2],
            explicito: (.[3] == "si"), fecha: .[4], descripcion: .[5]
        }) | sort_by(-.bytes)'
}

# ── Entrada ──────────────────────────────────────────────────────────────────

case "${1:-todo}" in
    discos)     discos ;;
    # `_preparar_qi` SIEMPRE desde el padre, también en los verbos sueltos: crear el volcado dentro
    # de una sustitución de órdenes lo dejaba borrado por el trap del subshell antes de poder
    # leerlo, y `categorias`/`apps` salían rotos. Ver la cabecera de `_preparar_qi`.
    categorias) _preparar_qi; categorias ;;
    apps)       _preparar_qi; apps ;;
    todo)
        # El volcado se genera AQUÍ, antes de forkear: una variable asignada dentro de un subshell
        # no vuelve al padre ni llega a sus hermanos, así que si cada sondeo lo creara por su
        # cuenta serían tres `pacman -Qi`. Igual de lento, solo que simultáneo y por tanto
        # invisible en el reloj de pared.
        _preparar_qi

        # Los tres en paralelo: `categorias` está dominado por E/S y `apps` por
        # CPU, así que solaparlos cuesta lo que el más lento en vez de la suma.
        d=$(mktemp) c=$(mktemp) a=$(mktemp)
        # Se encadena al trap que ya pueda haber puesto `_preparar_qi`: un `trap` nuevo sustituye al
        # anterior, y sin esto el volcado se quedaría en /tmp después de cada análisis.
        trap 'rm -f "$d" "$c" "$a" "$VOLCADO_QI"' EXIT
        discos >"$d" & pd=$!
        categorias >"$c" & pc=$!
        apps >"$a" & pa=$!
        wait $pd $pc $pa
        jq -n --slurpfile discos "$d" --slurpfile cats "$c" --slurpfile apps "$a" \
            --arg epoch "$(date +%s)" '{
                version: 2,
                epoch: ($epoch | tonumber),
                discos: ($discos[0] // []),
                categorias: ($cats[0] // []),
                apps: ($apps[0] // [])
            }'
        ;;
    *) echo "uso: $0 {discos|categorias|apps|todo}" >&2; exit 2 ;;
esac
