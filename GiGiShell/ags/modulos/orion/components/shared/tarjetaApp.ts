// Icono y "tarjeta" de app (icono + nombre a dos líneas) que Apps, Inicio, el
// panel derecho y la búsqueda reactiva pintaban cada uno por su cuenta con el
// mismo árbol de widgets y las mismas clases CSS.

import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import type Gio from "gi://Gio"
import { esIconoUtilizable } from "../../../../servicios/aplicaciones/iconos"

/** Lo que se pinta cuando el `.desktop` no deja nada que GTK pueda cargar. */
const ICONO_GENERICO = "application-x-executable"

/**
 * Icono de una app: prioriza el `Gio.Icon` nativo (resuelve tema e
 * ilustraciones embebidas correctamente) y cae al nombre de icono simbólico
 * cuando no hay uno.
 *
 * El `Gio.Icon` se valida antes de usarlo (`esIconoUtilizable`): un `.desktop` puede traer
 * un `Icon=` con ruta absoluta a un fichero que no existe —`hp-uiscan.desktop` de HPLIP
 * apunta a `/usr/share/icons/Humanity/…/printer.svg`, un tema de Ubuntu— y GTK entonces no
 * pinta nada y suelta un aviso («Failed to load icon …») cada vez que la fila se dibuja.
 * Por lo mismo el nombre de respaldo se descarta si es una ruta: `iconName` sale de
 * `Gio.Icon.to_string()`, así que en ese caso trae la misma ruta rota disfrazada de nombre.
 */
export function crearIconoApp(
  gicon: Gio.Icon | null | undefined,
  iconName: string,
  size: number,
): Gtk.Image {
  if (gicon && esIconoUtilizable(gicon)) {
    const imagen = Gtk.Image.new_from_gicon(gicon)
    imagen.pixel_size = size
    return imagen
  }
  const nombre = iconName && !iconName.startsWith("/") ? iconName : ICONO_GENERICO
  return new Gtk.Image({ iconName: nombre, pixelSize: size })
}

/**
 * Rellena `boton` con el mosaico estándar de Orion: icono centrado + nombre
 * envuelto a dos líneas. Usado por la rejilla de "Todas las apps" y por los
 * favoritos de Inicio — antes duplicaban este árbol de widgets al detalle.
 */
export function construirTileApp(boton: Gtk.Button, icono: Gtk.Widget, nombre: string): void {
  const inner = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    cssClasses: ["apps-tile-inner"],
    spacing: 6,
    halign: Gtk.Align.CENTER,
  })
  const iconBox = new Gtk.Box({
    cssClasses: ["apps-tile-icon"],
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })
  iconBox.append(icono)
  inner.append(iconBox)
  inner.append(new Gtk.Label({
    label: nombre,
    cssClasses: ["apps-tile-label"],
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    lines: 2,
    ellipsize: Pango.EllipsizeMode.END,
    maxWidthChars: 12,
    halign: Gtk.Align.CENTER,
    justify: Gtk.Justification.CENTER,
    xalign: 0.5,
  }))
  boton.set_child(inner)
}
