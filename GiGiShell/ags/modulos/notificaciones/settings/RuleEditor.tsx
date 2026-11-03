// modulos/notificaciones/settings/RuleEditor.tsx
// Form editor for a single rule. No JSON exposed. Mounted fresh per edit.
import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import type { NotifRule } from "../rules/types.ts"
import { COINCIDENCIAS } from "../rules/coincidencias.ts"
import { upsertUserRule, removeUserRule, setBuiltinOverride, clearBuiltinOverride } from "../rules/rulesStore.ts"
import { fijarEfectosEvento, restaurarEvento } from "../rules/sistemaStore.ts"
import { eventoSistema } from "../rules/catalogoSistema.ts"
import { validateRule } from "../rules/validate.ts"
import CampoCoincidencia from "./CampoCoincidencia.tsx"
import EfectosEditor from "./EfectosEditor.tsx"
import { CampoEditor } from "./ControlesEditor.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import textosSistema from "../../../textos/ajustes/notificaciones-sistema.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export default function RuleEditor({ rule, onClose }: { rule: NotifRule; onClose: () => void }) {
  // Working copy held as one state; helpers patch it.
  const [draft, setDraft] = createState<NotifRule>(JSON.parse(JSON.stringify(rule)))
  const [errors, setErrors] = createState<string[]>([])
  const patch = (p: Partial<NotifRule>) => {
    if (errors.get().length) setErrors([]) // clear stale validation errors as the user edits
    setDraft({ ...draft.get(), ...p })
  }
  const patchMatch = (p: Partial<NotifRule["match"]>) => patch({ match: { ...draft.get().match, ...p } })
  const isBuiltin = rule.source === "builtin"
  // Un aviso del sistema es una entrada del catálogo, no una regla que el usuario haya
  // escrito: su `match` lo fija el catálogo (`event equals <id>`) y editarlo no tendría
  // sentido —apuntaría a otro aviso, o a ninguno—, así que el formulario esconde entero el
  // bloque "Cuándo aplica" y el nombre, y deja solo los efectos.
  const isSystem = rule.source === "system"
  const eventoId = isSystem ? (rule.match.event?.value ?? "") : ""
  const evento = eventoId ? eventoSistema(eventoId) : undefined
  const isNew = !isBuiltin && !isSystem
    && rule.name === textos.resumen.nuevaRegla
    && Object.keys(rule.match).length === 0
    && Object.keys(rule.effects).length === 0

  function save() {
    const d = draft.get()
    const errs = validateRule(d)
    if (errs.length) { setErrors(errs); return } // don't persist an invalid rule
    setErrors([])
    if (isSystem) {
      // Solo los efectos, y a SU fichero (`notif-sistema.json`). El resto de campos de la
      // regla —id, nombre, match, prioridad— los reconstruye el catálogo en cada arranque.
      fijarEfectosEvento(eventoId, d.effects)
    } else if (isBuiltin) {
      // Persist only the editable fields as an override keyed by builtin id.
      setBuiltinOverride(d.id, { enabled: d.enabled, name: d.name, match: d.match, effects: d.effects, priority: d.priority, stopOnMatch: d.stopOnMatch })
    } else {
      upsertUserRule(d)
    }
    onClose()
  }
  function del() {
    // "Borrar" un aviso del sistema no puede existir: el catálogo lo va a recrear igual. Lo
    // que hace el botón es restaurarlo, y por eso lleva otra etiqueta.
    if (isSystem) restaurarEvento(eventoId)
    else if (isBuiltin) clearBuiltinOverride(rule.id)
    else removeUserRule(rule.id)
    onClose()
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["re-panel"]}>
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <button cssClasses={["ns-back-btn"]} onClicked={onClose}><label label="󰅁" /></button>
        <label
          cssClasses={["ns-title"]}
          label={isSystem
            ? (evento?.nombre ?? textosSistema.editor.titulo)
            : (isBuiltin ? textos.editor.titulos.editarPredefinida : (isNew ? textos.editor.titulos.nueva : textos.editor.titulos.editar))}
          hexpand
          halign={Gtk.Align.START}
        />
        {/* El interruptor "Activa/Inactiva" es de la REGLA. En un aviso del sistema la regla
            existe siempre (la genera el catálogo) y desactivarla no significaría "no me
            avises" sino "ignora tu propia configuración": lo que silencia es el efecto
            «Descartar por completo», que está ahí abajo y en el interruptor de la lista. */}
        {!isSystem && (
          <button cssClasses={draft((d) => d.enabled ? ["re-toggle", "active"] : ["re-toggle"])} onClicked={() => patch({ enabled: !draft.get().enabled })}>
            <label label={draft((d) => d.enabled ? textos.editor.acciones.activa : textos.editor.acciones.inactiva)} />
          </button>
        )}
      </box>

      <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} vexpand>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={10}>
          {/* Identidad (solo avisos del sistema): no editable, pero SÍ visible — es la clave
              con la que se guarda la configuración y la que se busca en los scripts. */}
          {isSystem && (
            <CampoEditor titulo={textosSistema.editor.identidad}>
              <label cssClasses={["re-row-summary"]} label={eventoId} halign={Gtk.Align.START} selectable />
              <label cssClasses={["re-hint"]} label={formatearTexto(textosSistema.pestana.origen, { origen: evento?.origen ?? "?" })} halign={Gtk.Align.START} wrap={true} />
              <label cssClasses={["re-hint"]} label={textosSistema.editor.ayudaIdentidad} halign={Gtk.Align.START} wrap={true} />
            </CampoEditor>
          )}

          {/* Name */}
          <CampoEditor titulo={textos.editor.titulos.nombre} visible={!isSystem}>
            <Gtk.Entry cssClasses={["re-entry"]} text={rule.name} onChanged={(self) => patch({ name: self.text })} />
          </CampoEditor>

          {!isSystem && (
            <>
              <label cssClasses={["re-section"]} label={textos.editor.titulos.cuando} halign={Gtk.Align.START} />
              <label
                cssClasses={["re-hint"]}
                label={textos.editor.ayudas.cuando}
                halign={Gtk.Align.START}
                wrap={true}
              />
              {COINCIDENCIAS.filter((c) => c.editor).map((c) => (
                <CampoCoincidencia campo={c.campo} titulo={c.editor!.titulo} borrador={draft} actualizarMatch={patchMatch} reemplazarMatch={(match) => patch({ match })} />
              ))}
            </>
          )}

          {/* «Qué hacer»: lo genera el registro de efectos (`rules/efectos/`). */}
          <EfectosEditor borrador={draft} inicial={rule} cambiarEfectos={(effects) => patch({ effects })} />
        </box>
      </Gtk.ScrolledWindow>

      {/* validation errors (shown when Save is blocked) */}
      <label
        cssClasses={["re-error"]}
        visible={errors((e) => e.length > 0)}
        label={errors((e) => e.join("\n"))}
        wrap={true}
        halign={Gtk.Align.START}
      />

      {/* footer */}
      <box spacing={6}>
        <button cssClasses={["re-save"]} onClicked={save} hexpand><label label={textos.editor.acciones.guardar} /></button>
        <button
          cssClasses={["re-delete"]}
          tooltipText={isSystem
            ? textosSistema.editor.restaurarAyuda
            : (isBuiltin ? textos.editor.acciones.restaurarAyuda : textos.editor.acciones.borrarAyuda)}
          onClicked={del}
        >
          <label label={isSystem
            ? textosSistema.editor.restaurar
            : (isBuiltin ? textos.editor.acciones.revertir : textos.editor.acciones.borrar)} />
        </button>
      </box>
    </box>
  )
}
