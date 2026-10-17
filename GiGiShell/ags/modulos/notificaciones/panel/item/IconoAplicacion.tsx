import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import {
  observarCambiosIconos,
  resolverIconoNotificacion,
} from "../../iconos/resolucion"

interface PropiedadesIcono {
  iconoApp?: string
  nombreApp: string
  alternativa?: string
  tamano?: number
  clase?: string
  alCambiarDisponibilidad?: (disponible: boolean) => void
}

/** Una imagen por vista; las referencias y las señales se comparten entre todas. */
export default function IconoAppNotificacion({
  iconoApp = "", nombreApp, alternativa = "", tamano = 18,
  clase = "notif-app-img", alCambiarDisponibilidad,
}: PropiedadesIcono): Gtk.Box {
  const caja = new Gtk.Box({ valign: Gtk.Align.CENTER, css_classes: [clase] })
  const imagen = new Gtk.Image({ pixel_size: tamano })
  const simbolo = alternativa
    ? new Gtk.Label({ label: alternativa })
    : null
  caja.tooltip_text = nombreApp || null
  caja.append(imagen)
  if (simbolo) caja.append(simbolo)

  function actualizar(): void {
    let icono = resolverIconoNotificacion(iconoApp, nombreApp)
    try {
      if (icono instanceof Gio.FileIcon) {
        // Una representación nueva y ajustada a la escala evita reutilizar el
        // contenido antiguo cuando un avatar se sobrescribe en la misma ruta.
        imagen.set_from_paintable(Gtk.IconPaintable.new_for_file(
          icono.get_file(), tamano, imagen.get_scale_factor(),
        ))
      } else if (icono) imagen.set_from_gicon(icono)
      else imagen.clear()
    } catch (_) {
      icono = null
      imagen.clear()
    }
    imagen.visible = !!icono
    if (simbolo) simbolo.visible = !icono
    caja.visible = !!icono || !!alternativa
    alCambiarDisponibilidad?.(caja.visible)
  }

  const dejarDeObservar = observarCambiosIconos(actualizar)
  const senalEscala = imagen.connect("notify::scale-factor", actualizar)
  onCleanup(() => {
    dejarDeObservar()
    imagen.disconnect(senalEscala)
  })
  actualizar()
  return caja
}
