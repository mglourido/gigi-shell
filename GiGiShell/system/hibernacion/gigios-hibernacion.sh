#!/usr/bin/env bash
# gigios-hibernacion — fija el retardo de HIBERNACIÓN DURANTE LA SUSPENSIÓN.
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigios-hibernacion (install.sh, paso
# `hibernacion`). NO se symlinkea desde ~/GiGiShell: corre como root vía /etc/sudoers.d/gigios-hibernacion,
# y apuntar a un script escribible por el usuario sería una escalada silenciosa (misma regla que el
# helper de TLP, el de cámara y el de limpieza; ver CLAUDE.md).
#
# ¿Por qué hace falta root para "un número de minutos"? Porque el temporizador NO es nuestro: es
# `HibernateDelaySec` de systemd, que solo se lee de /etc/systemd/sleep.conf y sus drop-ins. Es el
# plazo que `systemctl suspend-then-hibernate` usa para armar una ALARMA RTC antes de dormirse: el
# equipo despierta solo al vencer y se hiberna. Ese despertar-y-hibernar es la única forma de contar
# tiempo con el userspace congelado — hypridle, AGS y este script están todos parados durante un S3,
# así que un temporizador en espacio de usuario NO PUEDE existir aquí. De ahí que el timer general de
# inactividad (hypridle) y este sean mecanismos distintos aunque la UI enseñe un solo número.
#
# Uso:  gigios-hibernacion {retardo <segundos>|estado}
#   retardo N  escribe [Sleep] HibernateDelaySec=N en el drop-in (atómico). N=0 borra el drop-in.
#   estado     imprime `disponible=` / `motivo=` / `retardo=` (no necesita root).
set -euo pipefail

DROPIN=/etc/systemd/sleep.conf.d/99-gigios-hibernacion.conf

usage() { echo "uso: ${0##*/} {retardo <segundos>|estado}" >&2; exit 2; }

# Lee el retardo vigente del drop-in. 0 = no hay retardo puesto por GiGiShell.
leer_retardo() {
  local n
  n=$(sed -n 's/^[[:space:]]*HibernateDelaySec[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' "$DROPIN" 2>/dev/null | tail -1)
  printf '%s' "${n:-0}"
}

# ¿Puede hibernar esta máquina? Se lo preguntamos a logind, que es quien lo sabe de verdad:
# comprueba swap suficiente Y `resume=` en la línea de comandos del kernel. Un `systemctl hibernate`
# a pelo aquí serviría de poco — respondería fallando, y ya estaríamos hibernando.
#
# Respuestas de logind: "yes" | "no" | "na" (no disponible: falta swap o resume=) | "challenge"
# (haría falta autenticar; para nosotros es tan bueno como "yes", porque quien lo pide es una sesión
# local y activa). Cualquier otra cosa —o que logind no conteste— se trata como NO disponible: es el
# lado seguro, porque el único efecto es que la fila de Ajustes salga apagada con su motivo, en vez
# de un interruptor que promete algo que fallaría en silencio a las tres de la mañana.
estado() {
  local can="" motivo=""
  if command -v busctl >/dev/null 2>&1; then
    can=$(busctl --no-pager call org.freedesktop.login1 /org/freedesktop/login1 \
            org.freedesktop.login1.Manager CanHibernate 2>/dev/null \
          | sed -n 's/^s "\(.*\)"$/\1/p')
  fi
  case "$can" in
    yes|challenge) printf 'disponible=si\nmotivo=\n' ;;
    na)  printf 'disponible=no\nmotivo=sin-swap-o-sin-resume\n' ;;
    no)  printf 'disponible=no\nmotivo=prohibido-por-politica\n' ;;
    *)   printf 'disponible=no\nmotivo=logind-no-responde\n' ;;
  esac
  printf 'retardo=%s\n' "$(leer_retardo)"
}

case "${1:-}" in
  estado)
    [[ $# -eq 1 ]] || usage
    estado
    ;;
  retardo)
    [[ $# -eq 2 ]] || usage
    # Validación ESTRICTA aquí y no en la regla sudoers: el comodín de sudoers es lo que abre la
    # puerta, este `[[ =~ ]]` es lo que decide qué entra. Sin él, un argumento con espacios o `..`
    # llegaría al printf de abajo.
    [[ "$2" =~ ^[0-9]+$ ]] || { echo "el retardo debe ser un número de segundos" >&2; exit 2; }
    # Techo de 24 h. No es paranoia de seguridad (el fichero solo lo lee systemd), es que un
    # HibernateDelaySec absurdo arma una alarma RTC absurda y el equipo se queda suspendido para
    # siempre creyendo que va a hibernar.
    (( $2 <= 86400 )) || { echo "retardo fuera de rango (máximo 86400)" >&2; exit 2; }
    if (( $2 == 0 )); then
      rm -f "$DROPIN"
      echo 0
      exit 0
    fi
    install -d -m 755 "$(dirname "$DROPIN")"
    tmp="$(mktemp "${DROPIN}.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    cat > "$tmp" <<EOF
# Generado por GiGiShell (Ajustes > Pantalla > Suspensión). No lo edites a mano:
# lo reescribe /usr/local/bin/gigios-hibernacion cada vez que se cambia el tiempo.
[Sleep]
HibernateDelaySec=$2
EOF
    chmod 644 "$tmp"
    mv -f "$tmp" "$DROPIN"
    trap - EXIT
    echo "$2"
    ;;
  *) usage ;;
esac
