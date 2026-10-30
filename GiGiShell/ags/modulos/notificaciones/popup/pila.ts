import { createRoot, createState } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import ElementoPopup from "./ElementoPopup.tsx"
import {
  anulaEvento, calcularDuracionPopup, claveAgrupacion, esObsoletaEnCola, insertarPorPrioridad,
  PRIORIDAD_CRITICA, prioridadPopup, sonIdenticas,
} from "./logica.ts"
import { appCoincide } from "../autoDnd/politica.ts"
import { canFitPopup } from "./disposicion.ts"
import { notifPanelVisible, type StoredNotification } from "../store"
import {
  popupDuracionNormalMs, popupDuracionSistemaMs, popupDuracionAccionesMs, popupsConversacion,
} from "../../ajustes/preferences.ts"

const MAXIMO_POPUPS = 5
// Tres tarjetas con el cuerpo lleno agotan el presupuesto; las cortas dejan sitio hasta
// MAXIMO_POPUPS. Las tres primeras entran siempre, aunque traigan botones y midan más.
const POPUPS_GARANTIZADOS = 3
// Medido con `hyprctl layers`: 64 px con dos líneas de cuerpo, sin botones.
const ALTURA_POPUP_LLENO = 64
const ANCHO_POPUP = 360
const ESPACIADO_POPUPS = 8
const MARGEN_INFERIOR_PANTALLA = 16
const PRESUPUESTO_PILA = POPUPS_GARANTIZADOS * ALTURA_POPUP_LLENO
  + (POPUPS_GARANTIZADOS - 1) * ESPACIADO_POPUPS

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
const visibles = new Map<number, StoredNotification>()
const contadores = new Map<number, number>()
// El tiempo sigue corriendo con el ratón encima, pero la tarjeta no se va hasta que salga.
const bajoCursor = new Set<number>()
const caducadas = new Set<number>()
const contadoresPendientes = new Map<number, number>()

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
  visibles.delete(id)
  contadores.delete(id)
  bajoCursor.delete(id)
  caducadas.delete(id)
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
      temporizadores.delete(notificacion.id)
      if (bajoCursor.has(notificacion.id)) caducadas.add(notificacion.id)
      else iniciarDescarte(notificacion.id)
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

function construirElemento(notificacion: StoredNotification, contador: number) {
  let desecharAmbito: () => void = () => {}
  const elemento = createRoot((desechar) => {
    desecharAmbito = desechar
    return ElementoPopup({
      notificacion,
      contador,
      alDescartar: () => eliminarInmediatamente(notificacion.id),
      registrarDescarte: (descartar, cancelar) => callbacksDescarte.set(notificacion.id, { descartar, cancelar }),
      alCambiarCursor: (dentro) => {
        if (dentro) {
          bajoCursor.add(notificacion.id)
          return
        }
        bajoCursor.delete(notificacion.id)
        if (caducadas.delete(notificacion.id)) iniciarDescarte(notificacion.id)
      },
    }) as Gtk.Widget
  })
  return { elemento, desecharAmbito }
}

function medirAltura(elemento: Gtk.Widget): number {
  try {
    const [, alturaNatural] = elemento.measure(Gtk.Orientation.VERTICAL, ANCHO_POPUP)
    return alturaNatural
  } catch {
    return 96
  }
}

function registrarVisible(
  notificacion: StoredNotification,
  elemento: Gtk.Widget,
  desecharAmbito: () => void,
  contador: number,
): void {
  widgets.set(notificacion.id, elemento)
  ambitos.set(notificacion.id, desecharAmbito)
  alturas.set(notificacion.id, medirAltura(elemento))
  visibles.set(notificacion.id, notificacion)
  contadores.set(notificacion.id, contador)
  programarDescarte(notificacion)
  setHayPopups(true)
}

/** Hace sitio a una crítica retirando la tarjeta menos importante que no esté bajo el cursor. */
function expulsarPara(notificacion: StoredNotification): boolean {
  if (prioridadPopup(notificacion) < PRIORIDAD_CRITICA) return false
  let candidata: StoredNotification | null = null
  for (const visible of visibles.values()) {
    if (bajoCursor.has(visible.id) || prioridadPopup(visible) >= PRIORIDAD_CRITICA) continue
    if (!candidata || prioridadPopup(visible) < prioridadPopup(candidata)) candidata = visible
  }
  if (!candidata) return false
  eliminarInmediatamente(candidata.id, false)
  return true
}

function drenarCola(): void {
  if (!contenedor || notifPanelVisible.get()) return

  const ahora = Date.now()
  for (let i = pendientes.length - 1; i >= 0; i--) {
    if (esObsoletaEnCola(pendientes[i], ahora)) {
      contadoresPendientes.delete(pendientes[i].id)
      pendientes.splice(i, 1)
    }
  }

  while (pendientes.length > 0) {
    const notificacion = pendientes[0]
    if (widgets.size >= MAXIMO_POPUPS) {
      if (expulsarPara(notificacion)) continue
      break
    }

    const contador = contadoresPendientes.get(notificacion.id) ?? 1
    const { elemento, desecharAmbito } = construirElemento(notificacion, contador)

    if (!canFitPopup(
      Array.from(alturas.values()),
      medirAltura(elemento),
      alturaDisponible(),
      MAXIMO_POPUPS,
      ESPACIADO_POPUPS,
      POPUPS_GARANTIZADOS,
      PRESUPUESTO_PILA,
    )) {
      callbacksDescarte.delete(notificacion.id)
      desecharAmbito()
      if (expulsarPara(notificacion)) continue
      break
    }

    pendientes.shift()
    contadoresPendientes.delete(notificacion.id)
    registrarVisible(notificacion, elemento, desecharAmbito, contador)
    contenedor.append(elemento)
  }
}

function claveDe(notificacion: StoredNotification): string | null {
  return claveAgrupacion(notificacion, appCoincide(notificacion.appName, popupsConversacion.get()))
}

/** Sustituye la tarjeta sin cambiarla de sitio, para que no salte al final de la pila. */
function reemplazarVisible(vieja: StoredNotification, nueva: StoredNotification, contador: number): void {
  const anterior = widgets.get(vieja.id)?.get_prev_sibling() ?? null
  eliminarInmediatamente(vieja.id, false)
  const { elemento, desecharAmbito } = construirElemento(nueva, contador)
  registrarVisible(nueva, elemento, desecharAmbito, contador)
  contenedor?.insert_child_after(elemento, anterior)
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

/** ¿Ya se está enseñando o espera en cola una idéntica? Entonces no hay popup ni sonido. */
export function esPopupDuplicado(notificacion: StoredNotification): boolean {
  for (const visible of visibles.values()) if (sonIdenticas(visible, notificacion)) return true
  return pendientes.some((pendiente) => sonIdenticas(pendiente, notificacion))
}

export function agregarPopup(notificacion: StoredNotification): void {
  if (esPopupDuplicado(notificacion)) return

  for (const visible of Array.from(visibles.values())) {
    if (anulaEvento(notificacion, visible)) iniciarDescarte(visible.id)
  }
  for (let i = pendientes.length - 1; i >= 0; i--) {
    if (anulaEvento(notificacion, pendientes[i])) pendientes.splice(i, 1)
  }

  const clave = claveDe(notificacion)
  const coincide = (otra: StoredNotification) =>
    otra.id === notificacion.id || (clave !== null && claveDe(otra) === clave)

  const visible = Array.from(visibles.values()).find(coincide)
  if (visible) {
    reemplazarVisible(visible, notificacion, (contadores.get(visible.id) ?? 1) + (visible.id === notificacion.id ? 0 : 1))
    return
  }

  let contador = 1
  const indicePendiente = pendientes.findIndex(coincide)
  if (indicePendiente >= 0) {
    const pendiente = pendientes[indicePendiente]
    contador = (contadoresPendientes.get(pendiente.id) ?? 1) + (pendiente.id === notificacion.id ? 0 : 1)
    contadoresPendientes.delete(pendiente.id)
    pendientes.splice(indicePendiente, 1)
  }
  if (contador > 1) contadoresPendientes.set(notificacion.id, contador)
  insertarPorPrioridad(pendientes, notificacion)
  drenarCola()
}

export function descartarTodosLosPopups(): void {
  for (const id of Array.from(widgets.keys())) eliminarInmediatamente(id, false)
}

/** Al activarse una condición de silencio, retira lo que su política ya no deja pasar. */
export function expirarPopupsNoPermitidos(permitida: (n: StoredNotification) => boolean): void {
  for (let i = pendientes.length - 1; i >= 0; i--) {
    if (!permitida(pendientes[i])) pendientes.splice(i, 1)
  }
  for (const visible of Array.from(visibles.values())) {
    if (!permitida(visible)) iniciarDescarte(visible.id)
  }
}

export function reiniciarPilaPorRafaga(): void {
  pendientes.splice(0)
  descartarTodosLosPopups()
}

export const ANCHO_VENTANA_POPUP = ANCHO_POPUP
export const ESPACIADO_VENTANA_POPUP = ESPACIADO_POPUPS
