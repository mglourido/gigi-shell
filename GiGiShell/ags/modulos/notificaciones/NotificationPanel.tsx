import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState } from "ags"
import GLib from "gi://GLib"
import { barTopMargin, clasesFondoShell } from "../ajustes/preferences"
import {
  notifications,
  notifPanelVisible,
  closeNotifPanel,
} from "./store"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import CabeceraPanel from "./panel/CabeceraPanel"
import ListaPanel from "./panel/ListaPanel"
import PiePanel from "./panel/PiePanel"

// ── Ventana principal ─────────────────────────────────────────────────────────

export default function NotificationPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, RIGHT } = Astal.WindowAnchor
  const PANEL_TOTAL_WIDTH = 407
  const PANEL_PANEL_WIDTH = 389
  // Espacio reservado para la barra superior, la cabecera del panel y un
  // pequeño margen inferior. La lista crece de forma natural hasta este límite.
  const MAX_LIST_HEIGHT = Math.max(210, gdkmonitor.get_geometry().height - 120)
  // La animación dura 280 ms; estos 20 ms extra garantizan que GTK pinte el
  // último frame con el panel completamente fuera antes de ocultar la ventana.
  const PANEL_EXIT_MS = 300
  const PANEL_ENTER_MS = 280
  // Techo de seguridad del arranque de la entrada. El reloj de frames sólo corre mientras
  // la superficie está mapeada, así que si no llegara ningún tick con allocación la
  // animación debe arrancar igual: quedarse en `np-preparing` es quedarse en opacity 0,
  // o sea un panel abierto e invisible. Fail-open, como la puerta del Wake up.
  const PANEL_PREPARE_CAP_MS = 120
  const [panelRendered, setPanelRendered] = createState(notifPanelVisible.get())
  // Igual que Quick Settings: mapear la superficie directamente con ON_DEMAND
  // deja el foco de puntero de Hyprland desactualizado hasta mover el ratón y se
  // pierde el clic inmediato sobre el botón del bar. Se pide teclado solo cuando
  // el usuario entra en el panel, manteniendo Escape sin romper el toggle.
  const [panelKeyboardActive, setPanelKeyboardActive] = createState(false)
  let panelRef: any = null
  let animationRef: any = null
  let windowRef: any = null
  let enterTickId: number | null = null
  let enterCapTimer: number | null = null
  let entrancePending = false
  let enterSettleTimer: number | null = null
  let exitTimer: number | null = null
  let hoverCloseTimer: number | null = null
  let alturaConservada = -1
  // Recorte de la región de entrada; se asigna tras construir la ventana. Debe re-ejecutarse al
  // terminar la animación de entrada (el transform de deslizamiento falsea la medida mientras corre).
  let reclipInput: ((inmediato?: boolean) => void) | null = null

  /**
   * Mantiene estable la geometría visible durante esta apertura. Las notificaciones
   * actualizan su lista de forma síncrona, pero GTK recalcula el layout después; por
   * eso este método, llamado desde la suscripción previa al repintado, todavía ve la
   * altura con la que el panel se estaba mostrando. `height-request` es un mínimo:
   * contenido nuevo puede hacerlo crecer, mientras que borrar contenido no encoge la
   * superficie justo antes de la animación de salida.
   */
  function conservarAlturaActual(): void {
    const alturaActual = panelRef?.get_height?.() ?? 0
    if (alturaActual <= 0) return
    alturaConservada = Math.max(alturaConservada, alturaActual)
    panelRef?.set_height_request?.(alturaConservada)
  }

  function liberarAlturaConservada(): void {
    alturaConservada = -1
    panelRef?.set_height_request?.(-1)
  }

  // Se registra antes de construir la cabecera y la lista para capturar la
  // asignación anterior antes de que sus suscriptores reconstruyan u oculten filas.
  notifications.subscribe(() => {
    if (notifPanelVisible.get()) conservarAlturaActual()
  })

  function cancelHoverClose(): void {
    if (hoverCloseTimer === null) return
    GLib.source_remove(hoverCloseTimer)
    hoverCloseTimer = null
  }

  function pointerIsOverPanel(): boolean {
    try {
      const surface = windowRef?.get_surface()
      const pointer = windowRef?.get_display()?.get_default_seat()?.get_pointer()
      if (!surface || !pointer) return false
      const [inside] = surface.get_device_position(pointer)
      return inside
    } catch (_) {
      return false
    }
  }

  function handlePointerEnter(): void {
    cancelHoverClose()
    setPanelKeyboardActive(true)
  }

  function handlePointerLeave(): void {
    cancelHoverClose()
    if (!notifPanelVisible.get()) return
    hoverCloseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      hoverCloseTimer = null
      if (notifPanelVisible.get() && !pointerIsOverPanel()) closeNotifPanel()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Suelta el tick y el techo de la preparación, ganen o pierdan. */
  function cancelPrepare(): void {
    if (enterTickId !== null) {
      animationRef?.remove_tick_callback(enterTickId)
      enterTickId = null
    }
    if (enterCapTimer !== null) {
      GLib.source_remove(enterCapTimer)
      enterCapTimer = null
    }
  }

  /** Arranca el deslizamiento visible. Idempotente: la gana el tick o el techo, no ambos. */
  function startEntrance(): void {
    if (!entrancePending) return
    entrancePending = false
    cancelPrepare()
    // Medir ANTES de añadir la clase que dispara el transform: la región queda
    // fija en su posición final desde el primer frame, no desplazada hasta el
    // reclip de abajo. Ver utilidades/inputRegion.ts.
    reclipInput?.(true)
    animationRef?.remove_css_class("np-preparing")
    animationRef?.add_css_class("np-entering")
    // Al terminar el deslizamiento (transform en identidad) re-medir la región
    // de entrada, por si algo cambió de tamaño durante la animación.
    enterSettleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_ENTER_MS, () => {
      reclipInput?.()
      enterSettleTimer = null
      return GLib.SOURCE_REMOVE
    })
  }

  function beginEntrance(): void {
    entrancePending = false
    cancelPrepare()
    if (enterSettleTimer !== null) { GLib.source_remove(enterSettleTimer); enterSettleTimer = null }
    animationRef?.remove_css_class("np-leaving")
    animationRef?.remove_css_class("np-entering")
    animationRef?.add_css_class("np-preparing")
    setPanelRendered(true)
    entrancePending = true

    // La animación arranca cuando GTK dice que ya ha medido y pintado, NO a un plazo
    // fijo. Antes eran 32 ms ("dos fotogramas aproximadamente") apostados a ciegas: en la
    // 1.ª apertura la ventana todavía no se había mapeado nunca, así que ahí caían de
    // golpe el realize de la superficie, la primera resolución del CSS global (~90 KB)
    // contra todo el subárbol `.np-*`, la rasterización de los glifos Nerd Font del
    // header y el primer render node. Cuando eso no cabía en 32 ms el deslizamiento
    // empezaba con el layout a medias — el microcorte de la primera vez. El reloj de
    // frames ya sabe cuándo ha terminado; se le pregunta en vez de adivinar.
    let framesSeen = 0
    enterTickId = animationRef?.add_tick_callback((widget: any) => {
      if (!entrancePending) return GLib.SOURCE_REMOVE
      // El tick corre en la fase de ACTUALIZACIÓN, antes de pintar, y los primeros pueden
      // llegar sin allocación. Se espera a tener altura real (ya medido) y a un frame más:
      // ese es el primero con el panel preparado ya pintado.
      if ((widget.get_height?.() ?? 0) <= 0) return GLib.SOURCE_CONTINUE
      if (++framesSeen < 2) return GLib.SOURCE_CONTINUE
      enterTickId = null   // ya nos vamos: que cancelPrepare no lo quite dos veces
      startEntrance()
      return GLib.SOURCE_REMOVE
    }) ?? null

    enterCapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_PREPARE_CAP_MS, () => {
      enterCapTimer = null
      startEntrance()
      return GLib.SOURCE_REMOVE
    })
  }

  // La ventana permanece creada mientras está oculta, así que la clase debe
  // retirarse al cerrar y añadirse de nuevo en cada apertura para reiniciar CSS.
  // `panelRendered` retrasa el ocultado hasta que acaba la animación de salida.
  notifPanelVisible.subscribe(() => {
    cancelHoverClose()
    if (notifPanelVisible.get()) {
      setPanelKeyboardActive(false)
      if (exitTimer !== null) {
        GLib.source_remove(exitTimer)
        exitTimer = null
      }
      liberarAlturaConservada()
      beginEntrance()
      return
    }

    // Congelar antes de que closeNotifPanel quite el footer de selección o cualquier
    // otro hijo reactivo. La salida conserva así exactamente la altura que se veía.
    conservarAlturaActual()
    setPanelKeyboardActive(false)
    entrancePending = false
    cancelPrepare()
    if (enterSettleTimer !== null) {
      GLib.source_remove(enterSettleTimer)
      enterSettleTimer = null
    }
    animationRef?.remove_css_class("np-preparing")
    animationRef?.remove_css_class("np-entering")
    animationRef?.add_css_class("np-leaving")
    if (exitTimer !== null) GLib.source_remove(exitTimer)
    exitTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_EXIT_MS, () => {
      setPanelRendered(false)
      animationRef?.remove_css_class("np-leaving")
      liberarAlturaConservada()
      exitTimer = null
      return GLib.SOURCE_REMOVE
    })
  })

  const win = (
    <window
      name="notification-panel"
      namespace="notification-panel"
      visible={panelRendered}
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={panelKeyboardActive((active) =>
        active ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
      anchor={TOP | RIGHT}
      application={app}
      widthRequest={PANEL_TOTAL_WIDTH}
      // La barra fija reserva 38px; mantener el mismo solape visual de 1px que
      // usamos al flotar evita que aparezca una costura entre ambas superficies.
      marginTop={barTopMargin(37, -1)}
      marginRight={0}
      decorated={false}
      cssClasses={clasesFondoShell("np-window")}
      $={(self: any) => { windowRef = self }}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) { closeNotifPanel(); return true }
          return false
        }}
      />

      <box
        cssClasses={["np-wrapper"]}
        orientation={Gtk.Orientation.HORIZONTAL}
        spacing={0}
        $={(self: any) => {
          animationRef = self
          if (notifPanelVisible.get()) beginEntrance()
        }}
      >
        <box cssClasses={["np-bar-connector"]} valign={Gtk.Align.START} />
        <box
          cssClasses={["np-panel"]}
          widthRequest={PANEL_PANEL_WIDTH}
          orientation={Gtk.Orientation.VERTICAL}
          spacing={0}
          $={(self: any) => {
            panelRef = self
          }}
        >
          <Gtk.EventControllerMotion onEnter={handlePointerEnter} onLeave={handlePointerLeave} />

          {/* Vista principal (los ajustes ahora viven en una ventana centrada aparte) */}
          <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
            <CabeceraPanel />
            <ListaPanel maxContentHeight={MAX_LIST_HEIGHT} rendered={panelRendered} />
            <PiePanel />
          </box>
        </box>
      </box>
    </window>
  )

  reclipInput = clipWindowInputToContent(win, panelRef)
  return win
}
