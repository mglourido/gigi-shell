#!/usr/bin/env bash
# Monitor de actualizaciones del SO + drivers de GPU.
#
# Escribe ~/.config/gigishell/updates.json con el número de paquetes de sistema y la
# lista de drivers de GPU pendientes; `Actualizaciones` en la barra lo
# observa con un FileMonitor y muestra un icono + popover cuando hay algo.
#
# Todo el sondeo es SOLO LECTURA y SIN SUDO:
#   - Arch/CachyOS: `checkupdates` (pacman-contrib; sincroniza una BD temporal en la
#     caché del usuario, nunca la del sistema). Fallback: `pacman -Qu`.
#   - Fedora:       `dnf -q check-update` (refresca metadatos en la caché del usuario).
#   - Debian/Ubuntu:`apt list --upgradable` con la caché existente (sin `apt update`).
#
# Preferencias (config/preferences.json), leídas UNA sola vez al arrancar — patrón
# batteryMonitor/tempMonitor: un cambio solo surte efecto reiniciando el script (lo
# que el setter maestro de AGS hace en caliente vía pkill+exec):
#   updatesMonitor        (bool, ausente=true)  maestro; false => borra json y sale
#   updatesPeriodic       (bool, ausente=true)  false => solo arranque y cambios locales
#   updatesIntervalHours  (num,  ausente=3)     horas entre comprobaciones
#   updatesWatchList      ([str], ausente=[])   paquetes vigilados por el usuario:
#       en cuanto UNO de ellos aparece entre las pendientes se deja de mirar la
#       lista (basta uno para avisar) y va a `watched`, que tiene su propio icono.

PREFS="$HOME/.config/gigishell/preferences.json"
OUT="$HOME/.config/gigishell/updates.json"

# jq es obligatorio: construimos el JSON con él para escapar bien nombres/versiones.
if ! command -v jq >/dev/null 2>&1; then
    echo "[updates-monitor] jq no está instalado; no se puede generar $OUT" >&2
    exit 0
fi

# ── Preferencias (una sola lectura) ───────────────────────────────────────────
enabled=true; periodic=true; interval_hours=3
if [[ -r "$PREFS" ]]; then
    # `.k // true` sería incorrecto para false literal (jq trata false como ausente),
    # de ahí el has()/tostring explícito.
    enabled=$(jq -r 'if has("updatesMonitor") then (.updatesMonitor|tostring) else "true" end' "$PREFS" 2>/dev/null) || enabled=true
    periodic=$(jq -r 'if has("updatesPeriodic") then (.updatesPeriodic|tostring) else "true" end' "$PREFS" 2>/dev/null) || periodic=true
    interval_hours=$(jq -r 'if has("updatesIntervalHours") then (.updatesIntervalHours|tostring) else "3" end' "$PREFS" 2>/dev/null) || interval_hours=3
fi
[[ "$enabled" == "false" ]] && { rm -f "$OUT"; exit 0; }

# Lista vigilada → conjunto (nombre exacto de paquete). Sin prefs o sin clave, vacía.
declare -A watch_set=()
if [[ -r "$PREFS" ]]; then
    while IFS= read -r w; do
        [[ -n "$w" ]] && watch_set["$w"]=1
    done < <(jq -r '(.updatesWatchList // []) | if type=="array" then .[] | strings else empty end' "$PREFS" 2>/dev/null)
fi
# Saneo del intervalo: entero ≥1, si no 3.
[[ "$interval_hours" =~ ^[0-9]+$ ]] && (( interval_hours >= 1 )) || interval_hours=3

# ── Detección de distro (una vez) ─────────────────────────────────────────────
# mgr: arch | fedora | debian | ""(desconocida). update_cmd: el comando que abrirá
# el botón "Actualizar" del popover.
mgr=""; update_cmd=""
if [[ -r /etc/os-release ]]; then
    id=$(. /etc/os-release 2>/dev/null; echo "$ID $ID_LIKE" | tr 'A-Z' 'a-z')
else
    id=""
fi
case " $id " in
    *" arch "*|*cachyos*|*manjaro*|*endeavouros*) mgr=arch;   update_cmd="sudo pacman -Syu" ;;
    *fedora*|*rhel*|*centos*|*" nobara "*)        mgr=fedora; update_cmd="sudo dnf upgrade" ;;
    *debian*|*ubuntu*|*" mint "*|*" pop "*)       mgr=debian; update_cmd="sudo apt update && sudo apt upgrade" ;;
esac

# ── Detección de GPU (una vez) ────────────────────────────────────────────────
has_nvidia=false; has_amd=false
if command -v lspci >/dev/null 2>&1; then
    gpus=$(lspci 2>/dev/null | grep -iE 'vga|3d|display' || true)
    [[ "$gpus" == *NVIDIA* ]] && has_nvidia=true
    echo "$gpus" | grep -qiE 'AMD|ATI|Radeon' && has_amd=true
fi

# ¿El nombre de paquete corresponde a un driver de GPU de un fabricante presente?
is_gpu() {
    local n=$1
    if $has_nvidia && [[ "$n" == *nvidia* ]]; then return 0; fi
    if $has_amd && [[ "$n" == *mesa* || "$n" == *radeon* || "$n" == *amdgpu* || "$n" == *amdvlk* ]]; then return 0; fi
    return 1
}

# ¿Es una actualización de kernel? Cubre arch/cachyos (linux, linux-lts, linux-zen,
# linux-cachyos*, linux-*-headers, linux-firmware), debian (linux-image-*,
# linux-headers-*) y fedora (kernel, kernel-core, kernel-modules…).
# `util-linux` no casa: exigimos que EMPIECE por linux-/kernel-.
is_kernel() {
    local n=$1
    [[ "$n" == "linux" || "$n" == linux-* || "$n" == "kernel" || "$n" == kernel-* ]]
}

# ── Obtención de pendientes ───────────────────────────────────────────────────
# Emite por stdout líneas "nombre<TAB>versión_vieja<TAB>versión_nueva" (vieja/nueva
# pueden ir vacías si el gestor no las expone). Va a prioridad baja para no molestar.
collect_updates() {
    local modo=${1:-red} out rc
    case "$mgr" in
        arch)
            local opciones=() cache_bd="${CHECKUPDATES_DB:-${TMPDIR:-/tmp}/checkup-db-$UID}"
            [[ "$modo" == local ]] && opciones=(--nosync)
            if [[ "$modo" == local && ! -d "$cache_bd/sync" ]]; then
                # /tmp puede vaciarse entre sesiones; --nosync no detecta ese error.
                out=$(pacman -Qu 2>/dev/null) || return 1
            elif command -v checkupdates >/dev/null 2>&1; then
                out=$(nice -n19 ionice -c3 checkupdates "${opciones[@]}" 2>/dev/null)
                rc=$?
                # 2 significa que no quedan pendientes; un error no debe borrar avisos.
                if (( rc != 0 && rc != 2 )); then
                    [[ "$modo" == local ]] || return 1
                    out=$(pacman -Qu 2>/dev/null) || return 1
                fi
            else
                out=$(pacman -Qu 2>/dev/null) || return 1
            fi
            # Formato: "name oldver -> newver"
            awk 'NF>=4 && $3=="->" {print $1"\t"$2"\t"$4}' <<< "$out"
            ;;
        fedora)
            local opciones=()
            [[ "$modo" == local ]] && opciones=(--cacheonly)
            out=$(nice -n19 ionice -c3 dnf -q "${opciones[@]}" check-update 2>/dev/null)
            rc=$?
            (( rc == 0 || rc == 100 )) || return 1
            # rc 100 = hay updates, 0 = ninguna; los errores conservan el JSON. Líneas:
            # "name.arch   version   repo". Saltamos cabeceras/obsoletos.
            awk 'NF==3 && $1 !~ /^(Obsoleting|Last|Security:)/ {
                     name=$1; sub(/\.(x86_64|noarch|i686|aarch64|armv7hl)$/,"",name);
                     print name"\t\t"$2 }' <<< "$out"
            ;;
        debian)
            out=$(nice -n19 ionice -c3 apt list --upgradable 2>/dev/null) || return 1
            # "name/repo newver arch [upgradable from: oldver]"
            awk -F'[ /]' '/upgradable from:/ {
                     old=$0; sub(/.*upgradable from: */,"",old); sub(/].*/,"",old);
                     print $1"\t"old"\t"$3 }' <<< "$out"
            ;;
    esac
}

# ── Una comprobación → escritura atómica de $OUT ──────────────────────────────
run_check() {
    local pendientes
    pendientes=$(collect_updates "${1:-red}") || return 1
    # Tres cubos: kernel e drivers de GPU son las "importantes" (las únicas que hacen
    # aparecer el icono en la barra); el resto son actualizaciones normales de
    # paquetes/dependencias, que solo se listan al abrir el popover.
    local gpu_tsv="" kernel_tsv="" watched_tsv="" sys_names="" sys_count=0
    # La lista vigilada se consulta hasta el PRIMER acierto: con uno ya hay aviso, y
    # a partir de ahí los paquetes siguen su clasificación normal.
    local watching=false
    (( ${#watch_set[@]} > 0 )) && watching=true
    if [[ -n "$mgr" ]]; then
        local name from to
        while IFS=$'\t' read -r name from to; do
            [[ -z "$name" ]] && continue
            if $watching && [[ -n "${watch_set[$name]:-}" ]]; then
                watched_tsv="$name"$'\t'"$from"$'\t'"$to"$'\n'
                watching=false
            elif is_gpu "$name"; then
                gpu_tsv+="$name"$'\t'"$from"$'\t'"$to"$'\n'
            elif is_kernel "$name"; then
                kernel_tsv+="$name"$'\t'"$from"$'\t'"$to"$'\n'
            else
                sys_count=$(( sys_count + 1 ))
                (( sys_count <= 20 )) && sys_names+="$name"$'\n'
            fi
        done <<< "$pendientes"
    fi

    local dir tmp
    dir=$(dirname "$OUT")
    [[ -d "$dir" ]] || mkdir -p "$dir"
    tmp=$(mktemp "$dir/.updates.XXXXXX") || return
    jq -n \
        --arg     distro    "${mgr:-unknown}" \
        --arg     cmd       "$update_cmd" \
        --argjson system    "$sys_count" \
        --arg     kernel    "$kernel_tsv" \
        --arg     gpu       "$gpu_tsv" \
        --arg     watched   "$watched_tsv" \
        --arg     sample    "$sys_names" \
        'def paquetes: split("\n") | map(select(length>0) | split("\t")
             | {name:.[0], from:(.[1]//""), to:(.[2]//"")});
         {checkedAt:(now|floor), distro:$distro, updateCmd:$cmd,
          system:$system, kernel:($kernel|paquetes), gpu:($gpu|paquetes),
          watched:($watched|paquetes),
          systemSample:($sample|split("\n")|map(select(length>0)))}' > "$tmp" 2>/dev/null \
        && mv -f "$tmp" "$OUT" || rm -f "$tmp"
}

# ── Vigilancia de la BD de paquetes ───────────────────────────────────────────
# La escucha permanece activa durante las comprobaciones y el gate de juego:
# recrear inotifywait en cada espera perdía las instalaciones que acababan mientras
# consultábamos pendientes y dejaba el aviso pegado hasta el siguiente intervalo.
db_path=""
case "$mgr" in
    arch)   db_path=/var/lib/pacman
            if command -v pacman-conf >/dev/null 2>&1; then
                ruta_bd=$(pacman-conf DBPath 2>/dev/null)
                [[ -d "$ruta_bd" ]] && db_path=${ruta_bd%/}
            fi ;;
    debian) db_path=/var/lib/dpkg ;;
    fedora) for p in /usr/lib/sysimage/rpm /var/lib/rpm; do
                [[ -d "$p" ]] && { db_path=$p; break; }
            done ;;
esac
have_inotify=false
command -v inotifywait >/dev/null 2>&1 && [[ -n "$db_path" && -r "$db_path" ]] && have_inotify=true

DB_EVENTS=(-e create,delete,close_write,moved_to)
FILTRO_BD=()
if [[ "$mgr" == arch ]]; then
    # La calma de /local no implica fin de transacción: los hooks de pacman pueden
    # tardar minutos sin tocarla. El borrado del bloqueo sí marca la salida completa.
    DB_EVENTS=(-e delete,moved_from)
    FILTRO_BD=(--include '/db[.]lck$')
fi

vigilante_pid=""
eventos_fd=""
detener_vigilancia() {
    if [[ -n "$vigilante_pid" ]]; then
        kill "$vigilante_pid" 2>/dev/null
        wait "$vigilante_pid" 2>/dev/null
        vigilante_pid=""
    fi
    [[ -n "$eventos_fd" ]] && exec {eventos_fd}<&-
    eventos_fd=""
}
trap detener_vigilancia EXIT

iniciar_vigilancia() {
    $have_inotify || return 0
    # Un pipe anónimo basta: no se crean archivos ni una cola persistente. La
    # confirmación inicial evita empezar la consulta antes de instalar el watch.
    exec {eventos_fd}< <(LC_ALL=C exec inotifywait -m --format '%f' \
        "${DB_EVENTS[@]}" "${FILTRO_BD[@]}" "$db_path" 2>&1)
    vigilante_pid=$!
    if blocking confirmar_vigilancia; then
        return 0
    fi
    detener_vigilancia
    have_inotify=false
}

confirmar_vigilancia() {
    trap - EXIT TERM INT
    local evento
    while IFS= read -r -u "$eventos_fd" evento; do
        [[ "$evento" == 'Watches established.' ]] && return 0
    done
    return 1
}

# Bash DIFIERE las señales mientras espera a un hijo en primer plano: con un
# `sleep` de 3h delante,
# un SIGTERM —el `pkill` que hace el toggle maestro de AGS al desactivarlo— quedaría
# pendiente hasta que ese hijo acabara, y el script seguiría vivo reescribiendo
# updates.json. Lanzando el hijo en segundo plano y esperándolo con `wait`, la señal
# se procesa al instante.
_child=""
_on_term() {
    if [[ -n "$_child" ]]; then
        kill "$_child" 2>/dev/null
        wait "$_child" 2>/dev/null
        _child=""
    fi
    exit 0
}
trap _on_term TERM INT

blocking() {
    "$@" >/dev/null 2>&1 &
    _child=$!
    wait "$_child"
    local rc=$?
    _child=""
    return $rc
}

esperar_eventos_bd() {
    # Se ejecuta como hijo de blocking: wait atiende incluso una señal recibida
    # justo antes del read. El hijo no debe heredar la limpieza del vigilante.
    trap - EXIT TERM INT
    local evento
    IFS= read -r "$@" -u "$eventos_fd" evento || return $?
    while IFS= read -r -t 5 -u "$eventos_fd" evento; do :; done
    return 0
}

# Espera hasta la próxima comprobación. Los eventos usan la caché existente, sin
# red; solo el arranque y el intervalo sincronizan los repositorios.
modo_comprobacion=red
wait_next() {
    modo_comprobacion=red
    local rc timeout espera=${1:-$(( interval_hours * 3600 ))}
    while $have_inotify; do
        timeout=()
        # Si empieza otra transacción durante la calma, seguimos esperando su fin.
        if [[ -n "${1:-}" || "$periodic" == true ]] && ! [[ "$mgr" == arch && -e "$db_path/db.lck" ]]; then
            timeout=(-t "$espera")
        fi
        blocking esperar_eventos_bd "${timeout[@]}"
        rc=$?
        if (( rc == 0 )); then
            [[ "$mgr" == arch && -e "$db_path/db.lck" ]] && continue
            modo_comprobacion=local
            return 0
        fi
        (( rc > 128 )) && return 0  # venció el intervalo
        detener_vigilancia         # EOF/error: conservar el respaldo periódico
        have_inotify=false
    done
    [[ -z "${1:-}" && "$periodic" == false ]] && return 1
    blocking sleep "$espera"
    return 0
}

esperar_mantenimiento() {
    # El gate aplaza la búsqueda por red, pero sigue retirando avisos ya instalados.
    # El ámbito local conserva la consulta de red pendiente en el bucle principal.
    local modo_comprobacion=red
    wait_next "$1" || return 0
    [[ "$modo_comprobacion" == local ]] && run_check local
    return 0
}

comprobar_pendientes() {
    local modo=${1:-red}
    # El gate compartido lee runtime-state.json y aplaza la consulta mientras juegas.
    # Solo la búsqueda por red espera; retirar avisos ya instalados sigue siendo local.
    [[ "$modo" == red ]] && gaming_gate_wait updates
    run_check "$modo"
}

# ── Bucle principal ───────────────────────────────────────────────────────────
# El gate aplaza solo la sincronización por red. Su durmiente reutiliza la escucha
# de paquetes para atender instalaciones sin salir del ahorro ni despertar la radio.
GAMING_GATE_SLEEP=esperar_mantenimiento
# shellcheck source=lib/gaming-gate.sh
if ! source "$HOME/.config/hypr/scripts/lib/gaming-gate.sh" 2>/dev/null; then
    gaming_gate_wait() { :; }   # sin la librería, el monitor sigue como siempre
fi

iniciar_vigilancia
# Retira el estado obsoleto de una sesión anterior aunque la búsqueda esté pausada.
[[ "$mgr" == arch && -e "$db_path/db.lck" ]] || run_check local
while true; do
    comprobar_pendientes "$modo_comprobacion"
    wait_next || break
done
