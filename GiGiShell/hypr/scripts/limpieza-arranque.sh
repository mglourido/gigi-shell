#!/usr/bin/env bash
# limpieza-arranque.sh — decide al iniciar sesión si toca autolimpiar, y si no, sale.
#
# Lo lanza gigishell/autostart.lua (t=45). **No es un daemon: no hay bucle ni proceso residente.**
#
#   limpieza-arranque.sh          comprobación de arranque (lo que corre en la sesión)
#   limpieza-arranque.sh --ahora  limpia ya, saltándose intervalo y umbral (botón "Ejecutar ahora")
#
# ── Por qué NO es un bucle, que es lo que era antes ──────────────────────────
# La versión anterior (`limpieza-monitor.sh`) dormía 60 s, comprobaba, y se quedaba en un
# `while :; do pasada; sleep 3600; done` el resto de la sesión. Coste medido de **cada** pasada:
# hasta **15 procesos `jq`** —uno por clave de configuración, más uno por cada una de las 11
# acciones automatizables, dentro del bucle— más un `df`. Y todo eso para responder casi siempre
# «todavía no toca»: con el intervalo por defecto de 24 h, 23 de cada 24 despertares no hacían
# absolutamente nada salvo forkear quince veces y volverse a dormir.
#
# El coste de este fichero hoy es: **una lectura (un solo `jq` que abre los dos JSON) y un `if`**.
# Si no toca, el script termina ahí — cero procesos residentes, cero despertares.
#
# LO QUE SE PIERDE, Y ES DELIBERADO: un equipo encendido durante días ya no autolimpia hasta el
# siguiente inicio de sesión. Es aceptable porque lo que esto borra —caché de paquetes, journal,
# temporales, miniaturas— crece con el USO y no con el reloj, y porque el botón «Ejecutar ahora»
# de Ajustes cubre el caso raro. Si algún día hiciera falta la comprobación periódica, el sitio
# correcto es un `systemd --user` timer, no volver al bucle: un timer duerme sin proceso.
set -uo pipefail

export LC_ALL=C

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/almacenamiento.json"
ESTADO="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell/limpieza.json"
LIMPIAR="$HOME/.config/hypr/scripts/limpiar-almacenamiento.sh"

# Debe coincidir con `ACCIONES_AUTOMATIZABLES` de ags/servicios/disco/catalogo.ts, que a su vez se
# deriva de excluir las acciones de pkexec **y las marcadas `manual`**. La lista se repite aquí —y
# no se lee del JSON tal cual— porque es la última barrera: un `acciones` manipulado a mano no puede
# colar en el lote desatendido algo que abra un diálogo de contraseña sin nadie delante, ni
# `cacheSombreadores`, que no pide permisos pero se cobra en la siguiente partida (recompilar, y
# volver a descargar el shadercache de Steam) lo que ahorra en disco.
AUTOMATIZABLES=" cachePaquetes cacheAur huerfanos registros temporales cacheUsuario miniaturas cacheDesarrollo papelera descargas flatpak rutasPersonalizadas "

command -v jq >/dev/null 2>&1 || exit 0

forzar=0
[[ "${1:-}" == "--ahora" ]] && forzar=1

# ── La lectura: UN solo jq para los dos ficheros ─────────────────────────────
# `--slurpfile` sobre /dev/null da `[]`, así que un estado inexistente (primer arranque) no es un
# caso especial que haya que programar: `$e[0]` sale `null` y el `// {}` lo absorbe. La
# configuración sí tiene que existir — sin ella no hay autolimpieza que valga.
[[ -r "$CONFIG" ]] || exit 0
[[ -r "$ESTADO" ]] || ESTADO=/dev/null

# Salida: auto \t intervaloHoras \t umbralUso \t ultima \t ultimaAuto \t ultimaManual \t notificar
#         \t "accion accion …"
#
# `ultimaAuto` y `ultimaManual` no deciden nada aquí: se leen para volver a escribirlas tal cual al
# poner la marca (el `printf` reescribe el fichero entero) y son lo que enseña la cabecera de
# Ajustes > Liberar espacio. `ultima` es la única que cuenta para el intervalo.
#
# `notificar` NO se pide como `.notificar // true`: en jq el operador `//` considera falsy a
# **`false`, no solo a `null`**, así que con la opción desactivada devolvía `true` y la limpieza
# avisaba igual. Las claves booleanas se preguntan con `has()`; las numéricas sí pueden usar `//`
# porque un 0 en jq es truthy.
IFS=$'\t' read -r auto intervalo umbral ultima ultimaAuto ultimaManual notificar marcadas < <(
    jq -rn --slurpfile c "$CONFIG" --slurpfile e "$ESTADO" '
        ($c[0] // {}) as $cfg | ($e[0] // {}) as $est |
        [ (if ($cfg | has("auto")) then $cfg.auto else false end),
          ($cfg.intervaloHoras // 24),
          ($cfg.umbralUso // 0),
          ($est.ultima // 0),
          # Un fichero de antes de existir `ultimaAuto` solo trae `ultima`: se hereda como automática
          # (igual que hace `servicios/disco/registroLimpieza.ts`) en vez de reescribirla a 0.
          (if ($est | has("ultimaAuto")) then $est.ultimaAuto else ($est.ultima // 0) end),
          ($est.ultimaManual // 0),
          (if ($cfg | has("notificar")) then $cfg.notificar else true end),
          (($cfg.acciones // {}) | to_entries
             | map(select(.value == true) | .key) | join(" "))
        ] | @tsv' 2>/dev/null
)

# ── El if ────────────────────────────────────────────────────────────────────
[[ "$auto" == true || $forzar -eq 1 ]] || exit 0

[[ "$intervalo" =~ ^[0-9]+$ ]] && ((intervalo > 0)) || intervalo=24
[[ "$umbral"    =~ ^[0-9]+$ ]] || umbral=0
[[ "$ultima"    =~ ^[0-9]+$ ]] || ultima=0
[[ "$ultimaAuto"   =~ ^[0-9]+$ ]] || ultimaAuto=0
[[ "$ultimaManual" =~ ^[0-9]+$ ]] || ultimaManual=0

ahora=$(printf '%(%s)T' -1)   # builtin de bash: no forkea un `date`

if ((forzar == 0)); then
    (( ahora - ultima < intervalo * 3600 )) && exit 0

    # El umbral se mira DESPUÉS del intervalo y sin tocar la marca: con el disco holgado no hay
    # nada que hacer, pero tampoco hay que dar el ciclo por consumido — si se llena mañana, la
    # siguiente sesión debe poder limpiar. `df` solo se ejecuta si hay umbral que comprobar.
    if ((umbral > 0)); then
        uso=$(df --output=pcent / 2>/dev/null | tail -n1 | tr -dc '0-9')
        [[ "$uso" =~ ^[0-9]+$ ]] || exit 0
        ((uso < umbral)) && exit 0
    fi
fi

# Filtro final contra la lista blanca, sin forkear: sustitución de patrones sobre una cadena.
lote=()
for accion in $marcadas; do
    [[ "$AUTOMATIZABLES" == *" $accion "* ]] && lote+=("$accion")
done
((${#lote[@]} == 0)) && exit 0

# ── La limpieza ──────────────────────────────────────────────────────────────
# La marca se pone ANTES de limpiar. Si algo se cuelga o el equipo se apaga a mitad, lo peor que
# pasa es saltarse un ciclo; ponerla después haría que un fallo repetido relanzara la limpieza
# entera en cada inicio de sesión, para siempre.
#
# Va en `~/.cache` y no en el JSON de configuración porque es estado regenerable (perderlo solo
# adelanta una limpieza) y porque AGS reescribe la configuración entera con un `replace_contents`:
# se llevaría la marca por delante. Se escribe con `printf`, no con `jq`: son tres números ya
# leídos y no vale otro fork.
#
# «Ejecutar ahora» (`--ahora`) también reinicia el intervalo —limpia el mismo lote que la automática,
# repetirlo en el siguiente arranque no tendría sentido—, pero se anota como MANUAL: la cabecera de
# Ajustes distingue las dos. Las limpiezas fila a fila de «Liberar espacio» solo tocan `ultimaManual`
# (lo escribe AGS, `servicios/disco/registroLimpieza.ts`): una acción suelta no es el lote.
if ((forzar)); then ultimaManual=$ahora; else ultimaAuto=$ahora; fi
ESTADO="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell/limpieza.json"
mkdir -p "${ESTADO%/*}"
printf '{"ultima":%d,"ultimaAuto":%d,"ultimaManual":%d}\n' "$ahora" "$ultimaAuto" "$ultimaManual" > "$ESTADO"

# El aviso lo da este script a partir del JSON, y no el limpiador: así sale igual con la
# implementación en Rust (que no notifica) que con la de bash. Dos cifras, porque no son la misma:
# lo BORRADO y lo que de verdad ha crecido el espacio libre (`recuperado`, por `statvfs`). En btrfs
# con compresión, o con instantáneas de snapper reteniendo ficheros, la segunda es menor — y es la
# que el usuario ve luego en el disco. Contar solo la primera es lo que hacía que «se han liberado
# 24 GB» acabara siendo 13.
salida=$("$LIMPIAR" "${lote[@]}" 2>/dev/null)
[[ "$notificar" == false ]] && exit 0
IFS=$'\t' read -r borrado recuperado < <(
    jq -r '[ (map(select(.estado == "ok") | .liberado) | add // 0),
             (map(select(.estado == "ok") | .recuperado) | if any(. == null) then "" else (add // 0) end)
           ] | @tsv' <<<"$salida" 2>/dev/null
)
[[ "$borrado" =~ ^[0-9]+$ ]] && ((borrado > 0)) || exit 0
_legible() {
    local t; t=$(numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null) || { echo "$1 B"; return; }
    local num=${t%%[A-Za-z]*}; num=${num/./,}; num=${num%,0}
    echo "$num ${t#"${t%%[A-Za-z]*}"}"
}
cuerpo="Se han borrado $(_legible "$borrado")."
# Solo se menciona la otra cifra si difiere de verdad (más de un 10 %): repetir la misma cifra es ruido.
if [[ "$recuperado" =~ ^[0-9]+$ ]] && ((recuperado * 10 < borrado * 9)); then
    cuerpo+=" En disco se han recuperado $(_legible "$recuperado"): el resto lo ahorraba ya la compresión o lo retienen las instantáneas."
fi
NOTIF_APP="Mantenimiento"
source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null \
    && notificar limpieza.completada -u low -t 8000 "Limpieza automática" "$cuerpo"
