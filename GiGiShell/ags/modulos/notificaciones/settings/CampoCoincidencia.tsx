import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"
import type { MatchSpec, NotifRule, StringMatch } from "../rules/types.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

type CampoCoincidenciaId = "app" | "summary" | "body" | "source"

const OPERADORES: StringMatch["op"][] = ["contains", "equals", "regex"]
const ETIQUETAS_OPERADOR: Record<StringMatch["op"], string> = {
  contains: textos.editor.operadores.contiene,
  equals: textos.editor.operadores.igual,
  regex: textos.editor.operadores.expresionRegular,
}

export default function CampoCoincidencia({
  campo,
  titulo,
  borrador,
  actualizarMatch,
  reemplazarMatch,
}: {
  campo: CampoCoincidenciaId
  titulo: string
  borrador: Accessor<NotifRule>
  actualizarMatch: (cambios: Partial<MatchSpec>) => void
  reemplazarMatch: (match: MatchSpec) => void
}) {
  const actual = (): StringMatch | undefined => borrador.get().match[campo]

  const cambiarValor = (valor: string): void => {
    if (!valor) {
      const match = { ...borrador.get().match }
      delete match[campo]
      reemplazarMatch(match)
      return
    }
    actualizarMatch({ [campo]: { op: actual()?.op ?? "contains", value: valor } })
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["re-field"]}>
      <label cssClasses={["re-field-label"]} label={titulo} halign={Gtk.Align.START} />
      <box spacing={4}>
        {OPERADORES.map((operador) => (
          <button
            cssClasses={borrador((regla) =>
              regla.match[campo]?.op === operador ? ["re-seg", "active"] : ["re-seg"])}
            onClicked={() => actualizarMatch({
              [campo]: { op: operador, value: actual()?.value ?? "", ci: actual()?.ci },
            })}
          >
            <label label={ETIQUETAS_OPERADOR[operador]} />
          </button>
        ))}
      </box>
      <Gtk.Entry
        cssClasses={["re-entry"]}
        text={actual()?.value ?? ""}
        placeholderText={textos.editor.ayudas.campoVacio}
        onChanged={(self) => cambiarValor(self.text)}
      />
    </box>
  )
}
