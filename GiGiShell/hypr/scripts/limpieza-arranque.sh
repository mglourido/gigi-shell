#!/usr/bin/env bash
# limpieza-arranque.sh — decide al iniciar sesión si toca autolimpiar, y si no, sale.
#
# Lo lanza gigios/autostart.lua (t=45). **No es un daemon: no hay bucle ni proceso residente.**
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

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/almacenamiento.json"
ESTADO="${XDG_CACHE_HOME:-$HOME/.cache}/gigios/limpieza.json"
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

# Salida: auto \t intervaloHoras \t umbralUso \t ultima \t notificar \t "accion accion …"
#
# `notificar` NO se pide como `.notificar // true`: en jq el operador `//` considera falsy a
# **`false`, no solo a `null`**, así que con la opción desactivada devolvía `true` y la limpieza
# avisaba igual. Las claves booleanas se preguntan con `has()`; las numéricas sí pueden usar `//`
# porque un 0 en jq es truthy.
IFS=$'\t' read -r auto intervalo umbral ultima notificar marcadas < <(
    jq -rn --slurpfile c "$CONFIG" --slurpfile e "$ESTADO" '
        ($c[0] // {}) as $cfg | ($e[0] // {}) as $est |
        [ (if ($cfg | has("auto")) then $cfg.auto else false end),
          ($cfg.intervaloHoras // 24),
          ($cfg.umbralUso // 0),
          ($est.ultima // 0),
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
# se llevaría la marca por delante. Se escribe con `printf`, no con `jq`: es un objeto de un campo
# y no vale otro fork.
ESTADO="${XDG_CACHE_HOME:-$HOME/.cache}/gigios/limpieza.json"
mkdir -p "${ESTADO%/*}"
printf '{"ultima":%d}\n' "$ahora" > "$ESTADO"

GIGIOS_LIMPIEZA_NOTIFICAR=$([[ "$notificar" == false ]] && echo 0 || echo 1) \
    "$LIMPIAR" "${lote[@]}" >/dev/null 2>&1
