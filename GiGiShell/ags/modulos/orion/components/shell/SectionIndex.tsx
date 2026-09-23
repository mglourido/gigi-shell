// Barra de pestañas de Orion (Inicio/Apps/Flujos/…) con un indicador
// deslizante que se anima entre botones usando `Gtk.Overlay` + transform CSS
// en vez de reconstruirse — el mismo patrón de "medir, luego animar por
// transform" que usa la entrada de `Orion.tsx`.

import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import GLib from "gi://GLib"
import { activeSection, setSection, type SectionId } from "../../state"

interface SectionIndexItem {
  id: string
  label: string
  icon: string
  target: SectionId
}

// Índice único de Orion: solo las secciones con página real montada
// (ver `SECTION_COMPONENTS`). No añadas aquí un destino sin componente: la
// pestaña navegaría a un panel vacío.
const SECTIONS: SectionIndexItem[] = [
  { id: "inicio",    label: "Inicio",       icon: "go-home-symbolic",                       target: "inicio" },
  { id: "apps",      label: "Aplicaciones", icon: "view-app-grid-symbolic",                  target: "apps" },
  { id: "rice",      label: "Temas",        icon: "preferences-desktop-theme-symbolic",      target: "rice" },
  { id: "keybinds",  label: "Atajos",       icon: "input-keyboard-symbolic",                 target: "keybinds" },
]

export default function SectionIndex() {
  const root = new Gtk.Box({ cssClasses: ["section-index"], hexpand: true })
  const scroll = new Gtk.ScrolledWindow({ cssClasses: ["section-index-scroll"], hexpand: true })
  scroll.set_policy(Gtk.PolicyType.EXTERNAL, Gtk.PolicyType.NEVER)

  const controladorScroll = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.VERTICAL,
  })
  controladorScroll.connect("scroll", (_controlador, _dx, dy) => {
    const ajuste = scroll.get_hadjustment()
    ajuste.set_value(ajuste.get_value() + dy * 40)
    return true
  })
  scroll.add_controller(controladorScroll)

  const DURACION_MOVIMIENTO_MS = 260
  const PREPARACION_MOVIMIENTO_MS = 32
  let temporizadorPreparacion: number | null = null
  let temporizadorFin: number | null = null
  let secuenciaAnimacion = 0
  let posicionActual = 0
  let posicionYActual = 0
  let anchoActual = 0
  let altoActual = 0
  let geometriaDisponible = false
  const [cssIndicador, establecerCssIndicador] = createState(".section-index-indicator {}")

  // La fila conserva el layout natural. El indicador se asigna mediante el
  // mecanismo nativo del Overlay y su movimiento se pinta con transform.
  const fila = new Gtk.Box({ cssClasses: ["section-index-row"], spacing: 2 })
  const capa = new Gtk.Overlay()
  capa.set_child(fila)
  const indicador = (
    <box cssClasses={["section-index-indicator"]} css={cssIndicador} />
  ) as unknown as Gtk.Widget
  indicador.set_can_target(false)
  capa.add_overlay(indicador)
  capa.set_clip_overlay(indicador, true)

  capa.connect("get-child-position", (_overlay, widget, asignacion) => {
    if (widget !== indicador || anchoActual <= 0 || altoActual <= 0) return false
    asignacion.x = Math.round(posicionActual)
    asignacion.y = Math.round(posicionYActual)
    asignacion.width = Math.max(1, Math.round(anchoActual))
    asignacion.height = Math.max(1, Math.round(altoActual))
    return true
  })

  const botones = new Map<SectionId, Gtk.Button>()
  for (const section of SECTIONS) {
    const boton = new Gtk.Button({
      cssClasses: ["section-index-btn"],
      tooltipText: section.label,
    })
    const contenido = new Gtk.Box({ spacing: 5 })
    contenido.append(new Gtk.Image({
      iconName: section.icon,
      pixelSize: 13,
      cssClasses: ["section-index-icon"],
    }))
    contenido.append(new Gtk.Label({ label: section.label }))
    boton.set_child(contenido)
    boton.connect("clicked", () => setSection(section.target))
    botones.set(section.target, boton)
    fila.append(boton)
  }

  scroll.set_child(capa)
  root.append(scroll)

  // ⚠️ `compute_bounds()` NO falla mientras el botón está sin asignar: devuelve
  // `true` con la caja CSS a secas — medido, `[-8,-3,16,6]` para un botón cuyo
  // `get_width()` es todavía 0. O sea que un `valido && width > 0` da por buena
  // una geometría falsa, y el indicador se asignaba a 16x6 px en un origen
  // negativo: el fondo del botón activo no desaparecía, se encogía a una
  // astilla invisible al abrir Orion. La asignación es lo único que hay que
  // preguntar, y eso lo dice `get_width()/get_height()`.
  function medir(boton: Gtk.Button) {
    if (boton.get_width() <= 0 || boton.get_height() <= 0) return null
    const resultado = boton.compute_bounds(fila)
    const valido = Array.isArray(resultado) ? resultado[0] : false
    const rect = Array.isArray(resultado) ? resultado[1] : null
    if (!valido || !rect || rect.size.width <= 0 || rect.size.height <= 0) return null
    return {
      x: rect.origin.x,
      y: rect.origin.y,
      ancho: rect.size.width,
      alto: rect.size.height,
    }
  }

  function detenerAnimacion() {
    if (temporizadorPreparacion !== null) {
      GLib.source_remove(temporizadorPreparacion)
      temporizadorPreparacion = null
    }
    if (temporizadorFin !== null) {
      GLib.source_remove(temporizadorFin)
      temporizadorFin = null
    }
  }

  function aplicarGeometria(x: number, y: number, ancho: number, alto: number) {
    posicionActual = x
    posicionYActual = y
    anchoActual = ancho
    altoActual = alto
    capa.queue_allocate()
  }

  function dejarIndicadorQuieto() {
    establecerCssIndicador(".section-index-indicator { transform: none; }")
  }

  function colocarSinAnimar(geometria: { x: number; y: number; ancho: number; alto: number }) {
    detenerAnimacion()
    indicador.opacity = 1
    aplicarGeometria(geometria.x, geometria.y, geometria.ancho, geometria.alto)
    dejarIndicadorQuieto()
  }

  // `compute_bounds()` falla mientras la fila no está asignada, y eso pasa de
  // verdad al abrir Orion: la ventana se mapea y el primer idle puede llegar
  // antes de la primera allocación. Rendirse ahí dejaba `anchoActual` a 0 —
  // `get-child-position` devuelve `false` y el Overlay pinta el indicador a su
  // tamaño natural, o sea sin fondo bajo el botón activo — y nada lo reintentaba
  // hasta el siguiente cambio de sección. Por eso la medición se reintenta por
  // frame hasta que GTK entrega una geometría real.
  const MAX_INTENTOS_GEOMETRIA = 90
  let idFrameGeometria: number | null = null
  let seccionPendiente: SectionId | null = null

  function cancelarEsperaGeometria() {
    if (idFrameGeometria === null) return
    root.remove_tick_callback(idFrameGeometria)
    idFrameGeometria = null
    seccionPendiente = null
  }

  function esperarGeometria(section: SectionId) {
    seccionPendiente = section
    if (idFrameGeometria !== null) return
    let intentos = 0
    idFrameGeometria = root.add_tick_callback(() => {
      const objetivo = seccionPendiente
      const destino = objetivo === null ? undefined : botones.get(objetivo)
      const geometria = destino ? medir(destino) : null
      if (!geometria) {
        // El reloj de frames sólo corre mapeado, así que este techo cuenta
        // frames visibles: si tras ellos GTK sigue sin asignar, se abandona en
        // vez de dejar un callback vivo para siempre.
        if (objetivo !== null && ++intentos <= MAX_INTENTOS_GEOMETRIA) return true
        idFrameGeometria = null
        seccionPendiente = null
        return false
      }
      idFrameGeometria = null
      seccionPendiente = null
      colocarSinAnimar(geometria)
      return false
    })
  }

  function sincronizarClases(section: SectionId) {
    for (const [id, boton] of botones) {
      boton.set_css_classes(id === section
        ? ["section-index-btn", "active"]
        : ["section-index-btn"])
    }
  }

  function animarIndicador(
    xAnterior: number,
    anchoAnterior: number,
    geometria: { x: number; y: number; ancho: number; alto: number },
  ) {
    detenerAnimacion()
    const desplazamiento = xAnterior - geometria.x
    const escalaInicial = Math.max(0.35, anchoAnterior / Math.max(1, geometria.ancho))
    const origen = desplazamiento < 0 ? "left center" : "right center"
    const nombre = `indice-movil-${++secuenciaAnimacion}`
    const transformacionInicial = `translateX(${desplazamiento.toFixed(2)}px) scaleX(${escalaInicial.toFixed(4)})`

    // Igual que la entrada de Orion: primero GTK asigna el widget en el destino
    // mientras el transform lo mantiene visualmente en el origen.
    establecerCssIndicador(`
      .section-index-indicator {
        transform-origin: ${origen};
        transform: ${transformacionInicial};
      }
    `)
    aplicarGeometria(geometria.x, geometria.y, geometria.ancho, geometria.alto)

    temporizadorPreparacion = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PREPARACION_MOVIMIENTO_MS,
      () => {
        establecerCssIndicador(`
          @keyframes ${nombre} {
            from { transform: ${transformacionInicial}; }
            58% { transform: translateX(${(desplazamiento * 0.22).toFixed(2)}px) scaleX(1.06); }
            to { transform: translateX(0) scaleX(1); }
          }
          .section-index-indicator {
            transform-origin: ${origen};
            animation: ${nombre} ${DURACION_MOVIMIENTO_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
          }
        `)
        temporizadorPreparacion = null
        temporizadorFin = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          DURACION_MOVIMIENTO_MS + 32,
          () => {
            dejarIndicadorQuieto()
            temporizadorFin = null
            return GLib.SOURCE_REMOVE
          },
        )
        return GLib.SOURCE_REMOVE
      },
    )
  }

  function moverIndicador(section: SectionId, animar: boolean) {
    const destino = botones.get(section)
    sincronizarClases(section)

    if (!destino) {
      cancelarEsperaGeometria()
      detenerAnimacion()
      indicador.opacity = 0
      return
    }

    const geometria = medir(destino)
    if (!geometria) {
      esperarGeometria(section)
      return
    }
    cancelarEsperaGeometria()
    indicador.opacity = 1

    if (!animar || anchoActual <= 0) {
      colocarSinAnimar(geometria)
      return
    }

    const xInicial = posicionActual
    const anchoInicial = anchoActual
    animarIndicador(xInicial, anchoInicial, geometria)
  }

  // Cada apertura de Orion vuelve a mapear este widget (la ventana alterna
  // `visible`, no se reconstruye). Recolocar aquí sin animar cubre las dos
  // formas de llegar mal: la primera apertura, sin medida todavía, y una
  // sección cambiada mientras estaba oculto (`preparePanelOpen` corre antes de
  // volver a mostrar la ventana), que dejaba el fondo bajo el botón anterior.
  root.connect("map", () => {
    geometriaDisponible = true
    detenerAnimacion()
    const section = activeSection.get()
    sincronizarClases(section)
    const destino = botones.get(section)
    const geometria = destino ? medir(destino) : null
    if (geometria) {
      cancelarEsperaGeometria()
      colocarSinAnimar(geometria)
    } else {
      esperarGeometria(section)
    }
  })
  root.connect("unmap", cancelarEsperaGeometria)
  // Los Accessor de Gnim notifican sin entregar el valor al callback. Leerlo
  // explícitamente evita tratar `undefined` como una sección y ocultar el fondo.
  const desuscribir = activeSection.subscribe(() => {
    const section = activeSection.get()
    // Oculto no hay frames ni medidas fiables: basta con dejar las clases al
    // día; el `map` de la próxima apertura coloca el indicador.
    if (!root.get_mapped()) {
      sincronizarClases(section)
      seccionPendiente = section
      return
    }
    if (geometriaDisponible) moverIndicador(section, true)
    else sincronizarClases(section)
  })
  root.connect("destroy", () => {
    cancelarEsperaGeometria()
    detenerAnimacion()
    if (typeof desuscribir === "function") desuscribir()
  })

  return root
}
