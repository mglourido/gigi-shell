#!/usr/bin/env bash
# scan-downloads.sh — escaneo FORZADO de toda la carpeta de descargas, a demanda.
#
# Lo dispara el botón "Escanear Descargas ahora" de Ajustes › Seguridad. A
# diferencia del escaneo automático de oom-monitor.sh, IGNORA todo: el toggle
# maestro (downloadScan), las pausas (ahorro/batería/juego) y el tope de tamaño.
# Es el "escanea igualmente aunque lo tenga desactivado o esté con batería".
#
# No duplica motor ni notificaciones: resuelve la carpeta y delega en
# scan-file.sh (que ya hace clamscan -r sin tope, con prioridad baja, y notifica
# limpio/infectado/no-se-pudo).

set -u

APP="Análisis ClamAV"
SCAN_FILE="$HOME/.config/hypr/scripts/scan-file.sh"

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

# Carpeta de descargas locale-aware (misma lógica que monitor_downloads).
dir=""
command -v xdg-user-dir >/dev/null 2>&1 && dir=$(xdg-user-dir DOWNLOAD 2>/dev/null)
[[ -n "$dir" && "$dir" != "$HOME" && -d "$dir" ]] || dir=""
if [[ -z "$dir" ]]; then
    for cand in "$HOME/Downloads" "$HOME/Descargas"; do
        [[ -d "$cand" ]] && { dir="$cand"; break; }
    done
fi

if [[ -z "$dir" ]]; then
    notificar analisis.sin-carpeta -u critical "$APP" "No encuentro la carpeta de descargas." -t 8000
    exit 1
fi

exec "$SCAN_FILE" "$dir"
