// puentes.ts
//
// Todo lo que AGS atiende desde fuera (`ags request <nombre> [args…]`), en una tabla.
// Se busca solo por el PRIMER argumento: los demás pueden traer texto libre y no deben
// poder casar con otro request.
//
// La respuesta es siempre `ok`, un valor o `error: …`. Un handler que lanza no puede
// quedarse sin responder: `ags request` esperaría sin límite (medido). Quien tenga una
// reserva debe llamar por hypr/scripts/pedir-ags.sh, porque esas respuestas salen con
// código 0.
import { execAsync } from "ags/process"
import { abrirDesdeFuera, cerrarDesdeFuera } from "./modulos/cuenta-atras/puente"
import { showOSD } from "./modulos/osd/OSD"
import { showMicOSD } from "./modulos/osd/MicOSD"
import { togglePanel as alternarPanelOrion } from "./modulos/orion/state"
import { toggleGamemode } from "./servicios/energia/gamemode"
import { alternarSuspensionFalsa, entrarSuspensionFalsa } from "./servicios/energia/suspensionFalsa"
import { sfSustituirReal } from "./servicios/energia/powerState"
import { alternarBarPorTecla, alternarMenuEnergia, alternarPanelAjustes, alternarPanelNotificaciones, alternarQuickSettings, showBrightnessOSD, stepBrightness, toggleCalendar } from "./estado/shell"

type Atender = (args: string[]) => string

/** Para los requests que solo disparan algo y no tienen nada que contestar. */
function sinRespuesta(accion: () => unknown): Atender {
  return () => {
    accion()
    return "ok"
  }
}

const PUENTES = new Map<string, Atender>([
  // Cuenta atrás: la abren y la cierran quienes llevan la cuenta (boton-apagado.lua,
  // apagado-preventivo.sh); aquí solo se pinta. Ver modulos/cuenta-atras/puente.ts.
  ["cuenta-atras", abrirDesdeFuera],
  ["cuenta-atras-cerrar", cerrarDesdeFuera],

  ["volume-osd", sinRespuesta(showOSD)],
  ["mic-osd", sinRespuesta(showMicOSD)],
  ["brightness-osd", sinRespuesta(showBrightnessOSD)],
  // Las teclas de brillo pasan por aquí en vez de llamar a `brightnessctl` desde el
  // keybind: así funcionan con los dos backends (panel interno o DDC/CI) y el estado
  // del shell no se desincroniza del monitor. Ver `servicios/pantalla/brightness.ts`.
  ["brightness-up", sinRespuesta(() => stepBrightness(0.1))],
  ["brightness-down", sinRespuesta(() => stepBrightness(-0.1))],

  // Mismo interruptor que el botón de mando de Quick Settings, por si algún día
  // se quiere una tecla. La respuesta dice en qué estado queda.
  ["toggle-gamemode", () => (toggleGamemode() ? "on" : "off")],

  // "Suspender" de todo el sistema pasa por aquí —el menú de energía y el botón físico de
  // encendido— en vez de llamar a `systemctl suspend` cada uno por su cuenta. El motivo es
  // el ajuste «sustituir la suspensión real por la falsa»: sin un punto único, encenderlo
  // arreglaría la inactividad y dejaría el botón de encendido suspendiendo de verdad, que
  // es exactamente el caso que el usuario quiere evitar y encima el más fácil de pulsar sin
  // pensar. Quien llama tiene un `|| systemctl suspend` de reserva por si AGS no responde:
  // sin AGS no hay nadie que pueda hacer una suspensión falsa, así que la real es la
  // degradación correcta (misma REGLA DE ORO que idle-action.sh).
  ["suspend", () => {
    if (sfSustituirReal.get()) {
      entrarSuspensionFalsa().catch((e) => console.error("[suspend] suspensión falsa falló:", e))
      return "falsa"
    }
    execAsync(["systemctl", "suspend"]).catch((e) => console.error("[suspend] falló:", e))
    return "real"
  }],
  // Entrada SIN alternar. La pide la TAPA del portátil («Suspensión falsa» en
  // Ajustes > Energía, hypr/gigishell/tapa.lua): cerrar la tapa estando ya dentro
  // tiene que dejarla puesta, y `toggle-suspension-falsa` haría justo lo
  // contrario — sacar de ella con la tapa cerrada y nadie delante de la pantalla.
  // Es un request aparte y no un parámetro del de arriba porque `suspend` significa
  // otra cosa: allí la falsa solo entra si el usuario la ha puesto a sustituir a la
  // real, y aquí la ha pedido por su nombre.
  ["suspension-falsa-entrar", sinRespuesta(() =>
    entrarSuspensionFalsa().catch((e) => console.error("[suspension-falsa] entrada falló:", e)))],
  // Se expone como request y no solo como botón porque es el punto de entrada que necesitan
  // las otras superficies: el atajo de teclado (que además tiene que ser `locked = true`
  // para existir con hyprlock delante), el menú de energía —cuyas acciones son COMANDOS de
  // shell, `comando: string`, y no admiten una llamada interna sin cambiar el tipo— y
  // cualquier automatismo del usuario.
  ["toggle-suspension-falsa", () => (alternarSuspensionFalsa() ? "on" : "off")],

  ["toggle-orion", sinRespuesta(alternarPanelOrion)],
  ["toggle-bar", sinRespuesta(alternarBarPorTecla)],
  // Lo usa GiGiShell.boton_apagado() (hypr/gigishell/boton-apagado.lua) cuando el botón físico
  // está configurado para abrir el menú en vez de ejecutar una acción directa.
  ["toggle-power-menu", sinRespuesta(alternarMenuEnergia)],
  ["toggle-quicksettings", sinRespuesta(alternarQuickSettings)],
  ["toggle-settings", sinRespuesta(alternarPanelAjustes)],
  ["toggle-notifications", sinRespuesta(alternarPanelNotificaciones)],
  // El calendario era el único panel sin `request`: solo se abría pinchando el reloj de la barra.
  // Con la barra autoocultada eso obliga a ir a buscarla, y no había forma de atarlo a una tecla.
  ["toggle-calendar", sinRespuesta(toggleCalendar)],
])

export function atenderRequest(argv: string[], responder: (respuesta: string) => void) {
  const atender = PUENTES.get(argv[0])
  if (!atender) {
    responder("unknown request")
    return
  }
  try {
    responder(atender(argv.slice(1)))
  } catch (e) {
    console.error(`[puentes] ${argv[0]} falló:`, e)
    responder(`error: ${e}`)
  }
}
