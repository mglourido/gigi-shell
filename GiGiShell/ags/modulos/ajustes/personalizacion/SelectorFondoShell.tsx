import { Gtk } from "ags/gtk4"
import { FilaAjuste } from "../componentes"
import {
  fondoShell,
  setFondoShell,
  type FondoShell,
} from "../preferences"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const OPCIONES: { valor: FondoShell, etiqueta: string }[] = [
  { valor: "negro", etiqueta: textos.apariencia.fondo.opciones.negro },
  { valor: "grafito", etiqueta: textos.apariencia.fondo.opciones.grafito },
  { valor: "gris", etiqueta: textos.apariencia.fondo.opciones.gris },
]

/** Selector exclusivo del color compartido por las superficies del shell. */
export default function SelectorFondoShell() {
  return (
    <FilaAjuste
      titulo={textos.apariencia.fondo.titulo}
      informacion={textos.apariencia.fondo.descripcion}
    >
      <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER}>
        {OPCIONES.map(({ valor, etiqueta }) => (
          <button
            cssClasses={fondoShell((actual) =>
              actual === valor ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
            onClicked={() => setFondoShell(valor)}
          >
            <box spacing={6} valign={Gtk.Align.CENTER}>
              <box cssClasses={["sp-fondo-muestra", valor]} />
              <label label={etiqueta} />
            </box>
          </button>
        ))}
      </box>
    </FilaAjuste>
  )
}
