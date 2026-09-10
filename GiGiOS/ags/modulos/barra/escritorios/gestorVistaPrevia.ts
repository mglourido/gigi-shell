import Gdk from "gi://Gdk"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { margenBajoBarra } from "../componentes/anclaBarra"

const ANCHO_VISTA_PREVIA = 280
const ALTO_VISTA_PREVIA = 158

function crearVistaPreviaVacia(idEscritorio: number): Gtk.Label {
  const etiqueta = new Gtk.Label({ label: `Escritorio ${idEscritorio}` })
  etiqueta.add_css_class("ws-preview-empty")
  etiqueta.set_halign(Gtk.Align.CENTER)
  etiqueta.set_valign(Gtk.Align.CENTER)
  etiqueta.set_hexpand(true)
  etiqueta.set_vexpand(true)
  return etiqueta
}

function crearContenidoVistaPrevia(idEscritorio: number, ruta: string): Gtk.Box {
  const exterior = new Gtk.Box()
  exterior.add_css_class("ws-preview-bg")
  exterior.set_size_request(ANCHO_VISTA_PREVIA, ALTO_VISTA_PREVIA)

  if (!GLib.file_test(ruta, GLib.FileTest.EXISTS)) {
    exterior.append(crearVistaPreviaVacia(idEscritorio))
    return exterior
  }

  try {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
      ruta,
      ANCHO_VISTA_PREVIA,
      ALTO_VISTA_PREVIA,
      false,
    )
    const imagen = new Gtk.Picture({
      paintable: Gdk.Texture.new_for_pixbuf(pixbuf),
      width_request: ANCHO_VISTA_PREVIA,
      height_request: ALTO_VISTA_PREVIA,
    })
    exterior.append(imagen)
  } catch (_) {
    exterior.append(crearVistaPreviaVacia(idEscritorio))
  }
  return exterior
}

/** Gestiona un único popover por barra, sin referencias compartidas entre monitores. */
export function crearGestorVistaPreviaEscritorios(
  monitorGdk: Gdk.Monitor,
  alCambiarVisibilidad: (visible: boolean) => void,
) {
  const margenSuperior = margenBajoBarra()
  const geometriaMonitor = monitorGdk.get_geometry()
  const nombreMonitor = (monitorGdk.get_connector() ?? "monitor")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
  const ventana = new Astal.Window({
    application: app,
    name: `workspace-preview-${nombreMonitor}`,
    namespace: "workspace-preview",
    visible: false,
    decorated: false,
    layer: Astal.Layer.TOP,
    exclusivity: Astal.Exclusivity.NORMAL,
    anchor: Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT,
    keymode: Astal.Keymode.NONE,
    gdkmonitor: monitorGdk,
    css_classes: ["ws-preview-window"],
  })
  let ancla: Gtk.Widget | null = null
  let temporizadorCierre: ReturnType<typeof setTimeout> | null = null
  let eliminado = false

  const actualizarMargenSuperior = () => ventana.set_margin_top(margenSuperior.get())
  actualizarMargenSuperior()
  const dejarMargenSuperior = margenSuperior.subscribe(actualizarMargenSuperior)

  const cancelarCierre = () => {
    if (temporizadorCierre !== null) clearTimeout(temporizadorCierre)
    temporizadorCierre = null
  }

  const cerrar = () => {
    cancelarCierre()
    ventana.set_visible(false)
    ventana.set_child(null)
    ancla = null
    alCambiarVisibilidad(false)
  }

  const alEntrar = () => cancelarCierre()
  const alSalir = () => {
    cancelarCierre()
    temporizadorCierre = setTimeout(cerrar, 250)
  }

  const mostrar = (nuevaAncla: Gtk.Widget, idEscritorio: number, ruta: string) => {
    if (eliminado) return
    if (ventana.get_visible() && ancla === nuevaAncla) {
      cerrar()
      return
    }
    cerrar()

    const contenido = crearContenidoVistaPrevia(idEscritorio, ruta)
    const movimiento = new Gtk.EventControllerMotion()
    movimiento.connect("enter", alEntrar)
    movimiento.connect("leave", alSalir)
    contenido.add_controller(movimiento)

    const raiz = nuevaAncla.get_root() as Gtk.Widget | null
    const [traducido, punto] = raiz
      ? nuevaAncla.compute_point(raiz, new Graphene.Point({ x: 0, y: 0 }))
      : [false, new Graphene.Point({ x: 0, y: 0 })]
    const xAncla = traducido ? punto.x : nuevaAncla.get_allocation().x
    const margenIzquierdo = Math.round(Math.max(
      0,
      Math.min(
        geometriaMonitor.width - ANCHO_VISTA_PREVIA - 2,
        xAncla + (nuevaAncla.get_allocated_width() - ANCHO_VISTA_PREVIA) / 2,
      ),
    ))

    ventana.set_margin_left(margenIzquierdo)
    ventana.set_child(contenido)
    ancla = nuevaAncla
    alCambiarVisibilidad(true)
    ventana.set_visible(true)
  }

  return {
    mostrar,
    alEntrar,
    alSalir,
    cerrar,
    eliminar: () => {
      eliminado = true
      cerrar()
      dejarMargenSuperior()
      try { ventana.destroy() } catch (_) {}
    },
  }
}

export type GestorVistaPreviaEscritorios = ReturnType<typeof crearGestorVistaPreviaEscritorios>
