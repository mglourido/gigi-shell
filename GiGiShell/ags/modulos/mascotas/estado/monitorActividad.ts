// Traduce el estado de Hyprland de una salida concreta a la condición pura de
// modulos/mascotas/estado/disparador.ts. Mismo repliegue de resolución de
// monitor y misma colección de señales compartida que
// servicios/escritorios/pantallaCompleta.ts (una sola suscripción para todas
// las barras y mascotas).
import type { Gdk } from "ags/gtk4"
import { obtenerHyprland, suscribirDatosEscritorios } from "../../../servicios/escritorios/controlador"
import { debeMostrarMascota } from "./disparador"

type Hyprland = ReturnType<typeof obtenerHyprland>
type MonitorHyprland = ReturnType<Hyprland["get_monitors"]>[number]

// El conector de una salida no cambia mientras esa `Gdk.Monitor` viva, pero
// `get_connector()` es una llamada a GI y esto se resuelve en CADA evento de
// Hyprland (abrir, cerrar, mover o enfocar una ventana). Se memoiza por
// monitor; el `WeakMap` no retiene la salida cuando se desconecta.
const conectorPorMonitor = new WeakMap<Gdk.Monitor, string>()

function conectorDe(monitorGdk: Gdk.Monitor): string {
  const memoizado = conectorPorMonitor.get(monitorGdk)
  if (memoizado !== undefined) return memoizado
  const nombreSalida = monitorGdk.get_connector() ?? ""
  conectorPorMonitor.set(monitorGdk, nombreSalida)
  return nombreSalida
}

function resolverMonitor(monitorGdk: Gdk.Monitor): MonitorHyprland | undefined {
  const hyprland = obtenerHyprland()
  const nombreSalida = conectorDe(monitorGdk)
  if (nombreSalida) {
    const porNombre = hyprland.get_monitor_by_name(nombreSalida)
    if (porNombre) return porNombre
  }
  // Repliegue caro (marshala la lista entera de monitores): solo cuando la
  // salida no publica conector o Hyprland no la conoce por ese nombre.
  const geometria = monitorGdk.get_geometry()
  return hyprland.get_monitors().find(
    (monitor) => monitor.x === geometria.x && monitor.y === geometria.y,
  )
}

export function debeMostrarMascotaEnMonitor(monitorGdk: Gdk.Monitor): boolean {
  const monitor = resolverMonitor(monitorGdk)
  const idEscritorio = monitor?.activeWorkspace?.id
  // Sin escritorio resoluble no hay nada que tapar tampoco: se deja salir.
  if (idEscritorio == null) return true

  // Sin pedir la lista de clientes: `get_clients()` marshala TODOS los
  // clientes de Hyprland (un objeto GI por ventana abierta) y esto corre en
  // cada evento de ventana, varias veces por segundo mientras se trabaja.
  // El predicado no necesita el recuento salvo cuando hay un cliente
  // enfocado en este escritorio, y en ese caso el recuento es por fuerza >= 1
  // (el propio enfocado); si no lo hay, `debeMostrarMascota` devuelve `true`
  // sea cual sea el número de clientes. Un solo dato basta para las dos ramas.
  const clienteEnfocado = obtenerHyprland().focusedClient
  const hayClienteEnfocado = clienteEnfocado != null
    && clienteEnfocado.workspace?.id === idEscritorio

  return debeMostrarMascota(hayClienteEnfocado ? 1 : 0, hayClienteEnfocado)
}

/** Avisa cuando cambia si debe mostrarse la mascota en esta salida. El callback
 * recibe el valor ya deduplicado y se ejecuta también al suscribirse. */
export function suscribirActividadMascota(
  monitorGdk: Gdk.Monitor,
  alCambiar: (mostrar: boolean) => void,
): () => void {
  let anterior: boolean | null = null
  return suscribirDatosEscritorios(() => {
    const actual = debeMostrarMascotaEnMonitor(monitorGdk)
    if (actual === anterior) return
    anterior = actual
    alCambiar(actual)
  })
}
