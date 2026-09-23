# shellcheck shell=bash
# lib/limpieza-rutas.sh — QUÉ borra exactamente cada acción de limpieza. Se SOURCEA, no se ejecuta.
#
# EL PROBLEMA QUE RESUELVE: `analizar-almacenamiento.sh` estima cuánto se liberaría y
# `limpiar-almacenamiento.sh` borra. Si cada uno tiene su propia idea de qué entra y qué no, la
# cifra que enseña Ajustes es una ficción — y esa fue exactamente la avería: la estimación sumaba
# «lo que ocupa la carpeta» mientras el borrado respetaba media docena de exclusiones que la
# estimación desconocía. Medido en este equipo: 28,2 GiB prometidos contra 26,7 GiB reales, con
# `~/.cache` sobrestimado en 1,6 GB él solo.
#
# Aquí vive la lista única. Los dos scripts la sourcean, así que no pueden discrepar.
#
# ── Las tres cachés de ~/.cache son DISJUNTAS ────────────────────────────────
# `cacheUsuario`, `miniaturas` y `cacheDesarrollo` se solapaban en disco: las dos últimas viven
# DENTRO de la primera. Con tres casillas independientes en la autolimpieza eso hacía imposible
# una estimación exacta —marcar las tres sumaba `thumbnails` dos veces— y volvía impredecible el
# botón suelto, que se llevaba por delante lo que otro botón decía gestionar.
#
# Ahora `cacheUsuario` EXCLUYE lo que tiene botón propio. Cada acción borra exactamente lo suyo y
# la suma de lo marcado es siempre el espacio que se libera, ni más ni menos. Vaciar `~/.cache`
# entero sigue siendo posible: se marcan las tres.

CACHE_HOME=${XDG_CACHE_HOME:-$HOME/.cache}
DATA_HOME_LIMPIEZA=${XDG_DATA_HOME:-$HOME/.local/share}

# Nombres de primer nivel de ~/.cache que `cacheUsuario` NO toca. Dos motivos distintos:
#
#   · no son caché de verdad (gigios guarda ahí el mapa de fuentes del CSS y el sondeo de hardware,
#     que nada regenera);
#   · o tienen su propia acción, y borrarlas desde dos sitios es lo que rompía la estimación
#     (paru/yay → cacheAur, thumbnails → miniaturas, pip/go-build → cacheDesarrollo, y todo lo de
#     la GPU → cacheSombreadores).
#
# **Son PATRONES de `find -name`, no nombres literales**, y esa distinción arregla un fallo real:
# la entrada era `radv_builtin_shaders` a secas y el fichero que RADV escribe de verdad se llama
# `radv_builtin_shaders64` (el sufijo es el tamaño de puntero), así que la exclusión no casaba con
# nada y `cacheUsuario` se lo llevaba por delante. Aquí no se notó nunca porque esta máquina es
# NVIDIA. Lo mismo con `qtshadercache-<arch>-<endianness>-<abi>`, cuyo nombre lleva el triplete de
# la máquina dentro.
CACHE_PRESERVADO=(
    gigios
    paru yay
    'mesa_shader_cache*' nvidia 'radv_builtin_shaders*' AMD 'qtshadercache-*'
    thumbnails
    pip go-build
)

# Lo mismo en forma de argumentos para `find`: rellena el array `EXCLUIR_FIND` con
# `! -name x ! -name y …`. Se genera de la lista en vez de escribirse a mano para que añadir una
# exclusión sea tocar un sitio, y va en un array —no en una cadena— porque un nombre con espacios
# dentro de una cadena expandida sin comillas se partiría en dos argumentos de `find`.
cache_preservado_find() {
    local n
    EXCLUIR_FIND=()
    for n in "${CACHE_PRESERVADO[@]}"; do EXCLUIR_FIND+=(! -name "$n"); done
}

# Y en forma de RUTAS existentes, que es lo que necesita el analizador para descontar de
# `cacheUsuario` lo que el borrado respeta. Va por `find` y no por expansión de shell porque las
# entradas son patrones: `$CACHE_HOME/$n` con `n='mesa_shader_cache*'` no expande dentro de unas
# comillas, y sin ellas se partiría por los espacios. Una sola pasada de primer nivel.
cache_preservado_rutas() {
    ((${#CACHE_PRESERVADO[@]} == 0)) && return 0
    local -a expr=()
    local n
    for n in "${CACHE_PRESERVADO[@]}"; do
        ((${#expr[@]})) && expr+=(-o)
        expr+=(-name "$n")
    done
    find "$CACHE_HOME" -mindepth 1 -maxdepth 1 \( "${expr[@]}" \) 2>/dev/null
}

# ── Cachés de sombreadores ───────────────────────────────────────────────────
# Lo que compilan los drivers para no volver a compilar el mismo shader: OpenGL, Vulkan y los
# kernels de CUDA. **Es la única acción de usuario que NO es automatizable**, y no por privilegios
# —todo esto vive bajo $HOME— sino porque el coste de borrarla no se paga en disco: se paga en la
# siguiente partida, compilando otra vez, con tirones mientras tanto. Eso se decide mirando, no de
# madrugada y sin avisar. La lista blanca de `limpieza-arranque.sh` no la incluye, que es la barrera
# de verdad; el catálogo del shell la marca `manual`.
#
# La entrada gorda es **`steamapps/shadercache`** (14 GB en este equipo frente a los ~1 GB del resto
# junto): son las cachés precompiladas de Fossilize que Steam **descarga** por juego, así que
# borrarlas se vuelve a pagar en red la próxima vez que lo abras. Se listan sus tres ubicaciones
# posibles —nativa, el symlink histórico `~/.steam/steam` y la de Flatpak— y se **canonicalizan**:
# en esta máquina las dos primeras son literalmente el mismo directorio, y medirlo dos veces habría
# duplicado la cifra de la fila.
#
# `~/.nv/ComputeCache` no es de shaders sino de kernels de CUDA. Entra igual: mismo dueño, mismo
# comportamiento (se regenera solo) y a nadie le sirve una fila aparte para ella.
rutas_shaders() {
    local -a candidatas=(
        "$CACHE_HOME"/mesa_shader_cache*
        "$CACHE_HOME"/radv_builtin_shaders*
        "$CACHE_HOME"/qtshadercache-*
        "$CACHE_HOME/nvidia"
        "$CACHE_HOME/AMD"
        "$HOME/.nv/GLCache"
        "$HOME/.nv/ComputeCache"
        "$DATA_HOME_LIMPIEZA/Steam/steamapps/shadercache"
        "$HOME/.steam/steam/steamapps/shadercache"
        "$HOME/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/shadercache"
    )
    # Un patrón sin coincidencias se queda literal (no hay `nullglob` aquí y activarlo cambiaría el
    # comportamiento de todo el que sourcee esto), así que el filtro de existencia hace las dos
    # cosas: descartar lo que no hay y descartar los globs sin expandir.
    local -a vistas=()
    local r real v repetida
    for r in "${candidatas[@]}"; do
        [[ -e "$r" ]] || continue
        real=$(realpath -m -- "$r" 2>/dev/null) || continue
        repetida=0
        for v in "${vistas[@]}"; do [[ "$v" == "$real" ]] && { repetida=1; break; }; done
        ((repetida)) && continue
        vistas+=("$real")
        printf '%s\n' "$real"
    done
}

# Rutas de `cacheDesarrollo`, exactamente las que vacía la acción. `~/.cargo/registry/cache` y no
# `~/.cargo/registry` entero: dentro de `registry/` está también `src/`, que es el código fuente
# que Cargo descomprime y del que dependen las compilaciones ya hechas — borrarlo obliga a
# recompilar todo el árbol, no solo a volver a bajar los .crate.
rutas_desarrollo() {
    printf '%s\n' "$HOME/.npm" "$CACHE_HOME/pip" "$CACHE_HOME/go-build" "$HOME/.cargo/registry/cache"
}

# ── Preferencias de limpieza ─────────────────────────────────────────────────
# Las escribe AGS y las leen LOS DOS scripts: el analizador para saber cuánto liberaría cada acción
# y el limpiador para saber qué borrar. Estaban duplicadas —el mismo `jq` y los mismos valores por
# defecto escritos dos veces—, que es exactamente el reparto que ya causó la avería de la
# estimación: en cuanto uno de los dos cae a un default distinto, la cifra que enseña la interfaz
# deja de describir lo que ocurre.
#
# UN SOLO `jq` para todo, incluidas las dos listas de rutas: la primera línea trae los escalares en
# TSV y las siguientes, una ruta cada una, precedida de `P\t` (personalizada: se borra) o `E\t`
# (excluida: NO se borra). Las rutas no caben en el TSV porque pueden contener tabuladores; una por
# línea sí, y el prefijo no es ambiguo porque se corta por el PRIMER tabulador. Un salto de línea
# dentro de un nombre de carpeta es un caso que no se soporta a propósito.
#
# Las protegidas se leen y se podan ANTES que las personalizadas, porque `ruta_personalizada_valida`
# consulta la lista de protegidas para rechazar «borra esto» y «no borres esto» a la vez.
leer_preferencias_limpieza() {
    local config="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/almacenamiento.json"
    local -a lineas=()
    mapfile -t lineas < <(
        jq -rn --slurpfile c "$config" '
            ($c[0] // {}) as $g |
            ([ ($g.retenerJournal // "200M"),
               ($g.diasPapelera // 0),
               ($g.diasDescargas // 0),
               # `has()` y no `//`: en jq el `//` considera falsy a **`false`**, no solo a `null`,
               # así que con el interruptor apagado devolvería el valor por defecto. Mismo fallo
               # que ya documenta `limpieza-arranque.sh` para `notificar`.
               (if ($g | has("descargasAPapelera")) then $g.descargasAPapelera else false end)
             ] | @tsv),
            (($g.rutasPersonalizadas // []) | .[] | select(type == "string") | select(length > 0) | "P\t" + .),
            (($g.rutasProtegidas    // []) | .[] | select(type == "string") | select(length > 0) | "E\t" + .)
        ' 2>/dev/null
    )

    IFS=$'\t' read -r RETENER_JOURNAL DIAS_PAPELERA DIAS_DESCARGAS A_PAPELERA <<<"${lineas[0]:-}"
    [[ "$RETENER_JOURNAL" =~ ^[0-9]+[KMG]$ ]] || RETENER_JOURNAL=200M
    [[ "$DIAS_PAPELERA"   =~ ^[0-9]+$ ]]      || DIAS_PAPELERA=0
    [[ "$DIAS_DESCARGAS"  =~ ^[0-9]+$ ]]      || DIAS_DESCARGAS=0
    [[ "$A_PAPELERA"      == true ]]          || A_PAPELERA=false

    # Primero las protegidas: no se rechaza casi nada (proteger de más no borra de más) y hacen
    # falta ya para validar las personalizadas.
    RUTAS_PROTEGIDAS=()
    local linea cruda
    for linea in "${lineas[@]:1}"; do
        [[ "$linea" == E$'\t'* ]] || continue
        ruta_protegida_valida "${linea#E$'\t'}" && RUTAS_PROTEGIDAS+=("$RUTA_CANONICA")
    done
    podar_protegidas

    # Solo las que pasan el filtro. Los motivos de rechazo se acumulan para que el limpiador pueda
    # decirlos en su `mensaje` en vez de ignorar la ruta en silencio.
    RUTAS_PERSONALIZADAS=(); RUTAS_RECHAZADAS=()
    for linea in "${lineas[@]:1}"; do
        [[ "$linea" == P$'\t'* ]] || continue
        cruda=${linea#P$'\t'}
        if ruta_personalizada_valida "$cruda"; then
            RUTAS_PERSONALIZADAS+=("$RUTA_CANONICA")
        else
            RUTAS_RECHAZADAS+=("$MOTIVO_RUTA")
        fi
    done
}

# ── Rutas protegidas (lo que NUNCA se borra) ─────────────────────────────────
# La otra mitad de «rutas personalizadas»: allí el usuario escribe QUÉ borrar, aquí QUÉ NO. Nace de
# un problema real que la lista fija `CACHE_PRESERVADO` no puede resolver: esa lista la decide este
# repositorio, y cada equipo tiene su propia carpeta que técnicamente es caché pero cuesta cara de
# perder —el perfil de un navegador que guarda la sesión bajo `~/.cache`, la caché de compilación de
# un proyecto en el que trabajas hoy, los índices de una biblioteca de fotos—. Sin esto la única
# forma de salvarlas era desmarcar la acción entera y quedarse sin limpiar nada.
#
# TRES REGLAS, y la tercera es la que hace útil la función:
#
#   1. Si el objetivo a borrar ES una ruta protegida, o está DENTRO de ella → no se toca.
#   2. Si no tiene nada que ver → se borra como siempre.
#   3. Si el objetivo CONTIENE una ruta protegida (proteges `~/.cache/foo/perfil` y la limpieza iba
#      a llevarse `~/.cache/foo` entero) → **no se borra el objetivo: se desciende un nivel** y se
#      vuelve a filtrar. Se acaba borrando todo lo de dentro menos lo protegido, que es lo que pide
#      cualquiera que proteja una subcarpeta. Saltarse el objetivo entero «por si acaso» habría
#      convertido proteger un fichero de 4 KB en no limpiar el gigabyte que lo rodea.
#
# La protección se aplica en `_borrar_medido` y `_vaciar` (limpiador), o sea en el punto por el que
# pasan TODAS las acciones que borran nosotros mismos: cachés de usuario, miniaturas, papelera,
# descargas y las rutas personalizadas. Lo que borra un tercero (`paccache`, `paru -Sc`,
# `npm cache clean`, `pip cache purge`, `flatpak uninstall`, el helper root) NO puede respetarla:
# esas herramientas deciden por su cuenta qué se llevan y no aceptan exclusiones. Está dicho en la
# UI, porque una protección que no protege es peor que no tenerla.
#
# OJO con los symlinks: se guarda la ruta CANÓNICA, y los objetivos que enumera `find` no se
# canonicalizan (sería un fork por entrada). Proteger el destino de un enlace protege el destino; si
# la limpieza llega por el enlace, se borra el enlace —no lo que hay al otro lado, porque `rm -rf`
# sobre un symlink borra el symlink—. Protege la ruta tal y como cuelga de lo que se limpia.

# Canónicas y podadas. Se declara aquí para que `filtrar_protegidos` funcione (devolviendo la lista
# intacta) aunque nadie haya llamado a `leer_preferencias_limpieza`.
RUTAS_PROTEGIDAS=()

# ¿Vale como ruta protegida? Deja la canónica en `RUTA_CANONICA`, el motivo en `MOTIVO_RUTA`.
#
# Filtra MUCHO menos que `ruta_personalizada_valida`, y es deliberado: aquí el error posible es
# proteger de más, que como mucho deja sin limpiar algo: nadie pierde datos por una protección de
# sobra. Por eso tampoco se exige que exista — proteger una carpeta que una aplicación aún no ha
# creado, o que está en un disco externo desconectado, tiene que seguir valiendo cuando aparezca.
ruta_protegida_valida() {
    local cruda=$1 real
    RUTA_CANONICA=""; MOTIVO_RUTA=""

    [[ -n "$cruda" ]]    || { MOTIVO_RUTA="ruta vacía"; return 1; }
    [[ "$cruda" == /* ]] || { MOTIVO_RUTA="no es una ruta absoluta: $cruda"; return 1; }
    real=$(realpath -m -- "$cruda" 2>/dev/null) || { MOTIVO_RUTA="ruta ilegible: $cruda"; return 1; }
    [[ "$real" == / ]]   && { MOTIVO_RUTA="proteger / no tiene sentido: no se limpiaría nada"; return 1; }

    RUTA_CANONICA=$real
    return 0
}

# Quita duplicados y descendientes de otra protegida. Proteger `~/x` y `~/x/y` es redundante, y
# además rompería la cuenta del analizador: mide las protegidas con `du` para descontarlas de lo
# liberable, y `~/x/y` se contaría dos veces.
podar_protegidas() {
    ((${#RUTAS_PROTEGIDAS[@]} < 2)) && return 0
    local -a podadas=()
    local a b sobra
    for a in "${RUTAS_PROTEGIDAS[@]}"; do
        sobra=0
        for b in "${RUTAS_PROTEGIDAS[@]}"; do
            [[ "$a" == "$b"/* ]] && { sobra=1; break; }
        done
        ((sobra)) && continue
        # El duplicado exacto sobrevive al bucle de arriba (una ruta no es descendiente de sí
        # misma), así que se descarta aquí.
        for b in "${podadas[@]}"; do [[ "$a" == "$b" ]] && { sobra=1; break; }; done
        ((sobra)) || podadas+=("$a")
    done
    RUTAS_PROTEGIDAS=("${podadas[@]}")
}

# ¿Está esta ruta protegida, o dentro de algo protegido? Sale con 0 si SÍ (o sea: no borrar).
protegido_cubre() {  # ruta canónica
    local ruta=$1 prot
    for prot in "${RUTAS_PROTEGIDAS[@]}"; do
        [[ "$ruta" == "$prot" || "$ruta" == "$prot"/* ]] && return 0
    done
    return 1
}

# Las protegidas que cuelgan de alguno de estos directorios (y existen). Lo usa el ANALIZADOR para
# descontarlas de `liberable`: si no, la sección seguiría prometiendo el espacio de lo que la
# limpieza ya no se lleva, que es exactamente el tipo de mentira que motivó la columna.
protegidos_bajo() {  # dir…
    local prot d
    for prot in "${RUTAS_PROTEGIDAS[@]}"; do
        [[ -e "$prot" ]] || continue
        for d in "$@"; do
            [[ "$prot" == "$d"/* ]] && { printf '%s\n' "$prot"; break; }
        done
    done
}

# Aplica las tres reglas de arriba a una lista de objetivos y deja el resultado en
# `OBJETIVOS_FILTRADOS`. Sin protecciones configuradas devuelve la lista tal cual y no forkea nada,
# que es el caso normal: esto corre también en el arranque de sesión.
OBJETIVOS_FILTRADOS=()
filtrar_protegidos() {  # objetivos…
    OBJETIVOS_FILTRADOS=()
    (($# == 0)) && return 0
    ((${#RUTAS_PROTEGIDAS[@]} == 0)) && { OBJETIVOS_FILTRADOS=("$@"); return 0; }

    local -a pendientes=("$@")
    local -i nivel=0
    local ruta prot omitir descender
    # Tope de profundidad: `find` no puede ciclar (no sigue enlaces), pero un árbol patológico o una
    # protección que nunca casa no deben poder colgar una limpieza desatendida.
    while ((${#pendientes[@]} && nivel < 32)); do
        local -a siguiente=()
        for ruta in "${pendientes[@]}"; do
            omitir=0; descender=0
            for prot in "${RUTAS_PROTEGIDAS[@]}"; do
                if [[ "$ruta" == "$prot" || "$ruta" == "$prot"/* ]]; then omitir=1; break; fi
                [[ "$prot" == "$ruta"/* ]] && descender=1
            done
            ((omitir)) && continue
            if ((descender)) && [[ -d "$ruta" && ! -L "$ruta" ]]; then
                local -a hijos=()
                mapfile -d '' -t hijos < <(find "$ruta" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
                ((${#hijos[@]})) && siguiente+=("${hijos[@]}")
            else
                OBJETIVOS_FILTRADOS+=("$ruta")
            fi
        done
        pendientes=("${siguiente[@]}")
        ((nivel++))
    done
}

# ── Rutas personalizadas ─────────────────────────────────────────────────────
# La acción `rutasPersonalizadas` borra lo que el usuario escriba en Ajustes. Una **carpeta** se
# vacía —se borra su contenido y la carpeta se conserva— y un **fichero** se borra él mismo, que es
# lo que espera cualquiera que escriba la ruta de un fichero. Es la única acción cuyo objetivo no lo
# decide este repositorio, así que es también la única que necesita un filtro — y lo necesita de verdad: puede ejecutarse **desatendida** desde
# `limpieza-arranque.sh`, o sea un `rm -rf` sobre una ruta arbitraria sin nadie delante.
#
# El filtro vive aquí y no en la UI porque la UI no es la última barrera: el JSON se puede editar a
# mano, restaurar de un backup viejo o venir de otro equipo donde esa ruta significaba otra cosa.
# Quien borra es quien valida.
#
# NO se protege contra el usuario, se protege contra el ACCIDENTE: un `~/tmp` que en realidad es un
# symlink a `/`, un `..` de más al teclear, un campo que se guardó a medias. Una carpeta suya que
# quiera vaciar de verdad se vacía.

# Directorios que no se vacían nunca, aunque los escribas. No es una lista de "cosas del sistema"
# —como usuario no podrías borrarlas de todos modos— sino de **directorios cuyo contenido es la
# configuración o la identidad de la sesión**, donde un vaciado no se nota hasta el siguiente
# arranque y ya no hay vuelta atrás.
rutas_vetadas() {
    printf '%s\n' \
        / /home /root /boot /dev /etc /proc /run /sys /usr /var /bin /sbin /lib /lib64 /opt /srv \
        "$HOME" \
        "$HOME/.config" "$HOME/.local" "$HOME/.local/share" "$HOME/.local/state" \
        "$HOME/.ssh" "$HOME/.gnupg" "$HOME/.dotfiles" "$HOME/.mozilla" \
        "${XDG_CACHE_HOME:-$HOME/.cache}"
}

# ¿Se puede vaciar esta ruta? Sale con 0 y deja la ruta CANÓNICA en `RUTA_CANONICA`; si no, sale con
# 1 y deja el motivo en `MOTIVO_RUTA`.
#
# Por variables y no por stdout/stderr para poder llamarla sin `$( )`: una sustitución de órdenes es
# un subshell, y lo aprendido en `analizar-almacenamiento.sh` (el volcado de pacman que su propio
# trap borraba) es que en este repositorio los subshells se pagan caro. Aquí además serían dos forks
# por ruta configurada.
#
# La canonicalización (`realpath -m`) es obligatoria y va ANTES de comparar: sin ella, un symlink
# `~/basura → /` o un `~/Descargas/../..` pasarían el filtro mirando la cadena de texto y `rm -rf`
# seguiría el enlace igual. `-m` no exige que exista, para poder dar un mensaje distinto de "no
# existe" al de "está vetada".
RUTA_CANONICA=""
MOTIVO_RUTA=""
RUTA_ES_CARPETA=1
ruta_personalizada_valida() {
    local cruda=$1 real veto
    RUTA_CANONICA=""; MOTIVO_RUTA=""
    _rechazo() { MOTIVO_RUTA=$1; return 1; }

    [[ -n "$cruda" ]]     || { _rechazo "ruta vacía"; return 1; }
    [[ "$cruda" == /* ]]  || { _rechazo "no es una ruta absoluta: $cruda"; return 1; }
    real=$(realpath -m -- "$cruda" 2>/dev/null) || { _rechazo "ruta ilegible: $cruda"; return 1; }

    while read -r veto; do
        [[ "$real" == "$veto" ]] && { _rechazo "ruta protegida: $real"; return 1; }
    done < <(rutas_vetadas)

    # «Bórrala» y «no la borres» a la vez no es una configuración, es un descuido: gana la
    # protección (la aplica `filtrar_protegidos` pase lo que pase aquí), así que la ruta se rechaza
    # con ese motivo en vez de quedarse en la lista sin borrar nunca nada y sin decir por qué.
    protegido_cubre "$real" && { _rechazo "está en tus rutas protegidas: $real"; return 1; }

    # Un ancestro de $HOME (`/home`, `/`) ya está en la lista, pero la comprobación se repite por
    # prefijo para cubrir un hogar fuera de /home (`/srv/usuarios/x`, montajes NFS…).
    [[ "$HOME" == "$real"/* ]] && { _rechazo "contiene tu carpeta personal: $real"; return 1; }

    # Dentro del árbol del sistema no se toca nada. Como usuario normal fallaría de todos modos,
    # pero fallar en silencio 500 veces no es lo mismo que decir por qué.
    case "$real"/ in
        /boot/*|/dev/*|/etc/*|/proc/*|/run/*|/sys/*|/usr/*|/var/*|/bin/*|/sbin/*|/lib/*|/lib64/*)
            _rechazo "ruta del sistema: $real"; return 1 ;;
    esac

    # Carpeta o fichero regular, nada más. Un socket, una FIFO o un nodo de dispositivo bajo $HOME
    # se rechazan explícitamente en vez de dejar que `rm` haga algo raro con ellos: son cosas que
    # nadie configura a mano aquí, y un error claro vale más que un borrado sorprendente.
    if [[ -d "$real" ]]; then
        RUTA_ES_CARPETA=1
    elif [[ -f "$real" ]]; then
        RUTA_ES_CARPETA=0
    else
        _rechazo "no existe o no es una carpeta ni un fichero: $real"; return 1
    fi
    RUTA_CANONICA=$real
    return 0
}

# Lo que hay que borrar para «limpiar» una ruta ya validada, en el array `OBJETIVOS_RUTA`:
#
#   · carpeta  → sus entradas de primer nivel. La carpeta SOBREVIVE, igual que en miniaturas: hay
#                aplicaciones que no recrean su directorio de trabajo y dejan de funcionar hasta el
#                siguiente login. Y deja el error reversible en el sentido que importa — lo que
#                configuraste sigue existiendo.
#   · fichero  → él mismo.
#
# Vive aquí, y no repetido en cada script, porque el analizador tiene que MEDIR exactamente lo que
# el limpiador va a BORRAR. Si los dos expandieran la ruta por su cuenta volveríamos al problema de
# origen de toda esta sección: dos ideas distintas de qué se borra y una cifra que no describe nada.
objetivos_de_ruta() {  # ruta canónica
    local ruta=$1
    OBJETIVOS_RUTA=()
    if [[ -d "$ruta" ]]; then
        mapfile -d '' -t OBJETIVOS_RUTA < <(find "$ruta" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
    elif [[ -e "$ruta" ]]; then
        OBJETIVOS_RUTA=("$ruta")
    fi
}
