import type { Gdk } from "ags/gtk4"
import { obtenerHyprland, suscribirDatosEscritorios } from "./controlador"
import { PANTALLA_COMPLETA_REAL } from "../juegos/deteccion"

/**
 * ¿Hay una ventana en pantalla completa **real** en el escritorio activo de una salida?
 *
 * Es lo que Hyprland usa para esconder las capas superiores: con `fullscreen: 2` la
 * barra pasa a alpha 0, con `fullscreen: 1` (maximizado) no. De ahí que se compare
 * contra `PANTALLA_COMPLETA_REAL` y no contra `!== 0` — el mismo error que ya costó
 * que Discord maximizado se colara en la detección de juegos.
 *
 * Se mira el **escritorio activo de esa salida**, no el enfocado: un juego a pantalla
 * completa en el monitor de al lado no tapa esta barra, y un juego en el escritorio 3
 * tampoco tapa nada mientras estás en el 1.
 */

type Hyprland = ReturnType<typeof obtenerHyprland>
type MonitorHyprland = ReturnType<Hyprland["get_monitors"]>[number]

/** Resuelve la salida de Hyprland que corresponde a un `Gdk.Monitor`.
 *
 * Mismo repliegue que `Escritorios.tsx`: hay backends/versiones de GDK que no
 * exponen `connector`, y ahí la posición lógica sigue identificando la salida sin
 * mezclar monitores. */
function resolverMonitor(monitorGdk: Gdk.Monitor): MonitorHyprland | undefined {
  const hyprland = obtenerHyprland()
  const nombreSalida = monitorGdk.get_connector() ?? ""
  if (nombreSalida) {
    const porNombre = hyprland.get_monitor_by_name(nombreSalida)
    if (porNombre) return porNombre
  }
  const geometria = monitorGdk.get_geometry()
  return hyprland.get_monitors().find(
    (monitor) => monitor.x === geometria.x && monitor.y === geometria.y,
  )
}

export function hayPantallaCompleta(monitorGdk: Gdk.Monitor): boolean {
  const monitor = resolverMonitor(monitorGdk)
  const idEscritorio = monitor?.activeWorkspace?.id
  if (idEscritorio == null) return false

  const hyprland = obtenerHyprland()
  return (hyprland.get_clients?.() ?? []).some((cliente) => {
    if (cliente?.workspace?.id !== idEscritorio) return false
    return ((cliente as { fullscreen?: number }).fullscreen ?? 0) >= PANTALLA_COMPLETA_REAL
  })
}

/**
 * Avisa cuando cambia el estado de pantalla completa de una salida. Se apoya en la
 * colección de señales que ya comparten las barras (`controlador.ts`), que incluye el
 * evento `fullscreen` de Hyprland además de clientes, escritorios y monitores.
 * El callback recibe el valor ya deduplicado y se ejecuta también al suscribirse.
 */
export function suscribirPantallaCompleta(
  monitorGdk: Gdk.Monitor,
  alCambiar: (hayPantallaCompleta: boolean) => void,
): () => void {
  let anterior: boolean | null = null
  return suscribirDatosEscritorios(() => {
    const actual = hayPantallaCompleta(monitorGdk)
    if (actual === anterior) return
    anterior = actual
    alCambiar(actual)
  })
}
