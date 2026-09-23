#!/usr/bin/env bash
# Setup único: obtiene un refresh_token de Google Calendar y lo guarda en texto plano en
# ~/.config/gigios/google-calendar-creds.json (chmod 600). Específico del escritorio ags.
#
# El consentimiento vive AQUÍ y no dentro de AGS a propósito: es interactivo, ocurre una vez en la
# vida de la máquina, y montar el servidor del callback dentro del shell significaría tener un
# puerto en escucha toda la sesión para algo que se usa una tarde. Mismo reparto que
# scripts/spotify-auth.sh.
#
# El puerto del loopback se pide al kernel (puerto 0) en vez de fijarlo: Google acepta cualquier
# puerto en http://127.0.0.1 para clientes de escritorio, y así el script no falla porque otra cosa
# ocupara el 8888.
set -euo pipefail

SCOPE="https://www.googleapis.com/auth/calendar"
CREDS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/gigios/google-calendar-creds.json"

command -v python3 >/dev/null || { echo "Falta python3"; exit 1; }
command -v curl    >/dev/null || { echo "Falta curl"; exit 1; }

cat <<'EOF'
Antes de seguir, en https://console.cloud.google.com/ :

  1. Crea (o elige) un proyecto.
  2. APIs y servicios > Biblioteca > habilita «Google Calendar API».
  3. Pantalla de consentimiento OAuth: tipo «Externo», y AÑÁDETE como usuario de prueba.
  4. Credenciales > Crear credenciales > ID de cliente de OAuth > «Aplicación de escritorio».

Pega aquí el ID de cliente. El secreto lo pide después: en las apps de escritorio Google lo
entrega igualmente, no es un secreto de verdad (por eso se usa PKCE), pero su endpoint de token
lo sigue exigiendo. Déjalo vacío si tu cliente no tiene.

AVISO: mientras el proyecto siga en modo «Testing», Google CADUCA los refresh tokens a los
7 días y habrá que volver a ejecutar este script. Para que duren, publica la app
(«En producción») en la pantalla de consentimiento.
EOF
echo
read -rp "Google Client ID: " CLIENT_ID
read -rsp "Google Client Secret (Enter si no hay): " CLIENT_SECRET; echo
[[ -n "$CLIENT_ID" ]] || { echo "Sin Client ID no se puede continuar"; exit 1; }

# PKCE: verificador aleatorio y su reto SHA-256 en base64url. Es lo que impide que un proceso local
# que intercepte el código de autorización pueda canjearlo: sin el verificador, el código no vale.
VERIFIER="$(python3 -c 'import secrets;print(secrets.token_urlsafe(64)[:96])')"
CHALLENGE="$(python3 -c '
import base64, hashlib, sys
d = hashlib.sha256(sys.argv[1].encode()).digest()
print(base64.urlsafe_b64encode(d).decode().rstrip("="))' "$VERIFIER")"
# Estado anti-CSRF: se compara al recibir el callback, para no aceptar un código que no pedimos.
STATE="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# El servidor arranca ANTES de abrir el navegador y escribe el puerto que le tocó, para que no haya
# ventana en la que el usuario ya haya autorizado y aquí todavía no escuche nadie.
python3 - "$STATE" "$TMP" <<'PY' &
import http.server, socket, sys, urllib.parse, json, os
state_esperado, tmp = sys.argv[1], sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        salida = {"code": (q.get("code") or [""])[0],
                  "state": (q.get("state") or [""])[0],
                  "error": (q.get("error") or [""])[0]}
        ok = salida["state"] == state_esperado and salida["code"]
        with open(os.path.join(tmp, "result.json"), "w") as f:
            json.dump(salida if ok else {"error": salida["error"] or "estado no coincide"}, f)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(("<h2>Listo. Puedes cerrar esta pestana.</h2>" if ok
                          else "<h2>Fallo en la autorizacion.</h2>").encode())
    def log_message(self, *a): pass

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
with open(os.path.join(tmp, "port"), "w") as f:
    f.write(str(srv.server_address[1]))
srv.timeout = 300
srv.handle_request()
PY
SERVIDOR=$!

for _ in $(seq 1 50); do [[ -s "$TMP/port" ]] && break; sleep 0.1; done
PORT="$(cat "$TMP/port" 2>/dev/null || true)"
[[ -n "$PORT" ]] || { echo "No se pudo abrir el servidor local"; exit 1; }
REDIRECT="http://127.0.0.1:${PORT}"

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth"
AUTH_URL+="?client_id=$(enc "$CLIENT_ID")"
AUTH_URL+="&redirect_uri=$(enc "$REDIRECT")"
AUTH_URL+="&response_type=code"
AUTH_URL+="&scope=$(enc "$SCOPE")"
AUTH_URL+="&code_challenge=$(enc "$CHALLENGE")&code_challenge_method=S256"
AUTH_URL+="&state=$(enc "$STATE")"
# Sin estas dos, una segunda autorización devuelve el código pero NO un refresh_token nuevo, y el
# script terminaría "bien" dejando las credenciales inservibles.
AUTH_URL+="&access_type=offline&prompt=consent"

echo "Abriendo el navegador para autorizar…"
xdg-open "$AUTH_URL" >/dev/null 2>&1 || echo "Abre manualmente: $AUTH_URL"

wait "$SERVIDOR" || true
[[ -s "$TMP/result.json" ]] || { echo "No llegó ninguna respuesta (¿se agotó el tiempo?)"; exit 1; }

CODE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("code",""))' "$TMP/result.json")"
if [[ -z "$CODE" ]]; then
  python3 -c 'import json,sys;print("Error:", json.load(open(sys.argv[1])).get("error","desconocido"))' "$TMP/result.json"
  exit 1
fi

RESP="$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${CLIENT_ID}" \
  ${CLIENT_SECRET:+-d "client_secret=${CLIENT_SECRET}"} \
  -d "code=${CODE}" \
  -d "code_verifier=${VERIFIER}" \
  -d "redirect_uri=${REDIRECT}" \
  -d "grant_type=authorization_code")"

REFRESH="$(python3 -c 'import json,sys;print(json.loads(sys.stdin.read()).get("refresh_token",""))' <<<"$RESP")"
if [[ -z "$REFRESH" ]]; then
  echo "No llegó refresh_token. Respuesta del servidor:"
  # Se imprime solo el campo de error: el cuerpo completo puede traer un access_token.
  python3 -c 'import json,sys;d=json.loads(sys.stdin.read());print(" ", d.get("error"), d.get("error_description",""))' <<<"$RESP"
  exit 1
fi

mkdir -p "$(dirname "$CREDS_FILE")"
umask 077
python3 - "$CREDS_FILE" "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH" <<'PY'
import json, sys
ruta, cid, secreto, refresh = sys.argv[1:5]
json.dump({"client_id": cid, "client_secret": secreto, "refresh_token": refresh},
          open(ruta, "w"), indent=2)
PY
chmod 600 "$CREDS_FILE"

echo
echo "Guardado en $CREDS_FILE (chmod 600, fuera del repositorio)."
echo "Abre el panel de calendario: se sincronizará solo."
