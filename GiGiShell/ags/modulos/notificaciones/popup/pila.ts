import { createRoot, createState } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import ElementoPopup from "./ElementoPopup.tsx"
import { calcularDuracionPopup } from "./logica.ts"
import { canFitPopup } from "./disposicion.ts"
import { notifPanelVisible, type StoredNotification } from "../store"
import {
  popupDuracionNormalMs, popupDuracionSistemaMs, popupDuracionAccionesMs,
} from "../../ajustes/preferences.ts"

const MAXIMO_POPUPS = 5
const ANCHO_POPUP = 360
const ESPACIADO_POPUPS = 8
const MARGEN_INFERIOR_PANTALLA = 16

const [hayPopups, setHayPopups] = createState(false)
export { hayPopups }

let contenedor: Gtk.Box | null = null
let monitor: Gdk.Monitor | null = null
let margenSuperior = 16
const widgets = new Map<number, Gtk.Widget>()
// Cada popup se construye en su propio ámbito (`createRoot`): `drenarCola` corre desde la señal
// del daemon, fuera de todo `Scope`, y sin ámbito los `onCleanup` de sus widgets (el del icono de
// app, los del JSX) daban `out of tracking context` y nunca se ejecutaban. Desecharlo al retirar
// el popup es lo que da de baja sus señales. Ver `utilidades/coalescer.ts`.
const ambitos = new Map<number, () => void>()
const alturas = new Map<number, number>()
const temporizadores = new Map<number, number>()
const callbacksDescarte = new Map<number, { descartar: () => void; cancelar: () => void }>()
const pendientes: StoredNotification[] = []

function cancelarTemporizador(id: number): void {
  const temporizador = temporizadores.get(id)
  if (temporizador == null) return
  GLib.source_remove(temporizador)
  temporizadores.delete(id)
}

function eliminarInmediatamente(id: number, rellenar = true): void {
  cancelarTemporizador(id)
  // La salida pertenece al widget retirado: no puede borrar su sustituto si
  // llega otra notificación con el mismo ID antes de terminar la animación.
  callbacksDescarte.get(id)?.cancelar()
  callbacksDescarte.delete(id)

  const widget = widgets.get(id)
  if (widget) {
    widget.set_visible(false)
    try {
      contenedor?.remove(widget)
    } catch {
      // Puede haberse desmontado la ventana antes que el widget.
    }
    widgets.delete(id)
    alturas.delete(id)
  }
  ambitos.get(id)?.()
  ambitos.delete(id)

  setHayPopups(widgets.size > 0)
  if (rellenar) drenarCola()
}

function iniciarDescarte(id: number): void {
  cancelarTemporizador(id)
  const descartar = callbacksDescarte.get(id)
  if (descartar) descartar.descartar()
  else eliminarInmediatamente(id)
}

function programarDescarte(notificacion: StoredNotification): void {
  // Las duraciones se leen AQUÍ, al programar el descarte, y no se suscriben: cambiarlas en
  // Ajustes afecta a los popups siguientes, no al que ya está en pantalla con su temporizador
  // en marcha. Reprogramar los vivos sería más ruido que valor —el popup se descarta solo en
  // segundos— y obligaría a guardar el instante de inicio de cada uno.
  const temporizador = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    calcularDuracionPopup(notificacion, {
      normal: popupDuracionNormalMs.get(),
      sistema: popupDuracionSistemaMs.get(),
      conAcciones: popupDuracionAccionesMs.get(),
    }),
    () => {
      iniciarDescarte(notificacion.id)
      return GLib.SOURCE_REMOVE
    },
  )
  temporizadores.set(notificacion.id, temporizador)
}

function alturaDisponible(): number {
  if (!monitor) return Number.POSITIVE_INFINITY
  return Math.max(
    0,
    monitor.get_geometry().height - margenSuperior - MARGEN_INFERIOR_PANTALLA,
  )
}

function drenarCola(): void {
  if (!contenedor || notifPanelVisible.get()) return

  while (pendientes.length > 0 && widgets.size < MAXIMO_POPUPS) {
    const notificacion = pendientes[0]
    let alturaMedida = 0
    let desecharAmbito: () => void = () => {}
    const elemento = createRoot((desechar) => {
      desecharAmbito = desechar
      return ElementoPopup({
        notificacion,
        alDescartar: () => eliminarInmediatamente(notificacion.id),
        registrarDescarte: (descartar, cancelar) => callbacksDescarte.set(notificacion.id, { descartar, cancelar }),
      }) as Gtk.Widget
    })

    try {
      const [, alturaNatural] = elemento.measure(Gtk.Orientation.VERTICAL, ANCHO_POPUP)
      alturaMedida = alturaNatural
    } catch {
      alturaMedida = 96
    }

    if (!canFitPopup(
      Array.from(alturas.values()),
      alturaMedida,
      alturaDisponible(),
      MAXIMO_POPUPS,
      ESPACIADO_POPUPS,
    )) {
      callbacksDescarte.delete(notificacion.id)
      desecharAmbito()
      break
    }

    pendientes.shift()
    widgets.set(notificacion.id, elemento)
    ambitos.set(notificacion.id, desecharAmbito)
    alturas.set(notificacion.id, alturaMedida)
    contenedor.append(elemento)
    programarDescarte(notificacion)
    setHayPopups(true)
  }
}

export function configurarPilaPopups(
  nuevoContenedor: Gtk.Box,
  nuevoMonitor: Gdk.Monitor,
  nuevoMargenSuperior: number,
): void {
  contenedor = nuevoContenedor
  monitor = nuevoMonitor
  margenSuperior = nuevoMargenSuperior
  drenarCola()
}

export function actualizarMargenPila(margen: number): void {
  margenSuperior = margen
  drenarCola()
}

export function agregarPopup(notificacion: StoredNotification): void {
  const indicePendiente = pendientes.findIndex(({ id }) => id === notificacion.id)
  if (indicePendiente >= 0) pendientes.splice(indicePendiente, 1)
  if (widgets.has(notificacion.id)) eliminarInmediatamente(notificacion.id, false)
  pendientes.push(notificacion)
  drenarCola()
}

export function descartarTodosLosPopups(): void {
  for (const id of Array.from(widgets.keys())) eliminarInmediatamente(id, false)
}

// Como si a todos se les acabara el tiempo a la vez: salida animada, no retirada en seco.
// La cola se vacía ANTES porque cada salida, al terminar, rellena con la siguiente
// pendiente — y quien llama a esto es porque ya no debe aparecer ninguna.
export function expirarTodosLosPopups(): void {
  pendientes.splice(0)
  for (const id of Array.from(widgets.keys())) iniciarDescarte(id)
}

export function reiniciarPilaPorRafaga(): void {
  pendientes.splice(0)
  descartarTodosLosPopups()
}

export const ANCHO_VENTANA_POPUP = ANCHO_POPUP
export const ESPACIADO_VENTANA_POPUP = ESPACIADO_POPUPS
