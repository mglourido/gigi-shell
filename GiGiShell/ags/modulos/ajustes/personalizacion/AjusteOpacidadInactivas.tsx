// modulos/ajustes/personalizacion/AjusteOpacidadInactivas.tsx
//
// Selector de tres valores de la transparencia de las ventanas al perder el foco.
// Solo toca la opacidad INACTIVA; lo aplica hypr/gigishell/ventanas.lua.
import { Gtk } from "ags/gtk4"
import { FilaAjuste } from "../componentes"
import {
  opacidadVentanasInactivas,
  setOpacidadVentanasInactivas,
  type ModoOpacidadInactivas,
} from "../preferences"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const t = textos.ventanas.opacidadInactivas

const OPCIONES: { valor: ModoOpacidadInactivas, etiqueta: string }[] = [
  { valor: "desactivado", etiqueta: t.opciones.desactivado },
  { valor: "predeterminado", etiqueta: t.opciones.predeterminado },
  { valor: "activado", etiqueta: t.opciones.activado },
]

export default function AjusteOpacidadInactivas() {
  return (
    <FilaAjuste titulo={t.titulo} informacion={t.descripcion}>
      <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER}>
        {OPCIONES.map(({ valor, etiqueta }) => (
          <button
            cssClasses={opacidadVentanasInactivas((actual) =>
              actual === valor ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
            onClicked={() => setOpacidadVentanasInactivas(valor)}
          >
            <label label={etiqueta} />
          </button>
        ))}
      </box>
    </FilaAjuste>
  )
}
