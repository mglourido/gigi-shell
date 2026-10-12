import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import GLib from "gi://GLib"
import { barTopMargin, clasesFondoShell } from "../ajustes/preferences"
import {
  notifPanelVisible,
  closeNotifPanel,
} from "./store"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import CabeceraPanel from "./panel/CabeceraPanel"
import ListaPanel from "./panel/ListaPanel"
import PiePanel from "./panel/PiePanel"

// ── Ventana principal ─────────────────────────────────────────────────────────

export default function NotificationPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, BOTTOM, RIGHT } = Astal.WindowAnchor
  const PANEL_TOTAL_WIDTH = 407
  const PANEL_PANEL_WIDTH = 389
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
  // Entrada y salida son excluyentes; comparten un único temporizador de finalización.
  let temporizadorAnimacion: number | null = null
  let hoverCloseTimer: number | null = null
  // Recorte de la región de entrada; se asigna tras construir la ventana. Debe re-ejecutarse al
  // terminar la animación de entrada (el transform de deslizamiento falsea la medida mientras corre).
  let reclipInput: ((inmediato?: boolean) => void) | null = null

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

  function cancelarAnimacion(): void {
    entrancePending = false
    cancelPrepare()
    if (temporizadorAnimacion !== null) {
      GLib.source_remove(temporizadorAnimacion)
      temporizadorAnimacion = null
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
    temporizadorAnimacion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_ENTER_MS, () => {
      temporizadorAnimacion = null
      reclipInput?.()
      return GLib.SOURCE_REMOVE
    })
  }

  function beginEntrance(): void {
    cancelarAnimacion()
    animationRef?.remove_css_class("np-leaving")
    animationRef?.remove_css_class("np-entering")
    animationRef?.add_css_class("np-preparing")
    setPanelRendered(true)
    entrancePending = true

    // Esperar al layout y a un frame preparado evita el microcorte de la primera
    // apertura. Un retraso fijo de 32 ms no bastaba al crear la superficie y los glifos.
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
  const bajaVisibilidad = notifPanelVisible.subscribe(() => {
    cancelHoverClose()
    setPanelKeyboardActive(false)
    if (notifPanelVisible.get()) {
      beginEntrance()
      return
    }

    cancelarAnimacion()
    animationRef?.remove_css_class("np-preparing")
    animationRef?.remove_css_class("np-entering")
    animationRef?.add_css_class("np-leaving")
    temporizadorAnimacion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_EXIT_MS, () => {
      temporizadorAnimacion = null
      setPanelRendered(false)
      animationRef?.remove_css_class("np-leaving")
      return GLib.SOURCE_REMOVE
    })
  })

  onCleanup(() => {
    bajaVisibilidad()
    cancelarAnimacion()
    cancelHoverClose()
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
      // La altura la asigna el compositor, independiente del contenido y la animación.
      anchor={TOP | BOTTOM | RIGHT}
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
        vexpand
        $={(self: any) => { animationRef = self }}
      >
        <box cssClasses={["np-bar-connector"]} valign={Gtk.Align.START} />
        <box
          cssClasses={["np-panel"]}
          widthRequest={PANEL_PANEL_WIDTH}
          orientation={Gtk.Orientation.VERTICAL}
          spacing={0}
          vexpand
          $={(self: any) => {
            panelRef = self
          }}
        >
          <Gtk.EventControllerMotion onEnter={handlePointerEnter} onLeave={handlePointerLeave} />

          {/* Vista principal (los ajustes ahora viven en una ventana centrada aparte) */}
          <box orientation={Gtk.Orientation.VERTICAL} spacing={0} vexpand>
            <CabeceraPanel />
            <ListaPanel rendered={panelRendered} />
            <PiePanel />
          </box>
        </box>
      </box>
    </window>
  )

  reclipInput = clipWindowInputToContent(win, panelRef)
  if (notifPanelVisible.get()) beginEntrance()
  return win
}
