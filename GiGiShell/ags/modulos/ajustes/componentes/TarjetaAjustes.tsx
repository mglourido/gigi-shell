import { Gtk } from "ags/gtk4"
import TituloSubseccion from "./TituloSubseccion"

type PropiedadesTarjetaAjustes = {
  titulo: any
  icono: string
  children: any
  cssClasses?: string[]
  visible?: any
  /** Widget opcional a la derecha del título: un estado de la tarjeta, no un ajuste. */
  detalle?: any
}

/** Tarjeta compartida para agrupar ajustes relacionados bajo un encabezado. */
export default function TarjetaAjustes({
  titulo,
  icono,
  children,
  cssClasses = [],
  visible = true,
  detalle,
}: PropiedadesTarjetaAjustes) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["dev-card", ...cssClasses]} visible={visible}>
      <box spacing={8} cssClasses={["dev-card-header"]}>
        <label cssClasses={["dev-card-icon"]} label={icono} />
        <TituloSubseccion label={titulo} halign={Gtk.Align.START} />
        {detalle ?? <box />}
      </box>
      {children}
    </box>
  )
}
