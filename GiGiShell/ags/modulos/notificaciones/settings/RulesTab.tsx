// modulos/notificaciones/settings/RulesTab.tsx
import { Gtk } from "ags/gtk4"
import { createState, For, With } from "ags"
import type { NotifRule } from "../rules/types.ts"
import { rulesFile, allRules, upsertUserRule, setBuiltinOverride } from "../rules/rulesStore.ts"
import { blankRule, summarizeRule } from "./ruleFactory.ts"
import RuleEditor from "./RuleEditor.tsx"
import AppFilterBar from "./AppFilterBar.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

export default function RulesTab() {
  const [editing, setEditing] = createState<NotifRule | null>(null)
  // Sin el filtro, las ~100 entradas del catálogo del sistema entierran las reglas
  // predefinidas y las del usuario, que es lo que esta pestaña existe para enseñar. Los
  // avisos del sistema se editan en su propia pestaña, con su propio fichero.
  const reglasVisibles = () => allRules().filter(r => r.source !== "system")
  const [rules, setRules] = createState<NotifRule[]>(reglasVisibles())
  rulesFile.subscribe(() => setRules(reglasVisibles()))
  const [filter, setFilter] = createState<string>("all")
  const apps = rules((rs) => Array.from(new Set((rs ?? [])
    .map(r => r.match.app?.value).filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b)))

  function toggleEnabled(r: NotifRule) {
    if (r.source === "builtin") setBuiltinOverride(r.id, { enabled: !r.enabled })
    else upsertUserRule({ ...r, enabled: !r.enabled })
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand vexpand>
      <With value={editing}>
        {(e: NotifRule | null) => e
          ? <RuleEditor rule={e} onClose={() => setEditing(null)} />
          : <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand>
              <box spacing={6} valign={Gtk.Align.CENTER} hexpand>
                <label cssClasses={["st-tab-hint"]} label={textos.reglas.cabecera} hexpand halign={Gtk.Align.START} />
                <button cssClasses={["st-add-btn"]} onClicked={() => setEditing(blankRule(`user.${Date.now()}`))}>
                  <label label={textos.reglas.nueva} />
                </button>
              </box>

              <AppFilterBar apps={apps} active={filter} onSelect={setFilter} />

              <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} hexpand vexpand>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                  <For each={rules}>
                    {(r: NotifRule) => (
                      <box cssClasses={["re-row"]} spacing={8} valign={Gtk.Align.CENTER} visible={filter((f) => f === "all" || r.match.app?.value === f)} hexpand>
                        <button
                          cssClasses={r.enabled ? ["re-toggle", "active"] : ["re-toggle"]}
                          valign={Gtk.Align.CENTER}
                          tooltipText={r.enabled ? textos.reglas.desactivar : textos.reglas.activar}
                          onClicked={() => toggleEnabled(r)}
                        >
                          <label label={r.enabled ? "󰔡" : "󰨙"} />
                        </button>
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand halign={Gtk.Align.START}>
                          <box spacing={6}>
                            <label cssClasses={["re-row-name"]} label={r.name} halign={Gtk.Align.START} ellipsize={3} />
                            {r.source === "builtin" && <label cssClasses={["re-badge"]} label={textos.reglas.predefinida} />}
                          </box>
                          <label cssClasses={["re-row-summary"]} label={summarizeRule(r)} halign={Gtk.Align.START} wrap={true} lines={3} ellipsize={3} />
                        </box>
                        <button cssClasses={["re-edit-btn"]} tooltipText={textos.reglas.editar} onClicked={() => setEditing(r)}><label label="󰏫" /></button>
                      </box>
                    )}
                  </For>
                </box>
              </Gtk.ScrolledWindow>
            </box>
        }
      </With>
    </box>
  )
}
