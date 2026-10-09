import { Gtk } from "ags/gtk4"

type PropiedadesEntradaTextoAjustes = {
  expandir?: boolean
  cssClasses?: string[]
  children?: any
  [propiedad: string]: any
}

/** Entrada compacta: el ancho lo decide la fila, sin la reserva implícita de GTK. */
export default function EntradaTextoAjustes({
  expandir = false,
  cssClasses = [],
  children,
  ...propiedades
}: PropiedadesEntradaTextoAjustes) {
  return (
    <Gtk.Entry
      widthChars={1}
      maxWidthChars={1}
      widthRequest={expandir ? -1 : 180}
      heightRequest={30}
      hexpand={expandir}
      valign={Gtk.Align.CENTER}
      {...propiedades}
      cssClasses={["account-entry", ...cssClasses]}
    >
      {children}
    </Gtk.Entry>
  )
}
