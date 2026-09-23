import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createComputed, createState, onCleanup } from "ags"
import GLib from "gi://GLib"
import { calendarVisible, setCalendarVisible, panelAutoClose } from "../../estado/shell"
import { barTopMargin, clasesFondoShell } from "../ajustes/preferences"
import { clipWindowInputToContent } from "../../utilidades/inputRegion.ts"
import { VistaMes } from "./calendario/VistaMes.tsx"
import { AgendaDia } from "./calendario/AgendaDia.tsx"
import { FormularioEvento } from "./calendario/FormularioEvento.tsx"
import { VistaReloj } from "./reloj/VistaReloj.tsx"
import { EstadoGoogle } from "./google/EstadoGoogle.tsx"
import {
  cerrarEdicion,
  edicion,
  establecerSeccionActiva,
  seccionActiva,
} from "./estado.ts"

/**
 * Panel lateral de calendario y reloj.
 *
 * **Las dos secciones se construyen una sola vez y se conmutan con un `Gtk.Stack`**, no se montan y
 * desmontan. Son baratas y sin estado de disco, y así cambiar de pestaña no pierde el mes que
 * estabas mirando ni reinicia la cuenta atrás visible. Lo que sí se apaga al ocultarse son los
 * *ticks*: cada widget del reloj cuelga del `relojVisible` que se calcula aquí, así que con el panel
 * cerrado —o en la pestaña Calendario— no queda ni un temporizador de repintado vivo.
 *
 * El editor de eventos, en cambio, sí se monta y desmonta: tiene estado propio y widgets con foco.
 */
export default function PanelCalendario(gdkmonitor: Gdk.Monitor) {
  const { LEFT, TOP, BOTTOM } = Astal.WindowAnchor
  const DURACION_ENTRADA_MS = 280
  const DURACION_SALIDA_MS = 300
  const TOPE_PREPARACION_MS = 120

  const vistaMes = VistaMes()
  const agenda = AgendaDia()
  vistaMes.set_hexpand(true)
  agenda.set_hexpand(true)
  agenda.set_vexpand(true)

  const relojVisible = createComputed(() => calendarVisible() && seccionActiva() === "reloj")
  const vistaReloj = VistaReloj({ visible: relojVisible })

  const pila = new Gtk.Stack()
  pila.set_hexpand(true)
  pila.set_vexpand(true)
  pila.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
  pila.set_transition_duration(120)

  const vistaCalendario = (
    <box cssClasses={["cal-cuerpo"]} orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand vexpand>
      {vistaMes}
      {agenda}
    </box>
  ) as unknown as Gtk.Widget

  pila.add_named(vistaCalendario, "calendario")
  pila.add_named(vistaReloj, "reloj")
  pila.set_visible_child_name(seccionActiva.get())

  const botonCalendario = new Gtk.Button()
  const botonReloj = new Gtk.Button()
  const contenidoPestana = (icono: string, texto: string) => {
    const contenido = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER })
    const glifo = new Gtk.Label({ label: icono })
    const etiqueta = new Gtk.Label({ label: texto })
    glifo.set_css_classes(["cal-view-tab-icono"])
    etiqueta.set_css_classes(["cal-view-tab-texto"])
    contenido.append(glifo)
    contenido.append(etiqueta)
    return contenido
  }
  botonCalendario.set_child(contenidoPestana("󰃭", "Calendario"))
  botonReloj.set_child(contenidoPestana("󰥔", "Reloj"))
  botonCalendario.set_valign(Gtk.Align.CENTER)
  botonReloj.set_valign(Gtk.Align.CENTER)
  botonCalendario.connect("clicked", () => establecerSeccionActiva("calendario"))
  botonReloj.connect("clicked", () => establecerSeccionActiva("reloj"))

  function sincronizarPestanas() {
    const activa = seccionActiva.get()
    pila.set_visible_child_name(activa)
    botonCalendario.set_css_classes(activa === "calendario" ? ["cal-view-tab", "active"] : ["cal-view-tab"])
    botonReloj.set_css_classes(activa === "reloj" ? ["cal-view-tab", "active"] : ["cal-view-tab"])
  }
  const bajaPestanas = seccionActiva.subscribe(sincronizarPestanas)
  sincronizarPestanas()

  // ── Editor de eventos (overlay que se monta y desmonta) ───────────────────
  const overlay = new Gtk.Overlay()
  overlay.set_child(pila)

  let formularioVivo: Gtk.Widget | null = null
  // Se observa si HAY edición, no la edición en sí: `edicion` cambia también al parchear el
  // borrador, y reconstruir el formulario en cada tecleo destruiría el widget que tiene el foco.
  const hayEdicion = createComputed(() => edicion() !== null)
  function sincronizarEditor() {
    if (formularioVivo) {
      overlay.remove_overlay(formularioVivo)
      formularioVivo = null
    }
    if (hayEdicion.get()) {
      formularioVivo = FormularioEvento({ altoDisponible: overlay.get_allocated_height() })
      // El fondo oscurecido se estira A MANO: un hijo de `Gtk.Overlay` se mide por su tamaño
      // natural, así que sin esto el velo solo cubría la tarjeta y el resto del panel seguía
      // pareciendo pulsable.
      formularioVivo.set_hexpand(true)
      formularioVivo.set_vexpand(true)
      formularioVivo.set_halign(Gtk.Align.FILL)
      formularioVivo.set_valign(Gtk.Align.FILL)
      overlay.add_overlay(formularioVivo)
    }
  }
  const bajaEdicion = hayEdicion.subscribe(sincronizarEditor)
  // Se llama también al construir: `subscribe` solo avisa de los CAMBIOS, así que un panel montado
  // con una edición ya abierta se quedaría sin editor y sin ninguna señal de por qué.
  sincronizarEditor()

  onCleanup(() => {
    for (const baja of [bajaPestanas, bajaEdicion]) if (typeof baja === "function") baja()
  })

  const calAutoClose = panelAutoClose(() => setCalendarVisible(false), 300, calendarVisible)
  const [panelRenderizado, establecerPanelRenderizado] = createState(calendarVisible.get())
  const [tecladoActivo, establecerTecladoActivo] = createState(false)
  let envoltorioAnimado: Gtk.Widget | null = null
  let idTickEntrada: number | null = null
  let temporizadorPreparacion: number | null = null
  let temporizadorAsentamiento: number | null = null
  let temporizadorSalida: number | null = null
  let entradaPendiente = false
  let recalcularRegionEntrada: ((inmediato?: boolean) => void) | null = null

  function cancelarPreparacion(): void {
    if (idTickEntrada !== null) {
      envoltorioAnimado?.remove_tick_callback(idTickEntrada)
      idTickEntrada = null
    }
    if (temporizadorPreparacion !== null) {
      GLib.source_remove(temporizadorPreparacion)
      temporizadorPreparacion = null
    }
  }

  function iniciarEntrada(): void {
    if (!entradaPendiente) return
    entradaPendiente = false
    cancelarPreparacion()
    // Medir ANTES de añadir la clase que dispara el transform: si se mide
    // después, `compute_bounds()` devuelve la posición ya desplazada y esa es
    // la región que queda fija durante toda la animación. Midiendo aquí la
    // región clicable queda en su sitio final desde el primer frame.
    recalcularRegionEntrada?.(true)
    envoltorioAnimado?.remove_css_class("cal-preparing")
    envoltorioAnimado?.add_css_class("cal-entering")
    // Se vuelve a recortar al terminar, por si algo cambió de tamaño durante la animación.
    temporizadorAsentamiento = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      DURACION_ENTRADA_MS,
      () => {
        recalcularRegionEntrada?.()
        temporizadorAsentamiento = null
        return GLib.SOURCE_REMOVE
      },
    )
  }

  function prepararEntrada(): void {
    entradaPendiente = false
    cancelarPreparacion()
    if (temporizadorAsentamiento !== null) {
      GLib.source_remove(temporizadorAsentamiento)
      temporizadorAsentamiento = null
    }
    envoltorioAnimado?.remove_css_class("cal-leaving")
    envoltorioAnimado?.remove_css_class("cal-entering")
    envoltorioAnimado?.add_css_class("cal-preparing")
    establecerPanelRenderizado(true)
    entradaPendiente = true

    // Igual que Notificaciones, la entrada espera a que GTK haya medido y pintado
    // la superficie preparada. El límite evita dejar un panel invisible si el reloj
    // de frames no llegara a arrancar durante el primer mapeo.
    let fotogramasVistos = 0
    idTickEntrada = envoltorioAnimado?.add_tick_callback((widget: Gtk.Widget) => {
      if (!entradaPendiente) return GLib.SOURCE_REMOVE
      if ((widget.get_height?.() ?? 0) <= 0) return GLib.SOURCE_CONTINUE
      if (++fotogramasVistos < 2) return GLib.SOURCE_CONTINUE
      idTickEntrada = null
      iniciarEntrada()
      return GLib.SOURCE_REMOVE
    }) ?? null

    temporizadorPreparacion = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      TOPE_PREPARACION_MS,
      () => {
        temporizadorPreparacion = null
        iniciarEntrada()
        return GLib.SOURCE_REMOVE
      },
    )
  }

  const bajaVisibilidad = calendarVisible.subscribe(() => {
    establecerTecladoActivo(false)
    if (calendarVisible.get()) {
      if (temporizadorSalida !== null) {
        GLib.source_remove(temporizadorSalida)
        temporizadorSalida = null
      }
      prepararEntrada()
      return
    }

    // Cerrar el panel cancela una edición a medias. Dejarla viva reabriría el formulario con datos
    // de hace media hora encima de lo que el usuario venga a hacer.
    cerrarEdicion()
    entradaPendiente = false
    cancelarPreparacion()
    if (temporizadorAsentamiento !== null) {
      GLib.source_remove(temporizadorAsentamiento)
      temporizadorAsentamiento = null
    }
    envoltorioAnimado?.remove_css_class("cal-preparing")
    envoltorioAnimado?.remove_css_class("cal-entering")
    envoltorioAnimado?.add_css_class("cal-leaving")
    if (temporizadorSalida !== null) GLib.source_remove(temporizadorSalida)
    temporizadorSalida = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DURACION_SALIDA_MS, () => {
      establecerPanelRenderizado(false)
      envoltorioAnimado?.remove_css_class("cal-leaving")
      temporizadorSalida = null
      return GLib.SOURCE_REMOVE
    })
  })

  onCleanup(() => {
    if (typeof bajaVisibilidad === "function") bajaVisibilidad()
    entradaPendiente = false
    cancelarPreparacion()
    for (const temporizador of [temporizadorAsentamiento, temporizadorSalida]) {
      if (temporizador !== null) GLib.source_remove(temporizador)
    }
  })

  let superficiePanel: Gtk.Widget | null = null
  const ventana = <window
    name="calendar-panel"
    namespace="calendar-panel"
    gdkmonitor={gdkmonitor}
    application={app}
    visible={panelRenderizado}
    anchor={LEFT | TOP | BOTTOM}
    layer={Astal.Layer.TOP}
    exclusivity={Astal.Exclusivity.NORMAL}
    keymode={tecladoActivo((activo) => (activo ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE))}
    // Solapamos 1 px el borde inferior de la barra para que no aparezca una costura transparente,
    // tanto cuando flota (37 px) como cuando su zona exclusiva ya reserva la altura (-1 px).
    marginTop={barTopMargin(37, -1)}
    // La superficie anclada se prolonga 1 px bajo el límite del monitor para absorber el redondeo
    // de la escala de salida y mantener pintada también la última fila visible.
    marginBottom={-1}
    widthRequest={428}
    decorated={false}
    cssClasses={clasesFondoShell("cal-window")}
  >
    <Gtk.EventControllerKey
      onKeyPressed={(_self, keyval) => {
        if (keyval !== Gdk.KEY_Escape) return false
        // Escape cierra primero el editor y solo después el panel: con un único nivel, cancelar un
        // formulario cerraría también el calendario y habría que reabrirlo para seguir.
        if (edicion.get() !== null) cerrarEdicion()
        else setCalendarVisible(false)
        return true
      }}
    />
    <box
      cssClasses={["cal-wrapper"]}
      spacing={0}
      vexpand
      $={(self: Gtk.Widget) => {
        envoltorioAnimado = self
        if (calendarVisible.get()) prepararEntrada()
      }}
    >
      <box
        cssClasses={["cal-panel", "cal-superficie"]}
        orientation={Gtk.Orientation.VERTICAL}
        overflow={Gtk.Overflow.HIDDEN}
        widthRequest={410}
        vexpand
        $={(self: Gtk.Widget) => { superficiePanel = self }}
      >
        <Gtk.EventControllerMotion
          onEnter={() => {
            calAutoClose.onEnter()
            establecerTecladoActivo(true)
          }}
          onLeave={calAutoClose.onLeave}
        />

        <box cssClasses={["cal-titlebar"]} spacing={5}>
          <box cssClasses={["cal-view-tabs"]} spacing={3} valign={Gtk.Align.CENTER}>
            {botonCalendario}
            {botonReloj}
          </box>
          <box hexpand />
          {EstadoGoogle()}
        </box>

        <box hexpand vexpand>
          {overlay}
        </box>
      </box>
      <box cssClasses={["cal-bar-connector"]} valign={Gtk.Align.START} />
    </box>
  </window>

  // El conector solo pinta su curva superior. El resto de sus 18 px es transparente y debe dejar
  // pasar los clics, igual que en los paneles de Notificaciones y Ajustes rápidos.
  recalcularRegionEntrada = clipWindowInputToContent(ventana, superficiePanel)
  return ventana
}
