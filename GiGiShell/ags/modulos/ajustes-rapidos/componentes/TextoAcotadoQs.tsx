import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"

type PropiedadesTextoAcotadoQs = {
  label: any
  xalign?: number
  [propiedad: string]: any
}

/** El texto ocupa el hueco de su fila y conserva el nombre completo en el tooltip. */
export default function TextoAcotadoQs({ label, xalign = 0, ...propiedades }: PropiedadesTextoAcotadoQs) {
  return (
    <label
      {...propiedades}
      label={label}
      tooltipText={label}
      hexpand
      halign={Gtk.Align.FILL}
      xalign={xalign}
      singleLineMode
      ellipsize={Pango.EllipsizeMode.END}
      // Acotar el ancho NATURAL evita que el nombre ensanche el panel. FILL
      // permite usar todo el ancho asignado, sin truncar antes de llegar al borde.
      maxWidthChars={1}
    />
  )
}
