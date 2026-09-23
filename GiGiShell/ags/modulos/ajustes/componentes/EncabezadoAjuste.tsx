import { Gtk } from "ags/gtk4"
import TituloAjuste from "./TituloAjuste"
import TextoInformativo from "./TextoInformativo"

type PropiedadesEncabezadoAjuste = {
  titulo: any
  informacion?: any
  propiedadesTitulo?: Record<string, any>
  propiedadesInformacion?: Record<string, any>
  spacing?: number
  hexpand?: any
  halign?: Gtk.Align
}

/** Bloque compartido de título y descripción que precede a un control. */
export default function EncabezadoAjuste({
  titulo,
  informacion,
  propiedadesTitulo = {},
  propiedadesInformacion = {},
  spacing = 2,
  hexpand = true,
  halign,
}: PropiedadesEncabezadoAjuste) {
  const alineacion = halign === undefined ? {} : { halign }
  return (
    <box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={spacing}
      hexpand={hexpand}
      {...alineacion}
    >
      <TituloAjuste label={titulo} {...propiedadesTitulo} />
      {informacion != null
        ? <TextoInformativo label={informacion} {...propiedadesInformacion} />
        : <box />}
    </box>
  )
}
