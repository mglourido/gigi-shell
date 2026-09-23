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
import { quickSettingsVisible } from "../../estado/shell"
import {
  obtenerControlVisibilidadBarra,
  type EstadoVisibilidadBarra,
} from "../../estado/visibilidadBarra"
import { barAutoHideEnabled, clasesFondoShell } from "../ajustes/preferences"
import { ingest } from "./procesamiento/ingesta.ts"
import { crearResumenRafaga } from "./popup/logica.ts"
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

function gestionarPopupEntrante(notificacion: StoredNotification): void {
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
    daemonNotificaciones.connect("notified", (_daemon, id) => {
      const notificacionActiva = daemonNotificaciones.get_notification(id)
      if (!notificacionActiva) return

      const notificacion = ingest(notificacionActiva)
      if (!notificacion || daemonNotificaciones.dontDisturb) return
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

  return (
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
  )
}
