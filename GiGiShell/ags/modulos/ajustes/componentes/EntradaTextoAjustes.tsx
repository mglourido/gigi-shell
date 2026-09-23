import { Gtk } from "ags/gtk4"

type PropiedadesEntradaTextoAjustes = {
  cssClasses?: string[]
  children?: any
  [propiedad: string]: any
}

/** Entrada de texto compacta que no se estira con la altura de su fila. */
export default function EntradaTextoAjustes({
  cssClasses = [],
  children,
  ...propiedades
}: PropiedadesEntradaTextoAjustes) {
  return (
    <Gtk.Entry
      {...propiedades}
      cssClasses={["account-entry", ...cssClasses]}
      widthRequest={180}
      heightRequest={30}
      hexpand={false}
      valign={Gtk.Align.START}
    >
      {children}
    </Gtk.Entry>
  )
}
