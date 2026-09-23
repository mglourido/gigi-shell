#!/bin/bash

# ~/.config/inicializador/init.sh

CONFIG_DIR="$HOME/.config/gigios"
DISPLAY_CONFIG="$CONFIG_DIR/display.json"
STATE_CONFIG="$CONFIG_DIR/system_state.json"
PREFS_CONFIG="$CONFIG_DIR/preferences.json"

# --- Valores por Defecto ---
DEFAULT_BRIGHTNESS=50        # 0-100%
DEFAULT_NIGHTLIGHT=false     # true/false
DEFAULT_NIGHTLIGHT_TEMP=4500 # Temperatura en Kelvin
DEFAULT_WIFI=true            # true/false
DEFAULT_BLUETOOTH=true       # true/false
DEFAULT_VOLUME=50            # 0-100%
DEFAULT_MUTE=false           # true/false
DEFAULT_MIC_MUTE=false       # true/false

# --- Funciones Modulares ---

apply_brightness() {
    # Solo un panel interno expone la clase `backlight`. En un sobremesa el directorio
    # está vacío y `brightnessctl` sin `-c` no falla: cae al primer dispositivo `leds`
    # y acaba encendiendo el LED de scroll-lock del teclado en cada arranque.
    if ! compgen -G "/sys/class/backlight/*" > /dev/null; then
        return
    fi

    local val=$DEFAULT_BRIGHTNESS
    if [ -f "$DISPLAY_CONFIG" ]; then
        local raw=$(jq -r '.brightness // empty' "$DISPLAY_CONFIG")
        if [ -n "$raw" ]; then
            val=$(echo "$raw * 100" | bc | awk '{print int($1+0.5)}')
        fi
    fi
    brightnessctl -c backlight s "${val}%"
}

apply_nightlight() {
    local active=$DEFAULT_NIGHTLIGHT
    local temp=$DEFAULT_NIGHTLIGHT_TEMP
    
    if [ -f "$DISPLAY_CONFIG" ]; then
        local raw_active=$(jq -r '.nightLightActive // empty' "$DISPLAY_CONFIG")
        local raw_temp=$(jq -r '.nightLightTemp // empty' "$DISPLAY_CONFIG")
        
        [ -n "$raw_active" ] && active=$raw_active
        [ -n "$raw_temp" ] && temp=$raw_temp
    fi
    
    pkill -HUP -x hyprsunset
    if [ "$active" = "true" ]; then
        hyprsunset -t "$temp" &
    fi
}

apply_wifi() {
    local active=$DEFAULT_WIFI
    if [ -f "$STATE_CONFIG" ]; then
        local raw=$(jq -r '.wifi // empty' "$STATE_CONFIG")
        [ -n "$raw" ] && active=$raw
    fi
    
    if [ "$active" = "true" ]; then
        nmcli radio wifi on
    else
        nmcli radio wifi off
    fi
}

apply_bluetooth() {
    local active=$DEFAULT_BLUETOOTH
    if [ -f "$STATE_CONFIG" ]; then
        local raw=$(jq -r '.bluetooth // empty' "$STATE_CONFIG")
        [ -n "$raw" ] && active=$raw
    fi

    # Igual que el volumen y el micrófono: la preferencia de Personalización es
    # la fuente de verdad para el estado inicial —activada apaga la radio,
    # desactivada la enciende— y con ella el valor de system_state.json solo
    # actúa de respaldo si el fichero de preferencias todavía no existe.
    if [ -f "$PREFS_CONFIG" ]; then
        if [ "$(jq -r '.startupBluetoothOff // false' "$PREFS_CONFIG")" = "true" ]; then
            active=false
        else
            active=true
        fi
    fi
    
    if [ "$active" = "true" ]; then
        bluetoothctl power on
    else
        bluetoothctl power off
    fi
}

# init.sh corre desde exec-once de Hyprland, que puede ganarle la carrera al
# arranque de PipeWire/WirePlumber en la sesión de usuario. Hasta que WirePlumber
# no publica un sink por defecto, @DEFAULT_AUDIO_SINK@ no resuelve y los wpctl de
# abajo fallan en silencio: el volumen/mute guardado simplemente no se aplicaba.
wait_for_audio_endpoint() {
    local endpoint=$1
    local i=0
    while ! wpctl get-volume "$endpoint" &>/dev/null; do
        i=$((i + 1))
        [ "$i" -ge 50 ] && return 1   # techo de 10 s
        sleep 0.2
    done
}

apply_volume() {
    local vol=$DEFAULT_VOLUME
    local mute=$DEFAULT_MUTE

    wait_for_audio_endpoint @DEFAULT_AUDIO_SINK@ || return

    if [ -f "$STATE_CONFIG" ]; then
        local raw_vol=$(jq -r '.volume // empty' "$STATE_CONFIG")
        
        [ -n "$raw_vol" ] && vol=$(echo "$raw_vol * 100" | bc | awk '{print int($1+0.5)}')
    fi

    # La preferencia de Personalización es la fuente de verdad para el estado
    # inicial: activada fuerza mute; desactivada fuerza sonido.
    if [ -f "$PREFS_CONFIG" ]; then
        mute=$(jq -r '.startupVolumeMuted // false' "$PREFS_CONFIG")
    fi
    
    # Aplicar volumen
    wpctl set-volume @DEFAULT_AUDIO_SINK@ "${vol}%"
    
    # Aplicar mute
    if [ "$mute" = "true" ]; then
        wpctl set-mute @DEFAULT_AUDIO_SINK@ 1
    else
        wpctl set-mute @DEFAULT_AUDIO_SINK@ 0
    fi
}

apply_microphone_mute() {
    local mute=$DEFAULT_MIC_MUTE

    wait_for_audio_endpoint @DEFAULT_AUDIO_SOURCE@ || return

    if [ -f "$PREFS_CONFIG" ]; then
        mute=$(jq -r '.startupMicMuted // false' "$PREFS_CONFIG")
    fi

    if [ "$mute" = "true" ]; then
        wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 1
    else
        wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 0
    fi
}

# --- Ejecución ---
apply_brightness
apply_nightlight
apply_wifi
apply_bluetooth
apply_volume
apply_microphone_mute
