#!/usr/bin/env bash
# Setup único: obtiene un refresh_token de Spotify y lo guarda en texto plano en
# ~/.config/gigios/spotify-creds.json (chmod 600). Específico del escritorio ags.
set -euo pipefail

REDIRECT="http://127.0.0.1:8888/callback"
# Los dos scopes de playback son para llevar la reproducción a este equipo desde el
# widget de la barra (Spotify Connect): leer los dispositivos y activar este. Si
# cambias esta lista hay que volver a ejecutar este script: el refresh_token guardado
# conserva para siempre los scopes con los que se emitió.
SCOPES="user-library-read user-library-modify user-read-playback-state user-modify-playback-state"
CREDS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/spotify-creds.json"

command -v python3 >/dev/null || { echo "Falta python3"; exit 1; }

echo "Crea una app en https://developer.spotify.com/dashboard"
echo "y añade EXACTAMENTE este Redirect URI: ${REDIRECT}"
echo
read -rp "Spotify Client ID: " CLIENT_ID
read -rsp "Spotify Client Secret: " CLIENT_SECRET; echo

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

AUTH_URL="https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=$(enc "$REDIRECT")&scope=$(enc "$SCOPES")"

echo "Abriendo el navegador para autorizar…"
xdg-open "$AUTH_URL" >/dev/null 2>&1 || echo "Abre manualmente: $AUTH_URL"

CODE=$(python3 - <<'PY'
import http.server, urllib.parse
result = {}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        result['code'] = q.get('code', [''])[0]
        self.send_response(200); self.end_headers()
        self.wfile.write("Listo. Puedes cerrar esta pestana.".encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 8888), H).handle_request()
print(result.get('code', ''))
PY
)

[ -n "$CODE" ] || { echo "No se recibió el code de autorización."; exit 1; }

RESP=$(curl -s -X POST https://accounts.spotify.com/api/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=${CODE}" \
  -d "redirect_uri=${REDIRECT}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}")

REFRESH=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))')
[ -n "$REFRESH" ] || { echo "No se obtuvo refresh_token. Respuesta: $RESP"; exit 1; }

JSON=$(python3 -c 'import json,sys; print(json.dumps({"client_id":sys.argv[1],"client_secret":sys.argv[2],"refresh_token":sys.argv[3]}))' \
  "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH")

mkdir -p "$(dirname "$CREDS_FILE")"
printf '%s\n' "$JSON" > "$CREDS_FILE"
chmod 600 "$CREDS_FILE"
echo "Credenciales guardadas en ${CREDS_FILE} (texto plano, chmod 600)."
