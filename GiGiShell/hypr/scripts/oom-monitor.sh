#!/usr/bin/env bash
# System event monitor — kernel events, auth failures, SSH, file integrity,
# disk health y estado de servicios. Los monitores corren en paralelo via & + wait:
#   1. monitor_kernel  — journalctl -kf (SOLO kernel): OOM, panic, hung, I/O, GPU,
#                        errores de hardware (MCE/ECC), módulos sin firmar…
#   2. monitor_system  — journalctl -f filtrado por identificador: sudo, sshd, su,
#                        pkexec, polkitd, systemd (failed to start), systemd-coredump
#   3. monitor_files   — inotifywait sobre configs/persistencia críticas
#   4. monitor_smart   — polling de SMART (smartctl): disco a punto de fallar
#   5. monitor_units   — polling de `systemctl --failed`: unidades caídas
#
# Notas de diseño (evitar falsos positivos):
#   - `-n 0` evita reprocesar el backlog del journal al arrancar (si no, cada
#     inicio de sesión reenviaba eventos viejos).
#   - Los eventos de kernel se anclan a `journalctl -k` en vez de hacer match de
#     subcadenas sobre TODO el journal (antes cualquier log de app con "i/o error"
#     o "gpu … error" disparaba una alerta de disco/GPU).
#   - El monitor de sistema se restringe con `-t` a los identificadores relevantes,
#     así "failed to start" solo cuenta cuando lo emite systemd, no una app.
#   - Los monitores de polling siembran su estado en la primera pasada sin
#     notificar, para no avisar de fallos preexistentes al arrancar.

# ── Ajustes de seguridad (sección "Seguridad" de ags) ─────────────────────────
# Cada clave activa/desactiva un tipo de evento. Se leen UNA sola vez aquí al
# arrancar (nada de polling de la config), igual que battery-monitor.sh con
# preferences.json, así que un cambio en la UI solo surte efecto reiniciando el
# sistema o relanzando este script. Archivo ausente/ilegible → todo ON (por
# defecto). Fuente: ags/modulos/ajustes/seguridad/preferencias.ts → security.json.
SEC_CONFIG="$HOME/.config/gigios/security.json"
sec_oomKiller=true   sec_kernelPanic=true   sec_hungTask=true    sec_hwErrors=true
sec_kernelModules=true sec_cpuThrottling=true sec_diskError=true sec_diskHealth=true
sec_gpuError=true    sec_serviceFailure=true sec_serviceHealth=true
sec_sudoAuth=true    sec_privEsc=true       sec_ssh=true         sec_appCrash=true
sec_fileIntegrity=true sec_downloadScan=true sec_sandboxLaunch=true

if command -v jq >/dev/null 2>&1 && [[ -f "$SEC_CONFIG" ]]; then
    # Solo un `false` explícito desactiva; claves ausentes conservan el default ON.
    # Allowlist de claves para no fijar variables arbitrarias desde el JSON.
    while IFS='=' read -r _k _v; do
        [[ "$_v" == "false" ]] || continue
        case "$_k" in
            oomKiller|kernelPanic|hungTask|hwErrors|kernelModules|cpuThrottling|\
            diskError|diskHealth|gpuError|serviceFailure|serviceHealth|sudoAuth|\
            privEsc|ssh|appCrash|fileIntegrity|downloadScan|sandboxLaunch)
                printf -v "sec_$_k" '%s' false ;;
        esac
    done < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' "$SEC_CONFIG" 2>/dev/null)
fi

# ── Escalonado de arranque (ver hypr/gigios/autostart.lua) ──────────────────────────
# Este script NO se retrasa entero desde gigios/autostart.lua, y esa asimetría es el
# diseño: sus 6 sub-monitores no corren el mismo riesgo si empiezan tarde.
#
#   - kernel/system/files → SIN retardo. Siguen el journal con `-n 0` (que salta el
#     backlog a propósito, para no reenviar eventos viejos en cada login) e inotify,
#     que tampoco guarda lo pasado. Un OOM, un `sudo` fallido o un cambio en
#     /etc/shadow ocurridos durante un retardo NO se recuperan después: serían una
#     ventana ciega de seguridad, justo lo que este script existe para evitar.
#   - smart/units/downloads → SÍ. Son SONDEOS: leen un estado que sigue ahí cuando
#     los mires, así que retrasarlos no pierde nada, solo los aparta del pico de
#     arranque. Son además los caros (smartctl a cada disco; hash + ClamAV a las
#     descargas, que recarga ~200 MB de firmas por invocación).
#
# Segundos, relativos al arranque del script. Se aplican DENTRO de cada función y
# después de sus guardas, para no dejar un `sleep` colgando por un monitor apagado.
DELAY_UNITS=25      # primera pasada solo siembra: no notifica nada, retrasarla es invisible
DELAY_SMART=45      # un disco muriéndose lo sigue estando 45 s después
DELAY_DOWNLOADS=60  # el más caro del script; nada se descarga en el primer minuto de sesión

# Lanzador aislado (contención + análisis) que dispara el botón de la notificación.
RUN_UNTRUSTED="$HOME/.config/hypr/scripts/run-untrusted.sh"
# Escaneo a demanda (para archivos grandes que el barrido se salta).
SCAN_FILE="$HOME/.config/hypr/scripts/scan-file.sh"
# Actualización de firmas que dispara el botón del aviso "sin base de firmas".
UPDATE_SIGS="$HOME/.config/hypr/scripts/actualizar-firmas.sh"
# Estado "jugando" que escribe AGS (servicios/energia/gamingState.ts) y umbral de ahorro.
RUNTIME_STATE="$HOME/.config/gigios/runtime-state.json"
POWER_CONFIG="$HOME/.config/power-save/config.json"

# Gate compartido de "estoy jugando" (lee ese mismo RUNTIME_STATE). Lo usan los dos
# sub-monitores de SONDEO —monitor_smart y monitor_units— para no competir con un
# juego. Los tres SEGUIDORES de eventos (kernel/system/files) NO lo usan a propósito:
# congelarlos dejaría una ventana ciega de seguridad y no ahorraría nada, porque
# bloqueados en journalctl/inotifywait ya cuestan ~0 % de CPU. monitor_downloads
# mantiene su propia pausa (dlPauseWhileGaming), que es más específica y ya tiene UI.
# Ver lib/gaming-gate.sh para el razonamiento completo.
if ! source "$HOME/.config/hypr/scripts/lib/gaming-gate.sh" 2>/dev/null; then
    gaming_gate_wait() { :; }   # sin la librería, los monitores siguen como siempre
fi

# Identidad por aviso: cada `notificar <id>` declara CUÁL de los ~30 avisos de este
# script es, para que se pueda configurar por separado en Ajustes. Aquí NO se fija
# `NOTIF_APP` a propósito: los cuatro avisos con botón ya mandan su propio `-a
# "Seguridad"` y el resto nunca ha llevado nombre de app; ponerlo ahora cambiaría el
# `dedupKey` por defecto (app+título) de todo lo que este script ha guardado.
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigios-source:system "${_a[@]}" "$@"
    }
fi

# ── Firmas de ClamAV ──────────────────────────────────────────────────────────
# Solo el aviso con botón para el caso "ClamAV no puede analizar". Este script NUNCA
# actualiza firmas por su cuenta (ver la rama `rc == 2`). Sin la librería se degrada a
# un aviso sin botón: se pierde el atajo, no el aviso.
# shellcheck source=lib/firmas.sh
if ! source "$HOME/.config/hypr/scripts/lib/firmas.sh" 2>/dev/null; then
    firmas_aviso_con_boton() { notificar "$1" -u "$2" "$3" "$4" -t 0; }
fi

# ── Agrupación de notificaciones en ráfaga ────────────────────────────────────
# Los eventos NO vienen de uno en uno: una GPU atragantada repite la misma línea
# NVRM decenas de veces, un `pacman -Syu` toca decenas de ficheros vigilados y un
# disco muriéndose escupe errores de E/S por segundo. Una notificación por evento
# —muchas críticas con `-t 0`, sin autocierre— se despacha cerrándolas en bloque
# sin leer ninguna, que es el mismo fallo que motivó callar el pkexec autenticado
# en monitor_system (ver esa sección). La librería acumula por categoría y emite UNA notificación
# cuando la ráfaga se calma. Ver lib/notif-agrupar.sh para el contrato completo.
#
# Cada sub-monitor corre en su propio subshell (`func &`), así que registra SUS
# categorías dentro de la función y no comparte cola con los demás: una ráfaga de
# GPU no retrasa un cambio en /etc/shadow.
NOTIF_CALMA=4       # segundos sin eventos que cierran el grupo
NOTIF_TOPE=20       # tope con la ventana abierta: una actualización larga no la eterniza
if ! source "$HOME/.config/hypr/scripts/lib/notif-agrupar.sh" 2>/dev/null; then
    # Sin la librería (instalación a medias) se degrada a una notificación por
    # evento, que es el comportamiento anterior: ruidoso, pero nunca silencioso.
    # Misma firma que la librería —<cat> <evento> <urgencia> <timeout> <título> <plural>
    # [prefijo] [sufijo]— o el respaldo leería cada campo corrido una posición y sacaría
    # avisos con el id donde va la urgencia. Que sea un camino que casi nunca se toma no
    # lo salva: se toma justamente cuando la instalación está a medias.
    declare -A _NGF_EV=() _NGF_URG=() _NGF_TMO=() _NGF_TIT=() _NGF_PRE=() _NGF_SUF=()
    notif_grupo()   { _NGF_EV[$1]=$2 _NGF_URG[$1]=$3 _NGF_TMO[$1]=$4 _NGF_TIT[$1]=$5 _NGF_PRE[$1]=${7-} _NGF_SUF[$1]=${8-}; }
    notif_encolar() { notificar "${_NGF_EV[$1]}" -u "${_NGF_URG[$1]}" \
                        "${_NGF_TIT[$1]}" "${_NGF_PRE[$1]}$2${_NGF_SUF[$1]}" -t "${_NGF_TMO[$1]}"; }
    notif_leer()    { local -n _d=$1; IFS= read -r _d; }
    notif_volcar()  { :; }
    notif_pendiente() { return 1; }
    notif_grupo_unico() { :; }   # sin agrupación no hay nada que deduplicar
fi

# ¿Es "lanzable"? Bit de ejecución, tipo de instalador conocido o binario ELF.
# Se usa en monitor_downloads para avisar solo de lo que podrías ejecutar.
is_runnable() {
    local f="$1"
    [[ -f "$f" ]] || return 1
    [[ -x "$f" ]] && return 0
    case "${f,,}" in
        *.appimage|*.run|*.sh|*.bin|*.exe|*.msi|*.deb|*.rpm|*.desktop) return 0 ;;
    esac
    [[ "$(head -c4 "$f" 2>/dev/null)" == $'\x7fELF' ]]
}

# ── Estado de energía (leído del kernel, sin depender de AGS) ──────────────────
# La pila de un PERIFÉRICO no es "el PC va con batería", y confundirlas rompía esto
# en un sobremesa. `/sys/class/power_supply/` no lista solo la batería del portátil:
# aquí el ratón inalámbrico (Logitech G305) aparece como `hidpp_battery_0` y reporta
# `status=Discharging` SIEMPRE — un ratón sin cable siempre tira de su pila. Como las
# dos funciones de abajo recorrían el directorio entero y se quedaban con la primera
# que casara, este sobremesa se creía "a batería" de forma permanente y `_battery_pct`
# devolvía la carga del RATÓN. Con `dlPauseOnBattery` activado eso habría pausado el
# escáner de descargas para siempre, en silencio y sin nada que lo delatara en la UI.
#
# El kernel ya lo distingue: publica `scope=Device` para las pilas de periféricos
# (ratón, teclado, cascos) y `scope=System` —o ningún `scope`, como los BAT0 de
# portátil— para la del equipo. Se filtra también por `type=Battery` para no contar
# el adaptador de corriente (`type=Mains`).
_is_system_battery() {   # $1 = directorio del power_supply
    local dir=$1 scope="" type=""
    [[ -r "$dir/scope" ]] && scope=$(<"$dir/scope")
    [[ "$scope" == Device ]] && return 1          # pila de periférico → no cuenta
    [[ -r "$dir/type" ]] && type=$(<"$dir/type")
    [[ -n "$type" && "$type" != Battery ]] && return 1   # Mains/USB → no es batería
    return 0
}
_on_battery() {   # 0 = con batería (descargando)
    local s
    for s in /sys/class/power_supply/*/status; do
        [[ -r "$s" ]] || continue
        _is_system_battery "${s%/status}" || continue
        [[ "$(<"$s")" == Discharging ]] && return 0
    done
    return 1
}
_battery_pct() {  # imprime el % de la primera batería DEL SISTEMA legible (100 si no hay)
    local c
    for c in /sys/class/power_supply/*/capacity; do
        [[ -r "$c" ]] || continue
        _is_system_battery "${c%/capacity}" || continue
        cat "$c"; return
    done
    echo 100
}

# ¿Debe pausarse el escaneo AUTOMÁTICO de descargas AHORA? Reevalúa condiciones en
# vivo. Los flags de qué-pausa-está-activada (dl_pause_*) los fija _dl_sweep por
# barrido y los ve por ámbito dinámico. Fail-open: si algo no se puede leer, no
# pausa (mejor escanear de más que de menos). El botón de forzado NO llama a esto.
#
# **Sin `jq`, y eso importa por DÓNDE se llama**: además de una vez por barrido, esto se consulta
# cada 2 s durante todo el `clamscan` del lote (ver la Fase B), que dura ~13 s por la recarga de
# firmas. Cada llamada forkeaba uno o dos `jq` sobre ficheros de tres líneas. Leerlos con `read` y
# casar con una expresión regular de bash es el mismo idioma que ya usa `lib/gaming-gate.sh` para
# este mismo fichero, y no cuesta ningún proceso.
_dl_leer() {   # $1 = ruta; imprime el contenido (vacío si no se puede leer)
    local raw=""
    [[ -r "$1" ]] || return 0
    # `read -d ''` sin NUL en el fichero devuelve 1 aunque HAYA leído todo (misma nota que en
    # gaming-gate.sh), así que el código de salida se ignora a propósito.
    IFS= read -r -d '' raw < "$1" 2>/dev/null || true
    printf '%s' "$raw"
}
_dl_paused() {
    local _js
    # Juego: flag que escribe AGS.
    if [[ "${dl_pause_juego:-false}" == true ]]; then
        _js=$(_dl_leer "$RUNTIME_STATE")
        [[ "$_js" =~ \"gaming\"[[:space:]]*:[[:space:]]*true ]] && return 0
    fi
    # Batería / ahorro: solo tiene sentido si estás desenchufado.
    if [[ "${dl_pause_bateria:-false}" == true || "${dl_pause_ahorro:-false}" == true ]] && _on_battery; then
        [[ "${dl_pause_bateria:-false}" == true ]] && return 0
        if [[ "${dl_pause_ahorro:-false}" == true ]]; then
            local pct thr=15
            pct=$(_battery_pct)
            _js=$(_dl_leer "$POWER_CONFIG")
            [[ "$_js" =~ \"thresholdPct\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && thr="${BASH_REMATCH[1]}"
            [[ "$pct" =~ ^[0-9]+$ ]] || pct=100
            (( pct <= thr )) && return 0
        fi
    fi
    return 1
}

# ── Disco: de dónde viene un error de E/S ─────────────────────────────────────
# El kernel nombra el bloque de dos formas en las líneas de error de E/S:
#   Buffer I/O error on dev sdb1, logical block 786432, lost async page write
#   blk_update_request: I/O error, dev sdb, sector 6293504 op 0x1:(WRITE)
# Saca "sdb1"/"sdb" (o nvme0n1p2, mmcblk0p1); vacío si la línea no nombra ninguno.
_io_dev() {
    local pat='(on dev|, dev) ([a-zA-Z0-9_-]+)'
    [[ "$1" =~ $pat ]] && printf '%s' "${BASH_REMATCH[2]}"
}

# Partición → disco padre (sdb1→sdb, nvme0n1p2→nvme0n1). Si el nodo aún existe lo
# resolvemos por sysfs; si el dispositivo YA desapareció (el caso que nos importa)
# no queda symlink que seguir, así que caemos al recorte textual del sufijo.
_disk_base() {
    local d=$1 parent
    [[ -e /sys/block/$d ]] && { printf '%s' "$d"; return; }
    if [[ -e /sys/class/block/$d ]]; then
        parent=$(basename "$(readlink -f "/sys/class/block/$d/..")")
        [[ -e /sys/block/$parent ]] && { printf '%s' "$parent"; return; }
    fi
    case "$d" in
        nvme*|mmcblk*|loop*) printf '%s' "${d%p[0-9]*}" ;;
        *)                   printf '%s' "${d%%[0-9]*}" ;;
    esac
}

# ¿Es un disco interno de verdad? Solo entonces un error de E/S significa "tu disco
# está fallando". Dos negativas, ambas necesarias:
#   - el nodo ya no existe → lo arrancaste en caliente; los errores son el rastro de
#     la escritura pendiente que no llegó, no un disco enfermo.
#   - removable=1 (pendrive, SD) → aunque siga enchufado, no es el disco del sistema.
# El nodo puede sobrevivir unos ms al desconecte (udev aún no lo ha retirado), por eso
# no basta con comprobar la existencia: el flag removable cubre esa carrera.
_disk_is_internal() {
    local base=$1
    [[ -n "$base" && -e /sys/block/$base ]] || return 1
    [[ "$(<"/sys/block/$base/removable" 2>/dev/null)" == 1 ]] && return 1
    return 0
}

# ¿La E/S que falló era una ESCRITURA? Hay que mirarlo antes de decirle a nadie que
# "se quitó con escrituras pendientes", porque esa frase es una afirmación sobre
# sus datos y en la mitad de los casos es falsa. Las dos formas del kernel:
#
#   I/O error, dev sda, sector 6293504 op 0x1:(WRITE)     ← escritura
#   I/O error, dev sda, sector 57945872 op 0x0:(READ)     ← lectura
#   Buffer I/O error on dev sdb1, …, lost async page write ← escritura
#   Buffer I/O error on dev sda1, …, async page read       ← lectura
#
# Caso real que lo motivó: al tirar de un pendrive mientras algo lo estaba LEYENDO
# (un `fsck.exfat -n` lanzado por udisks) salían decenas de "op 0x0:(READ)" y el
# aviso afirmaba que había escrituras sin volcar y que podía haber archivos
# incompletos. No había ninguna: no se había escrito nada.
#
# La ambigüedad se resuelve a favor de NO alarmar: si la línea no dice de qué tipo
# es, se trata como lectura (mensaje suave). Preferimos quedarnos cortos en una
# línea rara a acusar de pérdida de datos que no ha ocurrido.
_io_es_escritura() {
    local l=${1,,}
    [[ "$l" == *"(write)"* || "$l" == *"page write"* || "$l" == *"write error"* ]]
}

# ── Kernel monitor (SOLO kernel, anclado con -k) ──────────────────────────────
monitor_kernel() {
    # Si TODAS las categorías de kernel están desactivadas, no arrancamos el pipe.
    if [[ "$sec_oomKiller" == false && "$sec_kernelPanic" == false && \
          "$sec_hungTask" == false && "$sec_diskError" == false && \
          "$sec_gpuError" == false && "$sec_cpuThrottling" == false && \
          "$sec_hwErrors" == false && "$sec_kernelModules" == false && \
          "$sec_appCrash" == false ]]; then
        return
    fi

    # Cooldown por proceso para no spamear si el mismo binario crashea en bucle
    declare -A _crash_cooldown
    # Íd. por dispositivo de bloque: un disco muriéndose (o un pendrive arrancado a
    # medio escribir) suelta decenas de líneas por segundo, una notificación cada una.
    declare -A _io_cooldown

    # Agrupación por tipo de evento. Los cooldowns de arriba y esto son capas
    # distintas y las dos hacen falta: el cooldown decide QUÉ se encola (un disco
    # agonizando no aporta nada nuevo cada 200 ms), la agrupación decide CÓMO se
    # presenta lo encolado. Sin cooldown, agrupar solo cambiaría "40 popups" por
    # "un popup cada NOTIF_TOPE segundos, para siempre".
    notif_grupo koom      kernel.oom               critical 10000 "OOM Killer"                     "procesos matados por OOM"   "Proceso: "
    notif_grupo khung     kernel.tarea-colgada     critical 15000 "Proceso colgado"                "procesos colgados"
    notif_grupo kdisk     disco.error-es           critical 15000 "Error de disco"                 "errores de disco"
    notif_grupo kusb      usb.extraccion-insegura  normal   12000 "Extracción insegura"            "extracciones inseguras" \
        "Se quitó " " con escrituras pendientes. Puede haber archivos incompletos o el sistema de ficheros marcado como sucio. Expúlsalo antes de retirarlo."
    # Mismo tirón, pero solo se estaba LEYENDO: nada que se haya quedado a medias de
    # escribir, así que no se habla de archivos incompletos. Id. propio para que se
    # pueda silenciar por separado en Ajustes > Notificaciones > Sistema — es el más
    # inocuo de los dos y el candidato natural a molestar.
    notif_grupo kusbr     usb.extraccion-en-lectura normal  10000 "Se retiró mientras se leía"     "dispositivos retirados mientras se leían" \
        "Se quitó " " mientras se leía de él. No había escrituras pendientes, así que no debería faltar nada; lo que estuviera leyéndolo (una copia, una comprobación) se quedó a medias."
    notif_grupo khw       hardware.error           critical 15000 "Error de hardware"              "errores de hardware"
    notif_grupo kmod      kernel.modulo-sin-firmar critical 15000 "Módulo de kernel sin firmar"    "módulos de kernel sin firmar"
    notif_grupo kgpu      gpu.error                critical 15000 "Error GPU"                      "errores de GPU"
    notif_grupo kthrottle cpu.throttling           normal   10000 "CPU Throttling"                 "avisos de CPU throttling"
    notif_grupo kseg      app.crash                critical 15000 "App crasheada"                  "apps crasheadas"            "Proceso: "

    # ¿Este evento es ruido garantizado de una actualización, y no un fallo? Vale para
    # GPU y para módulos del kernel, que son los dos que una actualización de drivers
    # dispara sí o sí: reemplazar el .ko de nvidia bajo una sesión viva produce NVRM
    # *ERROR* a punta pala, y un dkms recompilando produce "loading out-of-tree module".
    # Cubre las dos fases, que son distintas y las dos hacen ruido:
    #   · DURANTE la transacción (pkg_tx_activa).
    #   · DESPUÉS, hasta que reinicies, si la sesión quedó desincronizada — ahí no se
    #     calla y ya está: se avisa UNA vez de que hay que reiniciar y de que por eso
    #     se silencian. Un aviso que explica su propio silencio es honesto; callar sin
    #     decirlo sería quitarle al usuario la única pista de qué está pasando.
    # El resto de eventos del kernel (OOM, E/S, MCE, panic) NO pasan por aquí: una
    # actualización no los provoca, así que si aparecen son de verdad.
    aviso_reinicio=false
    _ruido_de_drivers() {
        pkg_tx_activa && return 0
        pkg_sesion_desincronizada || return 1
        if [[ "$aviso_reinicio" == false ]]; then
            aviso_reinicio=true
            notificar sistema.reinicio-pendiente -u normal "Reinicio pendiente" \
                "Se actualizaron el kernel o los drivers y la sesión sigue con los antiguos. Los errores de GPU y de módulos quedan silenciados hasta que reinicies." \
                -t 20000
        fi
        return 0
    }

    # La tubería va en SEGUNDO PLANO y se espera con `wait`, y no es un capricho de estilo:
    # bash **aplaza las señales mientras espera a un hijo en primer plano**, así que con un
    # `journalctl -kf` delante —que puede bloquearse para siempre— el SIGTERM del `pkill` quedaba
    # pendiente hasta que ese hijo terminara, o sea nunca: el trap no corría y el nieto se
    # quedaba huérfano (ver "Apagado limpio" al final del script). Esperando con `wait`, la
    # señal se atiende al instante. Mismo patrón que el envoltorio `blocking` de
    # updates-monitor.sh, que ya lo documenta para su `inotifywait`.
    trap '_matar_descendientes "$_tuberia" 2>/dev/null; exit 0' TERM INT HUP
    {
        journalctl -kf -n 0 --no-pager 2>/dev/null | while :; do

            notif_leer line; rc=$?
            if (( rc != 0 )); then
                notif_volcar
                (( rc == 2 )) || break   # 1 = se acabó el stream de journalctl
                continue
            fi

            lower="${line,,}"

            # --- OOM killer ---
            if [[ "$sec_oomKiller" != false ]] && \
               [[ "$lower" == *"oom-killer"* || "$lower" == *"out of memory"* || "$lower" == *"killed process"* ]]; then
                process="desconocido"
                pat_killed='Killed process [0-9]+ \(([^)]+)\)'
                pat_kill='Kill process [0-9]+ \(([^)]+)\)'
                pat_invoked='([^[:space:]]+) invoked oom-killer'

                if [[ "$line" =~ $pat_killed ]]; then
                    process="${BASH_REMATCH[1]}"
                elif [[ "$line" =~ $pat_kill ]]; then
                    process="${BASH_REMATCH[1]}"
                elif [[ "$line" =~ $pat_invoked ]]; then
                    process="${BASH_REMATCH[1]} (disparador)"
                fi

                notif_encolar koom "$process"

            # --- Kernel panic ---
            #     ÚNICO evento que NO se agrupa: el sistema se está yendo AHORA y una
            #     ventana de calma de 4 s puede ser más de lo que le queda de vida a la
            #     sesión. Además un panic no llega en ráfaga — llega una vez y ya.
            elif [[ "$sec_kernelPanic" != false ]] && [[ "$lower" == *"kernel panic"* ]]; then
                notificar kernel.panic -u critical "Kernel Panic" "El sistema va a reiniciar" -t 0

            # --- Hung task ---
            elif [[ "$sec_hungTask" != false ]] && \
                 [[ "$lower" == *"hung_task"* || "$lower" == *"blocked for more than"* ]]; then
                notif_encolar khung "$line"

            # --- Error de E/S de disco ---
            #     OJO: no todo "i/o error" es un disco enfermo. Arrancar un pendrive sin
            #     expulsarlo, con escrituras aún en la caché, hace que el kernel escupa un
            #     "Buffer I/O error on dev sdb1 … lost async page write" por cada página que
            #     no llegó — antes cada una de ellas era una crítica "Error de disco".
            #     (Por eso solo pasaba al MOVER archivos: sin nada sucio pendiente, no hay
            #     writeback que fallar y el kernel no loguea nada.) Clasificamos por
            #     dispositivo antes de alarmar.
            elif [[ "$sec_diskError" != false ]] && [[ "$lower" == *"i/o error"* ]]; then
                _dev=$(_io_dev "$line")
                _base=$(_disk_base "$_dev")
                _now=$(date +%s)

                # El cooldown se lleva por dispositivo Y POR TIPO: una extracción en
                # caliente a mitad de una copia suelta lecturas y escrituras fallidas
                # entremezcladas, y con una sola clave la primera línea que llegase
                # (normalmente una lectura, que es lo que más readahead genera) se
                # comía los 30 s y ocultaba las escrituras, que son las que sí
                # importan. Son dos hechos distintos sobre el mismo tirón.
                if _io_es_escritura "$line"; then _tipo=w; else _tipo=r; fi
                _key="${_base:-desconocido}:$_tipo"

                if (( _now - ${_io_cooldown[$_key]:-0} >= 30 )); then
                    _io_cooldown[$_key]=$_now
                    if [[ -z "$_base" ]] || _disk_is_internal "$_base"; then
                        # Disco interno (o línea que no nombra dispositivo → no la tragamos).
                        notif_encolar kdisk "$line"
                    elif [[ "$_tipo" == w ]]; then
                        # Extraíble con escrituras perdidas: aviso de datos, no de hardware.
                        notif_encolar kusb "$_dev"
                    else
                        # Extraíble, pero solo se leía: nada que se haya perdido.
                        notif_encolar kusbr "$_dev"
                    fi
                fi

            # --- Hardware error (MCE / ECC / EDAC) ---
            elif [[ "$sec_hwErrors" != false ]] && \
                 [[ "$lower" == *"machine check"* || "$lower" == *"mce:"* || \
                    "$lower" == *"hardware error"* || "$lower" == *"edac"* || \
                    "$lower" == *"memory error"* ]]; then
                notif_encolar khw "$line"

            # --- Módulo de kernel sin firmar / fuera del árbol (posible rootkit) ---
            elif [[ "$sec_kernelModules" != false ]] && \
                 [[ "$lower" == *"tainting kernel"* || "$lower" == *"module verification failed"* || \
                    "$lower" == *"loading out-of-tree module"* || "$lower" == *"unsigned module"* ]]; then
                _ruido_de_drivers || notif_encolar kmod "$line"

            # --- GPU / NVIDIA error ---
            elif [[ "$sec_gpuError" != false ]] && \
                 [[ "$lower" == *"nvrm"* || \
                    ( "$lower" == *"nvidia"* && "$lower" == *"error"* ) || \
                    ( "$lower" == *"gpu"* && "$lower" == *"error"* ) ]]; then
                _ruido_de_drivers || notif_encolar kgpu "$line"

            # --- CPU throttling ---
            elif [[ "$sec_cpuThrottling" != false ]] && [[ "$lower" =~ cpu.*throttl ]]; then
                notif_encolar kthrottle "$line"

            # --- App crash: segfault ---
            elif [[ "$sec_appCrash" != false ]] && [[ "$lower" == *"segfault"* ]]; then
                # Una app que revienta mientras actualizas casi siempre es la actualización
                # cambiándole las .so bajo los pies (el proceso vivo sigue mapeando las
                # viejas). Se descarta ANTES del cooldown para no gastarlo en un crash que
                # no se va a notificar y perder así el siguiente, que sí sería real.
                pkg_tx_activa && continue
                app="desconocida"
                pat_seg='kernel: ([^[]+)\[[0-9]+\]: segfault'
                [[ "$line" =~ $pat_seg ]] && app="${BASH_REMATCH[1]}"
                _now=$(date +%s)
                if (( _now - ${_crash_cooldown[$app]:-0} >= 10 )); then
                    _crash_cooldown[$app]=$_now
                    notif_encolar kseg "$app (segfault)"
                fi

            fi
        done
    } &
    _tuberia=$!
    wait "$_tuberia"
}

# ── System / auth monitor (filtrado por identificador) ────────────────────────
monitor_system() {
    if [[ "$sec_serviceFailure" == false && "$sec_sudoAuth" == false && \
          "$sec_ssh" == false && "$sec_appCrash" == false && \
          "$sec_privEsc" == false && "$sec_serviceHealth" == false ]]; then
        return
    fi

    declare -A _crash_cooldown
    declare -a _coredump_times=()   # ventana deslizante para detectar tormentas
    _storm_last=0

    # Agrupación. Aquí la ráfaga típica no es un fallo de hardware sino un ataque o
    # un servicio en bucle: un SSH expuesto recibe cientos de "Failed password" por
    # minuto y un `systemd` con una unidad rota reintenta cada pocos segundos. El
    # aviso de sudo NO lleva dato variable a propósito (no se filtra la línea del
    # journal), así que encola texto vacío y lo que informa es el recuento.
    notif_grupo ssvc     servicio.fallo-arranque      normal   10000 "Servicio fallido"              "servicios fallidos"
    notif_grupo ssudo    sudo.fallo-autenticacion     critical 15000 "Fallo sudo"                    "fallos de sudo" "Intento fallido de sudo"
    notif_grupo spriv    seguridad.escalada-privilegios critical 15000 "Escalada de privilegios"       "escaladas de privilegios"
    notif_grupo sssh     ssh.evento                   normal   15000 "SSH"                           "eventos SSH"
    notif_grupo score    app.crash                    critical 15000 "App crasheada"                 "apps crasheadas" "Proceso: "

    # -t restringe a los identificadores que nos interesan → menos volumen y sin
    # falsos positivos de apps que casualmente logueen "failed to start", etc.
    # La tubería va en SEGUNDO PLANO y se espera con `wait`, y no es un capricho de estilo:
    # bash **aplaza las señales mientras espera a un hijo en primer plano**, así que con un
    # `journalctl -f` delante —que puede bloquearse para siempre— el SIGTERM del `pkill` quedaba
    # pendiente hasta que ese hijo terminara, o sea nunca: el trap no corría y el nieto se
    # quedaba huérfano (ver "Apagado limpio" al final del script). Esperando con `wait`, la
    # señal se atiende al instante. Mismo patrón que el envoltorio `blocking` de
    # updates-monitor.sh, que ya lo documenta para su `inotifywait`.
    trap '_matar_descendientes "$_tuberia" 2>/dev/null; exit 0' TERM INT HUP
    {
        journalctl -f -n 0 --no-pager \
            -t sudo -t sshd -t su -t pkexec -t polkitd -t systemd -t systemd-coredump 2>/dev/null |
        while :; do

            notif_leer line; rc=$?
            if (( rc != 0 )); then
                notif_volcar
                (( rc == 2 )) || break   # 1 = se acabó el stream de journalctl
                continue
            fi

            lower="${line,,}"

            # --- Systemd service failure ---
            if [[ "$sec_serviceFailure" != false ]] && [[ "$lower" == *"failed to start"* ]]; then
                # Una actualización reinicia units con los binarios a medio reemplazar: los
                # "failed to start" de esos segundos son del proceso de actualización, no
                # del servicio. Lo que siga roto DESPUÉS lo caza monitor_units, que mira
                # estado y no flanco — así que esto se descarta, no se pierde.
                pkg_tx_activa || notif_encolar ssvc "$line"

            # --- Sudo auth failure ---
            elif [[ "$sec_sudoAuth" != false ]] && \
                 [[ "$lower" == *"sudo"* && \
                    ( "$lower" == *"authentication failure"* || "$lower" == *"incorrect password"* ) ]]; then
                notif_encolar ssudo ""

            # --- Escalada de privilegios (pkexec / su / polkit) ---
            #     pkexec emite DOS líneas por escalada: la de PAM ("session opened",
            #     que NO dice qué se ejecuta) y la de "Executing command [...]
            #     [COMMAND=…]". Ninguna de las dos avisa: un pkexec con COMMAND= es una
            #     escalada que el propio usuario acaba de autorizar metiendo su
            #     contraseña en el diálogo de polkit — no es una señal de nada
            #     sospechoso, así que notificarla solo enseña a ignorar la categoría
            #     (era el mismo ruido que antes motivaba una allowlist ad-hoc para
            #     GameMode; ahora sobra porque TODA escalada autenticada calla).
            #     Lo que sigue vigilando esta rama es la escalada que NO pasó por una
            #     contraseña válida: un pkexec DENEGADO no abre sesión PAM ni loguea
            #     COMMAND=, pero sí "Not authorized", que esta rama capta; igual que
            #     los fallos de autenticación de `su` y de polkit.
            elif [[ "$sec_privEsc" != false ]] && \
                 [[ "$lower" == *"pkexec"* || \
                    ( "$lower" == *"(su:auth)"* && "$lower" == *"authentication failure"* ) || \
                    ( "$lower" == *"polkit"* && "$lower" == *"failed to authenticate"* ) ]]; then

                if [[ "$lower" == *"pkexec"* ]]; then
                    [[ "$lower" == *"pam_unix(polkit-1:session)"* ]] && continue
                    # COMMAND= presente → autenticación correcta, callar.
                    [[ "$line" == *"[COMMAND="* ]] && continue
                fi

                notif_encolar spriv "$line"

            # --- SSH events ---
            elif [[ "$sec_ssh" != false ]] && \
                 [[ "$lower" == *"sshd"* && \
                    ( "$lower" == *"failed password"* || "$lower" == *"accepted"* ) ]]; then
                notif_encolar sssh "$line"

            # --- App crash: coredump (systemd-coredump, userspace) ---
            #     La notificación por-app va bajo appCrash; la detección de "tormenta"
            #     (varios coredumps en <60s) va bajo serviceHealth. Procesamos la línea
            #     si CUALQUIERA de los dos está activo.
            elif [[ "$sec_appCrash" != false || "$sec_serviceHealth" != false ]] && \
                 [[ "$lower" == *"coredump"* && \
                    ( "$lower" == *"dumped core"* || "$lower" == *"terminated abnormally"* ) ]]; then
                app="desconocida"
                # Mismo caso que el segfault de monitor_kernel: reemplazar bibliotecas bajo
                # procesos vivos los tumba en cascada, y esa cascada dispararía además la
                # "tormenta de crashes" (3 volcados en 60 s) con un crítico sin autocierre.
                pkg_tx_activa && continue
                pat_core='Process [0-9]+ \(([^)]+)\)'
                [[ "$line" =~ $pat_core ]] && app="${BASH_REMATCH[1]}"
                _now=$(date +%s)

                if [[ "$sec_appCrash" != false ]] && (( _now - ${_crash_cooldown[$app]:-0} >= 10 )); then
                    _crash_cooldown[$app]=$_now
                    notif_encolar score "$app (coredump)"
                fi

                if [[ "$sec_serviceHealth" != false ]]; then
                    _coredump_times+=("$_now")
                    pruned=()
                    for t in "${_coredump_times[@]}"; do (( _now - t < 60 )) && pruned+=("$t"); done
                    _coredump_times=("${pruned[@]}")
                    if (( ${#_coredump_times[@]} >= 3 )) && (( _now - _storm_last >= 60 )); then
                        _storm_last=$_now
                        notificar app.tormenta-crashes -u critical "Tormenta de crashes" \
                            "${#_coredump_times[@]} volcados de core en <60s. Algo va muy mal." -t 0
                    fi
                fi

            fi
        done
    } &
    _tuberia=$!
    wait "$_tuberia"
}

# ── ¿Hay una transacción de paquetes en curso? ────────────────────────────────
# Una actualización del sistema REESCRIBE medio /etc por diseño: `pacman -Syu` deja
# `.pacnew` en /etc/pam.d, reinstala units en /etc/systemd/system, toca /etc/passwd
# vía sysusers y renueva kernel+initramfs en /boot. Eso no es persistencia de un
# atacante: es el gestor de paquetes haciendo su trabajo, autenticado por el propio
# usuario segundos antes. Avisarlo como "Posible persistencia" con `-t 0` durante
# una actualización larga entierra la pantalla en tarjetas críticas que el usuario
# aprende a cerrar sin leer — y el día que una SÍ importe, la cerrará igual.
#
# Se detecta por el LOCK del gestor, no por el proceso: `/var/lib/pacman/db.lck`
# existe exactamente mientras dura la transacción (incluidos los hooks post-install,
# que es cuando llegan la mayoría de los eventos) y comprobarlo es un `stat`, barato
# de hacer por evento. Para los gestores cuyo lock es un fichero PERMANENTE que se
# bloquea con flock (dpkg) el `-e` no serviría, así que ahí se cae a un `pgrep`
# limitado a una vez cada 2 s (esta máquina es Arch/CachyOS; el resto es cortesía).
#
# GRACIA posterior: `paru`/`yay` sueltan y retoman el lock entre la fase de repos y
# la del AUR, y hay hooks (dkms, mkinitcpio disparado aparte) que escriben justo
# después de liberarlo. Sin margen, ese hueco de segundos volvía a disparar la
# avalancha. Es una ventana ciega de PKG_GRACIA segundos tras cada operación de
# paquetes, aceptada a sabiendas: quien puede lanzar pacman como root ya no necesita
# esconder nada de /etc, y a cambio la alerta vuelve a significar algo.
PKG_LOCKS=(/var/lib/pacman/db.lck)
# `pgrep -x` ancla el patrón al NOMBRE completo del proceso (sin -f: la línea de
# órdenes de un `sudo apt install …` no casaría con un nombre suelto).
PKG_PROCS='apt|apt-get|aptitude|dpkg|unattended-upgr|dnf|dnf5|zypper|rpm'
PKG_GRACIA=90       # segundos de margen tras soltarse el lock
PKG_CALMA=30        # ventana de calma ANCHA mientras dura la actualización (ver monitor_files)
PKG_TOPE=900        # tope de esa ventana: una actualización larga cabe entera en un resumen
_pkg_hasta=0        # epoch hasta el que se sigue considerando "en actualización"
_pkg_pgrep_ts=0     # última vez que se consultó pgrep (limitador de ráfaga)
_pkg_pgrep_res=1    # último veredicto de pgrep (0 = había gestor corriendo)
pkg_tx_activa() {
    local ahora l
    printf -v ahora '%(%s)T' -1
    for l in "${PKG_LOCKS[@]}"; do
        [[ -e "$l" ]] || continue
        _pkg_hasta=$(( ahora + PKG_GRACIA ))
        return 0
    done
    if (( ahora - _pkg_pgrep_ts >= 2 )); then
        _pkg_pgrep_ts=$ahora
        pgrep -x "$PKG_PROCS" >/dev/null 2>&1 && _pkg_pgrep_res=0 || _pkg_pgrep_res=1
    fi
    if (( _pkg_pgrep_res == 0 )); then
        _pkg_hasta=$(( ahora + PKG_GRACIA ))
        return 0
    fi
    (( ahora < _pkg_hasta ))
}

# ── ¿La sesión corre con drivers distintos a los que hay instalados? ──────────
# La ventana de la transacción NO basta para la GPU, y por eso hace falta esto: al
# actualizar `nvidia`/`linux` los .ko del disco se reemplazan pero el módulo cargado
# sigue siendo el viejo hasta que reinicias. A partir de ahí, cada vez que algo toca
# la GPU el kernel escupe NVRM/`nvidia_drm` *ERROR* — durante horas, mucho después de
# que pacman haya terminado. Es exactamente el aviso de la captura del usuario, y no
# es un fallo de hardware: es una sesión desincronizada que se arregla reiniciando.
#
# Dos comprobaciones, las dos baratas y sin depender del gestor de paquetes:
#   · `/usr/lib/modules/$(uname -r)` desaparecido → el paquete del kernel en ejecución
#     ya no está instalado (el árbol de módulos se fue con él).
#   · versión de nvidia EN EJECUCIÓN (`/sys/module/nvidia/version`) distinta de la del
#     .ko EN DISCO (`modinfo -F version nvidia`).
# Sin nvidia cargado (AMD/Intel) la segunda no aplica y no inventa un desajuste.
#
# Una vez detectado, NO se vuelve a mirar: sin reiniciar no puede dejar de ser cierto,
# y así el caso caro (dos forks) se paga como mucho una vez por minuto y solo hasta
# que da positivo.
PKG_DESYNC_TTL=60
_pkg_desync=-1      # -1 = sin calcular, 0 = desincronizada, 1 = al día
_pkg_desync_ts=0
pkg_sesion_desincronizada() {
    local ahora ejecutando disco
    (( _pkg_desync == 0 )) && return 0
    printf -v ahora '%(%s)T' -1
    if (( _pkg_desync == -1 || ahora - _pkg_desync_ts >= PKG_DESYNC_TTL )); then
        _pkg_desync_ts=$ahora
        _pkg_desync=1
        [[ -d "/usr/lib/modules/$(uname -r)" ]] || _pkg_desync=0
        if (( _pkg_desync == 1 )) && [[ -r /sys/module/nvidia/version ]]; then
            ejecutando=$(</sys/module/nvidia/version)
            disco=$(modinfo -F version nvidia 2>/dev/null)
            [[ -n "$disco" && "$disco" != "$ejecutando" ]] && _pkg_desync=0
        fi
    fi
    (( _pkg_desync == 0 ))
}

# ── File integrity monitor ────────────────────────────────────────────────────
# Se vigilan los DIRECTORIOS padre y se filtra por nombre: así se detectan también
# los reemplazos atómicos (write-temp + rename) que hacen passwd/visudo/editores,
# que un watch sobre el inodo del archivo se perdería. Cubre configs de auth,
# claves SSH y los sitios típicos de persistencia (systemd, autostart, cron).
#
# Los eventos se AGRUPAN antes de notificar (lib/notif-agrupar.sh): un solo
# `pacman -Syu` toca decenas de rutas vigiladas en segundos, y una notificación
# por fichero —todas críticas y con `-t 0`, o sea sin autocierre— era una avalancha
# que se despacha cerrándolas en bloque sin leer ninguna: el mismo efecto que
# desactivar la categoría entera.
monitor_files() {
    [[ "$sec_fileIntegrity" == false ]] && return

    if ! command -v inotifywait &>/dev/null; then
        notificar monitor.sin-inotify -u normal "oom-monitor" \
            "inotify-tools no instalado. Vigilancia de archivos desactivada." -t 10000
        return
    fi

    # inotifywait ABORTA entero si no puede vigilar UNA sola ruta, así que solo
    # añadimos las que el usuario puede vigilar de verdad: existentes y con permiso
    # de lectura+ejecución sobre el directorio (-r -x). Esto excluye dirs root-only
    # como /etc/sudoers.d (750 root) o /boot (700) cuando corremos sin privilegios
    # — no se puede vigilar lo que el kernel no nos deja ver. La vigilancia del
    # propio /etc (755) sí capta modificaciones de /etc/passwd, sudoers, shadow…
    # porque el evento se entrega a nivel de directorio (no hace falta leer el
    # fichero). Las subcarpetas root-only quedan sin cubrir sin ejecutar como root.
    local watch_paths=()
    local d
    for d in /etc /etc/pam.d /etc/sudoers.d /etc/ssh /etc/cron.d /etc/systemd/system \
             /boot "$HOME/.ssh" "$HOME/.config/autostart" "$HOME/.config/systemd/user"; do
        [[ -d "$d" && -r "$d" && -x "$d" ]] && watch_paths+=("$d")
    done
    [[ ${#watch_paths[@]} -gt 0 ]] || return

    # Un mismo cambio genera DOS eventos (create + close_write) sobre la misma
    # ruta: la deduplicación de la librería los colapsa en uno.
    notif_grupo fcrit    archivos.critico-modificado critical 0     "Archivo crítico modificado"         "archivos críticos modificados"   "Archivo: "
    notif_grupo fpersist archivos.persistencia       critical 0     "Posible persistencia"               "cambios de posible persistencia" "Nuevo/modificado: "
    notif_grupo fssh     archivos.clave-ssh          critical 0     "Clave SSH autorizada modificada"    "cambios en claves SSH autorizadas" "Archivo: "
    notif_grupo fboot    archivos.boot               normal   15000 "Cambio en /boot"                    "cambios en /boot"                "Archivo: " " (kernel/initramfs)"
    # Durante una actualización de paquetes los tres grupos de arriba se desvían a
    # este, que es informativo y se autocierra (ver pkg_tx_activa). No se callan del
    # todo a propósito: si algo tocó /etc mientras actualizabas, sigue constando.
    notif_grupo fpkg     archivos.actualizacion      low      15000 "Actualización del sistema"          "archivos de sistema actualizados" "Archivo: "
    # Un cambio = create + close_write: la misma ruta dos veces es UN cambio, no dos.
    notif_grupo_unico fcrit; notif_grupo_unico fpersist
    notif_grupo_unico fssh;  notif_grupo_unico fboot
    notif_grupo_unico fpkg

    # Ventana de agrupación: la normal, y la ANCHA que se usa mientras dura una
    # actualización. Con la normal (calma 4 s / tope 20 s) un `pacman -Syu` de tres
    # minutos escupiría un resumen cada 20 s — quince tarjetas en vez de una. Con la
    # ancha sale UNA al terminar, ~30 s después del último fichero tocado. Ojo al
    # efecto colateral: la ventana es de TODAS las categorías de este bucle, así que
    # un cambio en `authorized_keys` justo mientras actualizas —lo único que NO se
    # desvía a fpkg— avisa hasta PKG_CALMA segundos tarde. Se acepta: llega igual, y
    # el aviso sirve para enterarse, no para interrumpir el ataque en curso.
    local calma_base=$NOTIF_CALMA tope_base=$NOTIF_TOPE en_tx=false
    # Nested a propósito: ve `en_tx`/`calma_base` por ámbito dinámico, igual que
    # _dl_sweep en monitor_downloads.
    _ventana_paquetes() {
        if pkg_tx_activa; then
            [[ "$en_tx" == true ]] && return 0
            en_tx=true;  NOTIF_CALMA=$PKG_CALMA;  NOTIF_TOPE=$PKG_TOPE
        else
            [[ "$en_tx" == false ]] && return 0
            en_tx=false; NOTIF_CALMA=$calma_base; NOTIF_TOPE=$tope_base
        fi
        return 0
    }

    local path rc
    # La tubería va en SEGUNDO PLANO y se espera con `wait`, y no es un capricho de estilo:
    # bash **aplaza las señales mientras espera a un hijo en primer plano**, así que con un
    # `inotifywait -m` delante —que puede bloquearse para siempre— el SIGTERM del `pkill` quedaba
    # pendiente hasta que ese hijo terminara, o sea nunca: el trap no corría y el nieto se
    # quedaba huérfano (ver "Apagado limpio" al final del script). Esperando con `wait`, la
    # señal se atiende al instante. Mismo patrón que el envoltorio `blocking` de
    # updates-monitor.sh, que ya lo documenta para su `inotifywait`.
    trap '_matar_descendientes "$_tuberia" 2>/dev/null; exit 0' TERM INT HUP
    {
        inotifywait -m -e close_write,moved_to,create --format '%w%f' \
            "${watch_paths[@]}" 2>/dev/null |
        while :; do
            notif_leer path; rc=$?
            if (( rc != 0 )); then
                notif_volcar
                (( rc == 2 )) || break   # 1 = se acabó el stream de inotifywait
                _ventana_paquetes        # volcado hecho: si la actualización acabó, ventana normal
                continue
            fi

            # Artefactos del gestor de paquetes: NUNCA son el evento. Un `.pacnew` es un
            # fichero de referencia que pacman deja al lado del tuyo justamente para NO
            # tocar el activo — avisar de él como "posible persistencia" es exactamente
            # al revés de lo que significa. Se descartan pase lo que pase (llegan también
            # fuera de la ventana de la transacción, p. ej. al hacer `pacdiff` después).
            case "$path" in
                *.pacnew|*.pacsave|*.pacorig|*.pacsave.[0-9]|\
                *.dpkg-new|*.dpkg-dist|*.dpkg-old|*.dpkg-tmp|\
                *.rpmnew|*.rpmsave|*.rpmorig|*~)
                    continue ;;
            esac

            _ventana_paquetes
            if [[ "$en_tx" == true ]]; then
                case "$path" in
                    # Las claves SSH del usuario NO las escribe ningún paquete: si cambian
                    # en mitad de una actualización, sigue siendo la alerta crítica de
                    # siempre. Todo lo demás (/etc, /boot, units) es el gestor trabajando.
                    "$HOME"/.ssh/authorized_keys|"$HOME"/.ssh/authorized_keys2)
                        notif_encolar fssh "$path"; continue ;;
                    *)
                        notif_encolar fpkg "$path"; continue ;;
                esac
            fi

            case "$path" in
                /etc/passwd|/etc/shadow|/etc/group|/etc/gshadow|/etc/hosts|/etc/sudoers|/etc/ld.so.preload|/etc/ssh/sshd_config)
                    notif_encolar fcrit "$path" ;;
                /etc/sudoers.d/*|/etc/pam.d/*|/etc/cron.d/*|/etc/systemd/system/*|"$HOME"/.config/autostart/*|"$HOME"/.config/systemd/user/*)
                    notif_encolar fpersist "$path" ;;
                "$HOME"/.ssh/authorized_keys|"$HOME"/.ssh/authorized_keys2)
                    notif_encolar fssh "$path" ;;
                /boot/*)
                    notif_encolar fboot "$path" ;;
            esac
        done
    } &
    _tuberia=$!
    wait "$_tuberia"
}

# ── Disk health monitor (SMART, polling) ──────────────────────────────────────
# smartctl suele necesitar privilegios para leer los datos SMART. Si no puede
# (falta el binario o no hay permisos), avisa UNA vez y deja de intentarlo. La
# salud SMART cambia despacio → sondeo cada hora. `-H` da el veredicto global y
# `-A` con WHEN_FAILED=FAILING_NOW cubre atributos pre-fail cayendo ahora mismo.
monitor_smart() {
    [[ "$sec_diskHealth" == false ]] && return
    command -v smartctl >/dev/null 2>&1 || return
    command -v lsblk >/dev/null 2>&1 || return

    # Consultar SMART a cada disco despierta el hardware y no corre prisa: el sondeo
    # es horario, así que llegar 45 s tarde solo desplaza el primero. Ver DELAY_*.
    sleep "$DELAY_SMART"

    local warned_perm=false
    declare -A _smart_notified
    local disk dev report

    while :; do
        # Consultar SMART DESPIERTA cada disco físico; con un juego delante eso es un
        # tirón por nada, y la salud de un disco es exactamente igual de mala 20 min
        # después. Retiene, no salta: la pasada se hace al cerrar el juego.
        gaming_gate_wait smart

        while read -r disk; do
            [[ -z "$disk" ]] && continue
            dev="/dev/$disk"
            report=$(smartctl -H -A "$dev" 2>/dev/null)
            if [[ -z "$report" ]]; then
                if [[ "$warned_perm" == false ]]; then
                    warned_perm=true
                    notificar disco.smart-sin-permisos -u normal "Salud de disco" \
                        "smartctl no puede leer SMART (¿faltan privilegios?)." -t 10000
                fi
                continue
            fi
            if grep -qiE 'result:[[:space:]]*FAILED|FAILING_NOW' <<< "$report"; then
                if [[ -z "${_smart_notified[$dev]:-}" ]]; then
                    _smart_notified[$dev]=1
                    notificar disco.smart-fallo -u critical "Disco a punto de fallar" \
                        "$dev: SMART reporta fallo inminente. Haz copia de seguridad YA." -t 0
                fi
            fi
        done < <(lsblk -dno NAME,TYPE 2>/dev/null | awk '$2=="disk" && $1 !~ /^(zram|loop|ram|dm-|sr)/{print $1}')
        sleep 3600
    done
}

# ── Service health monitor (unidades en estado failed, polling) ───────────────
# Más amplio que "failed to start": detecta unidades que caen en failed en
# CUALQUIER momento (watchdog, crash tras arrancar, OOM del servicio…), tanto del
# bus de sistema como del de usuario. La primera pasada solo siembra el estado,
# para no notificar los fallos preexistentes al arrancar (criterio de -n 0).
monitor_units() {
    [[ "$sec_serviceHealth" == false ]] && return
    command -v systemctl >/dev/null 2>&1 || return

    # La primera pasada SOLO siembra `_known` (no notifica, para no avisar de fallos
    # preexistentes), así que retrasarla no retrasa ni un aviso: lo que se aparta del
    # arranque es literalmente trabajo que no informa de nada. Ver DELAY_*.
    sleep "$DELAY_UNITS"

    declare -A _known
    local seeded=false unit scope flag current

    # Aquí la ráfaga no necesita ventana de tiempo: la PASADA es el lote. Tras un
    # apagón sucio o una actualización caen varias unidades a la vez y `systemctl
    # --failed` las devuelve todas en el mismo barrido, así que se encolan durante
    # la pasada y se vuelcan al terminarla — sin retrasar nada ni un segundo.
    notif_grupo unit servicio.en-fallo critical 15000 "Servicio en fallo"    "servicios en fallo" "Unidad: "

    while :; do
        # Se congela mientras juegas, pero SOLO una vez sembrado, y esa condición no
        # sobra: `systemctl --failed` es estado de NIVEL, no de flanco, así que una
        # unidad que caiga durante la partida sigue estando en la lista al reanudar y
        # se avisa entonces (solo se pierde la que caiga Y se recupere dentro del
        # juego). Pero si el gate atrapara la PRIMERA pasada, todo lo que hubiera
        # fallado durante esas horas se sembraría como "preexistente" y no se
        # notificaría NUNCA. La siembra son 4 forks una sola vez: congelarla no
        # ahorra nada y cuesta avisos.
        [[ "$seeded" == true ]] && gaming_gate_wait units

        # Durante una actualización las units caen y se levantan sin parar. Se SALTA la
        # pasada entera en vez de filtrar el aviso, y la diferencia importa: al no tocar
        # `_known`, una unidad que quede rota no se siembra como "ya conocida" y la
        # siguiente pasada —ya con la actualización terminada— la reporta como nueva.
        # Filtrar solo el aviso la habría enterrado para siempre.
        if pkg_tx_activa; then
            sleep 120
            continue
        fi

        current=""
        for scope in system user; do
            flag=""
            [[ "$scope" == user ]] && flag="--user"
            while read -r unit; do
                [[ -z "$unit" ]] && continue
                current+="$scope/$unit"$'\n'
                if [[ "$seeded" == true && -z "${_known[$scope/$unit]:-}" ]]; then
                    notif_encolar unit "$unit ($scope)"
                fi
                _known["$scope/$unit"]=1
            done < <(systemctl $flag --failed --no-legend --plain 2>/dev/null | awk '{print $1}')
        done
        # Olvida las unidades ya recuperadas, para volver a avisar si recaen.
        for unit in "${!_known[@]}"; do
            grep -qxF "$unit" <<< "$current" || unset "_known[$unit]"
        done
        notif_volcar        # lote = pasada; con la cola vacía no hace nada
        seeded=true
        sleep 120
    done
}

# ── Download scanner (~/Downloads, sondeo recursivo) ──────────────────────────
# Hace DOS cosas sobre la carpeta de descargas:
#   1) AVISA de ejecutables nuevos (AppImage, .run, .exe para Wine, binarios +x…)
#      —"Mark of the Web"— para que los verifiques antes de lanzarlos.
#   2) ANALIZA con ClamAV TODOS los archivos nuevos (no solo ejecutables): un
#      virus puede venir en un .com, un documento, dentro de un instalador, etc.
#      Sin esto, algo como el fichero de prueba EICAR (.com, sin +x) no se miraba.
#
# Usa un BARRIDO recursivo con find (NO inotify): `inotifywait -r` no vigila las
# subcarpetas creadas después de arrancar, y el caso típico —descargar un .rar/
# .zip y extraerlo a una carpeta nueva— caía justo en ese punto ciego. El sondeo
# ve cualquier archivo a cualquier profundidad, sin importar cuándo apareció. El
# bucle corre CADA 30 s durante toda la sesión (no solo al arrancar).
#
# ── Deduplicación por CONTENIDO (no por ruta) ─────────────────────────────────
# El esquema viejo (clave ruta|tamaño, append-only, permanente) tenía un fallo
# grave: una vez visto un fichero NO se volvía a analizar JAMÁS, ni tras borrarlo
# y recrearlo, ni tras reiniciar (el estado persistía). Y como no miraba el
# contenido, reemplazar un fichero por otro DISTINTO del mismo tamaño pasaba
# desapercibido. Ahora hay dos estados en ~/.cache/gigios/:
#   • download-index  (mtime|tamaño|ruta por fichero existente) — memo BARATO para
#     saltarse en cada pasada lo que no ha cambiado sin volver a hashear. Se PODA
#     a los ficheros que existen ahora, así no crece sin control.
#   • download-hashes (un hash xxh64 por contenido ya analizado) — memoria de
#     "esto ya lo miré". PERSISTE aunque borres el fichero.
# Regla resultante (justo lo pedido): si el memo mtime|tamaño coincide → no se
# toca. Si cambió (fichero nuevo, editado, o borrado+recreado con otra fecha) se
# calcula el hash del contenido: si ese hash YA se analizó → NO se re-analiza
# (mismo contenido); si es un hash nuevo → SÍ se analiza. Reemplazar por contenido
# distinto = hash distinto = se analiza. Recrear el mismo fichero = mismo hash =
# no se re-analiza. La primera vez (sin estado) siembra sin avisar de ejecutables
# pero SÍ analiza con ClamAV todo lo existente (una alerta de malware no es spam).
#
# ── Recursos, pausas e higiene (ver docs/superpowers/specs/2026-07-11-*) ──────
#   • PRIORIDAD: hashing y ClamAV van bajo `nice -n19 ionice -c3` (idle): ceden
#     CPU/IO ante todo lo demás.
#   • PAUSAS (leídas de security.json EN CADA BARRIDO, sin reiniciar): dlPause
#     InPowerSave / OnBattery / WhileGaming. _dl_paused evalúa en vivo la batería
#     (/sys) y el flag de juego (runtime-state.json que escribe AGS). Si alguna
#     activada está activa → el barrido difiere TODO (no marca nada → se recoge al
#     reanudar). Tope de tamaño dlMaxScanGB también en vivo.
#   • INTERRUMPIBLE: clamscan recarga ~200 MB de firmas por llamada (~13 s), así
#     que NO se trocea. Se lanza UN clamscan sobre todo el lote en 2º plano y se
#     vigila la pausa: si cambia la condición se MATA (latencia ~2 s) y NO se marca
#     nada → el lote se reescanea al reanudar; si termina, se marca todo.
#   • DESCARGAS A MEDIAS: se ignoran los temporales de navegador/gestor (.part,
#     .crdownload, .aria2, .!qB…) Y su nombre base, y todo lo modificado hace
#     <15 s (aún escribiéndose). Un fichero movido fuera a mitad se salta.

# Aviso de un único ejecutable nuevo (con botón "Lanzar aislado" si procede).
download_alert() {
    local f="$1"
    if [[ "$sec_sandboxLaunch" != false && -x "$RUN_UNTRUSTED" ]]; then
        # notify-send --wait -A bloquea hasta el clic/cierre → subshell en 2º plano.
        ( act=$(notificar descargas.ejecutable-nuevo -a "Seguridad" --wait -t 45000 \
            -A "launch=Lanzar aislado" -u normal \
            "Ejecutable nuevo en Descargas" \
            "$(basename "$f") — verifícalo antes de lanzarlo.")
          [[ "$act" == "launch" ]] && "$RUN_UNTRUSTED" "$f" ) &
    else
        notificar descargas.ejecutable-nuevo -u normal "Ejecutable nuevo en Descargas" \
            "$(basename "$f") — verifícalo antes de lanzarlo." -t 12000
    fi
}

monitor_downloads() {
    [[ "$sec_downloadScan" == false ]] && return
    command -v find >/dev/null 2>&1 || return

    # El más caro del arranque: el primer `_dl_sweep` recorre Descargas entera y, ante
    # cualquier fichero nuevo, lo hashea y lo pasa por ClamAV — que recarga ~200 MB de
    # firmas en CADA invocación. Con el estado ya sembrado de sesiones anteriores el
    # barrido acierta en el memo y sale barato, pero el caso malo (una descarga nueva
    # desde el último login) coincidía de lleno con la carga del escritorio. No se
    # pierde nada: `find` ve el fichero igual dentro de un minuto. Ver DELAY_*.
    sleep "$DELAY_DOWNLOADS"

    # Carpeta de descargas locale-aware (aquí es ~/Descargas, no ~/Downloads).
    # xdg-user-dir devuelve $HOME si no está configurada → lo tratamos como vacío.
    local dir="" cand
    command -v xdg-user-dir >/dev/null 2>&1 && dir=$(xdg-user-dir DOWNLOAD 2>/dev/null)
    [[ -n "$dir" && "$dir" != "$HOME" && -d "$dir" ]] || dir=""
    if [[ -z "$dir" ]]; then
        for cand in "$HOME/Downloads" "$HOME/Descargas"; do
            [[ -d "$cand" ]] && { dir="$cand"; break; }
        done
    fi
    [[ -n "$dir" ]] || return

    # Un `-t 0` por cada firma encontrada no escala a un archivo comprimido lleno de
    # muestras; se agrupan por lote de clamscan (ver la llamada a notif_volcar).
    notif_grupo malware descargas.malware critical 0 "Malware detectado en Descargas"    \
        "amenazas detectadas en Descargas" "" " — NO lo ejecutes."

    # Motor antivirus. Preferimos clamscan (standalone, funciona con solo tener la
    # base de firmas) sobre clamdscan, que necesita el daemon clamd corriendo y si
    # no está devuelve error silencioso (no detectaría nada).
    # --max-filesize/--max-scansize: SIN esto clamscan SALTA (y asume limpios) los
    # ficheros > MaxFileSize (100 MB por defecto) → falso negativo. Los subimos al
    # tope que clamscan admite (2 GiB-1). Solo aplican a clamscan; clamdscan usa la
    # config del daemon (clamd.conf). La clasificación ya no manda a clamscan nada
    # ≥ clam_max (2 GiB-1), así que este tope siempre cubre lo que se le envía.
    local clam=()
    if command -v clamscan >/dev/null 2>&1; then
        clam=(clamscan --no-summary --max-filesize=2147483647 --max-scansize=2147483647)
    elif command -v clamdscan >/dev/null 2>&1; then
        clam=(clamdscan --fdpass --no-summary)
    fi
    # scan_max (tope de auto-análisis) es DINÁMICO: se recalcula en cada barrido
    # desde dlMaxScanGB de security.json (aplica sin reiniciar). Ver _dl_sweep.

    # Prioridad baja para hashing y ClamAV: ceden CPU/IO ante el resto del sistema.
    local -a lowprio=()
    command -v nice   >/dev/null 2>&1 && lowprio+=(nice -n 19)
    command -v ionice >/dev/null 2>&1 && lowprio+=(ionice -c 3)

    # Hash de contenido: xxh64sum es rapidísimo (varios GB/s); si no está, caemos a
    # sha1/md5. Solo se calcula cuando mtime|tamaño cambió, así que en régimen
    # normal casi nunca se hashea nada.
    local hasher=""
    for cand in xxh64sum xxhsum sha1sum md5sum; do
        command -v "$cand" >/dev/null 2>&1 && { hasher="$cand"; break; }
    done

    local cache="$HOME/.cache/gigios"
    local idx_file="$cache/download-index"     # mtime|tamaño|ruta (podado)
    local hash_file="$cache/download-hashes"   # hashes ya analizados (persistente)
    mkdir -p "$cache" 2>/dev/null
    # Limpieza única del estado viejo (clave ruta|tamaño, append-only, 6 MB).
    rm -f "$cache/download-seen" 2>/dev/null

    declare -A _idx      # ruta -> "mtime|tamaño"  (memo barato, persiste entre barridos)
    declare -A _scanned  # hash -> 1              (contenido ya analizado, persistente)
    # ruta -> "mtime|tamaño" del último aviso de "ejecutable nuevo" dado por ESTE
    # proceso. Solo en RAM y a propósito. Hace falta porque cuando clamscan sale con
    # error NO se marca `_idx` —para que el análisis se reintente en cuanto haya
    # firmas— y, sin freno, el mismo .exe volvería a caer en `new_exec` en CADA
    # barrido: un aviso cada 5 min (la red de seguridad de inotify), para siempre.
    # En el camino sano no hace nada: ahí `_idx` ya salta el fichero. Va por firma,
    # no por ruta, para que un fichero MODIFICADO sí vuelva a avisar.
    declare -A _alerted
    # Persistente ENTRE barridos (lo ve _dl_sweep por ámbito dinámico, como `seeded`):
    # el aviso de "sin firmas" se da una vez por proceso, no una por descarga.
    local _dl_warned_engine=false
    local seeded=false line mtime rest sz f

    # Cargar estado. Índice: formato mtime|tamaño|ruta (la ruta puede llevar '|',
    # por eso troceamos a mano y todo lo que sobra tras el 2º '|' es la ruta).
    if [[ -f "$idx_file" ]]; then
        seeded=true
        while IFS= read -r line; do
            mtime="${line%%|*}"; rest="${line#*|}"
            sz="${rest%%|*}";    f="${rest#*|}"
            [[ -n "$f" ]] && _idx["$f"]="$mtime|$sz"
        done < "$idx_file"
    fi
    [[ -f "$hash_file" ]] && while IFS= read -r line; do
        [[ -n "$line" ]] && _scanned["$line"]=1
    done < "$hash_file"

    # ¿Es un temporal de descarga en curso (navegador/gestor)?
    _dl_is_temp() {
        case "${1,,}" in
            *.part|*.crdownload|*.download|*.opdownload|*.partial|*.tmp|*.temp|\
            *.aria2|*.!qb|*.!ut|*.bc!|*.crswap) return 0 ;;
        esac
        return 1
    }

    # Un barrido completo, por fases (ver cabecera). Ve el estado persistente
    # (_idx/_scanned/seeded/dir/clam/lowprio/hasher…) por ámbito dinámico y muta
    # _idx/_scanned/seeded. Se invoca por evento (inotify) y por la red de seguridad.
    _dl_sweep() {
        # ── Config en vivo (relee cada barrido → aplica sin reiniciar) ──────────
        local dl_pause_ahorro=false dl_pause_bateria=false dl_pause_juego=false maxgb=1
        if command -v jq >/dev/null 2>&1 && [[ -f "$SEC_CONFIG" ]]; then
            # UN solo jq para los cuatro valores, no cuatro: son cuatro procesos y cuatro
            # lecturas del mismo fichero en cada barrido, o sea 5 ms contra 1 ms, y esto se
            # repite cada 300 s en reposo. `dlPauseWhileGaming` viene ACTIVADA por defecto (las
            # otras dos no): es la mitad más cara del modo juego. Y NO puede escribirse
            # `// true`: el operador // de jq trata un `false` literal como ausente, así que
            # apagar la pausa desde la UI no habría servido de nada — el script la seguiría
            # leyendo activada, y por eso su repliegue ante una salida ilegible también es
            # `true` y no `false`: ahí se replica lo que significa "clave ausente", no el valor
            # inicial de la línea de arriba (que es el caso distinto de "no hay jq ni fichero").
            IFS='|' read -r dl_pause_ahorro dl_pause_bateria dl_pause_juego maxgb < <(
                jq -r '[(.dlPauseInPowerSave // false),
                        (.dlPauseOnBattery // false),
                        (if has("dlPauseWhileGaming") then .dlPauseWhileGaming else true end),
                        (.dlMaxScanGB // 1)] | join("|")' "$SEC_CONFIG" 2>/dev/null)
            [[ "$dl_pause_ahorro"  == true || "$dl_pause_ahorro"  == false ]] || dl_pause_ahorro=false
            [[ "$dl_pause_bateria" == true || "$dl_pause_bateria" == false ]] || dl_pause_bateria=false
            [[ "$dl_pause_juego"   == true || "$dl_pause_juego"   == false ]] || dl_pause_juego=true
            [[ "$maxgb" =~ ^[0-9]+([.][0-9]+)?$ ]] || maxgb=1
        fi
        local scan_max
        scan_max=$(awk -v g="$maxgb" 'BEGIN{v=g*1073741824; if(v<1)v=1073741824; printf "%d", v}')
        # Techo real del auto-análisis = min(tope usuario, 2 GiB-1 que es lo máximo
        # que clamscan escanea). Lo que pase de ahí va a "archivo grande" (aviso),
        # no a clamscan, para que no lo salte y lo dé por limpio.
        local clam_max=$scan_max
        (( clam_max > 2147483647 )) && clam_max=2147483647

        # Puerta: si alguna pausa activada está activa AHORA, difiere TODO (no
        # hashea, no escanea, no avisa). El siguiente evento / red de seguridad
        # reintenta; nada se marca → lo pendiente se recoge al reanudar.
        _dl_paused && return

        local -a scan_batch=() big_files=() new_exec=() all=() present=()
        local rc=0 engine_ok=true   # rc/estado del clamscan del lote (ver Fase B)
        local -A _now _bhash tempbase _stat
        local changed=false f sig sz h mtime now mb lf out pid killed line vfile vsig
        now=$(date +%s)
        local settle=15   # s: no tocar lo modificado hace <settle (aún escribiéndose)

        # ── Fase A.1: recolectar rutas y marcar temporales (+ su nombre base) ───
        # `find -printf` trae mtime y tamaño DE PASO, y eso es lo que evita un `stat` por
        # fichero en la fase A.2. Con 67 ficheros en Descargas medía 40 ms y 67 forks por
        # barrido, contra 2 ms y ninguno — y esto corre cada 300 s aunque no pase nada, así
        # que era el grueso del consumo en reposo del escáner.
        # `%T@` da segundos con fracción: se trunca en el '.' (sin fork) para que la firma
        # siga siendo `mtime|tamaño` en enteros, que es el formato del índice en disco.
        # El troceo va a mano porque LA RUTA PUEDE LLEVAR '|' (misma razón que al cargar el
        # índice): todo lo que sobra tras el segundo '|' es la ruta.
        local _mt _sz _rest
        while IFS= read -r line; do
            _mt="${line%%|*}"; _rest="${line#*|}"
            _sz="${_rest%%|*}"; f="${_rest#*|}"
            [[ -n "$f" ]] || continue
            all+=("$f")
            _stat["$f"]="${_mt%%.*}|$_sz"
            _dl_is_temp "$f" && tempbase["${f%.*}"]=1
        done < <(find "$dir" -type f -printf '%T@|%s|%p\n' 2>/dev/null)

        # ── Fase A.2: clasificar (barato: solo stat + hash de lo nuevo) ─────────
        for f in "${all[@]}"; do
            [[ -f "$f" ]] || continue
            _dl_is_temp "$f" && continue                 # el propio temporal
            [[ -n "${tempbase[$f]:-}" ]] && continue     # final mientras exista su temp
            # La firma ya viene del `find` de la fase A.1; el `stat` es solo el repliegue para
            # un fichero que apareciera entre medias (o si `find -printf` no la trajo).
            sig="${_stat[$f]:-}"
            [[ -n "$sig" ]] || sig=$(stat -c '%Y|%s' "$f" 2>/dev/null) || continue
            _now["$f"]=1
            mtime="${sig%%|*}"; sz="${sig#*|}"
            (( now - mtime < settle )) && continue       # aún escribiéndose → luego
            [[ "${_idx[$f]:-}" == "$sig" ]] && continue  # sin cambios → saltar

            if (( ${#clam[@]} && sz > 0 && sz < clam_max )) && [[ -n "$hasher" ]]; then
                h=$("${lowprio[@]}" "$hasher" -- "$f" 2>/dev/null); h="${h%% *}"
                if [[ -n "$h" && -n "${_scanned[$h]:-}" ]]; then
                    _idx["$f"]="$sig"; changed=true       # contenido conocido → marcar y saltar
                    continue
                fi
                scan_batch+=("$f"); [[ -n "$h" ]] && _bhash["$f"]="$h"
                # Un aviso por fichero y proceso (ver `_alerted`): este es el único
                # camino que puede repetirse, porque con el motor roto no se marca _idx.
                if [[ "$seeded" == true ]] && is_runnable "$f" && [[ "${_alerted[$f]:-}" != "$sig" ]]; then
                    _alerted["$f"]="$sig"; new_exec+=("$f")
                fi
            elif (( ${#clam[@]} && sz >= clam_max )); then
                _idx["$f"]="$sig"; changed=true           # grande: avisar y marcar (no cada vez)
                [[ "$seeded" == true ]] && big_files+=("$f")
                [[ "$seeded" == true ]] && is_runnable "$f" && new_exec+=("$f")
            else
                _idx["$f"]="$sig"; changed=true           # sin clam/hasher: solo aviso de exe
                [[ "$seeded" == true ]] && is_runnable "$f" && new_exec+=("$f")
            fi
        done

        # Podar del índice lo que ya no existe (no crece sin límite; un fichero
        # borrado+recreado vuelve a evaluarse).
        for f in "${!_idx[@]}"; do
            [[ -n "${_now[$f]:-}" ]] || { unset '_idx[$f]'; changed=true; }
        done

        # Archivos demasiado grandes para el auto-análisis: aviso con botón.
        #
        # Mismo tope que los ejecutables nuevos, y por el mismo motivo: el botón
        # "Escanear igualmente" es POR FICHERO, así que agrupar cuesta el botón.
        # Hasta 4 compensa (un gesto y lo escaneas); a partir de ahí no, porque
        # descomprimir un juego suelta media docena de archivos enormes de golpe y
        # eso son seis popups con botón que nadie va a pulsar uno por uno.
        if (( ${#big_files[@]} > 4 )); then
            notificar descargas.archivo-grande -u normal \
                "${#big_files[@]} archivos grandes sin analizar" \
                "Superan el tope de auto-análisis. Escanéalos desde Ajustes › Seguridad." -t 15000
        else
            for f in "${big_files[@]}"; do
                mb=$(( $(stat -c%s "$f" 2>/dev/null || echo 0) / 1048576 ))
                if [[ -x "$SCAN_FILE" ]]; then
                    ( act=$(notificar descargas.archivo-grande -a "Seguridad" --wait -t 45000 \
                        -A "scan=Escanear igualmente" -u normal \
                        "Archivo grande sin analizar" \
                        "$(basename "$f") (${mb} MB) supera el tope de auto-análisis. Escanéalo aquí o en Ajustes › Seguridad.")
                      [[ "$act" == "scan" ]] && "$SCAN_FILE" "$f" ) &
                else
                    notificar descargas.archivo-grande -u normal "Archivo grande sin analizar" \
                        "$(basename "$f") (${mb} MB) — escanéalo desde Ajustes › Seguridad." -t 12000
                fi
            done
        fi

        # Aviso de ejecutables nuevos. ≤4 → individual con botón; más → resumen.
        if (( ${#new_exec[@]} )); then
            if (( ${#new_exec[@]} <= 4 )); then
                for f in "${new_exec[@]}"; do download_alert "$f"; done
            else
                notificar descargas.ejecutable-nuevo -u normal "${#new_exec[@]} ejecutables nuevos en Descargas" \
                    "En $(basename "$(dirname "${new_exec[0]}")")/ y otros. Revísalos antes de ejecutarlos (juego, instalador o crack)." -t 15000
            fi
        fi

        # ── Fase B: análisis antivirus, UNA invocación en 2º plano, interrumpible ─
        # clamscan recarga ~200 MB de firmas EN CADA llamada (~13 s), así que NO se
        # trocea: se lanza UN clamscan --file-list sobre todo el lote (una sola carga
        # de BD). Se corre en 2º plano y se vigila la pausa: si entras en juego/ahorro
        # a mitad, se MATA (latencia ~2 s) y NO se marca nada → se reescanea al
        # reanudar. Si termina solo, se marca todo. Antes se filtra a lo que aún
        # existe (movido fuera de Descargas).
        for f in "${scan_batch[@]}"; do [[ -f "$f" ]] && present+=("$f"); done
        if (( ${#present[@]} )); then
            killed=false
            lf=$(mktemp); out=$(mktemp)
            printf '%s\n' "${present[@]}" > "$lf"
            "${lowprio[@]}" "${clam[@]}" --file-list="$lf" > "$out" 2>/dev/null &
            pid=$!
            while kill -0 "$pid" 2>/dev/null; do
                if _dl_paused; then kill "$pid" 2>/dev/null; killed=true; break; fi
                sleep 2
            done
            wait "$pid" 2>/dev/null; rc=$?
            # ── El motor, ¿ha analizado algo siquiera? ────────────────────────
            # Códigos de clamscan: 0 = limpio, 1 = virus encontrado, 2 = ERROR (sin
            # base de firmas, permisos, fichero ilegible). Un 2 NO es "limpio", y
            # tratarlo como tal era un agujero de verdad: `2>/dev/null` se come el
            # "No supported database files found", no hay líneas FOUND que leer, y el
            # lote caía en la rama de "terminó bien" → se marcaba como analizado. Como
            # el memo va por hash de CONTENIDO y es PERMANENTE, esos ficheros no se
            # volverían a analizar NUNCA — ni después de instalar las firmas. Con la
            # DB vacía (recién instalado ClamAV, `freshclam` sin ejecutar) eso convertía
            # el escáner en un sello de "analizado" que no analiza nada. Ahora un 2 no
            # marca: el lote se reintenta cuando haya motor. Se avisa UNA vez por
            # proceso (mismo patrón que `warned_perm` en monitor_smart): esto se dispara
            # en cada barrido y sin el freno sería una notificación por descarga.
            if (( rc == 2 )); then
                engine_ok=false
                if [[ "$_dl_warned_engine" == false ]]; then
                    _dl_warned_engine=true
                    # **El barrido NO actualiza las firmas por su cuenta, y es deliberado.** Hubo
                    # una versión que las descargaba aquí en silencio; se quitó porque convertía un
                    # barrido de fondo en un disparador de ~200 MB a mitad de sesión, y porque
                    # reintentarlo barrido tras barrido es un temporizador de actualización con
                    # otro nombre — justo lo que no se quiere. Lo automático ocurre UNA vez, al
                    # arrancar Hyprland (`gigios/autostart.lua` → `actualizar-firmas.sh --auto`).
                    #
                    # Aquí solo se avisa, con BOTÓN (clic derecho en el popup) para arreglarlo sin
                    # abrir una terminal: es el único fallo de esta lista con una cura de un solo
                    # gesto, y decirle al usuario "ejecuta sudo freshclam" en un popup que se va en
                    # un minuto era pedirle que se acordara. `firmas_aviso_con_boton` BLOQUEA hasta
                    # el clic o su techo de espera → subshell en 2º plano, igual que en
                    # download_alert; en primer plano detendría el barrido entero hasta que alguien
                    # mirase el popup. Una vez por proceso (`_dl_warned_engine`), como
                    # `warned_perm` en monitor_smart: esto se dispara en cada barrido y sin el
                    # freno sería una notificación por descarga.
                    if [[ -x "$UPDATE_SIGS" ]]; then
                        ( firmas_aviso_con_boton antivirus.sin-firmas critical \
                            "Antivirus sin base de firmas" \
                            "ClamAV no puede analizar las descargas. Hasta que se actualicen las firmas NO se dan por analizadas." ) &
                    else
                        notificar antivirus.sin-firmas -u critical \
                            "Antivirus sin base de firmas" \
                            "ClamAV no puede analizar las descargas. Ejecuta 'sudo freshclam'. Hasta entonces NO se dan por analizadas." -t 0
                    fi
                fi
            else
                engine_ok=true
            fi
            # Avisar de lo detectado (aunque se cortara: lo ya escaneado cuenta).
            #
            # Un solo archivo infectado da UNA línea FOUND, pero un .zip con veinte
            # muestras dentro da veinte, y eran veinte críticas con `-t 0`. El lote
            # de clamscan ES el grupo natural: se encola aquí y se vuelca justo al
            # acabar de leer su salida, sin ventana de tiempo ni retraso.
            while IFS= read -r line; do
                [[ "$line" == *" FOUND" ]] || continue     # "/ruta: Firma FOUND"
                vfile="${line%%: *}"
                vsig="${line##*: }"; vsig="${vsig% FOUND}"
                notif_encolar malware "$vfile: $vsig"
            done < "$out"
            notif_volcar
            # Marcar índice + hash del CONTENIDO SOLO si terminó (no cortado) Y el motor
            # funcionaba: un infectado que se queda avisa UNA vez y recrear el mismo
            # contenido no se re-analiza; si se cortó —o si clamscan salió con error—
            # nada se marca → el lote se reescanea al reanudar (o al haber firmas).
            if [[ "$killed" == false && "$engine_ok" == true ]]; then
                for f in "${present[@]}"; do
                    sig=$(stat -c '%Y|%s' "$f" 2>/dev/null) || continue
                    _idx["$f"]="$sig"; changed=true
                    h="${_bhash[$f]:-}"
                    [[ -n "$h" && -z "${_scanned[$h]:-}" ]] && { _scanned["$h"]=1; printf '%s\n' "$h" >> "$hash_file"; }
                done
            fi
            rm -f "$lf" "$out"
        fi

        # Persistir el índice (reescritura atómica) solo si cambió algo.
        if [[ "$changed" == true ]]; then
            { for f in "${!_idx[@]}"; do printf '%s|%s\n' "${_idx[$f]}" "$f"; done; } \
                > "$idx_file.tmp" 2>/dev/null && mv -f "$idx_file.tmp" "$idx_file" 2>/dev/null
        fi

        # Válvula de seguridad de download-hashes (append-only, ~17 B/entrada): si
        # supera 10 MB, conservar solo las 100 más recientes (por ser append-only,
        # son las 100 últimas líneas) y reconstruir la memoria para dejar fichero y
        # RAM consistentes. A 10 MB esto tarda años; es un tope duro, no rutina.
        local hsz
        hsz=$(stat -c%s "$hash_file" 2>/dev/null || echo 0)
        if (( hsz > 10485760 )); then
            tail -n 100 "$hash_file" > "$hash_file.tmp" 2>/dev/null && mv -f "$hash_file.tmp" "$hash_file"
            _scanned=()
            while IFS= read -r h; do [[ -n "$h" ]] && _scanned["$h"]=1; done < "$hash_file"
        fi

        seeded=true
    }

    # ── Bucle dirigido por eventos ────────────────────────────────────────────
    # inotify actúa de DESPERTADOR, no de escáner: al despertar barremos con find,
    # así da igual que inotify se pierda subcarpetas nuevas o descarte eventos bajo
    # avalancha (el barrido lo ve todo). En reposo el proceso queda BLOQUEADO en
    # inotifywait — cero CPU/IO, sin sondear cada 30 s. Latencia típica ~debounce s.
    local debounce=3 safety=300 rc t0
    local -a ev=(-e create -e close_write -e moved_to -e moved_from -e delete)

    # Misma razón que en los tres monitores de tubería, aunque aquí el hijo sí acaba solo: un
    # SIGTERM mientras se espera al `inotifywait -t 300` quedaría pendiente hasta cinco minutos,
    # y durante ese rato el barrido puede arrancar un `clamscan` que nadie ha pedido ya. Con el
    # hijo en 2º plano y un `wait`, el apagado es inmediato y no deja el `inotifywait` suelto.
    local _espera=""
    trap '[[ -n "$_espera" ]] && kill "$_espera" 2>/dev/null; exit 0' TERM INT HUP
    _esperar_evento() {   # mismos argumentos que inotifywait; devuelve su código de salida
        "$@" >/dev/null 2>&1 &
        _espera=$!
        wait "$_espera"; local rc=$?
        _espera=""
        return $rc
    }

    _dl_sweep   # primer barrido inmediato (siembra y caza lo ya existente)

    if command -v inotifywait >/dev/null 2>&1; then
        while :; do
            # Bloquea hasta un evento en Descargas, o hasta `safety` s (red de
            # seguridad por si inotify se queda corto: overflow, watch fallido…).
            _esperar_evento inotifywait -q -r -t "$safety" "${ev[@]}" "$dir"
            rc=$?
            if (( rc == 0 )); then
                # Debounce: agrupa la avalancha (extraer un juego = miles de eventos)
                # esperando `debounce` s de calma, con tope de 30 s para no quedarnos
                # sin barrer si algo escribe sin parar (descarga larga, torrent…).
                t0=$SECONDS
                while _esperar_evento inotifywait -q -r -t "$debounce" "${ev[@]}" "$dir"; do
                    (( SECONDS - t0 >= 30 )) && break
                done
            elif (( rc == 1 )); then
                # Error de inotify (límite de watches, dir recreado…): degradamos a
                # poll suave para no hacer busy-loop, pero seguimos barriendo.
                sleep 30
            fi
            # rc==2 (timeout de la red de seguridad) → barrido directo.
            _dl_sweep
        done
    else
        # Sin inotify-tools: poll clásico de 30 s (comportamiento anterior).
        while :; do sleep 30; _dl_sweep; done
    fi
}

# ── Apagado limpio: no dejar hijos sueltos ────────────────────────────────────
# **Sin esto, cada muerte del script dejaba un `inotifywait -m` vivo PARA SIEMPRE.** Los seis
# monitores son hijos directos (`func &`) y `pkill -f oom-monitor.sh` sí se los lleva, pero sus
# NIETOS no casan con ese patrón: el `inotifywait -m` de monitor_files no tiene `-t`, así que se
# queda bloqueado esperando eventos, lo adopta init y ahí sigue — vigilando /etc, /boot y ~/.ssh y
# ocupando ~3,7 MB de RSS y sus watches de inotify, sin nadie al otro lado de la tubería. Medido en
# esta máquina: un huérfano de 1 h 48 min de una instancia anterior. Y se acumulan, porque tanto
# `hyprctl reload full-reset` como el ciclo documentado de "editar un *-monitor.sh y relanzarlo"
# pasan por ahí.
#
# Se matan de abajo arriba (nietos antes que padres): al revés, el padre muere primero, el nieto se
# queda huérfano y ya no hay `pgrep -P` que lo encuentre — que es exactamente el fallo que esto
# arregla. El `journalctl -f` de monitor_kernel/monitor_system entra por el mismo camino.
_matar_descendientes() {
    local pid=$1 hijo
    for hijo in $(pgrep -P "$pid" 2>/dev/null); do _matar_descendientes "$hijo"; done
    kill "$pid" 2>/dev/null
}
_limpiar_al_salir() {
    trap - EXIT TERM INT HUP   # idempotente: la señal puede llegar dos veces
    local j
    for j in $(jobs -p 2>/dev/null); do _matar_descendientes "$j"; done
    # **Y DESPUÉS, la recogida.** Recorrer el árbol no basta y está medido: `pkill -f
    # oom-monitor.sh` casa con TODOS los niveles de bash a la vez —este proceso, los seis
    # sub-monitores y el subshell de cada tubería, que comparten línea de órdenes—, así que cuando
    # esta limpieza corre, el subshell intermedio ya puede estar muerto y su `inotifywait` ya
    # reparentado a init: `pgrep -P` no lo encuentra porque su padre ya no existe. Un huérfano
    # recién hecho sí casa con los patrones de `_recoger_huerfanos`, que es la misma red que se usa
    # al arrancar. El respiro es para dejar que el kernel reparente a init lo que acabamos de matar.
    sleep 0.2
    _recoger_huerfanos
}
trap _limpiar_al_salir EXIT TERM INT HUP

# **Los traps NO bastan, y hay que saber por qué antes de "simplificar" esto.** Cubren el caso de
# matar un pid concreto, pero no el que se usa de verdad: `pkill -f oom-monitor.sh` casa con TODOS
# los niveles de bash a la vez —este proceso, los seis sub-monitores y el subshell de cada tubería,
# que comparten línea de órdenes— y les llega la señal simultáneamente. Un subshell creado con `&`
# **no hereda los traps** del padre, así que el intermedio puede morir en el acto y dejar a su nieto
# huérfano *antes* de que nadie recorra el árbol; y a partir de ahí `pgrep -P` ya no lo encuentra,
# porque su padre ya no existe. (Los traps por monitor sí hacen falta —ver el comentario de la
# tubería en segundo plano—, pero resuelven la otra mitad del problema, no esta.)
#
# Por eso la red que cierra el agujero es RECOGER HUÉRFANOS: al arrancar y como último paso de la
# limpieza. Un huérfano nuestro es
# reconocible sin ambigüedad: mismo usuario, **ppid 1** y la línea de órdenes exacta que emitimos
# (la lista de rutas vigiladas / las unidades de journalctl). Muere solo, pero solo al PRIMER evento
# —cuando el SIGPIPE le llega por escribir en una tubería sin lector—, y en /etc eso puede tardar
# días: mientras tanto ocupa RSS y watches de inotify. Se limpia aquí, una vez.
_recoger_huerfanos() {
    command -v pgrep >/dev/null 2>&1 || return 0
    local patron pid
    # Los patrones son las líneas de órdenes EXACTAS que emite este script (ver monitor_files,
    # monitor_system y monitor_kernel). Nada genérico: un `pgrep -f inotifywait` a secas se llevaría
    # por delante el vigilante de pacman de updates-monitor.sh, o el de cualquier otra app.
    for patron in \
        "inotifywait -m -e close_write,moved_to,create --format %w%f /etc " \
        "journalctl -f -n 0 --no-pager -t sudo -t sshd -t su" \
        "journalctl -kf -n 0 --no-pager"
    do
        # -u "$USER": nunca tocar procesos de otra cuenta. La comparación de ppid deja fuera a
        # cualquier instancia VIVA (sus hijos cuelgan de ella, no de init).
        while read -r pid; do
            [[ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" == 1 ]] && kill "$pid" 2>/dev/null
        done < <(pgrep -u "$USER" -f "$patron" 2>/dev/null)
    done
}
_recoger_huerfanos

# ── Run in parallel ───────────────────────────────────────────────────────────
# Los tres primeros enganchan YA (journal/inotify no guardan lo pasado: llegar tarde
# = ventana ciega). Los tres de sondeo se apartan del pico de arranque por dentro,
# cada uno con su DELAY_* — ver el bloque "Escalonado de arranque" arriba.
monitor_kernel &
monitor_system &
monitor_files &
monitor_smart &
monitor_units &
monitor_downloads &
wait
