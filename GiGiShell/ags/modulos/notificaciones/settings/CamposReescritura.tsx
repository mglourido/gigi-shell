import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"
import type { NotifRule } from "../rules/types.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

export type CampoReescrituraId = "appName" | "summary" | "body"

const CAMPOS: { id: CampoReescrituraId; titulo: string; accion: string }[] = [
  { id: "appName", titulo: textos.editor.titulos.nombreApp, accion: textos.editor.acciones.quitarNombre },
  { id: "summary", titulo: textos.editor.titulos.nuevoTitulo, accion: textos.editor.acciones.vaciar },
  { id: "body", titulo: textos.editor.titulos.nuevoCuerpo, accion: textos.editor.acciones.vaciar },
]

export default function CamposReescritura({
  reglaInicial,
  borrador,
  cambiarTexto,
  cambiarVaciado,
}: {
  reglaInicial: NotifRule
  borrador: Accessor<NotifRule>
  cambiarTexto: (campo: CampoReescrituraId, texto: string) => void
  cambiarVaciado: (campo: CampoReescrituraId, activo: boolean) => void
}) {
  // Cada campo va en su PROPIA `<box>`, no en un `<>`: un Fragment dentro de otro Fragment
  // hace que `Fragment.append` lance «nesting Fragments are not yet supported», y ese error
  // reventaba la construcción entera de `RuleEditor` — o sea que el botón "editar" de CUALQUIER
  // pestaña de Ajustes de notificaciones dejaba el panel en blanco, sin error visible: `<With>`
  // ya había quitado la vista de lista antes de intentar montar el editor.
  return (
    <>
      {CAMPOS.map(({ id, titulo, accion }) => {
        const valorInicial = reglaInicial.effects.rewrite?.[id]
        return (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <box spacing={6} valign={Gtk.Align.CENTER}>
              <label cssClasses={["re-field-label"]} label={titulo} hexpand halign={Gtk.Align.START} />
              <button
                cssClasses={borrador((regla) =>
                  regla.effects.rewrite?.[id] === "" ? ["re-toggle", "active"] : ["re-toggle"])}
                onClicked={() => cambiarVaciado(id, borrador.get().effects.rewrite?.[id] !== "")}
              >
                <label label={accion} />
              </button>
            </box>
            <Gtk.Entry
              cssClasses={["re-entry"]}
              text={valorInicial && valorInicial !== "" ? valorInicial : ""}
              placeholderText={textos.editor.ayudas.sinCambios}
              sensitive={borrador((regla) => regla.effects.rewrite?.[id] !== "")}
              onChanged={(self) => {
                if (borrador.get().effects.rewrite?.[id] !== "") cambiarTexto(id, self.text)
              }}
            />
          </box>
        )
      })}
    </>
  )
}
