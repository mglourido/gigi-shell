import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

type InformacionIcono =
  | { tipo: "nombre"; nombre: string }
  | { tipo: "archivo"; icono: Gio.FileIcon }

// Los iconos se repiten entre items y vistas. Se memoriza su resolución; GTK
// comparte su carga y adapta el archivo original al tamaño y escala de cada vista.
// Reducir antes el archivo a un pixbuf de 18 px emborronaba los iconos con HiDPI.
const cacheInformacionIconos = new Map<string, InformacionIcono | null>()

function resolverIconoSinCache(iconoApp: string): InformacionIcono | null {
  if (!iconoApp) return null

  try {
    if (iconoApp.startsWith("/")) {
      return GLib.file_test(iconoApp, GLib.FileTest.EXISTS)
        ? { tipo: "archivo", icono: Gio.FileIcon.new(Gio.File.new_for_path(iconoApp)) }
        : null
    }

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
      imagen = Gtk.Image.new_from_gicon(informacion.icono)
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
