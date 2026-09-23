import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"

type PropiedadesTituloAjuste = {
  label: any
  cssClasses?: string[]
  halign?: Gtk.Align
  [propiedad: string]: any
}

// Envuelve por defecto, y con `wrapMode` WORD_CHAR. El ancho MÍNIMO de una etiqueta
// que NO envuelve es su texto entero, así que estos títulos eran lo que empujaba las
// filas de Ajustes por encima del hueco del panel y sacaba la barra de desplazamiento
// horizontal. Con WORD (el modo por defecto de GTK) el mínimo baja solo hasta la
// palabra más larga, que en «Actualización» ya son ~90 px; WORD_CHAR lo deja en un
// carácter. El ancho NATURAL no cambia, así que donde hay sitio se sigue viendo en una
// línea. Cualquier llamante puede volver a `wrap={false}`: el spread va después.
/** Etiqueta principal compartida por los controles de Ajustes. */
export default function TituloAjuste({
  cssClasses = [],
  halign = Gtk.Align.START,
  ...propiedades
}: PropiedadesTituloAjuste) {
  return (
    <label
      cssClasses={["sp-field-label", ...cssClasses]}
      halign={halign}
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      {...propiedades}
    />
  )
}
