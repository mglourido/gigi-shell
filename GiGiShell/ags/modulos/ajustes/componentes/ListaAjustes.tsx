import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"
import TextoInformativo from "./TextoInformativo"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

type PropiedadesListaAjustes = {
  children: any
  cantidad?: Accessor<number>
  vacia?: string | Accessor<string>
  alto?: number
  expandir?: boolean
  cssClasses?: string[]
}

/** Reserva un alto fijo, o llena el espacio disponible con `expandir`.
 * El buscador y las acciones quedan fuera del scroll.
 * No virtualiza: los catálogos grandes deben entregar solo una página de filas. */
export default function ListaAjustes({
  children, cantidad, vacia, alto = 176, expandir = false, cssClasses = [],
}: PropiedadesListaAjustes) {
  return (
    <box cssClasses={["sp-lista"]} orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand={expandir}>
      {cantidad ? <TextoInformativo cssClasses={["sp-lista-resumen"]}
        label={cantidad((n) => formatearTexto(textos.listas.elementos, { cantidad: n }))} /> : <box />}
      <Gtk.ScrolledWindow
        cssClasses={["sp-lista-scroll", ...cssClasses]}
        hexpand
        vexpand={expandir}
        minContentHeight={expandir ? 0 : alto}
        maxContentHeight={expandir ? -1 : alto}
        propagateNaturalHeight={!expandir}
        propagateNaturalWidth={false}
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        overlayScrolling={false}
      >
        <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.START}>
          {vacia && cantidad ? <TextoInformativo cssClasses={["sp-lista-vacia"]}
            label={vacia} visible={cantidad((n) => n === 0)} /> : <box />}
          {children}
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}
