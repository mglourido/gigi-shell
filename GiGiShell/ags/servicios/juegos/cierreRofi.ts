// Cierra rofi cuando el foco pasa a un JUEGO, si rofi se abrió fuera de él.
//
// Es el mismo comportamiento que Orion (ver `modulos/orion/state.ts`): rofi es una
// layer-shell y se quedaría encima de la partida. Si se abrió ESTANDO en el juego,
// se respeta — ahí se ha llamado a propósito encima de él.
//
// Vive en AGS y no en `hypr/scripts/rofi-launch.py` porque aquí ya está el registro
// de juegos (`clienteJuegoEnFoco`), y en bash solo habría una copia de segunda mano
// en `runtime-state.json`, escrita DESPUÉS del cambio de foco: el script tendría que
// esperar a que AGS la actualizara, o sea depender de AGS igualmente pero con una
// carrera añadida. Cubre cualquier rofi (lanzador, portapapeles…), no solo el de apps.
//
// Sin sondeo: eventos de Hyprland (`openlayer`/`closelayer` con el namespace como
// dato, y `workspacev2`) más la suscripción al foco de juego. Con "Detectar juegos"
// apagado no hay juegos registrados y esto no hace nada.
//
// ⚠️ EL FOCO DE JUEGO SOLO NO BASTA, y fue el primer intento (no cerraba nunca).
// Mientras rofi tiene el teclado, Hyprland NO emite `activewindow` al cambiar de
// escritorio — medido escuchando el socket: `openlayer>>rofi`, `workspace>>3` (el
// del juego) y ningún `activewindow` hasta `closelayer>>rofi`. O sea que
// `clienteJuegoEnFoco` no cambia mientras rofi está abierto. Por eso se mira
// también si el escritorio al que se acaba de ir tiene un juego.

import AstalHyprland from "gi://AstalHyprland"
import { execAsync } from "ags/process"
import { clienteJuegoEnFoco, clientesJuego } from "./registro"

let iniciado = false
let rofiAbierto = false
let abiertoEnJuego = false

const esRofi = (namespace: string) => namespace.trim().toLowerCase().startsWith("rofi")

/** ¿Hay algún juego registrado en el escritorio `id`? (dato de `workspacev2`: "id,nombre"). */
export function escritorioTieneJuego(datosWorkspaceV2: string): boolean {
  const id = Number.parseInt(datosWorkspaceV2.split(",")[0] ?? "", 10)
  if (!Number.isFinite(id)) return false
  return clientesJuego.get().some((c: any) => c.workspace?.id === id)
}

function cerrarRofi() {
  rofiAbierto = false
  execAsync(["pkill", "-x", "rofi"]).catch(() => {})
}

export function initCierreRofiJuego(): void {
  if (iniciado) return
  iniciado = true
  const hypr = AstalHyprland.get_default()

  hypr.connect("event", (_origen, nombre: string, datos: string) => {
    if (nombre === "openlayer" && esRofi(datos)) {
      rofiAbierto = true
      abiertoEnJuego = clienteJuegoEnFoco.get() !== null
    } else if (nombre === "closelayer" && esRofi(datos)) {
      rofiAbierto = false
    } else if (nombre === "workspacev2" && rofiAbierto && !abiertoEnJuego && escritorioTieneJuego(datos)) {
      cerrarRofi()
    }
  })

  clienteJuegoEnFoco.subscribe(() => {
    // Sigue haciendo falta: un juego que se trae al frente solo sin cambiar de
    // escritorio sí pasa por aquí.
    if (!rofiAbierto || abiertoEnJuego || clienteJuegoEnFoco.get() === null) return
    cerrarRofi()
  })
}
