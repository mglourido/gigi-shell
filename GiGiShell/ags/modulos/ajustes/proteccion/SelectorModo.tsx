// modulos/ajustes/proteccion/SelectorModo.tsx — las cinco categorías de
// «accesos habituales» y su selector de tres estados. Lo comparten la tarjeta
// de valores por defecto (SeccionProteccion) y cada archivo (FicheroProtegido).

import { type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import { FilaAjuste, TextoInformativo } from "../componentes"
import type { ModoCategoria } from "../../../servicios/seguridad/guardian"
import textos from "../../../textos/ajustes/proteccion.json" with { type: "json" }

const t = textos.seccion

/** Orden en que se pintan (el de la tabla del diseño). */
export const CATEGORIAS = ["miniaturas", "busqueda", "indexadores", "antivirus", "copias"] as const
const MODOS: ModoCategoria[] = ["permitir", "preguntar", "silencio"]

function Selector({ actual, sensible, alElegir }: {
  actual: Accessor<ModoCategoria>
  sensible: Accessor<boolean>
  alElegir: (modo: ModoCategoria) => void
}) {
  return (
    <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER} sensitive={sensible}>
      {MODOS.map((modo) => (
        <button
          cssClasses={actual((a) => a === modo ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
          onClicked={() => { if (actual.get() !== modo) alElegir(modo) }}
        >
          <label label={t.modos[modo]} />
        </button>
      ))}
    </box>
  )
}

/**
 * Las cinco filas. `modos` da el modo actual de cada categoría (sin valor ⇒
 * preguntar, igual que el daemon).
 */
export default function SelectorCategorias({ modos, sensible, alElegir }: {
  modos: Accessor<Record<string, ModoCategoria>>
  sensible: Accessor<boolean>
  alElegir: (categoria: string, modo: ModoCategoria) => void
}) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      {CATEGORIAS.map((cat) => (
        <box orientation={Gtk.Orientation.VERTICAL}>
          <FilaAjuste titulo={t.categorias[cat]}>
            <Selector
              actual={modos((m) => m[cat] ?? "preguntar")}
              sensible={sensible}
              alElegir={(modo) => alElegir(cat, modo)}
            />
          </FilaAjuste>
          <box cssClasses={["dev-row"]} visible={cat === "busqueda"}>
            <TextoInformativo label={t.avisoBusqueda} />
          </box>
        </box>
      ))}
    </box>
  )
}
