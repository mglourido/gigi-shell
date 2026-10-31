import { createState } from "ags"
import { execAsync } from "ags/process"
import { closeAllPanels, setCalendarVisible } from "../../estado/shell"
import { suspensionFalsaActiva } from "../../servicios/energia/suspensionFalsa"
import { transicion, type EstadoCierre, type EventoCierre } from "./cierre"

/** Tiempo para el segundo toque de Tab. */
const PLAZO_TOQUE_MS = 250

export const [vistaEscritoriosVisible, setVistaEscritoriosVisible] = createState(false)

let estado: EstadoCierre = "cerrado"
let temporizador: ReturnType<typeof setTimeout> | null = null

const cancelarPlazo = () => {
  if (temporizador !== null) clearTimeout(temporizador)
  temporizador = null
}

export function avisarVistaEscritorios(evento: EventoCierre) {
  // Sin nadie delante no se abre; los avisos de soltar deben seguir llegando para cerrar.
  if (evento === "tab" && estado === "cerrado" && suspensionFalsaActiva.get()) {
    void salirDelSubmap()
    return
  }
  const paso = transicion(estado, evento)
  estado = paso.estado
  try {
    for (const accion of paso.acciones) {
      if (accion === "abrir") {
        closeAllPanels()
        // Solo el calendario: Orion se queda abierto y utilizable al cerrar este menú.
        setCalendarVisible(false)
        setVistaEscritoriosVisible(true)
      } else if (accion === "cerrar") {
        setVistaEscritoriosVisible(false)
        void salirDelSubmap()
      } else if (accion === "armar") {
        cancelarPlazo()
        temporizador = setTimeout(() => {
          temporizador = null
          avisarVistaEscritorios("expira")
        }, PLAZO_TOQUE_MS)
      } else {
        cancelarPlazo()
      }
    }
  } catch (e) {
    // Un fallo al abrir deja el estado en "sostenido" con el submap puesto: se vuelve a "cerrado"
    // y se sale del submap. El ocultado va en su propio try porque un suscriptor pudo ser el que falló.
    console.error("[vista-escritorios] transición falló:", e)
    cancelarPlazo()
    estado = "cerrado"
    try {
      setVistaEscritoriosVisible(false)
    } catch (e2) {
      console.error("[vista-escritorios] no se pudo ocultar:", e2)
    }
    void salirDelSubmap()
  }
}

/** Fijado (por Tab suelto o por un toque): el clic en el fondo cierra. En modo mantener, no. */
export function vistaEscritoriosFijada(): boolean {
  return estado === "fijado" || estado === "fijadoUnToque"
}

export function cerrarVistaEscritorios() {
  avisarVistaEscritorios("cerrar")
}

/** Con el menú fijado o cerrado por clic, el submap puede seguir puesto si SUPER sigue abajo. */
function salirDelSubmap() {
  return execAsync(["hyprctl", "dispatch", "hl.dsp.submap('reset')"]).catch(() => {})
}
