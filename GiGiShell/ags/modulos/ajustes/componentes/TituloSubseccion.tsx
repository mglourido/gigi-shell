import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"

type PropiedadesTituloSubseccion = {
  label: any
  cssClasses?: string[]
  halign?: Gtk.Align
  [propiedad: string]: any
}

/** Título compartido para grupos internos de una sección de Ajustes. */
export default function TituloSubseccion({
  cssClasses = [],
  halign = Gtk.Align.START,
  ...propiedades
}: PropiedadesTituloSubseccion) {
  return (
    <label
      cssClasses={["sp-subsection-title", ...cssClasses]}
      halign={halign}
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      {...propiedades}
    />
  )
}
