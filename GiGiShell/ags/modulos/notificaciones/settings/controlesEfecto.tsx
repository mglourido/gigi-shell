// modulos/notificaciones/settings/controlesEfecto.tsx
// Un control GTK por TIPO de control de efecto (`ControlEditor` en `rules/efectos/tipos.ts`).
// Los efectos no se nombran aquí: un efecto nuevo de un tipo que ya existe aparece en el editor
// sin tocar este fichero. Un TIPO nuevo se añade una vez, como un `case` más.
import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"
import type { NotifRule } from "../rules/types.ts"
import type { DefinicionEfecto } from "../rules/efectos/tipos.ts"
import { condicionesEditables } from "../rules/condiciones/index.ts"
import { NOTIF_FIELDS } from "../rules/notifFields.ts"
import { parseDuration, formatDuration } from "../rules/duration.ts"
import ColorPicker from "./ColorPicker.tsx"
import { crearCampoRutaAudio } from "../sonido/CampoRutaAudio.ts"
import CamposReescritura, { type CampoReescrituraId } from "./CamposReescritura.tsx"
import { CampoEditor } from "./ControlesEditor.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export interface PropiedadesControl {
  def: DefinicionEfecto
  borrador: Accessor<NotifRule>
  /** La regla tal como se abrió: los `Gtk.Entry` se rellenan UNA vez desde aquí y no desde el
   *  borrador, o se reescribirían a cada tecla y perderían el cursor. */
  inicial: NotifRule
  /** Fija el valor del efecto; `undefined` borra la clave («la regla no opina»). */
  fijar: (valor: unknown) => void
  /** Escritura libre de los efectos, para los controles que tocan subcampos (la reescritura). */
  cambiarEfectos: (efectos: NotifRule["effects"]) => void
  visible?: Accessor<boolean> | boolean
}

const valorDe = (regla: NotifRule, def: DefinicionEfecto): unknown =>
  (regla.effects as Record<string, unknown>)[def.clave]

/** La ayuda bajo un control, o `false` si no hay texto. Seguro dentro de `CampoEditor`, que
 *  filtra sus hijos; FUERA de él, solo como hijo directo de una etiqueta JSX (ver allí por qué). */
function ayuda(texto?: string): Gtk.Widget | false {
  return !!texto && (<label cssClasses={["re-hint"]} label={texto} halign={Gtk.Align.START} wrap={true} /> as Gtk.Widget)
}

/** El control de un efecto, según su `editor.tipo`. Los interruptores no pasan por aquí: los
 *  agrupa en filas `EfectosEditor`. */
export function ControlEfecto(p: PropiedadesControl): Gtk.Widget | null {
  const { def, borrador, inicial, fijar, visible } = p
  const editor = def.editor
  switch (editor.tipo) {
    case "opciones": {
      const seleccion = editor.seleccion ?? ((v: unknown) => v)
      return (
        <CampoEditor titulo={editor.titulo} visible={visible}>
          <box spacing={4}>
            {editor.opciones.map((opcion) => (
              <button
                cssClasses={borrador((d) => seleccion(valorDe(d, def)) === opcion.valor ? ["re-seg", "active"] : ["re-seg"])}
                onClicked={() => fijar(opcion.valor)}
              >
                <label label={opcion.etiqueta} />
              </button>
            ))}
          </box>
          {ayuda(editor.ayuda)}
        </CampoEditor>
      ) as Gtk.Widget
    }

    case "duracion": {
      const inicialMs = valorDe(inicial, def)
      return (
        <CampoEditor titulo={editor.titulo} visible={visible}>
          <Gtk.Entry
            cssClasses={["re-entry"]}
            text={typeof inicialMs === "number" && inicialMs ? formatDuration(inicialMs) : ""}
            placeholderText={editor.marcador}
            // Lo que no se entiende queda como «sin valor», no como error: la validación solo
            // salta con valores presentes y malos, que solo pueden venir del JSON a mano.
            onChanged={(self) => fijar(self.text.trim() ? (parseDuration(self.text) ?? undefined) : undefined)}
          />
          {ayuda(editor.ayuda)}
        </CampoEditor>
      ) as Gtk.Widget
    }

    case "color":
      return (
        <CampoEditor titulo={editor.titulo} visible={visible}>
          <ColorPicker value={valorDe(inicial, def) as string | undefined} onChange={(hex) => fijar(hex || undefined)} />
        </CampoEditor>
      ) as Gtk.Widget

    case "ruta-audio": {
      // Se construye UNA vez y escribe en el borrador desde su callback: montarlo dentro de una
      // expresión reactiva lo recrearía a cada tecla y el foco se perdería a la primera.
      const campo = crearCampoRutaAudio({
        valor: valorDe(inicial, def) as string | undefined,
        marcador: editor.marcador,
        etiquetaProbar: editor.etiquetaProbar,
        ayudaProbar: editor.ayudaProbar,
        avisoNoExiste: editor.avisoNoExiste,
        alCambiar: (ruta) => fijar(ruta || undefined),
      })
      return (
        <CampoEditor titulo={editor.titulo} visible={visible}>
          {campo.widget}
          {ayuda(editor.ayuda)}
        </CampoEditor>
      ) as Gtk.Widget
    }

    case "condiciones":
      return (
        <CampoEditor titulo={editor.titulo} visible={visible}>
          {ayuda(editor.ayuda)}
          <box spacing={4}>
            {condicionesEditables().map((c) => (
              <button
                cssClasses={borrador((d) => ((valorDe(d, def) as string[] | undefined) ?? []).includes(c.id)
                  ? ["re-toggle", "active"] : ["re-toggle"])}
                onClicked={() => {
                  const actuales = new Set((valorDe(borrador.get(), def) as string[] | undefined) ?? [])
                  if (actuales.has(c.id)) actuales.delete(c.id); else actuales.add(c.id)
                  fijar(actuales.size ? [...actuales] : undefined)
                }}
              >
                <label label={c.etiqueta ?? c.id} />
              </button>
            ))}
          </box>
        </CampoEditor>
      ) as Gtk.Widget

    case "reescritura": {
      // Por campo: undefined = no cambiar, "" = vaciar u omitir, texto = reemplazar.
      type Reescritura = NonNullable<NotifRule["effects"]["rewrite"]>
      const actualizar = (campo: CampoReescrituraId, valor: string | undefined) => {
        const efectos = { ...borrador.get().effects }
        const rw: Reescritura = { ...(efectos.rewrite ?? {}) }
        if (valor === undefined) delete rw[campo]; else rw[campo] = valor
        if (rw.appName === undefined && rw.summary === undefined && rw.body === undefined) delete efectos.rewrite
        else efectos.rewrite = rw
        p.cambiarEfectos(efectos)
      }
      return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={visible}>
          <CamposReescritura
            reglaInicial={inicial}
            borrador={borrador}
            cambiarTexto={(campo, texto) => actualizar(campo, texto ? texto : undefined)}
            cambiarVaciado={(campo, vaciar) => actualizar(campo, vaciar ? "" : undefined)}
          />
          {ayuda(formatearTexto(textos.editor.ayudas.variables, {
            variables: NOTIF_FIELDS.map((f) => "{" + f.key + "}").join(", "),
          }))}
        </box>
      ) as Gtk.Widget
    }

    case "interruptor":
      return null
  }
}
