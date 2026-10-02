#!/usr/bin/env bash
# hyprlock-faillock.sh — tapa del campo de contraseña mientras pam_faillock
# tiene la cuenta bloqueada. La llama una `label` de hyprlock.conf cada segundo.
#
# POR QUÉ HACE FALTA: tras `deny` fallos seguidos (3 de fábrica) pam_faillock
# rechaza TAMBIÉN la contraseña correcta durante `unlock_time` (600 s). hyprlock
# 0.9.6 no se entera: el mensaje del módulo llega como PAM_ERROR_MSG, que solo
# va a su log, y `$FAIL` sigue diciendo "Authentication failed". Desde fuera
# parece que la contraseña está mal.
#
# POR QUÉ UNA TAPA Y NO DESACTIVAR EL CAMPO: hyprlock no tiene opción para
# ignorar el teclado, y en `input-field` no se ejecuta `cmd[]` (solo en
# `label`). Esta etiqueta tiene zindex mayor que el campo y lo cubre con un
# fondo opaco: las teclas siguen entrando al búfer, pero no se ven y no cuentan
# — durante el bloqueo pam_faillock no apunta fallos nuevos (`authfail` solo
# escribe si `check_tally` dice que no hay bloqueo), así que la espera no se
# alarga por mucho que se pulse Enter.
#
# EL TAMAÑO VA MEDIDO, no estimado: Noto Sans Mono a 10 pt da 8 px por carácter
# en Pango, y `line_height="1.75"` sube la línea a 33 px CON el fondo dentro
# (Pango 1.50+ reparte el interlineado en el rectángulo lógico del run, que es
# lo que pinta `background`). 33 columnas x 33 px = 264x33, centrado sobre un
# campo de 274x40 con `rounding = 10`: queda dentro de las esquinas redondeadas.
# Probado antes con tres líneas (relleno arriba y abajo): dejaba costuras de
# 1 px entre bandas. Si cambia el tamaño del campo, la fuente o el `font_size`
# de la etiqueta, hay que volver a medirlo.
#
# FAIL-OPEN: sin faillock, sin fichero o con cualquier dato raro imprime un
# espacio (etiqueta invisible). Lo peor que puede pasar es no avisar, nunca
# tapar el campo sin bloqueo de por medio.

set -uo pipefail
# ${#texto} cuenta caracteres, no bytes, solo con locale UTF-8 ("·" son dos bytes).
export LC_ALL=C.UTF-8

nada() { printf ' \n'; exit 0; }

CONF="${FAILLOCK_CONF:-/etc/security/faillock.conf}"
AHORA="${FAILLOCK_AHORA:-$(date +%s)}"
USUARIO="${USER:-$(id -un)}"

# Valores de fábrica de pam_faillock (man 5 faillock.conf).
deny=3
unlock_time=600
fail_interval=900
dir=/var/run/faillock

if [[ -r "$CONF" ]]; then
    while IFS='=' read -r clave valor; do
        clave="${clave//[[:space:]]/}"
        valor="${valor//[[:space:]]/}"
        case "$clave" in
            deny|unlock_time|fail_interval) [[ "$valor" =~ ^[0-9]+$ ]] && printf -v "$clave" '%s' "$valor" ;;
            dir) [[ -n "$valor" ]] && dir="$valor" ;;
        esac
    done < <(grep -E '^[[:space:]]*(deny|unlock_time|fail_interval|dir)[[:space:]]*=' "$CONF")
fi

# Camino rápido: se ejecuta cada segundo y casi siempre no hay nada apuntado.
[[ -s "$dir/$USUARIO" ]] || nada
(( deny > 0 )) || nada

ultimo=0
declare -a tiempos=()
while read -r fecha hora _ valido; do
    [[ "$valido" == V ]] || continue
    t=$(date -d "$fecha $hora" +%s 2>/dev/null) || continue
    tiempos+=("$t")
    (( t > ultimo )) && ultimo=$t
done < <(faillock --dir "$dir" --user "$USUARIO" 2>/dev/null | awk 'NF >= 4 && $NF ~ /^[VI]$/ { print $1, $2, $3, $NF }')

(( ultimo > 0 )) || nada

# Mismo criterio que check_tally(): fallos dentro de fail_interval contados
# desde el más reciente, y el bloqueo dura unlock_time desde ese mismo.
fallos=0
for t in "${tiempos[@]}"; do
    (( t > ultimo - fail_interval )) && (( fallos++ ))
done
(( fallos >= deny )) || nada

if (( unlock_time == 0 )); then
    texto="Bloqueado hasta reiniciar"
else
    resto=$(( ultimo + unlock_time - AHORA ))
    (( resto > 0 )) || nada
    texto=$(printf 'Bloqueado · espera %d:%02d' $(( resto / 60 )) $(( resto % 60 )))
fi

# 33 columnas de 8 px = 264 px; el texto va centrado con espacios a los lados.
ancho=33
largo=${#texto}
izq=$(( (ancho - largo) / 2 ))
der=$(( ancho - largo - izq ))
printf '<span line_height="1.75" background="#16191d">%*s%s%*s</span>\n' "$izq" '' "$texto" "$der" ''
