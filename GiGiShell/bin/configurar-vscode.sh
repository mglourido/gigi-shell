#!/usr/bin/env bash
# Fija el almacén de secretos de VS Code en ~/.vscode/argv.json (fuera del repo: es
# estado de usuario, y el fichero lleva además el crash-reporter-id de la máquina).
#
# EL PORQUÉ. VS Code guarda sus secretos (tokens de GitHub, cuentas de extensiones,
# Settings Sync) cifrados con la clave del keyring del escritorio, que pide por D-Bus
# como `org.freedesktop.secrets`. En una sesión de GiGiShell NO HAY NADIE que ofrezca ese
# nombre: KWallet/ksecretd está retirado a propósito (ver hypr/gigishell/autostart.lua,
# pedía la contraseña del monedero en CADA arranque) y gnome-keyring no se instala. Con
# autologin tampoco serviría: PAM no ve ninguna contraseña con la que desbloquear el
# llavero, así que gnome-keyring volvería a preguntar una vez por sesión.
#
# El resultado, en una instalación recién hecha, es un cartel modal en cada arranque de
# VS Code ("An OS keyring couldn't be identified...") con dos botones, ninguno de los
# cuales recuerda la respuesta de forma fiable. `password-store=basic` es el segundo de
# esos botones, pero escrito de forma permanente: VS Code cifra con una clave fija en vez
# de con el keyring. Es el mismo modelo de amenaza que el resto de credenciales del
# sistema (~/.config/gigishell/spotify-creds.json y google-calendar-creds.json, en texto
# plano con chmod 600): quien pueda leer tu $HOME puede leerlas.
#
# OJO CON EL FORMATO: argv.json es JSONC — JSON *con comentarios*, y VS Code los escribe
# él mismo con explicaciones de cada clave. Por eso aquí no se usa jq (que aborta ante un
# `//`) ni se regenera el fichero: se inserta la clave respetando lo que ya hubiera,
# incluido el crash-reporter-id, que si se pierde VS Code genera otro distinto.
set -euo pipefail

modo="${1:-aplicar}"
case "$modo" in
  aplicar|--check) ;;
  *) printf 'uso: %s [aplicar|--check]\n' "${0##*/}" >&2; exit 2 ;;
esac

archivo="${VSCODE_ARGV_JSON:-$HOME/.vscode/argv.json}"
almacen="${VSCODE_PASSWORD_STORE:-basic}"

# El valor actual, o vacío si la clave no está. Se ignoran las líneas comentadas para que
# el ejemplo comentado que trae VS Code de fábrica no cuente como valor puesto.
# El `|| true` NO es decorativo y el `return 0` tampoco: con `set -euo pipefail`, un grep
# sin coincidencias (el caso normal: la clave todavía no está) hace fallar el pipeline
# entero, y `actual="$(valor_actual)"` mata el script AHÍ MISMO, sin un solo mensaje. El
# efecto era que sobre un argv.json de fábrica esto no hacía nada y no lo decía.
valor_actual() {
  [[ -f "$archivo" ]] || return 0
  sed -e 's://.*::' "$archivo" \
    | { grep -o '"password-store"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } \
    | tail -n1 \
    | sed -e 's/.*"\([^"]*\)"$/\1/'
  return 0
}

actual="$(valor_actual)"

if [[ "$modo" == --check ]]; then
  if [[ "$actual" == "$almacen" ]]; then
    exit 0
  fi
  if [[ ! -f "$archivo" ]]; then
    echo "ERROR: no existe $archivo (¿VS Code no se ha abierto nunca?); password-store sin fijar." >&2
  else
    printf 'ERROR: %s password-store=%q; esperado %q\n' "$archivo" "$actual" "$almacen" >&2
  fi
  exit 1
fi

if [[ "$actual" == "$almacen" ]]; then
  echo "VS Code ya usa password-store=$almacen; no toco $archivo."
  exit 0
fi

mkdir -p "${archivo%/*}"

# VS Code crea argv.json la primera vez que arranca. Si todavía no existe se escribe uno
# mínimo: uno con solo esta clave es válido y VS Code le añade sus comentarios y su
# crash-reporter-id cuando lo reescriba.
if [[ ! -f "$archivo" ]]; then
  printf '{\n\t"password-store": "%s"\n}\n' "$almacen" > "$archivo"
  echo "Creado $archivo con password-store=$almacen."
  exit 0
fi

cp -p "$archivo" "$archivo.bak"

if [[ -n "$actual" ]]; then
  # La clave está con otro valor: se sustituye en su sitio, sin mover nada más.
  sed -i 's/\("password-store"[[:space:]]*:[[:space:]]*\)"[^"]*"/\1"'"$almacen"'"/' "$archivo"
else
  # No está: se inserta antes de la llave de cierre final, poniendo la coma que falte en
  # la última línea con contenido (que puede no ser la anterior: VS Code deja comentarios
  # y líneas en blanco entre medias).
  awk -v almacen="$almacen" '
    { lineas[NR] = $0 }
    END {
      cierre = 0
      for (i = NR; i >= 1; i--) if (lineas[i] ~ /^[[:space:]]*}[[:space:]]*$/) { cierre = i; break }
      if (cierre == 0) { print "SIN_CIERRE" > "/dev/stderr"; exit 1 }
      ultima = 0
      for (i = cierre - 1; i >= 1; i--) {
        linea = lineas[i]
        sub(/\/\/.*$/, "", linea)
        if (linea ~ /[^[:space:]]/) { ultima = i; break }
      }
      for (i = 1; i < cierre; i++) {
        if (i == ultima && lineas[i] !~ /,[[:space:]]*$/ && lineas[i] !~ /{[[:space:]]*$/)
          print lineas[i] ","
        else
          print lineas[i]
      }
      print ""
      print "\t// Fijado por GiGiShell (bin/configurar-vscode.sh): esta sesión no ofrece"
      print "\t// org.freedesktop.secrets, así que sin esto VS Code pide el llavero del"
      print "\t// sistema en cada arranque. Ver el porqué en la cabecera de ese script."
      print "\t\"password-store\": \"" almacen "\""
      for (i = cierre; i <= NR; i++) print lineas[i]
    }
  ' "$archivo.bak" > "$archivo" || {
    mv -f "$archivo.bak" "$archivo"
    echo "ERROR: no encontré la llave de cierre en $archivo; lo dejo como estaba." >&2
    exit 1
  }
fi

# Verificación después de escribir: un sed/awk que no encaje dejaría el fichero intacto
# sin dar error, y el cartel seguiría saliendo en cada arranque sin que nadie lo supiera.
if [[ "$(valor_actual)" != "$almacen" ]]; then
  mv -f "$archivo.bak" "$archivo"
  echo "ERROR: no pude fijar password-store en $archivo; restaurada la copia previa." >&2
  exit 1
fi

rm -f "$archivo.bak"
echo "VS Code configurado: password-store=$almacen en $archivo (surte efecto al reiniciar VS Code)."
