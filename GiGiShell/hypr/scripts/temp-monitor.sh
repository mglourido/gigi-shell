#!/usr/bin/env bash
# Temperature monitor daemon — notifies when CPU or GPU exceed WARN_TEMP, and
# again when they cool back below COOL_TEMP (hysteresis). This is a secondary,
# nice-to-have monitor, so it's built to cost as close to nothing as possible:
#
#   - CPU temp is read straight from sysfs (hwmon `temp1_input`) via a bash
#     builtin `read` — no `sensors` fork, and (the big one) no `python3`
#     interpreter startup per tick, which is what the old version forked
#     every 10s just to parse a two-field JSON blob.
#   - CPU sensor: Intel `coretemp` ("Package id 0") or AMD `k10temp`/`zenpower`
#     ("Tdie", else "Tctl"). Resolved once at startup.
#   - GPUs are found once by PCI class 0x03 in sysfs (never `lspci`: it reads
#     config space, which wakes a dGPU in D3cold). Each one is read from its own
#     hwmon node (amdgpu `edge`, xe…) with a builtin `read`; NVIDIA exposes no
#     hwmon temp, so only it forks `nvidia-smi`.
#   - A GPU whose `power/runtime_status` is `suspended` is SKIPPED, not read:
#     reading that attribute does not wake it, but `nvidia-smi` or a hwmon read
#     would — on a hybrid laptop that was a dGPU wake every minute. Asleep means
#     cold, so nothing is lost.
#   - The poll interval is adaptive: wide (idle) normally, and only tightens
#     up once a reading gets close to WARN_TEMP.

AGS_PREFS_CONFIG="$HOME/.config/gigishell/preferences.json"

# Ajuste "Monitor de temperatura" en Personalización (ags). Se lee UNA sola
# vez aquí al arrancar — nada de polling — así que activar/desactivar el
# ajuste solo surte efecto reiniciando este script (o en el próximo login).
if command -v jq >/dev/null 2>&1; then
    # NB: plain `.tempMonitor // "true"` sería incorrecto — el operador `//`
    # de jq trata un `false` literal como ausente también, así que siempre
    # resolvería a "true".
    enabled=$(jq -r 'if has("tempMonitor") then (.tempMonitor|tostring) else "true" end' \
        "$AGS_PREFS_CONFIG" 2>/dev/null)
    [[ "$enabled" == "false" ]] && exit 0
fi

WARN_TEMP=85
COOL_TEMP=80     # must drop below this to re-arm the alert
NEAR_MARGIN=15   # within this many degrees of WARN_TEMP → poll faster

POLL_IDLE=60     # comfortably cool — most of the time
POLL_ACTIVE=15   # getting close to WARN_TEMP — more responsive

cpu_alerted=false
gpu_alerted=false

# Resolved once at startup: sysfs path of the CPU package sensor.
CPU_TEMP_PATH=""
for hwmon in /sys/class/hwmon/hwmon*; do
    read -r name < "$hwmon/name" 2>/dev/null || continue
    case "$name" in
        coretemp)         buscados=("Package id 0") ;;
        k10temp|zenpower) buscados=("Tdie" "Tctl") ;;
        *) continue ;;
    esac
    for buscado in "${buscados[@]}"; do
        for label_file in "$hwmon"/temp*_label; do
            [[ -f "$label_file" ]] || continue
            read -r label < "$label_file" 2>/dev/null
            if [[ "$label" == "$buscado" ]]; then
                CPU_TEMP_PATH="${label_file%_label}_input"
                break 3
            fi
        done
    done
done

# Resolved once at startup: one entry per GPU with a temperature source.
#   GPU_PM[i]    its runtime_status file ("" if the device has no runtime PM)
#   GPU_TEMP[i]  hwmon temp*_input to read, or "" → use nvidia-smi
#   GPU_ID[i]    PCI address, for `nvidia-smi -i`
GPU_PM=(); GPU_TEMP=(); GPU_ID=()
HAS_NVIDIA_SMI=false
command -v nvidia-smi >/dev/null 2>&1 && HAS_NVIDIA_SMI=true
for dispositivo in /sys/bus/pci/devices/*; do
    IFS= read -r clase < "$dispositivo/class" 2>/dev/null || continue
    [[ "$clase" == 0x03* ]] || continue
    IFS= read -r fabricante < "$dispositivo/vendor" 2>/dev/null || continue
    # temp1 is amdgpu's `edge`; its `junction` runs 20 °C hotter by design and
    # would trip WARN_TEMP under normal load.
    temp=""
    for candidato in "$dispositivo"/hwmon/hwmon*/temp1_input "$dispositivo"/hwmon/hwmon*/temp*_input; do
        [[ -r "$candidato" ]] && { temp=$candidato; break; }
    done
    if [[ -z "$temp" ]]; then
        # Intel iGPU (i915) has no temp of its own: it lives in the CPU package.
        [[ "$fabricante" == 0x10de && "$HAS_NVIDIA_SMI" == true ]] || continue
    fi
    pm="$dispositivo/power/runtime_status"
    [[ -r "$pm" ]] || pm=""
    GPU_PM+=("$pm"); GPU_TEMP+=("$temp"); GPU_ID+=("${dispositivo##*/}")
done

# Sets global $cpu_temp. Pure bash builtin read — no fork.
get_cpu_temp() {
    if [[ -n "$CPU_TEMP_PATH" ]]; then
        local millideg
        read -r millideg < "$CPU_TEMP_PATH" 2>/dev/null || millideg=0
        cpu_temp=$(( millideg / 1000 ))
    else
        cpu_temp=0
    fi
}

# Sets global $gpu_temp to the hottest awake GPU (0 if none).
get_gpu_temp() {
    gpu_temp=0
    local i estado t
    for i in "${!GPU_ID[@]}"; do
        if [[ -n "${GPU_PM[i]}" ]]; then
            read -r estado < "${GPU_PM[i]}" 2>/dev/null || estado=""
            [[ "$estado" == suspended ]] && continue
        fi
        if [[ -n "${GPU_TEMP[i]}" ]]; then
            read -r t < "${GPU_TEMP[i]}" 2>/dev/null || continue
            t=$(( t / 1000 ))
        else
            t=$(nvidia-smi -i "${GPU_ID[i]}" --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null)
            t=${t//[[:space:]]/}
        fi
        [[ "$t" =~ ^[0-9]+$ ]] && (( t > gpu_temp )) && gpu_temp=$t
    done
}

NOTIF_APP="Hardware"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigishell-source:system "${_a[@]}" "$@"
    }
fi

send_notif() {
    local evento=$1 urgency=$2 icon=$3 title=$4 body=$5
    notificar "$evento" \
        --urgency="$urgency" \
        --icon="$icon" \
        --expire-time=15000 \
        "$title" "$body"
}

while true; do
    get_cpu_temp
    get_gpu_temp

    # --- CPU ---
    if (( cpu_temp >= WARN_TEMP )) && [[ "$cpu_alerted" == false ]]; then
        send_notif temperatura.cpu-alta critical temperature-hot \
            "CPU sobrecalentada: ${cpu_temp}°C" \
            "La temperatura del procesador supera los ${WARN_TEMP}°C. Revisa el rendimiento o la ventilación."
        cpu_alerted=true
    elif (( cpu_temp < COOL_TEMP )) && [[ "$cpu_alerted" == true ]]; then
        send_notif temperatura.cpu-normal normal temperature \
            "CPU enfriada: ${cpu_temp}°C" \
            "La temperatura del procesador volvió a niveles normales."
        cpu_alerted=false
    fi

    # --- GPU ---
    if (( gpu_temp >= WARN_TEMP )) && [[ "$gpu_alerted" == false ]]; then
        send_notif temperatura.gpu-alta critical temperature-hot \
            "GPU sobrecalentada: ${gpu_temp}°C" \
            "La temperatura de la GPU supera los ${WARN_TEMP}°C. Revisa la carga gráfica o la ventilación."
        gpu_alerted=true
    elif (( gpu_temp < COOL_TEMP )) && [[ "$gpu_alerted" == true ]]; then
        send_notif temperatura.gpu-normal normal temperature \
            "GPU enfriada: ${gpu_temp}°C" \
            "La temperatura de la GPU volvió a niveles normales."
        gpu_alerted=false
    fi

    if (( cpu_temp >= WARN_TEMP - NEAR_MARGIN || gpu_temp >= WARN_TEMP - NEAR_MARGIN )); then
        sleep "$POLL_ACTIVE"
    else
        sleep "$POLL_IDLE"
    fi
done
