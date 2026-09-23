// servicios/energia/gamemode.ts
//
// Interruptor manual de **Feral GameMode** (paquete `gamemode`), el que sale en el
// encabezado de Quick Settings al lado de la campana. GameMode es lo que de verdad
// reduce la carga del SISTEMA mientras juegas: sube el gobernador de CPU a
// `performance`, ajusta prioridades/ioprio y aplica los tweaks de GPU que tenga
// configurados. No lo confundas con `gamingState.ts`, que es lo NUESTRO: detectar
// que hay un juego abierto para congelar los sondeos de mantenimiento del shell.
// Son complementarios y no se hablan.
//
// **Cómo se enciende, y por qué con un proceso hijo.** GameMode no tiene un
// "modo global": el demonio lo mantiene activo mientras haya al menos un cliente
// REGISTRADO, y libera en cuanto ese cliente muere. `gamemoded -r` sin PID es
// justo eso — se registra y se queda pausado —, así que el hijo ES el registro:
// mientras vive, GameMode está activo; al matarlo, el demonio devuelve el sistema
// a su estado normal él solo. La alternativa (registrar el PID de AGS por D-Bus)
// se descartó: GameMode renicia a quien registra, y renicear el shell para pedir
// un ajuste de CPU que no es suyo es un efecto colateral gratuito.
//
// **Que el hijo muera es el camino SEGURO, no un fallo**: si AGS se cae, el
// registro se va con él y el sistema vuelve solo. Lo único que hay que limpiar es
// el caso contrario — un hijo huérfano sobreviviendo a un AGS muerto dejaría el
// gobernador clavado en `performance` sin UI donde apagarlo (mismo razonamiento
// que `initWakeUp()`), y de ahí `initGamemode()`.
//
// El hijo se lanza con un argv0 propio (`gigios-gamemode`) por lo mismo que el
// coproceso de `screencast-monitor.sh`: hace que la limpieza por `pkill -f` sea
// inequívoca y no pueda llevarse por delante un `gamemoded` ajeno.
//
// Estado SOLO en RAM, por sesión: al reiniciar el shell no hay registro que valga,
// así que persistirlo solo podría mentir.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"

const ARGV0 = "gigios-gamemode"

/** ¿Está instalado el paquete `gamemode`? Sin él la UI oculta el botón. */
export const gamemodeAvailable = GLib.find_program_in_path("gamemoded") !== null

export const [gamemodeActive, setGamemodeActive] = createState(false)

let proc: Gio.Subprocess | null = null
// Distingue "lo he apagado yo" de "el hijo se ha muerto solo", que es lo único
// que merece aviso.
let stopping = false

function notify(urgency: string, body: string): void {
  try {
    Gio.Subprocess.new(
      ["notify-send", "-u", urgency, "-h", "string:x-gigios-source:system",
       "-h", "string:x-gigios-event:juegos.modo-juego", "Modo juego", body],
      Gio.SubprocessFlags.NONE,
    )
  } catch (e) {
    console.error("[gamemode] notify falló:", e)
  }
}

function start(): void {
  if (proc) return
  try {
    // STDERR_PIPE + communicate_utf8_async: el callback se dispara al SALIR el
    // hijo y trae su stderr, así que el mismo camino sirve para (a) enterarnos de
    // que GameMode ya no está y (b) poder decir por qué si el arranque falla.
    proc = Gio.Subprocess.new(
      ["bash", "-c", `exec -a ${ARGV0} gamemoded -r`],
      Gio.SubprocessFlags.STDERR_PIPE,
    )
  } catch (e) {
    console.error("[gamemode] no se pudo lanzar gamemoded -r:", e)
    notify("critical", "No se pudo activar GameMode.")
    return
  }

  stopping = false
  setGamemodeActive(true)

  const child = proc
  child.communicate_utf8_async(null, null, (p, res) => {
    let err = ""
    try {
      const [, , stderr] = (p as Gio.Subprocess).communicate_utf8_finish(res)
      err = (stderr ?? "").trim()
    } catch (e) {
      console.error("[gamemode] fin del hijo, sin poder leer stderr:", e)
    }
    if (proc !== child) return   // ya lo habíamos reemplazado; nada que hacer
    proc = null
    setGamemodeActive(false)
    if (stopping) return
    // Muerte inesperada: el demonio ya ha devuelto el sistema a la normalidad, así
    // que el estado de la UI (apagado) es correcto — pero el usuario había pedido
    // lo contrario y tiene que enterarse.
    console.error("[gamemode] el registro terminó solo:", err)
    notify("critical", err ? `GameMode se ha desactivado: ${err}` : "GameMode se ha desactivado solo.")
  })
}

function stop(): void {
  if (!proc) return
  stopping = true
  try {
    proc.send_signal(15)   // SIGTERM; el demonio libera al morir el cliente
  } catch (e) {
    console.error("[gamemode] no se pudo parar el registro:", e)
  }
  // El estado lo apaga el callback de salida, que es quien sabe de verdad que el
  // registro se ha soltado.
}

/** Devuelve el estado PEDIDO, no el vigente: apagar solo se consuma cuando el hijo
 *  muere (unos ms después), así que leer `gamemodeActive` aquí aún diría "on". */
export function toggleGamemode(): boolean {
  if (!gamemodeAvailable) return false
  if (proc) { stop(); return false }
  start()
  return gamemodeActive.get()
}

/**
 * Mata registros huérfanos de un AGS anterior. Los pid no valen como guarda aquí
 * (el hijo no escribe estado en disco), pero el argv0 propio hace la búsqueda
 * inequívoca: `gigios-gamemode` solo lo pone este módulo.
 */
export function initGamemode(): void {
  if (!gamemodeAvailable) return
  try {
    Gio.Subprocess.new(["pkill", "-f", `^${ARGV0} `], Gio.SubprocessFlags.NONE)
  } catch (e) {
    console.error("[gamemode] limpieza inicial fallida:", e)
  }
}
