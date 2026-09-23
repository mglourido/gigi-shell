// Handler de búsqueda para la sección "Atajos": inline mientras ya estás en
// esa sección (filtra en sitio, ver `KeybindsSection.tsx`); fuera de ella
// sus resultados navegan allí en vez de ejecutar nada directamente.

import { getKeybinds } from "../../data/keybinds"
import { MAX_RESULTADOS } from "../engine"
import type { HandlerMatch, SearchHandler, SearchResult } from "../types"

const MODIFIER_RE = /\b(super|ctrl|alt|shift|prtscn|print)\b/i

export const keybindsHandler: SearchHandler = {
  id: "keybinds",
  defaultFor: ["keybinds"],
  inlineFor: ["keybinds"],   // only inline when already IN keybinds section

  // Una sola pasada: recoge los atajos que casan y de ahí sale tanto la
  // puntuación como las filas (que solo se materializan si el handler gana).
  match(query: string): HandlerMatch {
    const q = query.toLowerCase()
    if (q.length < 2) return { score: 0.05, build: () => [] }

    const matches: SearchResult[] = []
    for (const group of getKeybinds()) {
      for (const kb of group.binds) {
        if (
          kb.description.toLowerCase().includes(q) ||
          kb.binding.toLowerCase().includes(q)
        ) {
          matches.push({
            id: `kb-${kb.binding}-${kb.description}`,
            title: kb.description,
            subtitle: `${group.name}  ·  ${kb.binding}`,
            iconName: "input-keyboard-symbolic",
            // Navigate to keybinds section with filter applied (query stays in SearchBar)
            navigateTo: "keybinds",
            action: () => {},
          })
        }
      }
    }

    // Un patrón de modificador es casi con seguridad una búsqueda de atajo,
    // gane o no por número de coincidencias.
    const score = MODIFIER_RE.test(q) ? 0.85 : matches.length > 0 ? 0.72 : 0.05

    return { score, build: () => matches.slice(0, MAX_RESULTADOS) }
  },
}
