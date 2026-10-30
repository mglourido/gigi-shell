/**
 * Popups temporales en la esquina superior derecha.
 * Mantiene la integración con el daemon, los paneles y la ventana; el elemento visual,
 * la lógica pura y la pila imperativa viven en módulos independientes.
 */

import { createState } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import AstalNotifd from "gi://AstalNotifd"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import { quickSettingsVisible } from "../../estado/shell"
import {
  obtenerControlVisibilidadBarra,
  type EstadoVisibilidadBarra,
} from "../../estado/visibilidadBarra"
import { barAutoHideEnabled, clasesFondoShell } from "../ajustes/preferences"
import { ingest } from "./procesamiento/ingesta.ts"
import {
  crearResumenRafaga, crearResumenReanudacion, PRIORIDAD_CRITICA, prioridadPopup,
} from "./popup/logica.ts"
import { notificacionPermitida } from "./autoDnd/watcher.ts"
import { alReanudar } from "../../servicios/sistema/reanudacion"
import { PopupBurstGuard } from "./popup/rafaga.ts"
import {
  agregarPopup,
  ANCHO_VENTANA_POPUP,
  actualizarMargenPila,
  configurarPilaPopups,
  descartarTodosLosPopups,
  ESPACIADO_VENTANA_POPUP,
  hayPopups,
  reiniciarPilaPorRafaga,
} from "./popup/pila.ts"
import { notifPanelVisible, type StoredNotification } from "./store"

const UMBRAL_RAFAGA = 20
const VENTANA_RAFAGA_MS = 8000
const ESPERA_RESUMEN_RAFAGA_MS = 1200
const MARGEN_SUPERIOR_PANEL = 38
const SEPARACION_PANEL_POPUP = 10
// El menú de energía NO está aquí a propósito: es una capa a pantalla completa
// (anclada a los cuatro bordes) con el menú centrado, así que su "borde inferior"
// es el de la pantalla y empujaba los popups hacia abajo al abrirlo.
const NOMBRES_PANELES = ["notification-panel", "quick-settings"]

// Con auto-ocultado la superficie debe compensar el bar. Sin él, la zona exclusiva
// del compositor ya desplaza paneles y popups, por lo que sumarlo duplicaría el hueco.
const desplazamientoPanel = (): number =>
  barAutoHideEnabled.get() ? MARGEN_SUPERIOR_PANEL : 0

const panelesQueDesplazanPopup = [notifPanelVisible, quickSettingsVisible]
let visibilidadPopup: EstadoVisibilidadBarra | null = null
let bajaVisibilidadPopup: (() => void) | null = null

const hayPanelQueDesplazaPopup = (): boolean =>
  panelesQueDesplazanPopup.some((estado) => estado.get())

function obtenerBordeInferiorPanelAbierto(): number {
  for (const nombre of NOMBRES_PANELES) {
    try {
      const ventana = app.get_window(nombre)
      if (!ventana?.visible) continue
      const altura = ventana.get_height()
      if (altura > 0) return desplazamientoPanel() + altura
    } catch {
      // Una ventana puede no estar construida todavía durante el arranque.
    }
  }
  return 0
}

function calcularMargen(): number {
  if (!hayPanelQueDesplazaPopup()) {
    return visibilidadPopup?.visible.get() ? desplazamientoPanel() + 16 : 16
  }

  const bordeInferior = obtenerBordeInferiorPanelAbierto()
  // Mientras GTK aún no conoce la altura se conserva el fallback previo.
  return (bordeInferior > 0 ? bordeInferior : desplazamientoPanel() + 260)
    + SEPARACION_PANEL_POPUP
}

const [margenPopup, setMargenPopup] = createState(calcularMargen())

function aplicarMargenCalculado(): void {
  const margen = calcularMargen()
  setMargenPopup(margen)
  actualizarMargenPila(margen)
}

function programarActualizacionMargen(): void {
  if (notifPanelVisible.get()) descartarTodosLosPopups()

  if (hayPanelQueDesplazaPopup()) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      aplicarMargenCalculado()
      return GLib.SOURCE_REMOVE
    })
    return
  }

  aplicarMargenCalculado()
}

panelesQueDesplazanPopup.forEach((estado) => estado.subscribe(programarActualizacionMargen))
barAutoHideEnabled.subscribe(programarActualizacionMargen)

const protectorRafaga = new PopupBurstGuard(UMBRAL_RAFAGA, VENTANA_RAFAGA_MS)
let temporizadorResumenRafaga: number | null = null
let siguienteIdSintetico = -1
let senalNotificacionConectada = false

function programarResumenRafaga(): void {
  if (temporizadorResumenRafaga !== null) GLib.source_remove(temporizadorResumenRafaga)

  temporizadorResumenRafaga = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    ESPERA_RESUMEN_RAFAGA_MS,
    () => {
      temporizadorResumenRafaga = null
      const cantidad = protectorRafaga.finish()
      if (cantidad > UMBRAL_RAFAGA) {
        agregarPopup(crearResumenRafaga(siguienteIdSintetico--, cantidad))
      }
      return GLib.SOURCE_REMOVE
    },
  )
}

// Al despertar llegan de golpe los avisos acumulados. Lo que no sea urgente ni pida una decisión
// va directo al panel, y al terminar la ventana se resume en un solo popup.
const VENTANA_REANUDACION_MS = 10000
let tragadasReanudacion: StoredNotification[] | null = null

function abrirVentanaReanudacion(): void {
  if (tragadasReanudacion) return
  tragadasReanudacion = []
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, VENTANA_REANUDACION_MS, () => {
    const tragadas = tragadasReanudacion ?? []
    tragadasReanudacion = null
    if (tragadas.length === 1) agregarPopup(tragadas[0])
    else if (tragadas.length > 1) agregarPopup(crearResumenReanudacion(siguienteIdSintetico--, tragadas.length))
    return GLib.SOURCE_REMOVE
  })
}

function gestionarPopupEntrante(notificacion: StoredNotification): void {
  const prioridad = prioridadPopup(notificacion)
  // Una crítica no espera a ningún resumen.
  if (prioridad >= PRIORIDAD_CRITICA) {
    agregarPopup(notificacion)
    return
  }
  if (tragadasReanudacion && prioridad < 2) {
    tragadasReanudacion.push(notificacion)
    return
  }

  const rafaga = protectorRafaga.record(Date.now())
  if (!rafaga.bursting) {
    agregarPopup(notificacion)
    return
  }

  if (rafaga.triggered) reiniciarPilaPorRafaga()
  programarResumenRafaga()
}

export default function NotificationPopup(monitor: Gdk.Monitor) {
  const { TOP, RIGHT } = Astal.WindowAnchor
  const daemonNotificaciones = AstalNotifd.get_default()

  bajaVisibilidadPopup?.()
  visibilidadPopup = obtenerControlVisibilidadBarra(monitor)
  bajaVisibilidadPopup = visibilidadPopup.visible.subscribe(programarActualizacionMargen)
  const margenInicial = calcularMargen()
  setMargenPopup(margenInicial)

  if (!senalNotificacionConectada) {
    senalNotificacionConectada = true
    alReanudar(abrirVentanaReanudacion)
    daemonNotificaciones.connect("notified", (_daemon, id) => {
      const notificacionActiva = daemonNotificaciones.get_notification(id)
      if (!notificacionActiva) return

      const notificacion = ingest(notificacionActiva)
      if (!notificacion || daemonNotificaciones.dontDisturb) return
      if (!notificacionPermitida(notificacion)) return
      gestionarPopupEntrante(notificacion)
    })
  }

  const contenedor = (
    <box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={ESPACIADO_VENTANA_POPUP}
      halign={Gtk.Align.END}
      valign={Gtk.Align.START}
    />
  ) as Gtk.Box

  configurarPilaPopups(contenedor, monitor, margenInicial)

  const ventana = (
    <window
      name="notification-popups"
      namespace="notification-popups"
      gdkmonitor={monitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={TOP | RIGHT}
      application={app}
      marginTop={margenPopup}
      marginRight={16}
      widthRequest={ANCHO_VENTANA_POPUP}
      cssClasses={clasesFondoShell("notif-popup-window")}
      visible={hayPopups}
    >
      {contenedor}
    </window>
  ) as Astal.Window

  // GTK conserva el tamaño anterior de la ventana al reducirse la pila. Recortar
  // por tarjeta retira esa entrada sobrante, los huecos y las esquinas; seguir el
  // layout mantiene la silueta durante los transforms y la recolocación.
  clipWindowInputToContent(ventana, () => {
    const tarjetas: Gtk.Widget[] = []
    for (let tarjeta = contenedor.get_first_child(); tarjeta; tarjeta = tarjeta.get_next_sibling()) {
      tarjetas.push(tarjeta)
    }
    return tarjetas
  }, {
    radioEsquinas: (tarjeta) => tarjeta.has_css_class("dunst") ? 0 : 10,
    vaciarAlMapear: true,
    vaciarSinContenido: true,
    seguirAsignacion: "antes-de-pintar",
  })

  return ventana
}
