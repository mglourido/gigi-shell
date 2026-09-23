// modulos/notificaciones/settings/SistemaTab.tsx
// Un aviso del sistema por fila, agrupados por categoría. Es la pestaña que hace que
// "configurable por separado" sea verdad: enumera el catálogo entero (`catalogoSistema.ts`),
// incluidos los avisos que nunca se han disparado — que son justo los que interesa dejar
// ajustados de antemano.
import { Gtk } from "ags/gtk4"
import { createState, For, With } from "ags"
import type { NotifRule } from "../rules/types.ts"
import { catalogoPorCategoria, type EventoSistema } from "../rules/catalogoSistema.ts"
import {
  archivoSistema, efectosEvento, eventoPersonalizado, alternarSilencio, reglaDeEvento,
} from "../rules/sistemaStore.ts"
import RuleEditor from "./RuleEditor.tsx"
import EmptyState from "../../../componentes/EmptyState.tsx"
import textos from "../../../textos/ajustes/notificaciones-sistema.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

function FilaEvento({ evento, onEdit }: { evento: EventoSistema; onEdit: () => void }) {
  // Se recalcula con cada cambio del fichero: silenciar desde la lista tiene que repintar la
  // fila (y su etiqueta) sin volver a montar la pestaña.
  const estado = archivoSistema((a) => ({
    efectos: efectosEvento(evento.id, a),
    tocado: eventoPersonalizado(evento.id, a),
  }))

  return (
    <box cssClasses={["re-row"]} spacing={8} valign={Gtk.Align.CENTER} hexpand>
      <button
        cssClasses={estado((s) => s.efectos.suppress ? ["re-toggle"] : ["re-toggle", "active"])}
        valign={Gtk.Align.CENTER}
        tooltipText={estado((s) => s.efectos.suppress ? textos.pestana.activar : textos.pestana.silenciar)}
        onClicked={() => alternarSilencio(evento.id)}
      >
        <label label={estado((s) => s.efectos.suppress ? "󰂛" : "󰂚")} />
      </button>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand halign={Gtk.Align.START}>
        <box spacing={6}>
          <label cssClasses={["re-row-name"]} label={evento.nombre} halign={Gtk.Align.START} ellipsize={3} />
          <label cssClasses={["re-badge"]} label={textos.pestana.silenciado} visible={estado((s) => !!s.efectos.suppress)} />
          <label cssClasses={["re-badge"]} label={textos.pestana.sinPopup} visible={estado((s) => !s.efectos.suppress && !!s.efectos.dontShow)} />
          <label cssClasses={["re-badge"]} label={textos.pestana.personalizado} visible={estado((s) => s.tocado)} />
        </box>
        <label
          cssClasses={["re-row-summary"]}
          label={formatearTexto(textos.pestana.origen, { origen: evento.origen })}
          halign={Gtk.Align.START}
          ellipsize={3}
        />
      </box>
      <button cssClasses={["re-edit-btn"]} tooltipText={textos.pestana.editar} onClicked={onEdit}>
        <label label="󰏫" />
      </button>
    </box>
  )
}

export default function SistemaTab() {
  const [editing, setEditing] = createState<NotifRule | null>(null)
  const [busqueda, setBusqueda] = createState("")
  const grupos = catalogoPorCategoria()

  // El filtro mira nombre E id: el id es lo que aparece en los scripts y en el JSON, así que
  // buscar "kernel.oom" tiene que encontrarlo aunque el nombre visible no lleve esa palabra.
  const casa = (e: EventoSistema, q: string) =>
    q === "" || e.nombre.toLowerCase().includes(q) || e.id.includes(q) || e.origen.toLowerCase().includes(q)

  const nadaVisible = busqueda((q) => {
    const t = q.trim().toLowerCase()
    return !grupos.some(g => g.eventos.some(e => casa(e, t)))
  })

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand vexpand>
      <With value={editing}>
        {(e: NotifRule | null) => e
          ? <RuleEditor rule={e} onClose={() => setEditing(null)} />
          : <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand>
              <label cssClasses={["st-tab-hint"]} label={textos.pestana.cabecera} halign={Gtk.Align.START} wrap={true} />
              <Gtk.Entry
                cssClasses={["re-entry"]}
                placeholderText={textos.pestana.buscar}
                onChanged={(self) => setBusqueda(self.text)}
              />

              <With value={nadaVisible}>
                {(vacio: boolean) => vacio
                  ? <EmptyState
                      icon="󰍉"
                      title={textos.pestana.vacio}
                      wrapClass="ns-empty-state"
                      iconClass="ns-empty-icon"
                      titleClass="ns-empty-label"
                      vexpand
                    />
                  : <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} hexpand vexpand>
                      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                        {grupos.map(g => (
                          <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand
                               visible={busqueda((q) => g.eventos.some(e => casa(e, q.trim().toLowerCase())))}>
                            <label cssClasses={["re-section"]} label={g.nombre} halign={Gtk.Align.START} />
                            {/* Sin `id`, `<For>` indexa por identidad de objeto — y aquí eso es
                                correcto y deliberado: `filter` devuelve las MISMAS referencias del
                                catálogo, que es una constante de módulo, así que teclear en el
                                buscador no reconstruye las filas que siguen visibles. */}
                            <For each={busqueda((q) => g.eventos.filter(e => casa(e, q.trim().toLowerCase())))}>
                              {(evento: EventoSistema) => (
                                <FilaEvento evento={evento} onEdit={() => setEditing(reglaDeEvento(evento.id) ?? null)} />
                              )}
                            </For>
                          </box>
                        ))}
                      </box>
                    </Gtk.ScrolledWindow>
                }
              </With>
            </box>
        }
      </With>
    </box>
  )
}
