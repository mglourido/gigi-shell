#!/usr/bin/env bash
# Monitor de actualizaciones del SO + drivers de GPU.
#
# Escribe ~/.config/gigios/updates.json con el número de paquetes de sistema y la
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
#   updatesPeriodic       (bool, ausente=true)  false => comprueba una vez y sale
#   updatesIntervalHours  (num,  ausente=3)     horas entre comprobaciones

PREFS="$HOME/.config/gigios/preferences.json"
OUT="$HOME/.config/gigios/updates.json"

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
    case "$mgr" in
        arch)
            local out
            if command -v checkupdates >/dev/null 2>&1; then
                out=$(nice -n19 ionice -c3 checkupdates 2>/dev/null) || out=""
            else
                out=$(pacman -Qu 2>/dev/null) || out=""
            fi
            # Formato: "name oldver -> newver"
            awk 'NF>=4 && $3=="->" {print $1"\t"$2"\t"$4}' <<< "$out"
            ;;
        fedora)
            local out
            out=$(nice -n19 ionice -c3 dnf -q check-update 2>/dev/null)
            # rc 100 = hay updates, 0 = ninguna, otros = error (out vacío). Líneas:
            # "name.arch   version   repo". Saltamos cabeceras/obsoletos.
            awk 'NF==3 && $1 !~ /^(Obsoleting|Last|Security:)/ {
                     name=$1; sub(/\.(x86_64|noarch|i686|aarch64|armv7hl)$/,"",name);
                     print name"\t\t"$2 }' <<< "$out"
            ;;
        debian)
            local out
            out=$(nice -n19 ionice -c3 apt list --upgradable 2>/dev/null) || out=""
            # "name/repo newver arch [upgradable from: oldver]"
            awk -F'[ /]' '/upgradable from:/ {
                     old=$0; sub(/.*upgradable from: */,"",old); sub(/].*/,"",old);
                     print $1"\t"old"\t"$3 }' <<< "$out"
            ;;
    esac
}

# ── Una comprobación → escritura atómica de $OUT ──────────────────────────────
run_check() {
    # Tres cubos: kernel e drivers de GPU son las "importantes" (las únicas que hacen
    # aparecer el icono en la barra); el resto son actualizaciones normales de
    # paquetes/dependencias, que solo se listan al abrir el popover.
    local gpu_tsv="" kernel_tsv="" sys_names="" sys_count=0
    if [[ -n "$mgr" ]]; then
        local name from to
        while IFS=$'\t' read -r name from to; do
            [[ -z "$name" ]] && continue
            if is_gpu "$name"; then
                gpu_tsv+="${name}\t${from}\t${to}"$'\n'
            elif is_kernel "$name"; then
                kernel_tsv+="${name}\t${from}\t${to}"$'\n'
            else
                sys_count=$(( sys_count + 1 ))
                sys_names+="${name}"$'\n'
            fi
        done < <(collect_updates)
    fi

    local gpu_json kernel_json sample_json
    local tsv_to_json='split("\n") | map(select(length>0) | split("\t")
                       | {name:.[0], from:(.[1]//""), to:(.[2]//"")})'
    gpu_json=$(printf '%b' "$gpu_tsv" | jq -R -s "$tsv_to_json" 2>/dev/null) || gpu_json='[]'
    kernel_json=$(printf '%b' "$kernel_tsv" | jq -R -s "$tsv_to_json" 2>/dev/null) || kernel_json='[]'
    sample_json=$(printf '%b' "$sys_names" | jq -R -s '
        split("\n") | map(select(length>0)) | .[0:20]' 2>/dev/null) || sample_json='[]'

    local dir tmp
    dir=$(dirname "$OUT")
    [[ -d "$dir" ]] || mkdir -p "$dir"
    tmp=$(mktemp "$dir/.updates.XXXXXX") || return
    jq -n \
        --argjson checkedAt "$(date +%s)" \
        --arg     distro    "${mgr:-unknown}" \
        --arg     cmd       "$update_cmd" \
        --argjson system    "$sys_count" \
        --argjson kernel    "$kernel_json" \
        --argjson gpu       "$gpu_json" \
        --argjson sample    "$sample_json" \
        '{checkedAt:$checkedAt, distro:$distro, updateCmd:$cmd,
          system:$system, kernel:$kernel, gpu:$gpu, systemSample:$sample}' > "$tmp" 2>/dev/null \
        && mv -f "$tmp" "$OUT" || rm -f "$tmp"
}

# ── Vigilancia de la BD de paquetes ───────────────────────────────────────────
# Sin esto el icono se queda pegado tras actualizar: solo recomprobábamos cada N
# horas, así que updates.json seguía anunciando lo que ya habías instalado. Ahora
# escuchamos la BD local de paquetes y recomprobamos en cuanto una actualización
# termina — la lances desde el botón del popover o desde tu propia terminal.
db_path=""
case "$mgr" in
    arch)   db_path=/var/lib/pacman/local ;;
    debian) db_path=/var/lib/dpkg ;;
    fedora) for p in /usr/lib/sysimage/rpm /var/lib/rpm; do
                [[ -d "$p" ]] && { db_path=$p; break; }
            done ;;
esac
have_inotify=false
command -v inotifywait >/dev/null 2>&1 && [[ -n "$db_path" && -r "$db_path" ]] && have_inotify=true

DB_EVENTS=(-e create,delete,close_write,moved_to)

# Bash DIFIERE las señales mientras espera a un hijo en primer plano: con un
# `inotifywait` (que puede bloquearse indefinidamente) o un `sleep` de 3h delante,
# un SIGTERM —el `pkill` que hace el toggle maestro de AGS al desactivarlo— quedaría
# pendiente hasta que ese hijo acabara, y el script seguiría vivo reescribiendo
# updates.json. Lanzando el hijo en segundo plano y esperándolo con `wait`, la señal
# se procesa al instante.
_child=""
_on_term() {
    [[ -n "$_child" ]] && kill "$_child" 2>/dev/null
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

# Espera hasta la próxima comprobación. Devuelve 0 = toca recomprobar, 1 = no hay
# nada más que esperar (salir).
wait_next() {
    if ! $have_inotify; then
        # Sin inotify-tools solo queda el sondeo periódico; si además está
        # desactivado, no hay nada que esperar.
        [[ "$periodic" == "false" ]] && return 1
        blocking sleep "$(( interval_hours * 3600 ))"
        return 0
    fi

    local timeout=()
    [[ "$periodic" == "true" ]] && timeout=(-t "$(( interval_hours * 3600 ))")

    # Bloquea (≈0% CPU) hasta un cambio en la BD o hasta que venza el intervalo.
    blocking inotifywait -qq "${timeout[@]}" "${DB_EVENTS[@]}" "$db_path"
    local rc=$?
    case $rc in
        0)  # Hubo actualización. Una instalación toca la BD cientos de veces, así
            # que esperamos a que se calme (5s sin eventos) antes de recomprobar.
            while blocking inotifywait -qq -t 5 "${DB_EVENTS[@]}" "$db_path"; do :; done
            ;;
        1)  # Error de inotify (p.ej. límite de watches): degradamos al sondeo.
            have_inotify=false
            [[ "$periodic" == "false" ]] && return 1
            blocking sleep "$(( interval_hours * 3600 ))"
            ;;
        *)  : ;;  # 2 = venció el timeout del intervalo → recomprobación periódica
    esac
    return 0
}

# ── Bucle principal ───────────────────────────────────────────────────────────
# El gate de juego va ENTRE la espera y la comprobación, no envolviendo la espera:
# bloqueado en `inotifywait` este script no cuesta nada, así que se le deja esperar
# normalmente y solo se retiene el `run_check`, que es lo caro (toca RED y sincroniza
# una BD temporal de pacman). Un evento de la BD que llegue mientras juegas no se
# pierde: se atiende en cuanto cierras el juego. Ver lib/gaming-gate.sh.
#
# GAMING_GATE_SLEEP=blocking es obligatorio aquí y no un detalle: un `sleep` en
# primer plano DIFERIRÍA el SIGTERM del toggle maestro de AGS y el script
# sobreviviría a su propio apagado (mismo motivo que `blocking()`, arriba).
GAMING_GATE_SLEEP="blocking sleep"
# shellcheck source=lib/gaming-gate.sh
if ! source "$HOME/.config/hypr/scripts/lib/gaming-gate.sh" 2>/dev/null; then
    gaming_gate_wait() { :; }   # sin la librería, el monitor sigue como siempre
fi

while true; do
    gaming_gate_wait updates
    run_check
    wait_next || break
done
