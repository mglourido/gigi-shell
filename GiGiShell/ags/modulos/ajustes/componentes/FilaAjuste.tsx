import { Gtk } from "ags/gtk4"
import EncabezadoAjuste from "./EncabezadoAjuste"

type PropiedadesFilaAjuste = {
  titulo: any
  informacion?: any
  children: any
  cssClasses?: string[]
  compacta?: boolean
  spacing?: number
  maxCaracteresInformacion?: number
  expandirInformacion?: boolean
  visible?: any
}

/** Fila compartida de título, descripción y control para las tarjetas de Ajustes. */
export default function FilaAjuste({
  titulo,
  informacion,
  children,
  cssClasses = [],
  compacta = false,
  spacing = 14,
  maxCaracteresInformacion = 52,
  expandirInformacion = true,
  visible,
}: PropiedadesFilaAjuste) {
  const propiedadVisibilidad = visible === undefined ? {} : { visible }
  return (
    <box
      cssClasses={["dev-row", ...(compacta ? ["sp-fila-compacta"] : []), ...cssClasses]}
      spacing={spacing}
      valign={Gtk.Align.CENTER}
      {...propiedadVisibilidad}
    >
      <EncabezadoAjuste
        titulo={titulo}
        informacion={informacion}
        propiedadesInformacion={{ wrap: true, xalign: 0, maxWidthChars: maxCaracteresInformacion, hexpand: expandirInformacion }}
      />
      {children}
    </box>
  )
}
