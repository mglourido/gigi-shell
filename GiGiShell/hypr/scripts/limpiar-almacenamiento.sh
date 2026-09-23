#!/usr/bin/env bash
# limpiar-almacenamiento.sh — ejecuta las limpiezas de Ajustes > Almacenamiento.
#
#   limpiar-almacenamiento.sh <accion> [<accion>…]   → JSON por stdout, una entrada por acción
#   limpiar-almacenamiento.sh --listar               → ids válidos, uno por línea
#   limpiar-almacenamiento.sh --validar-ruta <ruta>  → ¿se puede vaciar? ruta canónica / motivo
#   limpiar-almacenamiento.sh --validar-protegida <r> → ¿vale como ruta protegida? canónica / motivo
#
# Lo invocan dos consumidores con exigencias distintas: los botones de la UI (una acción, hay
# alguien delante) y `limpieza-arranque.sh` (varias acciones, desatendido). Por eso acepta varias y
# por eso el desenlace de cada una viaja en el JSON en vez de en el código de salida: en un lote,
# que la papelera falle no debe cancelar la limpieza de la caché ni parecer un fallo global.
#
# ── El reparto de privilegios, que es lo único delicado aquí ─────────────────
# Tres niveles, y cada acción está en uno a propósito:
#
#   1. usuario           todo lo que vive bajo $HOME. Sin sudo, sin diálogos.
#   2. sudo -n (helper)  lo de root que se REGENERA solo: caché de pacman, journal, /var/tmp,
#                        huérfanos. Va por /usr/local/bin/gigios-limpieza con NOPASSWD, que es lo
#                        que permite la autolimpieza desatendida. Ver system/limpieza/.
#   3. pkexec            lo de root IRREVERSIBLE: vaciar la caché entera. Pide contraseña siempre
#                        y por eso NO puede formar parte de la autolimpieza — se marca `manual`.
#
# Sin el helper instalado, las acciones del nivel 2 no fallan calladas: devuelven
# `estado:"sin-permisos"` con el paso de instalación que falta, y la UI lo pinta.
#
# ── De dónde sale la cifra de "liberado" ─────────────────────────────────────
# Ninguna herramienta de las que se llaman aquí informa de forma fiable de cuánto ha liberado
# (`paccache` imprime un resumen en texto libre, `journalctl --vacuum-size` no imprime nada útil,
# `rm` menos). Así que se mide con `du`, y hay DOS estrategias según quién borre:
#
#   · **Borramos nosotros** (cachés de usuario, miniaturas, papelera, descargas) → `_borrar_medido`:
#     se enumera lo que se va a borrar, se mide ESO una sola vez, se borra y se descuenta lo que
#     haya sobrevivido. Una travesía, y solo del subconjunto afectado.
#   · **Borra un tercero** (`paru -Sc`, `npm cache clean`, `pacman -Scc`, `flatpak uninstall`) → no
#     hay lista que enumerar, así que se mide el directorio antes y después. Es el caso caro y por
#     eso se ha quedado reducido a las cuatro acciones que de verdad lo necesitan.
#
# ── Lo que el usuario ha marcado como intocable ──────────────────────────────
# `rutasProtegidas` (Ajustes > Liberar espacio) se aplica en `_borrar_medido` y `_vaciar`, que es
# por donde pasa TODO lo que borra este script directamente. Lo que borra un tercero —paccache,
# `paru -Sc`, `npm cache clean`, `pip cache purge`, `flatpak uninstall`, el helper root— no puede
# respetarla, porque esas herramientas no aceptan exclusiones. Ver lib/limpieza-rutas.sh.
set -uo pipefail

export LC_ALL=C

APP="Almacenamiento"
NOTIF_APP="$APP"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigios-source:system "${_a[@]}" "$@"
    }
fi

DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/almacenamiento.json"
HELPER=/usr/local/bin/gigios-limpieza

# Define `CACHE_HOME`, `CACHE_PRESERVADO`, `cache_preservado_find` y `rutas_desarrollo`. Es la
# lista única de qué borra cada acción, compartida con `analizar-almacenamiento.sh` para que la
# cifra que promete la interfaz y lo que este script borra no puedan discrepar.
# shellcheck source=lib/limpieza-rutas.sh
source "$HOME/.config/hypr/scripts/lib/limpieza-rutas.sh"

ACCIONES=(cachePaquetes cachePaquetesTotal cacheAur huerfanos registros temporales
          cacheUsuario miniaturas cacheDesarrollo cacheSombreadores papelera descargas flatpak
          rutasPersonalizadas)

[[ "${1:-}" == "--listar" ]] && { printf '%s\n' "${ACCIONES[@]}"; exit 0; }

command -v jq >/dev/null 2>&1 || { echo '[{"accion":"","estado":"error","liberado":0,"mensaje":"falta jq"}]'; exit 1; }

# ── Preferencias ─────────────────────────────────────────────────────────────
# Las escribe AGS y las lee también el analizador; la lectura vive en `lib/limpieza-rutas.sh` para
# que no puedan discrepar en los valores por defecto. Define `RETENER_JOURNAL`, `DIAS_PAPELERA`,
# `DIAS_DESCARGAS`, `A_PAPELERA`, `RUTAS_PERSONALIZADAS`, `RUTAS_RECHAZADAS` y `RUTAS_PROTEGIDAS`.
#
# Va ANTES de los dos `--validar-*` a propósito: validar una ruta que se quiere borrar exige conocer
# las protegidas, porque «bórrala» y «no la borres» a la vez se resuelve rechazando la primera.
#
# Un fichero ausente, vacío o corrupto no puede impedir una limpieza manual que el usuario acaba de
# pedir: todo cae a su valor por defecto.
leer_preferencias_limpieza

# Lo llama Ajustes ANTES de guardar una ruta nueva, para poder decir «no se puede usar esa ruta:
# está protegida» en el momento en vez de dejar que la limpieza la ignore en silencio dentro de una
# semana. Deliberadamente el MISMO `ruta_personalizada_valida` que usa el borrado: dos
# implementaciones del filtro (una en TypeScript para avisar, otra en bash para borrar) es la forma
# garantizada de que acaben discrepando, y en este caso discrepar significa borrar algo que la
# interfaz había dado por rechazado.
if [[ "${1:-}" == "--validar-ruta" ]]; then
    if ruta_personalizada_valida "${2:-}"; then printf '%s\n' "$RUTA_CANONICA"; exit 0; fi
    printf '%s\n' "$MOTIVO_RUTA" >&2; exit 1
fi

# Lo mismo para la lista de protegidas. Es un filtro mucho más flojo —proteger de más no borra de
# más— pero pasa por aquí igual, para que la ruta que se guarda sea la CANÓNICA: la comparación que
# decide si algo se salva es textual, y `~/x/../x` no casaría con nada.
if [[ "${1:-}" == "--validar-protegida" ]]; then
    if ruta_protegida_valida "${2:-}"; then printf '%s\n' "$RUTA_CANONICA"; exit 0; fi
    printf '%s\n' "$MOTIVO_RUTA" >&2; exit 1
fi

# ── Utilidades ───────────────────────────────────────────────────────────────

# Tamaño de varias rutas, en UNA invocación de `du`. Antes forkeaba un `du` **y un `awk` por cada
# ruta**: con `cacheDesarrollo` (cuatro rutas, medidas antes y después) eran dieciséis procesos para
# sumar cuatro números. `--files0-from=-` acepta la lista por stdin separada por NUL, así que
# tampoco hay que preocuparse de rutas con espacios ni del límite de argumentos.
_tam() {
    (($# == 0)) && { echo 0; return 0; }
    printf '%s\0' "$@" | du -scxb --files0-from=- 2>/dev/null | awk 'END{print $1+0}'
}

# Mide, borra y devuelve lo liberado de verdad — en UNA travesía y solo del conjunto que se borra.
#
# Sustituye al patrón `antes=$(_tam dir); …borrar…; liberado=$((antes - $(_tam dir)))`, que tenía
# dos problemas:
#
#   1. **Dos travesías COMPLETAS del directorio**, incluida la parte que nunca se toca: en
#      `cacheUsuario` eso son `~/.cache/nvidia` (1 GB) y `~/.cache/yay` (557 MB) recorridos dos
#      veces para nada. Caliente da igual (9 ms), pero esto corre en el arranque de sesión con la
#      caché de inodos fría, que es donde `du` cuesta segundos.
#   2. **La resta iba sobre un blanco móvil**: entre las dos pasadas el navegador vuelve a escribir
#      en su caché, así que podía salir negativa y había que recortarla a 0.
#
# Midiendo exactamente lo que se va a borrar no puede salir negativa, y lo que sobreviva —un `rm`
# falla por permisos o por un fichero en uso— se descuenta después; esa comprobación normalmente no
# recorre nada, porque no sobrevive nada.
#
# El borrado va por `xargs -0`: un `rm -rf -- "${lista[@]}"` con una papelera de miles de elementos
# se pasa de `ARG_MAX` y falla entero, mientras que xargs trocea solo.
_borrar_medido() {  # rutas… → imprime los bytes liberados
    (($# == 0)) && { echo 0; return 0; }
    # Las rutas que el usuario ha marcado como intocables salen de la lista ANTES de medir: lo que
    # no se borra no puede contarse como liberado. Sin protecciones esto no hace nada ni forkea.
    filtrar_protegidos "$@"
    set -- "${OBJETIVOS_FILTRADOS[@]}"
    (($# == 0)) && { echo 0; return 0; }
    local antes; antes=$(_tam "$@")
    printf '%s\0' "$@" | xargs -0 -r rm -rf -- 2>/dev/null
    local -a vivos=(); local r
    for r in "$@"; do [[ -e "$r" ]] && vivos+=("$r"); done
    ((${#vivos[@]} == 0)) && { echo "$antes"; return 0; }
    echo $((antes - $(_tam "${vivos[@]}")))
}

# Bytes → «3,9 MiB». Lo usan el mensaje de "movido a la papelera" y el aviso de la autolimpieza,
# que antes se lo formateaba por su cuenta al final del fichero.
#
# Tiene que salir EXACTAMENTE como `formatearBytes` de `servicios/disco/formato.ts`, porque las dos
# cifras acaban una al lado de la otra en la misma sección: unidades binarias con la `i` (`MiB`, no
# `MB` — `--to=iec` da 1024 pero rotula en base 10, que es lo peor de los dos mundos), espacio antes
# de la unidad y coma decimal. El `LC_ALL=C` de la cabecera fuerza el punto en `numfmt`, así que la
# coma se pone aquí en vez de depender del locale, que en un `exec-once` no está garantizado.
_legible() {
    local t; t=$(numfmt --to=iec-i --suffix=B --format='%.1f' "${1:-0}" 2>/dev/null) || { echo "${1:-0} B"; return; }
    # "3.9MiB" → "3,9 MiB". El corte va donde empieza la unidad, que es la primera letra.
    # El `,0` sobrante se cae igual que en `formatearBytes` ("512,0 B" quedaría raro al lado de un
    # "512 B" de la fila de arriba).
    local num=${t%%[A-Za-z]*}
    num=${num/./,}; num=${num%,0}
    echo "$num ${t#"${t%%[A-Za-z]*}"}"
}

# Las entradas de primer nivel de un directorio, en un array (`SALIDA`). Es lo que alimenta a
# `_borrar_medido` allí donde antes había un `find … -exec rm -rf`: hace falta la LISTA, no solo el
# borrado, para poder medir justo eso. `-print0` + `mapfile -d ''` para no romperse con espacios.
_entradas() {  # dir [args extra de find…]
    local d=$1; shift
    SALIDA=()
    [[ -d "$d" ]] || return 0
    mapfile -d '' -t SALIDA < <(find "$d" -mindepth 1 -maxdepth 1 "$@" -print0 2>/dev/null)
}

# Borra el CONTENIDO de un directorio, nunca el directorio. Varias de estas rutas las crea la
# aplicación dueña al arrancar y no todas las recrean si desaparecen (~/.cache/thumbnails es el
# caso conocido: sin el directorio, GTK deja de generar miniaturas hasta el siguiente login).
#
# Respeta las rutas protegidas igual que `_borrar_medido`: aquí no hace falta medir, pero sí que un
# `~/.cache/paru/clone/mi-paquete` marcado como intocable sobreviva.
_vaciar() {
    local d=$1
    [[ -d "$d" ]] || return 0
    if ((${#RUTAS_PROTEGIDAS[@]} == 0)); then
        find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null
        return 0
    fi
    _entradas "$d"
    filtrar_protegidos "${SALIDA[@]}"
    ((${#OBJETIVOS_FILTRADOS[@]})) && printf '%s\0' "${OBJETIVOS_FILTRADOS[@]}" | xargs -0 -r rm -rf -- 2>/dev/null
    return 0
}

# Nivel 2: el helper root-owned. Devuelve los bytes liberados por stdout.
# Un rc≠0 aquí NO es lo mismo que "no hay helper": se distinguen porque lo segundo se comprueba
# antes, y así la UI puede decir "te falta un paso de instalación" en vez de "falló la limpieza".
_helper() {
    if [[ ! -x "$HELPER" ]]; then
        estado="sin-permisos"
        mensaje="Falta /usr/local/bin/gigios-limpieza (se instala con install.sh)."
        return 1
    fi
    local salida rc
    salida=$(sudo -n "$HELPER" "$@" 2>&1); rc=$?
    if ((rc != 0)); then
        estado="error"
        mensaje=$(printf '%s' "$salida" | tail -n 1)
        return 1
    fi
    [[ "$salida" =~ ^[0-9]+$ ]] && liberado=$salida
    return 0
}

# Nivel 3: pkexec. 126 = el usuario cerró el diálogo o falló la autenticación, que no es un error
# del que haya que quejarse en rojo (mismo criterio que desinstalar-app.sh).
_root_interactivo() {
    local salida rc
    salida=$(pkexec "$@" 2>&1); rc=$?
    case $rc in
        0)   return 0 ;;
        126) estado="cancelado"; mensaje="Cancelado."; return 1 ;;
        *)   estado="error"; mensaje=$(printf '%s' "$salida" | tail -n 1); return 1 ;;
    esac
}

# ── Acciones ─────────────────────────────────────────────────────────────────
# Cada una fija `liberado`, `estado` y `mensaje`. Las tres están declaradas por el llamante.

_ejecutar() {
    local accion=$1
    liberado=0; estado=ok; mensaje=""

    case "$accion" in
        cachePaquetes)   _helper paccache ;;
        registros)       _helper journal "$RETENER_JOURNAL" ;;
        temporales)      _helper tmp ;;
        huerfanos)       _helper huerfanos ;;

        # Vaciar la caché ENTERA, incluidos los paquetes de lo que está instalado. Deja el equipo
        # sin poder revertir una actualización sin red, así que pide contraseña siempre y nunca
        # entra en la autolimpieza.
        cachePaquetesTotal)
            local antes; antes=$(_tam /var/cache/pacman/pkg)
            if _root_interactivo /usr/bin/pacman -Scc --noconfirm; then
                liberado=$((antes - $(_tam /var/cache/pacman/pkg)))
            fi
            ;;

        # Caché del helper de AUR. `-Sc --noconfirm` deja los paquetes construidos de lo que sigue
        # instalado; los clones de git se borran aparte porque el helper los conserva para poder
        # reconstruir, y son la mayor parte del tamaño.
        cacheAur)
            local helper="" antes=0 d
            for d in paru yay; do command -v "$d" >/dev/null 2>&1 && { helper=$d; break; }; done
            if [[ -z "$helper" ]]; then
                estado=omitida; mensaje="No hay paru ni yay instalados."
            else
                antes=$(_tam "$CACHE_HOME/$helper")
                "$helper" -Sc --noconfirm >/dev/null 2>&1
                _vaciar "$CACHE_HOME/$helper/clone"
                liberado=$((antes - $(_tam "$CACHE_HOME/$helper")))
            fi
            ;;

        # ~/.cache entero MENOS lo que no es caché de verdad. La lista de exclusiones no es
        # cosmética: varias aplicaciones guardan ahí estado que no se regenera —GiGiShell mismo tiene
        # el mapa de fuentes del CSS y el sondeo de hardware, y las sesiones de algunos navegadores
        # viven en su caché—, así que un `rm -rf ~/.cache/*` a ciegas cuesta datos reales.
        #
        # También se excluye TODO LO QUE TIENE BOTÓN PROPIO: paru/yay (cacheAur), thumbnails
        # (miniaturas), pip y go-build (cacheDesarrollo). Antes esta acción se los llevaba por
        # delante y eso hacía imposible una estimación honesta —marcar las tres casillas de caché
        # contaba `thumbnails` dos veces— además de volver impredecible el botón suelto, que
        # borraba lo que otro botón decía gestionar. Ahora cada acción borra exactamente lo suyo y
        # la suma de lo marcado ES el espacio que se libera. Para vaciar ~/.cache entero se marcan
        # las tres. La lista vive en lib/limpieza-rutas.sh, que también lee el analizador.
        cacheUsuario)
            cache_preservado_find
            _entradas "$CACHE_HOME" "${EXCLUIR_FIND[@]}"
            liberado=$(_borrar_medido "${SALIDA[@]}")
            ;;

        miniaturas)
            # Las ENTRADAS, no el directorio: sin `~/.cache/thumbnails`, GTK deja de generar
            # miniaturas hasta el siguiente login (ver `_vaciar`, que sigue existiendo para el
            # mismo motivo allí donde no hace falta medir).
            _entradas "$CACHE_HOME/thumbnails"
            liberado=$(_borrar_medido "${SALIDA[@]}")
            ;;

        # Cachés de gestores de paquetes de lenguajes: se rellenan solas desde la red y no
        # contienen nada escrito por el usuario. `npm cache clean` en vez de un `rm` porque npm
        # mantiene un índice que se queda incoherente si le borras el contenido por debajo.
        # Aquí SÍ se sigue midiendo antes y después, y no es un descuido: `npm cache clean` y
        # `pip cache purge` borran por su cuenta lo que ellos deciden, así que no hay una lista que
        # enumerar de antemano. Lo que sí se ha quitado es el fork por ruta de `_tam`: eran
        # dieciséis procesos (cuatro rutas × du+awk × antes/después) y ahora son cuatro.
        cacheDesarrollo)
            local rutas; mapfile -t rutas < <(rutas_desarrollo)
            local antes; antes=$(_tam "${rutas[@]}")
            command -v npm >/dev/null 2>&1 && npm cache clean --force >/dev/null 2>&1
            command -v pip >/dev/null 2>&1 && pip cache purge >/dev/null 2>&1
            _vaciar "$CACHE_HOME/go-build"
            _vaciar "$HOME/.cargo/registry/cache"
            liberado=$((antes - $(_tam "${rutas[@]}")))
            ;;

        # ── Sombreadores ─────────────────────────────────────────────────────
        # Lo que los drivers compilan para no recompilar: Mesa (OpenGL y RADV), NVIDIA, AMDVLK, el
        # caché de shaders de Qt y el `shadercache` de Steam. La lista y el porqué de cada ruta
        # están en `rutas_shaders` (lib/limpieza-rutas.sh), compartida con el analizador.
        #
        # Se expande con `objetivos_de_ruta` —el CONTENIDO si es carpeta, el fichero si es fichero—,
        # la misma función que usan las rutas personalizadas: los directorios sobreviven porque
        # varios de estos drivers no recrean el suyo hasta el siguiente arranque de la aplicación, y
        # así lo medido es exactamente lo borrado.
        #
        # **No es automatizable**, y no por privilegios: borrarla no cuesta datos pero sí una
        # recompilación con tirones —y, en el caso de Steam, volver a descargar lo que ya tenías—.
        # Eso se decide mirando. La barrera está en la lista blanca de `limpieza-arranque.sh`.
        cacheSombreadores)
            local -a rutas=() objetivos=()
            mapfile -t rutas < <(rutas_shaders)
            if ((${#rutas[@]} == 0)); then
                estado=omitida; mensaje="No hay ninguna caché de sombreadores."
            else
                local ruta
                for ruta in "${rutas[@]}"; do
                    objetivos_de_ruta "$ruta"
                    objetivos+=("${OBJETIVOS_RUTA[@]}")
                done
                liberado=$(_borrar_medido "${objetivos[@]}")
            fi
            ;;

        # Papelera. Con `diasPapelera > 0` solo se van los elementos con esa antigüedad, que es lo
        # que hace utilizable la papelera en una limpieza automática: vaciarla entera cada noche la
        # convierte en un `rm` con pasos extra.
        #
        # Se borra el par (files/<x>, info/<x>.trashinfo) a la vez: dejar el .trashinfo huérfano
        # hace que los gestores de archivos enseñen entradas fantasma que no se pueden restaurar.
        papelera)
            local base="$DATA_HOME/Trash"
            local -a objetivos=()
            if ((DIAS_PAPELERA > 0)); then
                # Un solo `find` que emite YA el par (files/<x>, info/<x>.trashinfo) por cada
                # elemento caducado, sin un proceso por elemento. La versión anterior hacía un
                # `basename` **y** un `rm` por entrada dentro de un `while read`: con una papelera
                # de 500 elementos eran mil procesos para borrar quinientas cosas. `%p` es la ruta
                # y `%f` el nombre a secas, así que `basename` sobra.
                mapfile -d '' -t objetivos < <(
                    find "$base/files" -mindepth 1 -maxdepth 1 -mtime "+$DIAS_PAPELERA" \
                        -printf '%p\0'"$base"'/info/%f.trashinfo\0' 2>/dev/null)
            else
                local d
                for d in files info expunged; do
                    _entradas "$base/$d"
                    objetivos+=("${SALIDA[@]}")
                done
            fi
            liberado=$(_borrar_medido "${objetivos[@]}")
            ;;

        # Descargas por antigüedad. Es lo único de la lista que borra ficheros que el usuario puso
        # ahí a mano, así que SIN un número de días explícito no hace nada — nunca "vaciar
        # Descargas". Van a la papelera con `gio trash` cuando se puede, no a `rm`: es
        # recuperable, y aquí sí importa.
        # Descargas por antigüedad. Es lo único de la lista que borra ficheros que el usuario puso
        # ahí a mano, así que SIN un número de días explícito no hace nada — nunca "vaciar
        # Descargas".
        #
        # ── Borra DE VERDAD, salvo que pidas lo contrario ────────────────────
        # Antes iba siempre por `gio trash`, y eso hacía que la cifra mintiera: la papelera vive en
        # el MISMO sistema de ficheros, así que mover 5 GB ahí no libera un solo byte de disco
        # —solo cambia de carpeta— mientras la acción informaba de «5 GB liberados». El botón se
        # llama «liberar espacio» y no liberaba nada hasta que además vaciabas la papelera.
        #
        # El comportamiento por defecto es `rm`: lo que borra esta acción, se borra. Quien prefiera
        # la red de seguridad enciende `descargasAPapelera` en Ajustes, y entonces la acción es
        # honesta al revés — informa de **0 liberado** y dice cuánto ha movido, porque el espacio
        # sigue ocupado hasta que se vacíe la papelera (que tiene su propia acción).
        descargas)
            if ((DIAS_DESCARGAS <= 0)); then
                estado=omitida; mensaje="Requiere fijar una antigüedad en días."
            else
                local dir
                dir=$(xdg-user-dir DOWNLOAD 2>/dev/null)
                [[ -z "$dir" || "$dir" == "$HOME" ]] && dir="$HOME/Descargas"
                if [[ ! -d "$dir" ]]; then
                    estado=omitida; mensaje="No hay carpeta de Descargas."
                else
                    # Se enumera y se mide SOLO lo caducado, no la carpeta entera. Es la mayor
                    # diferencia de coste de todo el fichero: Descargas puede tener decenas de GB y
                    # el patrón anterior la recorría **dos veces** para averiguar cuánto se llevaba
                    # un puñado de ficheros viejos.
                    _entradas "$dir" -mtime "+$DIAS_DESCARGAS"
                    if ((${#SALIDA[@]} == 0)); then
                        liberado=0
                    elif [[ "$A_PAPELERA" == true ]] && command -v gio >/dev/null 2>&1; then
                        local movido; movido=$(_tam "${SALIDA[@]}")
                        printf '%s\0' "${SALIDA[@]}" | xargs -0 -r gio trash -- 2>/dev/null
                        local -a quedan=(); local r
                        for r in "${SALIDA[@]}"; do [[ -e "$r" ]] && quedan+=("$r"); done
                        ((${#quedan[@]})) && movido=$((movido - $(_tam "${quedan[@]}")))
                        liberado=0
                        mensaje="Se han movido $(_legible "$movido") a la papelera. Vacíala para liberar el espacio."
                    else
                        # Sin `gio` no hay papelera a la que mandar nada, así que aunque el
                        # interruptor esté puesto se borra: es preferible a no hacer nada y decir
                        # que se movió algo a un sitio que no existe.
                        liberado=$(_borrar_medido "${SALIDA[@]}")
                    fi
                fi
            fi
            ;;

        # Runtimes de Flatpak que ya no usa ninguna aplicación instalada: el equivalente exacto de
        # los huérfanos de pacman. `flatpak repair` NO se ejecuta aquí — verifica y redescarga, o
        # sea que puede tardar y consumir red, y eso no es una limpieza.
        flatpak)
            if ! command -v flatpak >/dev/null 2>&1; then
                estado=omitida; mensaje="Flatpak no está instalado."
            else
                local antes; antes=$(_tam /var/lib/flatpak "$DATA_HOME/flatpak")
                flatpak uninstall --unused -y >/dev/null 2>&1
                liberado=$((antes - $(_tam /var/lib/flatpak "$DATA_HOME/flatpak")))
            fi
            ;;

        # ── Rutas escritas por el usuario ────────────────────────────────────
        # La única acción cuyo objetivo no lo decide este repositorio, y por tanto la única que
        # puede apuntar a cualquier sitio. Tres cosas la mantienen a raya, y las tres importan:
        #
        #   1. De una CARPETA se vacía el contenido, nunca la carpeta en sí (igual que en
        #      miniaturas: hay aplicaciones que no recrean su directorio de trabajo y dejan de
        #      funcionar hasta el siguiente login; y deja el error reversible en el sentido que
        #      importa, porque lo que configuraste sigue existiendo). Un FICHERO se borra él mismo,
        #      que es lo que espera cualquiera que escriba la ruta de un fichero. El reparto lo
        #      hace `objetivos_de_ruta`, compartido con el analizador.
        #   2. Las rutas ya vienen filtradas y canonicalizadas por `ruta_personalizada_valida`
        #      (ver lib/limpieza-rutas.sh), que resuelve symlinks ANTES de comparar: sin eso, un
        #      `~/basura` que en realidad apunta a `/` pasaría cualquier comprobación textual.
        #   3. Lo rechazado NO se ignora en silencio: viaja en el `mensaje`. Una ruta que dejó de
        #      existir, o que se protegió después de configurarla, tiene que decirlo — si no,
        #      "limpieza correcta, 0 bytes" es indistinguible de "no había nada que borrar".
        rutasPersonalizadas)
            local -a objetivos=()
            local ruta
            for ruta in "${RUTAS_PERSONALIZADAS[@]}"; do
                objetivos_de_ruta "$ruta"
                objetivos+=("${OBJETIVOS_RUTA[@]}")
            done
            if ((${#RUTAS_PERSONALIZADAS[@]} == 0)) && ((${#RUTAS_RECHAZADAS[@]} == 0)); then
                estado=omitida; mensaje="No has añadido ninguna ruta."
            else
                liberado=$(_borrar_medido "${objetivos[@]}")
                if ((${#RUTAS_RECHAZADAS[@]})); then
                    mensaje="Se han omitido ${#RUTAS_RECHAZADAS[@]}: ${RUTAS_RECHAZADAS[0]}"
                    ((${#RUTAS_RECHAZADAS[@]} > 1)) && mensaje+=" (y $(( ${#RUTAS_RECHAZADAS[@]} - 1 )) más)"
                    # Sin rutas válidas no es un éxito parcial: no se ha limpiado nada de lo pedido.
                    ((${#RUTAS_PERSONALIZADAS[@]} == 0)) && estado=omitida
                fi
            fi
            ;;

        *)
            estado=error; mensaje="Acción desconocida: $accion"
            ;;
    esac

    # `du` mide un blanco móvil: entre las dos pasadas el navegador puede haber vuelto a escribir
    # en su caché, y entonces la resta sale negativa. Un "-3 MB liberados" no significa nada para
    # quien lo lee, así que se recorta a 0. El estado sigue siendo `ok`: la limpieza se hizo.
    ((liberado < 0)) && liberado=0
    return 0
}

# ── Entrada ──────────────────────────────────────────────────────────────────

(($# == 0)) && { echo "uso: $0 <accion>… | --listar" >&2; exit 2; }

resultados=""
total=0
for accion in "$@"; do
    liberado=0; estado=ok; mensaje=""
    _ejecutar "$accion"
    [[ "$estado" == ok ]] && total=$((total + liberado))
    resultados+="${accion}"$'\t'"${estado}"$'\t'"${liberado}"$'\t'"${mensaje}"$'\n'
done

printf '%s' "$resultados" | jq -R -s '
    split("\n") | map(select(length > 0)) | map(split("\t")) |
    map({ accion: .[0], estado: .[1], liberado: (.[2] | tonumber), mensaje: (.[3] // "") })'

# El aviso solo lo emite el modo desatendido. Desde un botón de Ajustes el resultado ya se ve en el
# propio panel, y notificar además lo que acabas de pulsar es ruido.
if [[ "${GIGIOS_LIMPIEZA_NOTIFICAR:-0}" == 1 && $total -gt 0 ]]; then
    legible=$(_legible "$total")
    notificar limpieza.completada -u low -t 8000 "Limpieza automática" "Se han liberado $legible."
fi
