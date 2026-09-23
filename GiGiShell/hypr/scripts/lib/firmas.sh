# shellcheck shell=bash
# lib/firmas.sh — "actualizar las firmas de ClamAV al iniciar sesión". Se SOURCEA, no se ejecuta.
#
# EL MODELO, y lo importante es lo que NO hay: **no existe ningún temporizador de actualización de
# ClamAV**. Ni un servicio periódico, ni un bucle, ni un reintento por barrido, ni un despertar a
# mitad de sesión. La única actualización automática ocurre **una vez, al arrancar Hyprland**
# (`gigios/autostart.lua` llama a `actualizar-firmas.sh --auto`), y solo si el interruptor
# `clamavAutoUpdate` de ~/.config/gigios/security.json está encendido (lo está por defecto) y la
# base falta o tiene más de un día. Con eso basta: una sesión de escritorio empieza casi a diario,
# así que las firmas entran al día y se quedan al día durante toda la sesión.
#
# POR QUÉ SUSTITUYE A `clamav-freshclam`: aquel despertaba cada pocas horas hiciera falta o no y su
# estado vivía en systemd (la UI tenía que preguntárselo). AGS lo apaga si se lo encuentra vivo
# (ver servicios/seguridad/clamav.ts) para que no queden dos actualizadores.
#
# LO QUE ESTA LIBRERÍA APORTA A LOS ESCÁNERES es el aviso con botón: si ClamAV no puede analizar a
# mitad de sesión, se ofrece actualizar de UN GESTO en vez de descargarse ~200 MB por su cuenta
# mientras el usuario está haciendo otra cosa. **Ningún escáner actualiza nada por sí mismo.**
#
# CÓMO SE USA:
#     # shellcheck source=lib/firmas.sh
#     source "$HOME/.config/hypr/scripts/lib/firmas.sh"
#     firmas_aviso_con_boton analisis.sin-firmas normal "Título" "Cuerpo"   # BLOQUEA: ver abajo

FIRMAS_CONFIG="${FIRMAS_CONFIG:-$HOME/.config/gigios/security.json}"
FIRMAS_SCRIPT="${FIRMAS_SCRIPT:-$HOME/.config/hypr/scripts/actualizar-firmas.sh}"
# Resultado del último intento automático: "<epoch> <rc>". Su único uso es el antirrebote de
# `actualizar-firmas.sh --auto`: `hyprctl reload full-reset` vuelve a ejecutar el autostart, y sin
# esto cada recarga reintentaría la descarga cuando el arranque anterior falló (sin red, por
# ejemplo). No es un temporizador: nadie lo consulta si nadie arranca la sesión.
FIRMAS_MARCA="${FIRMAS_MARCA:-$HOME/.cache/gigios/firmas-auto}"

# ¿Está encendido el interruptor "actualizar las firmas al iniciar sesión"? Ausente o ilegible =
# SÍ (es el valor por defecto en la UI, y con la base vacía el escáner de descargas no da NADA por
# analizado: el fallo seguro es actualizar).
#
# El `has()` NO es adorno: `.clamavAutoUpdate // true` daría `true` también con un `false`
# guardado, porque el operador `//` de jq trata `false` como ausente — apagar el interruptor desde
# Ajustes no habría servido de nada (mismo tropiezo ya documentado para `dlPauseWhileGaming` en
# oom-monitor.sh).
firmas_auto_activa() {
    local v=true
    if command -v jq >/dev/null 2>&1 && [[ -f "$FIRMAS_CONFIG" ]]; then
        v=$(jq -r 'if has("clamavAutoUpdate") then (.clamavAutoUpdate|tostring) else "true" end' \
            "$FIRMAS_CONFIG" 2>/dev/null)
    fi
    [[ "$v" != false ]]
}

# Techo de espera del aviso con botón. El popup de AGS vive 60 s como mucho
# (`DURACION_MAXIMA_POPUP_MS`), pero `notify-send --wait` no se entera de eso: espera a que el
# DAEMON cierre la notificación, y con `-t 0` el daemon no la cierra nunca. Sin techo quedaba un
# notify-send colgado hasta el fin de la sesión por cada aviso — invisible, pero uno por arranque y
# para siempre. Se le da margen sobre los 60 s del popup por si el reloj del daemon y el nuestro no
# arrancan a la vez.
FIRMAS_ESPERA_CLIC_S="${FIRMAS_ESPERA_CLIC_S:-120}"

# Aviso "no puedo analizar" CON botón de actualizar (clic derecho sobre el popup, ver
# ags/CLAUDE.md → "Acciones D-Bus en el popup"). Es el ÚNICO camino por el que se actualiza a mitad
# de sesión, y siempre lo abre un gesto del usuario.
#
# BLOQUEA hasta el clic, el cierre o el techo de arriba: llámalo en segundo plano si tu script
# tiene algo más que hacer. `notificar` tiene que estar ya definido (lib/notif.sh).
#
# El `timeout` NO puede envolver a `notificar` —es una función de shell, no un binario—, así que el
# techo se implementa con un vigilante que mata al notify-send. Un `timeout bash -c` perdería la
# función y el aviso saldría sin identidad (sin `x-gigios-event`, o sea inconfigurable desde
# Ajustes).
firmas_aviso_con_boton() {   # $1 evento  $2 urgencia  $3 título  $4 cuerpo
    local evento=$1 urgencia=$2 titulo=$3 cuerpo=$4
    local salida act vigilante notif
    salida=$(mktemp) || return 1

    notificar "$evento" -a "Seguridad" --wait -t 60000 \
        -A "update=Actualizar firmas" -u "$urgencia" "$titulo" "$cuerpo" > "$salida" &
    notif=$!
    # `pkill -P` antes del `kill`, y no es redundante: lo que está en segundo plano es un SUBSHELL
    # que llama a una función, así que el notify-send real puede ser un HIJO suyo y sobrevivir a
    # que se mate al padre — justo el proceso colgado que esto viene a evitar. (Bash suele
    # optimizar el último comando de un subshell con un `exec`, en cuyo caso el pid ya es el de
    # notify-send y el pkill no encuentra nada; no se puede depender de que ocurra.)
    ( sleep "$FIRMAS_ESPERA_CLIC_S"; pkill -P "$notif" 2>/dev/null; kill "$notif" 2>/dev/null ) &
    vigilante=$!
    wait "$notif" 2>/dev/null
    kill "$vigilante" 2>/dev/null

    act=$(cat "$salida" 2>/dev/null); rm -f "$salida"
    [[ "$act" == "update" && -x "$FIRMAS_SCRIPT" ]] && "$FIRMAS_SCRIPT"
    return 0
}
