import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { createState } from "ags"
import { esClienteJuego, invalidarEvidenciaProceso, type ClienteConProceso } from "./evidencia"
import { escanerJuegos } from "../../modulos/ajustes/preferences"

export const [clientesJuego, establecerClientesJuego] = createState<ClienteConProceso[]>([])
export const [clienteJuegoEnFoco, establecerClienteJuegoEnFoco] = createState<string | null>(null)
/** Cambia ante cualquier evento de ventana relevante para consumidores como auto-DND. */
export const [revisionVentanas, establecerRevisionVentanas] = createState(0)

let iniciado = false
// Espejo local de la preferencia `escanerJuegos` (Ajustes > Juegos). Se cachea en una
// variable en vez de leer el estado en cada evento porque lo consultan las tres rutas
// calientes (alta de ventana, cambio de título, cambio de foco).
//
// Apagado, este módulo deja de ser un escáner y pasa a ser solo el bus de eventos de
// ventana: NO conecta las señales por cliente, NO lee /proc ni las entradas .desktop y
// NO publica ningún juego. Lo que sí sigue emitiendo es `revisionVentanas`, porque el
// auto-DND lo usa también para su lista de apps a pantalla completa, que no tiene nada
// que ver con los juegos.
let escanerActivo = true
const juegos = new Map<string, ClienteConProceso>()
const clientes = new Map<string, ClienteConProceso>()
const conexionesCliente = new Map<string, Array<{ cliente: any; id: number }>>()
const reintentos = new Map<string, number>()

const claveDireccion = (direccion: string | null | undefined) =>
  String(direccion ?? "").toLowerCase().replace(/^0x/, "")

function publicarJuegos() {
  establecerClientesJuego([...juegos.values()])
}

function publicarRevision() {
  establecerRevisionVentanas(revisionVentanas.get() + 1)
}

function actualizarFoco(hypr: AstalHyprland.Hyprland) {
  const direccion = claveDireccion((hypr.focusedClient as any)?.address)
  establecerClienteJuegoEnFoco(direccion && juegos.has(direccion) ? direccion : null)
}

function evaluarCliente(
  hypr: AstalHyprland.Hyprland,
  cliente: ClienteConProceso | null | undefined,
  republicarSiSigue = false,
  permitirQuitar = false,
) {
  const direccion = claveDireccion((cliente as any)?.address)
  if (!direccion || !clientes.has(direccion)) return
  // Sin escáner no hay nada que decidir, pero el evento sigue valiendo para el resto.
  if (!escanerActivo) {
    publicarRevision()
    return
  }

  const eraJuego = juegos.has(direccion)
  const esJuego = esClienteJuego(cliente)
  if (esJuego && cliente) juegos.set(direccion, cliente)
  // Un juego reconocido permanece hasta cerrar su ventana aunque abandone fullscreen.
  // Solo un cambio de título puede desmentirlo (p. ej. un instalador Proton tardío).
  else if (!eraJuego || permitirQuitar) juegos.delete(direccion)

  const sigueSiendoJuego = juegos.has(direccion)
  if (eraJuego !== sigueSiendoJuego || (sigueSiendoJuego && republicarSiSigue)) publicarJuegos()
  actualizarFoco(hypr)
  publicarRevision()
}

function conectarCliente(hypr: AstalHyprland.Hyprland, cliente: any) {
  const direccion = claveDireccion(cliente?.address)
  if (!escanerActivo || !direccion || conexionesCliente.has(direccion)) return
  const conexiones: Array<{ cliente: any; id: number }> = []

  for (const senal of ["notify::title", "notify::class", "notify::fullscreen"]) {
    try {
      conexiones.push({
        cliente,
        id: cliente.connect(senal, () => evaluarCliente(
          hypr,
          cliente,
          senal === "notify::title",
          senal === "notify::title",
        )),
      })
    } catch (_) {}
  }
  conexionesCliente.set(direccion, conexiones)
}

function registrarCliente(hypr: AstalHyprland.Hyprland, cliente: any) {
  const direccion = claveDireccion(cliente?.address)
  if (!direccion) return
  clientes.set(direccion, cliente)
  conectarCliente(hypr, cliente)
  evaluarCliente(hypr, cliente)

  // El reintento tardío existe solo para volver a decidir si es un juego cuando la
  // ventana aún no tenía clase; sin escáner no hay decisión que rehacer.
  if (escanerActivo && !cliente.class && !reintentos.has(direccion)) {
    const fuente = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
      reintentos.delete(direccion)
      evaluarCliente(hypr, cliente, true)
      return GLib.SOURCE_REMOVE
    })
    reintentos.set(direccion, fuente)
  }
}

function olvidarCliente(hypr: AstalHyprland.Hyprland, direccionCruda: string) {
  const direccion = claveDireccion(direccionCruda)
  const cliente = clientes.get(direccion)
  desconectarCliente(direccion)
  clientes.delete(direccion)
  invalidarEvidenciaProceso(cliente?.pid)
  if (juegos.delete(direccion)) publicarJuegos()
  actualizarFoco(hypr)
  publicarRevision()
}

function desconectarCliente(direccion: string) {
  for (const conexion of conexionesCliente.get(direccion) ?? []) {
    try { conexion.cliente.disconnect(conexion.id) } catch (_) {}
  }
  conexionesCliente.delete(direccion)
  const reintento = reintentos.get(direccion)
  if (reintento !== undefined) {
    GLib.source_remove(reintento)
    reintentos.delete(direccion)
  }
}

/** Enciende o apaga el escáner en caliente, sin reiniciar el shell. Al apagarlo suelta
 *  todo su trabajo (señales por ventana, reintentos pendientes y caché de /proc) y
 *  publica "no hay juegos"; al encenderlo reevalúa lo que ya estuviera abierto. */
function aplicarEscaner(hypr: AstalHyprland.Hyprland, activo: boolean) {
  if (activo === escanerActivo) return
  escanerActivo = activo

  if (!activo) {
    for (const direccion of [...conexionesCliente.keys()]) desconectarCliente(direccion)
    for (const cliente of clientes.values()) invalidarEvidenciaProceso(cliente?.pid)
    const habiaJuegos = juegos.size > 0
    juegos.clear()
    if (habiaJuegos) publicarJuegos()
    establecerClienteJuegoEnFoco(null)
    publicarRevision()
    return
  }

  for (const cliente of clientes.values()) {
    conectarCliente(hypr, cliente)
    evaluarCliente(hypr, cliente)
  }
  publicarJuegos()
  actualizarFoco(hypr)
  publicarRevision()
}

export function iniciarRegistroJuegos(): void {
  if (iniciado) return
  iniciado = true
  const hypr = AstalHyprland.get_default()
  escanerActivo = escanerJuegos.get()
  escanerJuegos.subscribe(() => aplicarEscaner(hypr, escanerJuegos.get()))

  for (const cliente of hypr.get_clients?.() ?? []) registrarCliente(hypr, cliente)
  publicarJuegos()
  actualizarFoco(hypr)

  hypr.connect("client-added", (_origen, cliente) => registrarCliente(hypr, cliente))
  hypr.connect("client-removed", (_origen, direccion: string) => olvidarCliente(hypr, direccion))
  hypr.connect("event", (_origen, nombre: string) => {
    if (nombre === "fullscreen") evaluarCliente(hypr, hypr.focusedClient, true)
    if (
      nombre === "fullscreen"
      || nombre === "activewindow"
      || nombre === "activewindowv2"
      || nombre === "workspace"
      || nombre === "workspacev2"
      || nombre === "focusedmon"
    ) {
      actualizarFoco(hypr)
      publicarRevision()
    }
  })
  hypr.connect("notify::focused-workspace", () => {
    actualizarFoco(hypr)
    publicarRevision()
  })
}

export function esClienteRegistradoComoJuego(cliente: any): boolean {
  if (!escanerActivo) return false
  const direccion = claveDireccion(cliente?.address)
  return direccion ? juegos.has(direccion) : false
}
