#!/usr/bin/env bash
# Setup único: obtiene un refresh_token de Spotify y lo guarda en texto plano en
# ~/.config/gigishell/spotify-creds.json (chmod 600). Específico del escritorio ags.
set -euo pipefail

REDIRECT="http://127.0.0.1:8888/callback"
# Los dos scopes de playback son para llevar la reproducción a este equipo desde el
# widget de la barra (Spotify Connect): leer los dispositivos y activar este. Si
# cambias esta lista hay que volver a ejecutar este script: el refresh_token guardado
# conserva para siempre los scopes con los que se emitió.
SCOPES="user-library-read user-library-modify user-read-playback-state user-modify-playback-state"
CREDS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/spotify-creds.json"
CALLBACK_PID=""
TMP_RESULT=""
TMP_CREDS=""

limpiar_temporales() {
  if [[ -n "$CALLBACK_PID" ]]; then
    kill "$CALLBACK_PID" 2>/dev/null || true
    wait "$CALLBACK_PID" 2>/dev/null || true
  fi
  [[ -z "$TMP_RESULT" ]] || rm -f -- "$TMP_RESULT"
  [[ -z "$TMP_CREDS" ]] || rm -f -- "$TMP_CREDS"
}
trap limpiar_temporales EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v python3 >/dev/null || { echo "Falta python3"; exit 1; }
command -v curl >/dev/null || { echo "Falta curl"; exit 1; }

echo "Crea una app en https://developer.spotify.com/dashboard"
echo "y añade EXACTAMENTE este Redirect URI: ${REDIRECT}"
echo
read -rp "Spotify Client ID: " CLIENT_ID
read -rsp "Spotify Client Secret: " CLIENT_SECRET; echo

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

AUTH_URL="https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=$(enc "$REDIRECT")&scope=$(enc "$SCOPES")"

echo "Esperando la autorización de Spotify (máximo 5 minutos)…"
TMP_RESULT=$(mktemp)
python3 - <<'PY' > "$TMP_RESULT" &
import http.server, json, urllib.parse
resultado = {"code": "", "error": ""}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        resultado["code"] = q.get("code", [""])[0]
        resultado["error"] = q.get("error", [""])[0]
        correcto = bool(resultado["code"])
        self.send_response(200); self.end_headers()
        mensaje = ("Listo. Puedes cerrar esta pestana." if correcto
                   else "Autorizacion cancelada o fallida. Puedes cerrar esta pestana.")
        self.wfile.write(mensaje.encode())
    def log_message(self, *a): pass
servidor = http.server.HTTPServer(("127.0.0.1", 8888), H)
servidor.timeout = 300
if servidor.handle_request() is None:
    resultado["error"] = "timeout"
print(json.dumps(resultado))
PY
CALLBACK_PID=$!

echo "Abriendo el navegador para autorizar…"
xdg-open "$AUTH_URL" >/dev/null 2>&1 || echo "Abre manualmente: $AUTH_URL"
if ! wait "$CALLBACK_PID"; then
  echo "Falló el servidor local de autorización de Spotify." >&2
  exit 1
fi
CALLBACK_PID=""
RESULTADO=$(cat "$TMP_RESULT")

CODE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("code", ""))' "$RESULTADO")
ERROR=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("error", ""))' "$RESULTADO")

if [[ -z "$CODE" ]]; then
  if [[ "$ERROR" == "timeout" ]]; then
    echo "La autorización de Spotify agotó el tiempo de espera (5 minutos)." >&2
  elif [[ -n "$ERROR" ]]; then
    echo "La autorización de Spotify fue cancelada o rechazada ($ERROR)." >&2
  else
    echo "Spotify no devolvió un código de autorización." >&2
  fi
  exit 1
fi

echo "Autorización recibida; solicitando el token…"

if ! RESP=$(curl -sS --connect-timeout 10 --max-time 30 \
  -X POST https://accounts.spotify.com/api/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=${CODE}" \
  -d "redirect_uri=${REDIRECT}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" 2>/dev/null); then
  echo "Falló la conexión con Spotify o agotó el tiempo de espera; no se guardaron credenciales." >&2
  exit 1
fi

TOKEN_DATA=$(printf '%s' "$RESP" | python3 -c '
import json,sys
try:
    datos = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    datos = {}
if not isinstance(datos, dict):
    datos = {}
print(json.dumps({"refresh_token": datos.get("refresh_token", ""),
                  "error": datos.get("error", "")}))')
REFRESH=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("refresh_token", ""))' "$TOKEN_DATA")
if [[ -z "$REFRESH" ]]; then
  ERROR=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("error", ""))' "$TOKEN_DATA")
  if [[ -n "$ERROR" ]]; then
    echo "Spotify rechazó el canje del código ($ERROR); no se obtuvo refresh_token." >&2
  else
    echo "Spotify no devolvió refresh_token; no se guardaron credenciales." >&2
  fi
  exit 1
fi

JSON=$(python3 -c 'import json,sys; print(json.dumps({"client_id":sys.argv[1],"client_secret":sys.argv[2],"refresh_token":sys.argv[3]}))' \
  "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH")

umask 077
mkdir -p "$(dirname "$CREDS_FILE")"
TMP_CREDS=$(mktemp "${CREDS_FILE}.XXXXXX")
printf '%s\n' "$JSON" > "$TMP_CREDS"
chmod 600 "$TMP_CREDS"
mv -f -- "$TMP_CREDS" "$CREDS_FILE"
echo "Credenciales guardadas en ${CREDS_FILE} (texto plano, chmod 600)."
