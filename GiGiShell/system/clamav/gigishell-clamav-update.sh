#!/usr/bin/env bash
# gigishell-clamav-update — helper interno de AGS para actualizar las firmas de ClamAV y apagar el
# servicio periódico heredado `clamav-freshclam`.
#
# OJO AL LEER LO DE ABAJO: desde el cambio a un interruptor booleano, "mantener las firmas al día"
# ya NO es este servicio. Lo hace `hypr/scripts/actualizar-firmas.sh --auto` cuando hace falta (al
# iniciar sesión, o cuando un análisis se encuentra la base ausente o vieja), leyendo
# `clamavAutoUpdate` de ~/.config/gigishell/security.json. Este helper solo expone dos verbos internos:
# `update` (los dos botones y el arranque) y `auto-off` (AGS apaga el servicio si lo encuentra
# activo, para no dejar un actualizador periódico invisible). Ver "Firmas de ClamAV desde la UI"
# en docs/hyprland-modulos.md.
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigishell-clamav-update (install.sh paso 9).
# NO se symlinkea desde ~/GiGiShell: corre como root vía /etc/sudoers.d/gigishell-clamav, y apuntar a un
# script escribible por el usuario sería una escalada silenciosa (misma regla que el helper de TLP,
# la regla udev de USB y i2c-dev; ver CLAUDE.md). La copia versionada en ~/GiGiShell/system/clamav/
# solo se vuelve efectiva al reinstalar con sudo a propósito.
#
# POR QUÉ ROOT: /var/lib/clamav es de `clamav:clamav` y el log de freshclam está en /var/log/clamav.
# freshclam suelta privilegios él solo (DatabaseOwner), pero necesita poder escribir ahí; detener,
# iniciar y deshabilitar el servicio son operaciones de root.
#
# Uso interno: gigishell-clamav-update {update|auto-off}
#   update        detiene el servicio (si corre), actualiza SÍNCRONAMENTE con freshclam y lo deja
#                 COMO ESTABA. Imprime el resultado; sale != 0 si la actualización falló.
#   auto-off      deshabilita y detiene el servicio periódico heredado.
set -uo pipefail

UNIT=clamav-freshclam.service
DB_DIR=/var/lib/clamav

unit_exists() {
  local state
  state=$(systemctl show --property=LoadState "$UNIT" 2>/dev/null) || return 1
  [[ -n "$state" && "$state" != LoadState=not-found ]]
}

db_date() {
  local newest="" f
  for f in "$DB_DIR"/daily.cld "$DB_DIR"/daily.cvd "$DB_DIR"/main.cvd; do
    [[ -f "$f" ]] || continue
    [[ -z "$newest" || "$f" -nt "$newest" ]] && newest="$f"
  done
  if [[ -n "$newest" ]]; then date -r "$newest" '+%Y-%m-%d %H:%M'; else echo desconocida; fi
}

case "${1:-}" in
  # El servicio periódico no es el interruptor de AGS: la actualización automática ocurre al
  # iniciar sesión cuando el booleano está activo. `update` solo respeta el estado previo del servicio.
  update) ;;
  auto-off)
    unit_exists || { echo "no existe $UNIT en esta distro" >&2; exit 1; }
    # `disable --now` para y deshabilita: "que no se actualice solo" incluye no dejar el timer
    # interno del demonio corriendo hasta el próximo reinicio.
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || { echo "no pude deshabilitar $UNIT" >&2; exit 1; }
    echo disabled; exit 0 ;;
  *) echo "uso interno: $0 {update|auto-off}" >&2; exit 2 ;;
esac

command -v freshclam >/dev/null 2>&1 || { echo "freshclam no está instalado" >&2; exit 1; }

# El servicio mantiene abierto (y bloqueado) freshclam.log, así que un freshclam suelto con el
# demonio corriendo aborta con "locked by another process". Se para, se actualiza en primer plano
# —así hay código de salida y salida que enseñarle al usuario, cosa que un `systemctl restart` no
# da— y se vuelve a levantar. La ventana sin demonio es de segundos.
restaurar_pendiente=false
actualizacion_completada=false
restaurar_servicio() {
  $restaurar_pendiente || return 0
  # Dos intentos acotados cubren errores transitorios, tanto en el flujo normal como al salir por señal.
  if systemctl start "$UNIT" >/dev/null 2>&1 \
    || systemctl start "$UNIT" >/dev/null 2>&1; then
    restaurar_pendiente=false
    return 0
  fi
  echo "no pude restaurar $UNIT" >&2
  return 1
}

al_salir() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  if ! $actualizacion_completada && $restaurar_pendiente; then
    restaurar_servicio || rc=1
  fi
  exit "$rc"
}

# Si se cierra la sesión, se cancela el proceso o ocurre un error inesperado tras parar el servicio,
# el trap de salida intenta dejarlo activo otra vez. SIGKILL y un apagado brusco no son atrapables.
trap al_salir EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if unit_exists && systemctl is-active --quiet "$UNIT"; then
  restaurar_pendiente=true
  systemctl stop "$UNIT" >/dev/null 2>&1 || {
    echo "no pude detener $UNIT; no se ejecutó freshclam" >&2
    exit 1
  }
fi

rc=0
freshclam --stdout || rc=$?

# Dejar el servicio como estaba. Si la unidad no existe (distro sin ese nombre), la actualización
# manual ya se hizo y no es un error.
service_rc=0
restaurar_servicio || service_rc=1
actualizacion_completada=true

if (( rc == 0 )); then
  if (( service_rc == 0 )); then
    echo "firmas actualizadas ($(db_date))"
  else
    echo "firmas actualizadas, pero no se pudo dejar $UNIT en el estado solicitado" >&2
    rc=1
  fi
else
  echo "freshclam falló (código $rc)" >&2
  (( service_rc == 0 )) || rc=1
fi
exit "$rc"
