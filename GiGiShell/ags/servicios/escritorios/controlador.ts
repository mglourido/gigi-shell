import AstalHyprland from "gi://AstalHyprland"

type Hyprland = ReturnType<typeof AstalHyprland.get_default>
type MonitorHyprland = ReturnType<Hyprland["get_monitors"]>[number]

const hyprland = AstalHyprland.get_default()
const suscriptores = new Set<() => void>()
let idsSenales: number[] = []
let idsSenalesMonitores: Array<[MonitorHyprland, number]> = []
let operacionesEnCurso = 0

function desconectarSenalesMonitores() {
  for (const [monitor, idSenal] of idsSenalesMonitores) {
    try { monitor.disconnect(idSenal) } catch (_) {}
  }
  idsSenalesMonitores = []
}

function notificarSuscriptores() {
  if (operacionesEnCurso > 0) return
  for (const suscriptor of [...suscriptores]) {
    try { suscriptor() } catch (error) { console.error("Error actualizando escritorios", error) }
  }
}

function reconectarSenalesMonitores() {
  desconectarSenalesMonitores()
  for (const monitor of hyprland.get_monitors()) {
    const idSenal = monitor.connect("notify::active-workspace", notificarSuscriptores)
    idsSenalesMonitores.push([monitor, idSenal])
  }
}

function conectarSenales() {
  if (idsSenales.length > 0) return
  const reconectar = () => {
    reconectarSenalesMonitores()
    notificarSuscriptores()
  }
  idsSenales = [
    hyprland.connect("notify::workspaces", notificarSuscriptores),
    hyprland.connect("notify::clients", notificarSuscriptores),
    hyprland.connect("client-moved", notificarSuscriptores),
    hyprland.connect("notify::focused-client", notificarSuscriptores),
    hyprland.connect("notify::monitors", reconectar),
    // Entrar o salir de pantalla completa no altera la lista de clientes ni el foco,
    // así que ninguna de las señales de arriba se entera. `Workspace.has-fullscreen`
    // tampoco sirve: medido, no emite `notify::` — y además vale `true` para una
    // ventana solo MAXIMIZADA, que no es el caso que interesa. Queda el evento crudo
    // de Hyprland; quien lo consuma decide el modo mirando el cliente.
    hyprland.connect("event", (_origen: unknown, evento: string) => {
      if (evento === "fullscreen") notificarSuscriptores()
    }),
  ]
  reconectarSenalesMonitores()
}

function desconectarSenales() {
  desconectarSenalesMonitores()
  for (const idSenal of idsSenales) {
    try { hyprland.disconnect(idSenal) } catch (_) {}
  }
  idsSenales = []
}

/** Comparte una única colección de señales de AstalHyprland entre todas las barras.
 * Las vistas siguen siendo locales: cada suscriptor filtra por su salida. */
export function suscribirDatosEscritorios(suscriptor: () => void): () => void {
  suscriptores.add(suscriptor)
  if (suscriptores.size === 1) conectarSenales()
  suscriptor()
  return () => {
    suscriptores.delete(suscriptor)
    if (suscriptores.size === 0) desconectarSenales()
  }
}

export function obtenerHyprland() {
  return hyprland
}

export function iniciarOperacionEscritorios() {
  operacionesEnCurso++
}

export function terminarOperacionEscritorios() {
  operacionesEnCurso = Math.max(0, operacionesEnCurso - 1)
  if (operacionesEnCurso === 0) notificarSuscriptores()
}
