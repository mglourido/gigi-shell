#!/usr/bin/env bash
# run-untrusted.sh — lanza un archivo potencialmente peligroso de forma segura.
#
#   1) ANÁLISIS: lo escanea con ClamAV (si está instalado). Si da positivo, NO lo
#      lanza y avisa. Si no hay ClamAV, avisa de que va sin analizar.
#   2) CONTENCIÓN: si está limpio, lo ejecuta dentro de una jaula Firejail — con un
#      $HOME desechable donde SOLO se ve este archivo, sin red y sin privilegios.
#
# OJO: Firejail NO limpia ni desinfecta el archivo; lo AÍSLA en tiempo de
# ejecución. Es control de daños: si es malware, corre pero no puede tocar tus
# datos reales (documentos, ~/.ssh, tokens, etc.).
#
# Uso: run-untrusted.sh /ruta/al/archivo
#
# Respeta el toggle "Lanzador aislado" (sandboxLaunch en security.json): si el
# usuario lo apagó, no hace nada — igual que el resto de escáneres.

set -u

APP="Lanzador aislado"
NOTIF_APP="$APP"
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

f="${1:-}"

# ── Toggle (ausente/ilegible → activado) ──────────────────────────────────────
SEC_CONFIG="$HOME/.config/gigios/security.json"
if command -v jq >/dev/null 2>&1 && [[ -f "$SEC_CONFIG" ]]; then
    enabled=$(jq -r 'if has("sandboxLaunch") then (.sandboxLaunch|tostring) else "true" end' \
        "$SEC_CONFIG" 2>/dev/null)
    [[ "$enabled" == "false" ]] && exit 0
fi

# ── Validación ────────────────────────────────────────────────────────────────
f="$(realpath -- "$f" 2>/dev/null || echo "$f")"
name="$(basename -- "$f")"
[[ -n "$f" && -f "$f" ]] || { notificar aislado.sin-archivo -u critical "$APP" "No existe el archivo: $f" -t 8000; exit 1; }

# ── 1) Análisis previo (ClamAV) ───────────────────────────────────────────────
# clamscan lleva --max-filesize/--max-scansize al tope (2 GiB-1); si no, saltaría
# (asumiéndolos limpios) los ejecutables > 100 MB, justo los juegos/instaladores.
CLAMSCAN_MAX=(--max-filesize=2147483647 --max-scansize=2147483647)
clam=()
if command -v clamdscan >/dev/null 2>&1; then
    clam=(clamdscan --fdpass --no-summary)
elif command -v clamscan >/dev/null 2>&1; then
    clam=(clamscan --no-summary "${CLAMSCAN_MAX[@]}")
fi

if (( ${#clam[@]} )); then
    out=$("${clam[@]}" "$f" 2>/dev/null); rc=$?
    # clamdscan sin daemon devuelve error (rc≥2): reintenta con clamscan standalone.
    if (( rc >= 2 )) && [[ "${clam[0]}" == clamdscan ]] && command -v clamscan >/dev/null 2>&1; then
        out=$(clamscan --no-summary "${CLAMSCAN_MAX[@]}" "$f" 2>/dev/null); rc=$?
    fi
    if grep -q "FOUND" <<< "$out"; then
        notificar aislado.malware -u critical "Malware detectado — NO se lanza" \
            "$name: $(grep FOUND <<< "$out" | head -1)" -t 0
        exit 2
    elif (( rc != 0 )); then
        # rc=0 limpio · rc=1 virus (ya cazado arriba) · rc≥2 no se pudo analizar
        # (daemon parado o sin base de firmas). Contenemos igual, pero avisando — con botón para
        # arreglar las firmas de un gesto. **No se actualiza nada solo**: lo automático ocurre una
        # vez al arrancar Hyprland, y ponerse a descargar ~200 MB porque alguien acaba de lanzar un
        # ejecutable sería justo el trabajo de fondo que no se quiere. El aviso va en SUBSHELL de
        # fondo a propósito: el usuario ha pedido **lanzar** algo, y esperar a que mire el popup
        # retrasaría el lanzamiento. El análisis de ESTA ejecución ya no se repite; la
        # actualización sirve para las siguientes.
        UPDATE_SIGS="$HOME/.config/hypr/scripts/actualizar-firmas.sh"
        # shellcheck source=lib/firmas.sh
        if ! source "$HOME/.config/hypr/scripts/lib/firmas.sh" 2>/dev/null; then
            firmas_aviso_con_boton() { notificar "$1" -u "$2" "$3" "$4" -t 0; }
        fi
        if [[ -x "$UPDATE_SIGS" ]]; then
            ( firmas_aviso_con_boton aislado.no-analizado normal "No se pudo analizar" \
                "ClamAV no operativo (sin base de firmas o daemon parado). Se lanzará contenido pero SIN analizar." ) &
        else
            notificar aislado.no-analizado -u normal "No se pudo analizar" \
                "ClamAV no operativo (¿falta ejecutar 'sudo freshclam'?). Se lanzará contenido pero SIN analizar." -t 10000
        fi
    fi
else
    notificar aislado.sin-antivirus -u normal "Sin antivirus" \
        "ClamAV no instalado: se lanzará contenido pero SIN analizar. Instala 'clamav' para el escaneo." -t 10000
fi

# ── 2) Contención (Firejail) ──────────────────────────────────────────────────
if ! command -v firejail >/dev/null 2>&1; then
    notificar aislado.falta-firejail -u critical "Falta Firejail" \
        "Instala 'firejail' (sudo pacman -S firejail) para poder lanzar aislado." -t 0
    exit 3
fi

# Cómo ejecutarlo según el tipo.
launch_cmd=()
case "${f,,}" in
    *.exe|*.msi)
        if command -v wine >/dev/null 2>&1; then
            launch_cmd=(wine "$f")
        else
            notificar aislado.falta-wine -u critical "Falta Wine" "Instala 'wine' para ejecutar .exe/.msi." -t 0
            exit 4
        fi ;;
    *.sh)  launch_cmd=(bash "$f") ;;
    *)     chmod +x "$f" 2>/dev/null; launch_cmd=("$f") ;;
esac

notificar aislado.lanzando -u normal "Lanzando aislado" \
    "$name en jaula Firejail (sin red, sin acceso a tus datos)." -t 6000

# --whitelist=$f → el $HOME de la jaula queda vacío salvo este archivo.
# --noroot sin privilegios · --nodbus aísla del bus · --net=none sin red (evita
# exfiltración/C2). setsid + & para no bloquear al llamante (botón o ajustes).
setsid firejail --quiet --noroot --nodbus --net=none --whitelist="$f" \
    -- "${launch_cmd[@]}" >/dev/null 2>&1 &

exit 0
