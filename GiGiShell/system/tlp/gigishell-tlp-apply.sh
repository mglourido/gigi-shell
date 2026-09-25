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

# Conserva el perfil anterior para poder restaurarlo si TLP rechaza el nuevo.
backup=""
backup_borrable=1
preservar_backup=0
tmp=""
active_tmp=""

limpiar_temporales() {
  [[ -z "$tmp" ]] || rm -f "$tmp" 2>/dev/null || true
  [[ -z "${active_tmp:-}" ]] || rm -f "$active_tmp" 2>/dev/null || true
  if (( backup_borrable && ! preservar_backup )) && [[ -n "$backup" ]]; then
    rm -f "$backup" 2>/dev/null || true
  fi
}

restaurar_perfil_anterior() {
  if [[ -n "$backup" ]]; then
    if mv -f "$backup" "$TARGET"; then
      backup=""
      tlp start >/dev/null || echo "aviso: tampoco se pudo reaplicar el perfil anterior" >&2
    else
      preservar_backup=1
      echo "ERROR: no se pudo restaurar $TARGET; se conserva la copia en $backup" >&2
      return 1
    fi
  else
    if rm -f "$TARGET"; then
      tlp start >/dev/null || echo "aviso: tampoco se pudo iniciar TLP sin el perfil nuevo" >&2
    else
      echo "ERROR: no se pudo retirar el perfil nuevo de $TARGET" >&2
      return 1
    fi
  fi
}
trap limpiar_temporales EXIT

if [[ -e "$TARGET" ]]; then
  backup="$(mktemp "${TARGET}.gigishell-backup.XXXXXX")"
  cp -p "$TARGET" "$backup"
  backup_borrable=0
fi

# Prepara el estado antes de reemplazar la configuración para que los fallos de
# creación/escritura del temporal no cambien /etc/tlp.conf.
active_tmp="$(mktemp "$PROFILE_DIR/active.XXXXXX")"
printf '%s\n' "$mode" > "$active_tmp"
chmod 644 "$active_tmp"

# Escritura atómica: escribe a un temporal en el mismo sistema de ficheros y renombra.
tmp="$(mktemp "${TARGET}.gigishell.XXXXXX")"
cp -f "$src" "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$TARGET"

# Aplica el nuevo perfil sin reiniciar el servicio. `tlp start` relee /etc/tlp.conf.
if ! tlp start >/dev/null; then
  echo "tlp start falló; restauro el perfil anterior" >&2
  restaurar_perfil_anterior || true
  exit 1
fi

# Registra el modo activo para que AGS lo lea al arrancar (atómico también).
if ! mv -f "$active_tmp" "$ACTIVE_FILE"; then
  echo "No pude registrar el perfil activo; restauro el perfil anterior" >&2
  restaurar_perfil_anterior || true
  exit 1
fi
active_tmp=""
backup_borrable=1

echo "$mode"
