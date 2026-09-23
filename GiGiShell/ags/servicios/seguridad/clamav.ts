// servicios/seguridad/clamav.ts
//
// Base de firmas de ClamAV: estado + botón "actualizar ahora".
//
// POR QUÉ EXISTE: sin firmas, `clamscan` sale con código 2 y el escáner de descargas
// (hypr/scripts/oom-monitor.sh) NO da nada por analizado — avisa una vez por sesión y se queda
// esperando. Ese aviso decía "ejecuta sudo freshclam (o activa clamav-freshclam.service)" y no
// había ningún sitio en la UI donde hacerlo: había que acordarse de abrir una terminal.
//
// /var/lib/clamav es de `clamav` y habilitar el servicio es de root, así que AGS no actualiza
// nada por su cuenta: delega en un helper root-owned instalado por install.sh
// (/usr/local/bin/gigishell-clamav-update), autorizado sin contraseña por /etc/sudoers.d/gigishell-clamav
// SOLO para sus dos argumentos fijos. Mismo esquema que servicios/energia/tlp.ts; ver la sección
// "Firmas de ClamAV" del CLAUDE.md raíz.
//
// LEER el estado, en cambio, NO necesita sudo y por eso no pasa por el helper: la fecha sale del
// mtime de la base (world-readable) y el estado del servicio periódico de `systemctl is-enabled`,
// que cualquiera puede consultar. Preguntarle al sistema es lo único que no puede mentir: el
// helper puede estar instalado y el servicio apagado a mano.
//
// ── EL AUTOMÁTICO YA NO ES `clamav-freshclam`, Y NO HAY NINGÚN TEMPORIZADOR ────────────────
// Aquel interruptor encendía y apagaba el servicio, o sea que la actualización iba POR PERIODO
// (cada N horas, hiciera falta o no) y su estado vivía en systemd. Hoy el interruptor es un
// BOOLEANO de GiGiShell (`clamavAutoUpdate` en security.json, ver modulos/ajustes/seguridad/
// preferencias.ts) y quien actualiza es hypr/scripts/actualizar-firmas.sh --auto **una sola vez,
// al arrancar Hyprland**, en silencio y solo si la base falta o pasa de un día. Durante la sesión
// no queda nada corriendo: ni reloj, ni servicio, ni reintentos.
//
// **Este módulo tampoco sondea nada.** `refreshClamavState()` se llama al montar la tarjeta y tras
// una orden del helper — no hay `setInterval` ni `Gio.FileMonitor`. Si se añade uno algún día,
// será el primer temporizador de ClamAV del sistema y hay que justificarlo aquí.
//
// Se conserva la lectura de `systemctl is-enabled` por una razón concreta: si el servicio se quedó
// habilitado de la etapa anterior habría un actualizador periódico invisible. Con el booleano
// encendido se apaga UNA vez, en silencio, vía el helper (`auto-off`, ya autorizado en la regla
// sudoers). No se vuelve a tocar: si el usuario lo reactiva a mano por su cuenta, se le enseña el
// estado y se le deja en paz.
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"
import { clamavAutoUpdatePref } from "../../modulos/ajustes/seguridad/preferencias"

const HELPER = "/usr/local/bin/gigishell-clamav-update"
const DB_DIR = "/var/lib/clamav"
const UNIT = "clamav-freshclam.service"
// daily es la que se mueve a diario; main/bytecode cambian cada meses. La más reciente de las tres
// es la que responde "¿está al día esto?".
const DB_FILES = ["daily.cld", "daily.cvd", "main.cvd"]

/** ¿Hay ClamAV en la máquina? Sin él la tarjeta entera sobra: no hay firmas de las que hablar. */
export const clamavPresent = GLib.find_program_in_path("freshclam") !== null

/**
 * ¿Está el helper root-owned en su sitio (install.sh paso 9)? Sin él el botón no puede funcionar,
 * pero **la tarjeta se sigue pintando**, y esa es una diferencia deliberada con el selector TLP.
 * Allí "falta TLP" significa "esta función no aplica a esta máquina" y ocultarla es correcto; aquí
 * significa "te falta un paso de instalación", y esconderlo reproduce exactamente el problema que
 * esta tarjeta viene a resolver: un arreglo que existe pero que no hay dónde encontrar. Con el
 * helper ausente se enseña el estado igual (fecha, servicio) y el botón cede el sitio a la orden
 * que hay que ejecutar una vez.
 */
export const clamavHelperInstalled = GLib.file_test(HELPER, GLib.FileTest.EXISTS)

/** Fecha (epoch, segundos) de la base más reciente; `null` si no hay ninguna. */
function readDbEpoch(): number | null {
  let newest: number | null = null
  for (const name of DB_FILES) {
    try {
      const info = Gio.File.new_for_path(`${DB_DIR}/${name}`).query_info(
        "time::modified", Gio.FileQueryInfoFlags.NONE, null,
      )
      const t = info.get_attribute_uint64("time::modified")
      if (t && (newest === null || t > newest)) newest = t
    } catch (_) {
      // Fichero ausente: es lo normal (daily.cld o daily.cvd, no las dos).
    }
  }
  return newest
}

export const [clamavDbEpoch, _setClamavDbEpoch] = createState<number | null>(readDbEpoch())
// Estado del servicio PERIÓDICO heredado (`clamav-freshclam`). Ya no es el interruptor de nada:
// solo sirve para detectar que sigue encendido y apagarlo (ver `apagarServicioPeriodico`).
// `null` = todavía no se ha podido consultar (no es lo mismo que "desactivado"), igual que el
// `boolean | null` de teclaCedidaAHyprland.
export const [clamavServicioPeriodico, _setClamavServicioPeriodico] = createState<boolean | null>(null)
export const [clamavBusy, _setClamavBusy] = createState(false)

function notify(urgency: string, body: string): void {
  try {
    Gio.Subprocess.new(
      ["notify-send", "-u", urgency, "-h", "string:x-gigishell-source:system",
       "-h", "string:x-gigishell-event:antivirus.estado", "Antivirus", body],
      Gio.SubprocessFlags.NONE,
    )
  } catch (e) {
    console.error("[clamav] notify falló:", e)
  }
}

/** Relee fecha de la base y estado del servicio. Sin sudo y sin bloquear. */
export function refreshClamavState(): void {
  _setClamavDbEpoch(readDbEpoch())
  let proc: Gio.Subprocess
  try {
    proc = Gio.Subprocess.new(["systemctl", "is-enabled", UNIT], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
  } catch (e) {
    console.error("[clamav] no se pudo consultar el servicio:", e)
    return
  }
  proc.communicate_utf8_async(null, null, (p, res) => {
    try {
      const [, stdout] = (p as Gio.Subprocess).communicate_utf8_finish(res)
      const v = (stdout ?? "").trim()
      // "enabled", "enabled-runtime" o "static" = el servicio periódico sigue vivo. Cualquier
      // otra cosa (disabled, masked, o la unidad no existe) = no.
      const activo = v === "enabled" || v === "enabled-runtime" || v === "static"
      _setClamavServicioPeriodico(activo)
      // Un solo actualizador. Si el booleano de GiGiShell está encendido, el servicio periódico
      // sobra: se apaga una vez y en silencio (el usuario no ha pedido esto, así que no se le
      // notifica; y si falla, tampoco pasa nada grave: solo quedan dos actualizadores).
      if (activo && clamavAutoUpdatePref.get()) apagarServicioPeriodico()
    } catch (e) {
      console.error("[clamav] no se pudo leer el estado del servicio:", e)
    }
  })
}

/**
 * Ejecuta el helper con `sudo -n` y reconcilia el estado al terminar. `-n` evita colgarse pidiendo
 * contraseña: sin la regla sudoers falla en el acto en vez de bloquear la UI para siempre.
 * `clamavBusy` es de los dos comandos a la vez a propósito: apagar la actualización automática a
 * mitad de una descarga de firmas dejaría la UI describiendo un estado que aún se está moviendo.
 */
function runHelper(arg: string, exito: string, fallo: string): void {
  if (!clamavHelperInstalled) return
  if (clamavBusy.get()) return

  _setClamavBusy(true)
  let proc: Gio.Subprocess
  try {
    proc = Gio.Subprocess.new(
      ["sudo", "-n", HELPER, arg],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    )
  } catch (e) {
    _setClamavBusy(false)
    console.error("[clamav] no se pudo lanzar el helper:", e)
    notify("critical", fallo)
    return
  }

  proc.communicate_utf8_async(null, null, (p, res) => {
    _setClamavBusy(false)
    let ok = false
    let err = ""
    try {
      const [, , stderr] = (p as Gio.Subprocess).communicate_utf8_finish(res)
      ok = (p as Gio.Subprocess).get_successful()
      err = (stderr ?? "").trim().split("\n").slice(-3).join(" ")
    } catch (e) {
      console.error("[clamav] no se pudo leer el resultado del helper:", e)
    }
    // Siempre, también al fallar: el estado que se pinta sale de preguntarle al sistema, nunca de
    // suponer que la orden hizo lo que decía.
    refreshClamavState()
    if (ok) {
      notify("normal", exito)
    } else {
      console.error("[clamav] el helper falló:", err)
      notify("critical", err
        ? `${fallo} ${err}`
        : `${fallo} ¿Está la regla sudoers instalada (install.sh)?`)
    }
  })
}

/**
 * Actualiza las firmas ahora. Puede tardar (descarga ~200 MB la primera vez), de ahí `clamavBusy`.
 * Usa `update` y **no** `update-enable`: con un interruptor de actualización automática al lado,
 * reencender el servicio desde aquí cambiaría un ajuste que el usuario no ha tocado.
 */
export function updateClamavDb(): void {
  runHelper("update",
    "Firmas de ClamAV actualizadas. El escáner de descargas ya puede analizar.",
    "No se pudieron actualizar las firmas de ClamAV.")
}

/**
 * Apaga el servicio periódico heredado (`clamav-freshclam`) EN SILENCIO. No pasa por `runHelper`
 * a propósito: aquello notifica el resultado y reconcilia el estado, y aquí no hay nada que
 * contarle a nadie — el usuario no ha pedido esta orden, es limpieza de la etapa anterior. Ni
 * siquiera toma `clamavBusy`: bloquear el botón "Actualizar ahora" por una tarea de fondo que el
 * usuario no ve sería un botón muerto sin explicación.
 */
function apagarServicioPeriodico(): void {
  if (!clamavHelperInstalled) return
  try {
    const proc = Gio.Subprocess.new(
      ["sudo", "-n", HELPER, "auto-off"],
      Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
    proc.wait_async(null, () => { _setClamavServicioPeriodico(false) })
  } catch (e) {
    console.error("[clamav] no se pudo apagar el servicio periódico:", e)
  }
}
