#!/usr/bin/env bash
# Aplica el perfil ligero de Dolphin sin versionar dolphinrc, que también guarda
# estado editable por el usuario. Idempotente y comprobable con --check.
set -euo pipefail

modo="${1:-aplicar}"
archivo=dolphinrc
miniaturizadores='ffmpegthumbs,gsthumbnail,imagethumbnail,jpegthumbnail,opendocumentthumbnail,svgthumbnail'

case "$modo" in
  aplicar|--check) ;;
  *) printf 'uso: %s [aplicar|--check]\n' "${0##*/}" >&2; exit 2 ;;
esac

command -v kreadconfig6 >/dev/null 2>&1 \
  || { echo "ERROR: falta kreadconfig6 (paquete kconfig)." >&2; exit 1; }

leer() {
  kreadconfig6 --file "$archivo" --group "$1" --key "$2"
}

comprobar() {
  local grupo="$1" clave="$2" esperado="$3" actual
  actual="$(leer "$grupo" "$clave")"
  if [[ "$actual" != "$esperado" ]]; then
    printf 'ERROR: dolphinrc [%s] %s=%q; esperado %q\n' \
      "$grupo" "$clave" "$actual" "$esperado" >&2
    return 1
  fi
}

if [[ "$modo" == --check ]]; then
  estado=0
  comprobar PreviewSettings Plugins "$miniaturizadores" || estado=1
  comprobar General RememberOpenedTabs true || estado=1
  comprobar General ShowToolTips false || estado=1
  comprobar General BrowseThroughArchives false || estado=1
  comprobar General DynamicView false || estado=1
  exit "$estado"
fi

command -v kwriteconfig6 >/dev/null 2>&1 \
  || { echo "ERROR: falta kwriteconfig6 (paquete kconfig)." >&2; exit 1; }

kwriteconfig6 --file "$archivo" --group PreviewSettings --key Plugins "$miniaturizadores"
kwriteconfig6 --file "$archivo" --group General --key RememberOpenedTabs true
kwriteconfig6 --file "$archivo" --group General --key ShowToolTips false
kwriteconfig6 --file "$archivo" --group General --key BrowseThroughArchives false
kwriteconfig6 --file "$archivo" --group General --key DynamicView false

echo "Dolphin configurado: miniaturas selectivas y restauración de pestañas activada."
