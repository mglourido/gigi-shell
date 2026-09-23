#!/usr/bin/env bash
# gigios-clamav-update — actualiza la base de firmas de ClamAV (y, con verbos aparte, gobierna el
# servicio periódico heredado `clamav-freshclam`).
#
# OJO AL LEER LO DE ABAJO: desde el cambio a un interruptor booleano, "mantener las firmas al día"
# ya NO es este servicio. Lo hace `hypr/scripts/actualizar-firmas.sh --auto` cuando hace falta (al
# iniciar sesión, o cuando un análisis se encuentra la base ausente o vieja), leyendo
# `clamavAutoUpdate` de ~/.config/gigios/security.json. De los cinco verbos de aquí abajo, la regla
# sudoers solo autoriza DOS: `update` (los dos botones y el arranque) y `auto-off` (AGS apaga el
# servicio si lo encuentra vivo, para no dejar un actualizador periódico invisible). `update-enable`
# y `auto-on` siguen existiendo pero ya no los llama nadie y **no se pueden ejecutar sin
# contraseña**; `status` no necesita root. Ver la sección "Firmas de ClamAV desde la UI" de
# docs/hyprland-modulos.md.
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigios-clamav-update (install.sh paso 9).
# NO se symlinkea desde ~/GiGiShell: corre como root vía /etc/sudoers.d/gigios-clamav, y apuntar a un
# script escribible por el usuario sería una escalada silenciosa (misma regla que el helper de TLP,
# la regla udev de USB y i2c-dev; ver CLAUDE.md). La copia versionada en ~/GiGiShell/system/clamav/
# solo se vuelve efectiva al reinstalar con sudo a propósito.
#
# POR QUÉ ROOT: /var/lib/clamav es de `clamav:clamav` y el log de freshclam está en /var/log/clamav.
# freshclam suelta privilegios él solo (DatabaseOwner), pero necesita poder escribir ahí y
# `systemctl enable --now` es de root por definición.
#
# Uso:  gigios-clamav-update {update|update-enable|auto-on|auto-off|status}
#   update        detiene el servicio (si corre), actualiza SÍNCRONAMENTE con freshclam y lo deja
#                 COMO ESTABA. Imprime el resultado; sale != 0 si la actualización falló.
#   update-enable igual, pero además deja la actualización automática habilitada.
#   auto-on/off   solo el interruptor de actualización automática, sin descargar nada.
#   status        imprime "<enabled|disabled|missing> <fecha-de-la-base|desconocida>" (sin sudo hace
#                 falta: AGS lo lee de sysfs/systemctl por su cuenta; queda para diagnóstico manual).
set -uo pipefail

UNIT=clamav-freshclam.service
DB_DIR=/var/lib/clamav

unit_exists() { systemctl list-unit-files "$UNIT" >/dev/null 2>&1; }

db_date() {
  local newest="" f
  for f in "$DB_DIR"/daily.cld "$DB_DIR"/daily.cvd "$DB_DIR"/main.cvd; do
    [[ -f "$f" ]] || continue
    [[ -z "$newest" || "$f" -nt "$newest" ]] && newest="$f"
  done
  if [[ -n "$newest" ]]; then date -r "$newest" '+%Y-%m-%d %H:%M'; else echo desconocida; fi
}

enable_after=keep   # keep | yes | no  → qué hacer con el servicio al terminar
case "${1:-}" in
  status)
    if unit_exists; then
      systemctl is-enabled --quiet "$UNIT" && printf 'enabled ' || printf 'disabled '
    else
      printf 'missing '
    fi
    db_date
    exit 0
    ;;
  # `update` RESPETA el estado del servicio y `update-enable` lo enciende. Hoy TODOS los botones
  # usan `update`: encender el servicio periódico desde ellos añadiría un segundo actualizador
  # detrás del interruptor booleano, que es justo lo que se quitó. `update-enable` se conserva
  # para instalaciones a medio migrar y porque la regla sudoers ya lo autoriza.
  update) ;;
  update-enable) enable_after=yes ;;
  # Solo el interruptor: encender/apagar la actualización automática sin descargar nada.
  auto-on)
    unit_exists || { echo "no existe $UNIT en esta distro" >&2; exit 1; }
    systemctl enable --now "$UNIT" >/dev/null 2>&1 || { echo "no pude habilitar $UNIT" >&2; exit 1; }
    echo enabled; exit 0 ;;
  auto-off)
    unit_exists || { echo "no existe $UNIT en esta distro" >&2; exit 1; }
    # `disable --now` para y deshabilita: "que no se actualice solo" incluye no dejar el timer
    # interno del demonio corriendo hasta el próximo reinicio.
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || { echo "no pude deshabilitar $UNIT" >&2; exit 1; }
    echo disabled; exit 0 ;;
  *) echo "uso: $0 {update|update-enable|auto-on|auto-off|status}" >&2; exit 2 ;;
esac

command -v freshclam >/dev/null 2>&1 || { echo "freshclam no está instalado" >&2; exit 1; }

# El servicio mantiene abierto (y bloqueado) freshclam.log, así que un freshclam suelto con el
# demonio corriendo aborta con "locked by another process". Se para, se actualiza en primer plano
# —así hay código de salida y salida que enseñarle al usuario, cosa que un `systemctl restart` no
# da— y se vuelve a levantar. La ventana sin demonio es de segundos.
was_active=false
if unit_exists && systemctl is-active --quiet "$UNIT"; then
  was_active=true
  systemctl stop "$UNIT" >/dev/null 2>&1
fi

rc=0
freshclam --stdout || rc=$?

# Dejar el servicio como toque. Con `update` se devuelve al estado en que estaba —parar el demonio
# es un detalle de implementación de esta actualización, no una decisión del usuario—, y con
# `update-enable` se habilita. Si la unidad no existe (distro sin ese nombre), la actualización
# manual ya se hizo y no es un error.
if unit_exists; then
  if [[ "$enable_after" == yes ]]; then
    systemctl enable --now "$UNIT" >/dev/null 2>&1 \
      || { $was_active && systemctl start "$UNIT" >/dev/null 2>&1; }
  elif $was_active; then
    systemctl start "$UNIT" >/dev/null 2>&1
  fi
fi

if (( rc == 0 )); then
  echo "firmas actualizadas ($(db_date))"
else
  echo "freshclam falló (código $rc)" >&2
fi
exit "$rc"
