// servicios/energia/tlp.ts
//
// Selector manual del perfil TLP en batería: "normal" (equilibrado) vs "ahorro"
// (autonomía al máximo). TLP vive en /etc y aplicarlo (`tlp start`) necesita root,
// así que AGS NO toca /etc directamente: delega en un helper root-owned instalado
// por install.sh (/usr/local/bin/gigios-tlp-apply), autorizado sin contraseña por
// /etc/sudoers.d/gigios-tlp SOLO para los dos argumentos fijos. La copia versionada
// vive en ~/GiGiShell/system/tlp/; las de confianza en /etc/gigios/tlp/, root-owned.
// Ver la sección "Perfiles TLP" del CLAUDE.md raíz para el porqué de esta separación.
//
// Estado inicial = el modo activo que el helper dejó anotado en /etc/gigios/tlp/active
// (lectura directa del fichero, world-readable, sin sudo). Ausente = "normal".

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalBattery from "gi://AstalBattery"
import { createState } from "ags"

export type TlpMode = "normal" | "ahorro"

const HELPER = "/usr/local/bin/gigios-tlp-apply"
const ACTIVE_FILE = "/etc/gigios/tlp/active"

function batteryPresent(): boolean {
  try {
    const bat = AstalBattery.get_default()
    return !!(bat && bat.isPresent)
  } catch {
    return false
  }
}

/**
 * ¿Se puede ofrecer el selector? Hace falta TLP instalado, el helper root-owned
 * en su sitio (install.sh lo puso) y una batería real. En un sobremesa sin batería
 * o sin TLP la UI oculta la tarjeta entera, igual que el brillo sin backend DDC.
 */
export const tlpAvailable =
  GLib.find_program_in_path("tlp") !== null &&
  GLib.file_test(HELPER, GLib.FileTest.EXISTS) &&
  batteryPresent()

function readActiveMode(): TlpMode {
  try {
    const [ok, content] = GLib.file_get_contents(ACTIVE_FILE)
    if (ok) {
      const v = new TextDecoder().decode(content).trim()
      if (v === "ahorro") return "ahorro"
    }
  } catch (_) {}
  return "normal"
}

export const [tlpMode, _setTlpMode] = createState<TlpMode>(readActiveMode())
// Mientras el helper corre, la UI no debe permitir otro cambio (evita carreras
// entre dos `tlp start`).
export const [tlpBusy, _setTlpBusy] = createState(false)

function notify(urgency: string, body: string): void {
  try {
    Gio.Subprocess.new(
      ["notify-send", "-u", urgency, "-h", "string:x-gigios-source:system",
       "-h", "string:x-gigios-event:energia.perfil-tlp", "Perfil TLP", body],
      Gio.SubprocessFlags.NONE,
    )
  } catch (e) {
    console.error("[tlp] notify falló:", e)
  }
}

/**
 * Cambia el perfil activo. Ejecuta `sudo -n <helper> <mode>` de forma asíncrona;
 * solo actualiza el estado si el helper sale con éxito. `-n` evita colgarse pidiendo
 * contraseña: si la regla sudoers no está, falla en el acto en vez de bloquear.
 */
export function setTlpMode(mode: TlpMode): void {
  if (!tlpAvailable) return
  if (tlpBusy.get()) return
  if (mode === tlpMode.get()) return

  _setTlpBusy(true)
  let proc: Gio.Subprocess
  try {
    proc = Gio.Subprocess.new(
      ["sudo", "-n", HELPER, mode],
      Gio.SubprocessFlags.STDERR_PIPE,
    )
  } catch (e) {
    _setTlpBusy(false)
    console.error("[tlp] no se pudo lanzar el helper:", e)
    notify("critical", "No se pudo cambiar el perfil TLP.")
    return
  }

  proc.communicate_utf8_async(null, null, (p, res) => {
    _setTlpBusy(false)
    let ok = false
    let err = ""
    try {
      const [, , stderr] = (p as Gio.Subprocess).communicate_utf8_finish(res)
      ok = (p as Gio.Subprocess).get_successful()
      err = (stderr ?? "").trim()
    } catch (e) {
      console.error("[tlp] no se pudo leer el resultado del helper:", e)
    }
    if (ok) {
      _setTlpMode(mode)
    } else {
      // El fichero /etc/tlp.conf y el modo activo no han cambiado; releemos por si acaso.
      _setTlpMode(readActiveMode())
      console.error("[tlp] el helper falló:", err)
      notify("critical", err
        ? `No se pudo aplicar el perfil «${mode}»: ${err}`
        : `No se pudo aplicar el perfil «${mode}». ¿Está la regla sudoers instalada?`)
    }
  })
}
