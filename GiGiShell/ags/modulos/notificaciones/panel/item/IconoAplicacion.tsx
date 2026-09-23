import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"

type InformacionIcono =
  | { tipo: "nombre"; nombre: string }
  | { tipo: "archivo"; ruta: string }

// Los iconos se repiten entre items y vistas. Se memorizan tanto la consulta al
// tema como la decodificación en disco para hacerlas una sola vez por sesión.
const cacheInformacionIconos = new Map<string, InformacionIcono | null>()
const cachePixbufs = new Map<string, GdkPixbuf.Pixbuf | null>()

function cargarIconoArchivo(ruta: string): GdkPixbuf.Pixbuf | null {
  const cacheado = cachePixbufs.get(ruta)
  if (cacheado !== undefined) return cacheado

  let pixbuf: GdkPixbuf.Pixbuf | null = null
  try {
    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(ruta, 18, 18, true)
  } catch (_) {
    pixbuf = null
  }
  cachePixbufs.set(ruta, pixbuf)
  return pixbuf
}

function resolverIconoSinCache(iconoApp: string): InformacionIcono | null {
  if (!iconoApp) return null
  if (iconoApp.startsWith("/")) {
    return GLib.file_test(iconoApp, GLib.FileTest.EXISTS)
      ? { tipo: "archivo", ruta: iconoApp }
      : null
  }

  try {
    const pantalla = Gdk.Display.get_default()
    if (!pantalla) return null
    const tema = Gtk.IconTheme.get_for_display(pantalla)
    const minusculas = iconoApp.toLowerCase()
    const candidatos = [iconoApp, minusculas, minusculas.replace(/[_\s]/g, "-")]
    const encontrado = candidatos.find((nombre) => tema.has_icon(nombre))
    return encontrado ? { tipo: "nombre", nombre: encontrado } : null
  } catch (_) {
    return null
  }
}

function resolverIcono(iconoApp: string): InformacionIcono | null {
  const cacheado = cacheInformacionIconos.get(iconoApp)
  if (cacheado !== undefined) return cacheado
  const informacion = resolverIconoSinCache(iconoApp)
  cacheInformacionIconos.set(iconoApp, informacion)
  return informacion
}

export default function IconoAppNotificacion({ iconoApp }: { iconoApp: string }): Gtk.Image | null {
  const informacion = resolverIcono(iconoApp)
  if (!informacion) return null

  try {
    let imagen: Gtk.Image
    if (informacion.tipo === "archivo") {
      const pixbuf = cargarIconoArchivo(informacion.ruta)
      if (!pixbuf) return null
      imagen = Gtk.Image.new_from_pixbuf(pixbuf)
    } else {
      imagen = Gtk.Image.new_from_icon_name(informacion.nombre)
      imagen.pixel_size = 18
    }
    imagen.valign = Gtk.Align.CENTER
    imagen.css_classes = ["notif-app-img"]
    return imagen
  } catch (_) {
    return null
  }
}
