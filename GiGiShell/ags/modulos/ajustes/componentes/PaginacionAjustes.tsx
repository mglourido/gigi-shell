import { Gtk } from "ags/gtk4"
import { createComputed, type Accessor } from "ags"
import BotonAjustes from "./BotonAjustes"
import TextoInformativo from "./TextoInformativo"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

type PropiedadesPaginacion = {
  pagina: Accessor<number>
  paginas: Accessor<number>
  alCambiar: (pagina: number) => void
}

export default function PaginacionAjustes({ pagina, paginas, alCambiar }: PropiedadesPaginacion) {
  const resumen = createComputed(() => formatearTexto(textos.listas.pagina, {
    actual: pagina() + 1, total: paginas(),
  }))
  return (
    <box spacing={8} valign={Gtk.Align.CENTER} cssClasses={["sp-paginacion"]}>
      <BotonAjustes label="‹" tooltipText={textos.listas.anterior}
        sensitive={pagina((n) => n > 0)} onClicked={() => alCambiar(pagina.get() - 1)} />
      <TextoInformativo label={resumen} xalign={0.5} />
      <BotonAjustes label="›" tooltipText={textos.listas.siguiente}
        sensitive={createComputed(() => pagina() + 1 < paginas())}
        onClicked={() => alCambiar(pagina.get() + 1)} />
    </box>
  )
}
