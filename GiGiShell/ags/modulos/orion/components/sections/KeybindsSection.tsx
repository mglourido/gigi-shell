// Sección "Atajos" de Orion: lista los grupos de `data/keybinds.ts` (parseados
// de `gigios/keybinds.lua`) y los filtra en vivo contra `searchQuery` — la búsqueda
// es inline aquí (ver `search/handlers/keybinds.ts`, `inlineFor: ["keybinds"]`),
// no redirige a la sección reactiva.

import { Gtk } from "ags/gtk4"
import { keybinds } from "../../data/keybinds"
import { searchQuery } from "../../state"
import { vaciarCaja } from "../shared/gtkUtils"

export function KeybindsSection() {
  type RowEntry   = { box: Gtk.Box; binding: string; description: string }
  type GroupEntry = { groupBox: Gtk.Box; rows: RowEntry[] }

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["kb-content"] })
  let groupEntries: GroupEntry[] = []

  const emptyLabel = new Gtk.Label({ label: "Sin resultados", cssClasses: ["kb-empty"] })
  emptyLabel.visible = false

  function clearContent() {
    vaciarCaja(content)
  }

  function build() {
    clearContent()
    groupEntries = []

    for (const group of keybinds.get()) {
      const titleLabel = new Gtk.Label()
      titleLabel.label = group.name
      titleLabel.set_css_classes(["kb-group-title"])
      titleLabel.halign = Gtk.Align.START

      const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
      groupBox.append(titleLabel)

      const rows: RowEntry[] = []
      for (const kb of group.binds) {
        const rowBox    = new Gtk.Box({ cssClasses: ["kb-row"] })
        const keyLabel  = new Gtk.Label({ label: kb.binding,     cssClasses: ["kb-key"],  halign: Gtk.Align.START })
        const descLabel = new Gtk.Label({ label: kb.description, cssClasses: ["kb-desc"], halign: Gtk.Align.START, hexpand: true, ellipsize: 3 })
        rowBox.append(keyLabel)
        rowBox.append(descLabel)
        groupBox.append(rowBox)
        rows.push({ box: rowBox, binding: kb.binding, description: kb.description })
      }

      content.append(groupBox)
      groupEntries.push({ groupBox, rows })
    }

    content.append(emptyLabel)
    applyFilter(searchQuery.get())
  }

  function applyFilter(q: string) {
    const norm = q.toLowerCase().trim()
    let totalVisible = 0

    for (const { groupBox, rows } of groupEntries) {
      let anyVisible = false
      for (const row of rows) {
        const matches = !norm ||
          row.description.toLowerCase().includes(norm) ||
          row.binding.toLowerCase().includes(norm)
        row.box.visible = matches
        if (matches) anyVisible = true
      }
      groupBox.visible = anyVisible
      if (anyVisible) totalVisible++
    }

    emptyLabel.visible = totalVisible === 0 && norm.length > 0
  }

  build()
  // Rebuild when gigios/keybinds.lua / gigios/variables.lua change on disk.
  keybinds.subscribe(build)
  searchQuery.subscribe(() => applyFilter(searchQuery.get()))

  return content
}
