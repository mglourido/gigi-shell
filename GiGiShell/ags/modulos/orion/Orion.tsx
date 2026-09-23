// Ventana raíz de Orion: la layer OVERLAY anclada abajo, su animación de
// entrada/salida (deslizamiento + fade) y el enrutado de teclado que reenvía
// flechas/Tab/Enter al modelo de navegación compartido. El contenido en sí
// (secciones, búsqueda, panel contextual) vive en `components/`.

import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState } from "ags"
import GLib from "gi://GLib"
import {
  orionVisible,
  setOrionVisible,
  rightPanelVisible,
  hidePanel,
  preparePanelOpen,
  finalizarCierrePanel,
  activeSection,
} from "./state"
import CentroComandos from "./components/shell/CentroComandos"
import { focusSearchAndType } from "./components/shell/SearchBar"
import NavSections from "./components/shell/NavSections"
import { SystemStats } from "./components/sections/HomeSection"
import CornerCurve from "./components/shell/CornerCurve"
import RightPanel from "./components/shell/RightPanel"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import { NavegacionBusqueda } from "./components/shared/NavegacionBusqueda"
import { clasesFondoShell } from "../ajustes/preferences"

export default function Orion(gdkmonitor: Gdk.Monitor) {
  const { BOTTOM } = Astal.WindowAnchor
  const PROPORCION_HOLGURA_VERTICAL = 0.2
  // Techo de seguridad del arranque de la entrada. El reloj de frames sólo corre mientras
  // la superficie está mapeada, así que si no llegara ningún tick con allocación la
  // entrada debe arrancar igual: quedarse en la preparación es quedarse en `opacity: 0`,
  // o sea un Orion abierto e invisible. Fail-open, como en NotificationPanel.
  const TECHO_PREPARACION_MS = 120
  const DURACION_ENTRADA_MS = 280
  const DURACION_ANIMACION_SALIDA_MS = 220
  const ESPERA_DESMAPEO_MS = 280
  // Debe coincidir con el radio usado por components/shell/CornerCurve.tsx.
  const RADIO_CURVAS_LATERALES = 24
  const [orionRenderizado, establecerOrionRenderizado] = createState(orionVisible.get())
  const [cssAnimacionOrion, establecerCssAnimacionOrion] = createState(".orion-wrapper {}")
  let idFramePreparacion: number | null = null
  let temporizadorTechoPreparacion: number | null = null
  let preparacionPendiente = false
  let temporizadorFinEntrada: number | null = null
  let idFrameSalida: number | null = null
  let refVentana: any = null
  const navegacion = new NavegacionBusqueda()
  // El transform de entrada altera temporalmente compute_bounds(); el recorte
  // debe repetirse cuando el panel vuelve a su posición definitiva.
  let recalcularRegionEntrada: (() => void) | null = null

  // Panel shell: [orion-main][separator?][right?]. Las reservas exteriores
  // conservan siempre la misma anchura total: al abrir el panel contextual, su
  // ancho sustituye a la reserva derecha en vez de redimensionar y recentrar la
  // superficie completa de Orion.
  const panelInner = (
    <box cssClasses={["orion-panel"]}>
      <box cssClasses={["orion-main"]} orientation={Gtk.Orientation.VERTICAL}>
        <CentroComandos />
        <NavSections navegacion={navegacion} />
        <SystemStats />
      </box>
      <box cssClasses={["orion-panel-sep"]} visible={rightPanelVisible(v => v)} />
      <RightPanel navegacion={navegacion} />
    </box>
  ) as unknown as Gtk.Widget

  // La izquierda compensa el panel contextual; la derecha ocupa ese mismo
  // espacio mientras está cerrado. Separarlas de `.orion-panel` mantiene la
  // reserva transparente y evita mostrar una columna vacía dentro del shell.
  const reservaIzquierda = (<box cssClasses={["orion-balance"]} />) as unknown as Gtk.Widget
  const reservaDerecha = (
    <box cssClasses={["orion-balance"]} visible={rightPanelVisible(visible => !visible)} />
  ) as unknown as Gtk.Widget

  const panelContainer = (
    <box
      cssClasses={["orion-wrapper"]}
      css={cssAnimacionOrion}
      hexpand
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.END}
    >
      {reservaIzquierda}
      {CornerCurve({ left: true })}
      {panelInner}
      {CornerCurve({ left: false })}
      {reservaDerecha}
    </box>
  ) as unknown as Gtk.Widget

  function cancelarEsperaSalida(): void {
    if (idFrameSalida === null) return
    panelContainer.remove_tick_callback(idFrameSalida)
    idFrameSalida = null
  }

  /** Suelta el tick y el techo de la preparación, ganen o pierdan. */
  function cancelarPreparacion(): void {
    if (idFramePreparacion !== null) {
      panelContainer.remove_tick_callback(idFramePreparacion)
      idFramePreparacion = null
    }
    if (temporizadorTechoPreparacion !== null) {
      GLib.source_remove(temporizadorTechoPreparacion)
      temporizadorTechoPreparacion = null
    }
  }

  /** Devuelve si se canceló ESTANDO aún en la preparación invisible (nada que animar). */
  function cancelarTemporizadoresEntrada(): boolean {
    const estabaPreparando = preparacionPendiente
    preparacionPendiente = false
    cancelarPreparacion()
    if (temporizadorFinEntrada !== null) {
      GLib.source_remove(temporizadorFinEntrada)
      temporizadorFinEntrada = null
    }
    return estabaPreparando
  }

  function calcularDistanciaVertical(): number {
    const altoSuperficie = refVentana?.get_surface?.()?.get_height?.() ?? 0
    const altoVentana = refVentana?.get_height?.() ?? 0
    const altoPanel = panelContainer.get_height()
    const altoBase = Math.max(1, Math.ceil(Math.max(
      altoSuperficie,
      altoVentana,
      altoPanel,
    )))
    return Math.ceil(altoBase * (1 + PROPORCION_HOLGURA_VERTICAL))
  }

  function iniciarEntrada(): void {
    cancelarEsperaSalida()
    cancelarTemporizadoresEntrada()
    // Mapear primero con opacidad cero permite a GTK medir el panel incluso en
    // la primera apertura, sin mostrar un fotograma en su posición final.
    establecerCssAnimacionOrion(".orion-wrapper { opacity: 0; }")
    establecerOrionRenderizado(true)

    preparacionPendiente = true

    // La animación arranca cuando GTK dice que ya ha medido y pintado, NO a un plazo fijo.
    // Antes eran 32 ms ("dos fotogramas aproximadamente") apostados a ciegas, y aquí eso
    // costaba DOS cosas, no una. La primera apertura no había mapeado nunca la superficie,
    // así que ahí caían de golpe el realize, la primera resolución del CSS global contra
    // todo el subárbol `.orion-*` y el primer render node — el microcorte. Y además
    // `calcularDistanciaVertical()` MIDE dentro de esta ventana: sin allocación todavía,
    // `panelContainer.get_height()` da 0 y la distancia del deslizamiento sale de la
    // holgura sobre el alto de ventana, no del panel real. El reloj de frames ya sabe
    // cuándo ha terminado de medir; se le pregunta en vez de adivinar.
    let framesVistos = 0
    idFramePreparacion = panelContainer.add_tick_callback((widget: any) => {
      if (!preparacionPendiente) return false
      // El tick corre en la fase de ACTUALIZACIÓN, antes de pintar, y los primeros pueden
      // llegar sin allocación. Se espera a tener altura real (ya medido) y a un frame más:
      // ese es el primero con el panel preparado ya pintado.
      if ((widget.get_height?.() ?? 0) <= 0) return true
      if (++framesVistos < 2) return true
      idFramePreparacion = null   // ya nos vamos: que cancelarPreparacion no lo quite dos veces
      arrancarEntrada()
      return false
    })

    temporizadorTechoPreparacion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TECHO_PREPARACION_MS, () => {
      temporizadorTechoPreparacion = null
      arrancarEntrada()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Arranca el deslizamiento visible. Idempotente: la gana el tick o el techo, no ambos. */
  function arrancarEntrada(): void {
    if (!preparacionPendiente) return
    preparacionPendiente = false
    cancelarPreparacion()

    const distanciaEntrada = calcularDistanciaVertical()
    establecerCssAnimacionOrion(`
        @keyframes orion-panel-slide-in-dynamic {
          from { transform: translateY(${distanciaEntrada}px); }
          to { transform: translateY(0); }
        }
        @keyframes orion-panel-fade-in-dynamic {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .orion-wrapper {
          animation:
            orion-panel-slide-in-dynamic ${DURACION_ENTRADA_MS}ms cubic-bezier(0.16, 1, 0.3, 1),
            orion-panel-fade-in-dynamic 45ms linear;
        }
      `)

    temporizadorFinEntrada = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DURACION_ENTRADA_MS, () => {
      // El helper difiere la medición a idle, cuando el transform ya está en
      // identidad y la región coincide con el panel que ve el usuario.
      recalcularRegionEntrada?.()
      temporizadorFinEntrada = null
      return GLib.SOURCE_REMOVE
    })
  }

  function terminarSalida(): void {
    establecerOrionRenderizado(false)
    idFrameSalida = null
    // Restablecer la sección después de aplicar visible=false evita cambios de
    // contenido o anchura en el último fotograma de la animación.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!orionVisible.get() && !orionRenderizado.get()) finalizarCierrePanel()
      return GLib.SOURCE_REMOVE
    })
  }

  function iniciarSalida(): void {
    // Si se cierra durante los dos fotogramas invisibles de preparación, no hay
    // nada que animar ni conviene hacer aparecer el panel solo para ocultarlo.
    if (cancelarTemporizadoresEntrada()) {
      terminarSalida()
      return
    }
    const distanciaSalida = calcularDistanciaVertical()

    establecerCssAnimacionOrion(`
      @keyframes orion-panel-slide-out-dynamic {
        from { transform: translateY(0); }
        to { transform: translateY(${distanciaSalida}px); }
      }
      .orion-wrapper {
        animation: orion-panel-slide-out-dynamic ${DURACION_ANIMACION_SALIDA_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards;
      }
    `)

    cancelarEsperaSalida()
    let primerFrameUs: number | null = null
    let frameFinalPresentado = false
    idFrameSalida = panelContainer.add_tick_callback((_widget: any, relojFrame: any) => {
      const ahoraUs = relojFrame.get_frame_time()
      if (primerFrameUs === null) primerFrameUs = ahoraUs
      const transcurridoMs = (ahoraUs - primerFrameUs) / 1000
      if (transcurridoMs < ESPERA_DESMAPEO_MS) return true

      // Este tick dibuja el estado final. Esperar al siguiente garantiza que el
      // panel ya cruzó el borde inferior antes de desmapear la superficie.
      if (!frameFinalPresentado) {
        frameFinalPresentado = true
        return true
      }

      terminarSalida()
      return false
    })
  }

  const win = (
    <window
      name="orion"
      namespace="orion"
      visible={orionRenderizado}
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      // Sin anclajes laterales, la layer conserva el centrado horizontal pero
      // limita su superficie al ancho real de Orion. Así el blur y la entrada
      // no abarcan todo el monitor.
      anchor={BOTTOM}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={orionVisible((visible) =>
        visible ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
      application={app}
      decorated={false}
      deletable={false}
      marginTop={40}
      cssClasses={clasesFondoShell("Orion")}
      $={(self: any) => { refVentana = self }}
    >
      <Gtk.EventControllerKey
        $={(controlador: Gtk.EventControllerKey) => {
          controlador.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        }}
        onKeyPressed={(_controlador, keyval, _keycode, state) => {
          const seccion = activeSection.get()
          if (seccion !== "reactivo" && seccion !== "apps") return false

          const modificadores = state as unknown as number
          const CTRL = 4, ALT = 8, SUPER = 0x4000000
          if ((modificadores & CTRL) || (modificadores & ALT) || (modificadores & SUPER)) {
            return false
          }

          if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) {
            const retroceder = keyval === Gdk.KEY_ISO_Left_Tab || (modificadores & 1) !== 0
            if (seccion === "apps" && navegacion.estaEnSubmenu()) {
              return navegacion.moverVertical(retroceder ? -1 : 1)
            }
            return navegacion.moverResultados(retroceder ? -1 : 1)
          }
          if (keyval === Gdk.KEY_Up) {
            if (seccion === "apps" && !navegacion.estaEnSubmenu()) {
              return navegacion.moverEnCuadricula("arriba")
            }
            return navegacion.moverVertical(-1)
          }
          if (keyval === Gdk.KEY_Down) {
            if (seccion === "apps" && !navegacion.estaEnSubmenu()) {
              return navegacion.moverEnCuadricula("abajo")
            }
            return navegacion.moverVertical(1)
          }
          if (keyval === Gdk.KEY_Right) {
            if (seccion === "apps") {
              if (navegacion.estaEnSubmenu()) return true
              return navegacion.moverEnCuadricula("derecha")
            }
            return navegacion.entrarSubmenu()
          }
          if (keyval === Gdk.KEY_Left) {
            if (seccion === "apps" && !navegacion.estaEnSubmenu()) {
              return navegacion.moverEnCuadricula("izquierda")
            }
            return navegacion.salirSubmenu()
          }
          if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (seccion === "apps" && !navegacion.estaEnSubmenu()) {
              return navegacion.activarResultadoYEntrarSubmenu()
            }
            return navegacion.activarSeleccionado()
          }
          return false
        }}
      />

      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval, _keycode, state) => {
          if (keyval === Gdk.KEY_Escape) { hidePanel(); return true }
          const s = state as unknown as number
          const CTRL = 4, ALT = 8, SUPER = 0x4000000
          if (!(s & CTRL) && !(s & ALT) && !(s & SUPER)) {
            const cp = Gdk.keyval_to_unicode(keyval)
            if (cp >= 0x20) { focusSearchAndType(String.fromCodePoint(cp)); return true }
          }
          return false
        }}
      />

      <box hexpand>
        <Gtk.GestureClick onPressed={(self: Gtk.GestureClick, _n: number, x: number, y: number) => {
          const outerBox = self.get_widget() as Gtk.Widget
          const hit = outerBox.pick(x, y, 0)
          let w: Gtk.Widget | null = hit
          while (w && w !== outerBox) {
            if (w === panelContainer) return
            w = w.get_parent()
          }
          hidePanel()
        }} />
        {panelContainer as unknown as any}
      </box>
    </window>
  ) as unknown as Gtk.Widget

  // Mantener la ventana mapeada durante la salida permite completar el recorrido
  // hacia abajo antes de ocultarla realmente.
  orionVisible.subscribe(() => {
    if (orionVisible.get()) iniciarEntrada()
    else iniciarSalida()
  })

  // Compatibilidad con invocaciones manuales de `ags toggle orion`. El atajo
  // normal usa `ags request toggle-orion`, pero si GTK intenta ocultar la ventana
  // directamente la remapeamos en el mismo cambio y dejamos que el estado ejecute
  // la animación antes del cierre real.
  ;(win as any).connect("notify::visible", () => {
    const visible = (win as any).visible
    if (visible) {
      if (!orionVisible.get()) {
        preparePanelOpen()
        setOrionVisible(true)
      }
      return
    }

    if (orionVisible.get()) {
      ;(win as any).visible = true
      hidePanel()
    }
  })

  recalcularRegionEntrada = clipWindowInputToContent(win, panelInner, {
    radioCurvasInferioresLaterales: RADIO_CURVAS_LATERALES,
  })
  // El panel contextual cambia la anchura de `.orion-panel`, pero sustituye una
  // reserva exterior de igual tamaño y no redimensiona la superficie de Orion.
  rightPanelVisible.subscribe(() => recalcularRegionEntrada?.())

  return win
}
