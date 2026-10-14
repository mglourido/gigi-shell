// Puente del registro de juegos hacia scripts y eventd. Único escritor de
// runtime-state.json: el ahorro comparte este JSON para que dos módulos no se pisen.
// Dentro de AGS se consume el registro reactivo, nunca esta copia en disco.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { backgroundJobsSuspended } from "./powerState.ts"
import {
  clienteJuegoEnFoco,
  hayJuegosAbiertos,
  iniciarRegistroJuegos,
} from "../juegos/registro"
import { escanerJuegos } from "../../modulos/ajustes/preferences"

// Compatibilidad con imports antiguos, sin mantener un segundo booleano mutable.
export { hayJuegosAbiertos as isGaming } from "../juegos/registro"

const RUTA_ESTADO = `${GLib.get_user_config_dir()}/gigishell/runtime-state.json`
let iniciado = false
let pid = 0
let juegoEnFoco = false
let ultimoFocoJuego = 0
let ultimoEstadoPublicado = ""

function obtenerPid(): number {
  try {
    return new Gio.Credentials().get_unix_pid()
  } catch (error) {
    console.error("[gamingState] no se pudo obtener el pid:", error)
    return 0
  }
}

// `gaming` dura hasta cerrar la última ventana. `gameFocused` y `lastGameFocus`
// permiten a los sondeos aplicar cinco minutos de gracia después de perder el foco,
// sin reescribir el JSON con un temporizador. Descargas usa solo el juego abierto.
// El epoch absoluto también cubre una suspensión; el PID permite a los lectores
// descartar el estado si AGS muere. Al reiniciar siempre se publica el nuevo PID.
function publicarEstado(): void {
  const gaming = hayJuegosAbiertos.get()
  const foco = gaming && clienteJuegoEnFoco.get() !== null
  if (foco !== juegoEnFoco) {
    juegoEnFoco = foco
    ultimoFocoJuego = Math.floor(Date.now() / 1000)
  }

  // Tomar ambos valores antes de escribir evita publicar gaming:false con el foco
  // antiguo al cerrar el último juego. La guarda evita escrituras repetidas cuando
  // varias señales notifican la misma transición, o solo cambia el título del juego.
  const contenido = JSON.stringify({
    gaming,
    gameFocused: juegoEnFoco,
    lastGameFocus: ultimoFocoJuego,
    gameScanner: escanerJuegos.get(),
    powerSaveFreeze: backgroundJobsSuspended.get(),
    pid,
  })
  if (contenido === ultimoEstadoPublicado) return

  try {
    const directorio = GLib.path_get_dirname(RUTA_ESTADO)
    if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) {
      GLib.mkdir_with_parents(directorio, 0o755)
    }
    if (GLib.file_set_contents(RUTA_ESTADO, contenido)) ultimoEstadoPublicado = contenido
  } catch (error) {
    console.error("[gamingState] no se pudo publicar el estado:", error)
  }
}

export function initGamingState(): void {
  if (iniciado) return
  iniciado = true
  iniciarRegistroJuegos()
  pid = obtenerPid()
  // Reiniciar con un juego ya abierto comienza una gracia nueva, como antes.
  ultimoFocoJuego = Math.floor(Date.now() / 1000)
  publicarEstado()

  hayJuegosAbiertos.subscribe(publicarEstado)
  clienteJuegoEnFoco.subscribe(publicarEstado)
  backgroundJobsSuspended.subscribe(publicarEstado)
  // Tiene suscripción propia: cambiar el escáner sin juegos abiertos no modifica
  // el booleano, pero los lectores deben ver gameScanner actualizado igualmente.
  escanerJuegos.subscribe(publicarEstado)
}
