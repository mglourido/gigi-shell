#!/usr/bin/env bash
# gigishell-tlp-apply — cambia el perfil TLP activo entre "normal" y "ahorro".
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigishell-tlp-apply (install.sh paso 6).
# NO se symlinkea desde ~/GiGiShell: corre como root vía la regla /etc/sudoers.d/gigishell-tlp, y
# apuntar a un script escribible por el usuario sería una escalada silenciosa (misma regla que
# la regla udev de USB y i2c-dev; ver CLAUDE.md). Sus perfiles de confianza viven en
# /etc/gigishell/tlp/, también root-owned; la copia versionada en ~/GiGiShell/system/tlp/ solo se
# vuelve efectiva al reinstalar con sudo a propósito.
#
# Uso:  gigishell-tlp-apply {normal|ahorro|status}
#   normal|ahorro  copia /etc/gigishell/tlp/<modo>.conf -> /etc/tlp.conf (atómico) y aplica `tlp start`.
#   status         imprime el modo activo (contenido de /etc/gigishell/tlp/active, o "desconocido").
set -euo pipefail

PROFILE_DIR=/etc/gigishell/tlp
TARGET=/etc/tlp.conf
ACTIVE_FILE="$PROFILE_DIR/active"

usage() { echo "uso: $0 {normal|ahorro|status}" >&2; exit 2; }

[[ $# -eq 1 ]] || usage
mode="$1"

if [[ "$mode" == "status" ]]; then
  if [[ -r "$ACTIVE_FILE" ]]; then cat "$ACTIVE_FILE"; else echo "desconocido"; fi
  exit 0
fi

[[ "$mode" == "normal" || "$mode" == "ahorro" ]] || usage

src="$PROFILE_DIR/$mode.conf"
[[ -r "$src" ]] || { echo "perfil no encontrado: $src (¿reinstalaste con install.sh?)" >&2; exit 1; }
command -v tlp >/dev/null 2>&1 || { echo "tlp no está instalado" >&2; exit 1; }

# Escritura atómica: escribe a un temporal en el mismo sistema de ficheros y renombra.
tmp="$(mktemp "${TARGET}.gigishell.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp -f "$src" "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$TARGET"
trap - EXIT

# Aplica el nuevo perfil sin reiniciar el servicio. `tlp start` relee /etc/tlp.conf.
tlp start >/dev/null

# Registra el modo activo para que AGS lo lea al arrancar (atómico también).
printf '%s\n' "$mode" > "$ACTIVE_FILE.tmp" && mv -f "$ACTIVE_FILE.tmp" "$ACTIVE_FILE"

echo "$mode"
