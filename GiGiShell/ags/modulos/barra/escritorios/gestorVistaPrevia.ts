import Gdk from "gi://Gdk"
import Graphene from "gi://Graphene"
import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"

import { margenBajoBarra } from "../componentes/anclaBarra"
import { type AreaUtilSalida, obtenerAreaUtilSalida } from "./areaUtilSalida"
import { cargarFondoMiniatura } from "./fondoMiniatura"
import { capturarSalidaConGrim } from "./respaldoGrim"
import { iniciarVistaEnVivo } from "./vistaEnVivo"

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

/** Sin esto las apps de un escritorio oculto no pintan: ver `hypr/gigishell/vista-en-vivo.lua`. */
const llamarVistaEnVivo = (llamada: string) => {
  void execAsync(["hyprctl", "eval", `GiGiShell.${llamada}`]).catch(() => {})
}

/** Gestiona un único popover por barra, sin referencias compartidas entre monitores. */
export function crearGestorVistaPreviaEscritorios(
  monitorGdk: Gdk.Monitor,
  obtenerIdEscritorioActivo: () => number,
  alCambiarVisibilidad: (visible: boolean) => void,
) {
  const margenSuperior = margenBajoBarra()
  const geometriaMonitor = monitorGdk.get_geometry()
  const nombreSalida = monitorGdk.get_connector() ?? ""
  const nombreMonitor = (nombreSalida || "monitor").replace(/[^a-zA-Z0-9_-]/g, "-")
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
  let detenerVista = () => {}
  let eliminado = false
  // Invalida la apertura que aún espera a `hyprctl` si entretanto se cierra o se abre otra.
  let secuenciaApertura = 0

  // Un AGS caído con una miniatura abierta dejaría esas apps pintando a 30 fps.
  llamarVistaEnVivo("vista_en_vivo_limpiar()")

  const actualizarMargenSuperior = () => ventana.set_margin_top(margenSuperior.get())
  actualizarMargenSuperior()
  const dejarMargenSuperior = margenSuperior.subscribe(actualizarMargenSuperior)

  const cancelarCierre = () => {
    if (temporizadorCierre !== null) clearTimeout(temporizadorCierre)
    temporizadorCierre = null
  }

  const cerrar = () => {
    secuenciaApertura++
    cancelarCierre()
    detenerVista()
    detenerVista = () => {}
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

  /** La etiqueta da el tamaño y queda a la vista hasta el primer fotograma. La imagen va en el
   * overlay porque una textura más grande que la miniatura (monitor escalado) ensancharía la
   * ventana si participara en la medida. */
  const crearContenido = (idEscritorio: number, nombreEscritorio: string, area: AreaUtilSalida | null) => {
    // Sin la zona que reservan los paneles, que quedaría como una franja vacía. La altura sale de
    // lo que queda, para no deformar la imagen.
    const altoVista = area
      ? Math.round(ANCHO_VISTA_PREVIA * area.alto / area.ancho)
      : ALTO_VISTA_PREVIA
    const exterior = new Gtk.Box()
    exterior.add_css_class("ws-preview-bg")
    exterior.set_size_request(ANCHO_VISTA_PREVIA, altoVista)
    const etiqueta = crearVistaPreviaVacia(idEscritorio)
    const imagen = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.FILL })
    // La captura trae solo las ventanas, con el resto transparente: el fondo de pantalla va debajo.
    const fondo = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.COVER })
    const superposicion = new Gtk.Overlay({ child: etiqueta, hexpand: true })
    superposicion.add_overlay(fondo)
    superposicion.add_overlay(imagen)
    exterior.append(superposicion)

    const pintar = (textura: Gdk.Texture) => {
      etiqueta.set_visible(false)
      imagen.set_paintable(textura)
    }
    // A píxeles físicos: la miniatura sería borrosa en un monitor escalado.
    const escala = monitorGdk.get_scale()
    const anchoFisico = Math.round(ANCHO_VISTA_PREVIA * escala)
    const altoFisico = Math.round(altoVista * escala)
    let vigente = true
    const cancelarFondo = nombreSalida
      ? cargarFondoMiniatura(nombreSalida, anchoFisico, altoFisico, (textura) => fondo.set_paintable(textura))
      : () => {}
    const detenerAyudante = iniciarVistaEnVivo(nombreEscritorio, anchoFisico, altoFisico, area?.recorte ?? [0, 0, 0, 0], {
      alFotograma: pintar,
      alNoDisponible: () => {
        // Taparía la etiqueta «Escritorio N» de los escritorios ocultos sin respaldo.
        fondo.set_visible(false)
        // Sin connector no se puede elegir la salida con seguridad mediante `grim -o`.
        if (!vigente || !nombreSalida || obtenerIdEscritorioActivo() !== idEscritorio) return
        void capturarSalidaConGrim(nombreSalida, anchoFisico, altoFisico).then((textura) => {
          if (vigente && textura) pintar(textura)
        })
      },
    })
    llamarVistaEnVivo(`vista_en_vivo(${idEscritorio}, true)`)
    detenerVista = () => {
      vigente = false
      llamarVistaEnVivo(`vista_en_vivo(${idEscritorio}, false)`)
      cancelarFondo()
      detenerAyudante()
    }
    return exterior
  }

  const mostrar = (nuevaAncla: Gtk.Widget, idEscritorio: number, nombreEscritorio: string) => {
    if (eliminado) return
    if (ventana.get_visible() && ancla === nuevaAncla) {
      cerrar()
      return
    }
    cerrar()

    const apertura = secuenciaApertura
    // Se abre con la respuesta en la mano: la altura de la ventana depende de ella.
    void obtenerAreaUtilSalida(nombreSalida).then((area) => {
      if (eliminado || apertura !== secuenciaApertura) return
      abrir(nuevaAncla, idEscritorio, nombreEscritorio, area)
    })
  }

  const abrir = (
    nuevaAncla: Gtk.Widget,
    idEscritorio: number,
    nombreEscritorio: string,
    area: AreaUtilSalida | null,
  ) => {
    const contenido = crearContenido(idEscritorio, nombreEscritorio, area)
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
