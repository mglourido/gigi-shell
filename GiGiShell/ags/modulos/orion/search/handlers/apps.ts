// Handler de búsqueda por defecto de Inicio: fuzzy-match sobre nombre, exec,
// id y descripción de cada `.desktop` (algoritmo de subsecuencia estilo
// rofi/fzf), con pesos distintos por campo.

import type Gio from "gi://Gio"
import { MAX_RESULTADOS } from "../engine"
import type { HandlerMatch, SearchHandler, SearchResult } from "../types"
import { launchApp } from "../../data/launch"
import { getAppInfos } from "../../data/appsInfo"

// ── Fuzzy subsequence scoring ─────────────────────────────────────────────────
// All query chars must appear in target in order (rofi fuzzy algorithm).
// Returns null if target is not a match; positive score if it is.
// Higher score = better match.
function fuzzy(target: string, query: string): number | null {
  const t = target.toLowerCase()
  const q = query.toLowerCase()

  // Fast exact paths
  if (t === q)          return 2000
  if (t.startsWith(q)) return 1800
  if (t.includes(q))   return 1600

  // Subsequence scan: find each query char in order
  const pos: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti)
    if (idx === -1) return null   // not a subsequence → no match
    pos.push(idx)
    ti = idx + 1
  }

  let score = 200

  // Consecutive-run bonus: tightly-grouped chars score much higher
  let run = 1
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] === pos[i - 1] + 1) {
      score += 20 + (++run) * 10
    } else {
      run = 1
    }
  }

  // Word-boundary bonus: match starts at a word start
  for (const p of pos) {
    if (p === 0 || /[\s\-_.]/.test(t[p - 1])) score += 20
  }

  // Penalise late first-match (earlier = more relevant)
  score -= pos[0] * 4

  // Penalise wide span (tighter match = better)
  score -= pos[pos.length - 1] - pos[0]

  // Penalise long targets (shorter = more specific match)
  score -= (t.length - q.length) * 0.4

  return Math.max(score, 1)
}

// Score an app against a query across multiple fields with field weights
function scoreApp(app: Gio.AppInfo, q: string): number {
  const name = app.get_name() ?? ""
  const exec = app.get_executable() ?? ""
  const desc = app.get_description() ?? ""
  const id   = (app.get_id() ?? "").replace(/\.desktop$/, "")

  const ns = fuzzy(name, q)
  if (ns !== null) return ns * 1.5   // name is the strongest signal

  const es = fuzzy(exec, q)
  if (es !== null) return es * 1.2   // exec second

  const is = fuzzy(id, q)
  if (is !== null) return is * 1.0

  const ds = fuzzy(desc, q)
  if (ds !== null) return ds * 0.6   // description last

  return 0
}

// Materializa un `Gio.AppInfo` ya puntuado en una fila de resultados. Solo se
// llama para las 9 mejores del ganador, así el coste (icono, commandline) no se
// paga por app ni por el handler perdedor.
function crearResultado(a: Gio.AppInfo): SearchResult {
  return {
    id: a.get_id() ?? a.get_name() ?? Math.random().toString(),
    title: a.get_name() ?? "",
    subtitle: a.get_description() ?? undefined,
    icon: a.get_icon(),
    meta: {
      exec: a.get_commandline() ?? "",
      appId: a.get_id() ?? "",
      execName: a.get_executable() ?? "",
      // Lo consume el panel derecho para saber qué paquete posee la app.
      desktopFile: (a as any).get_filename?.() ?? "",
    },
    action: () => {
      const cmd = (a.get_commandline() ?? "").replace(/%[fFuUdDnNickvmb]/g, "").trim()
      if (cmd) launchApp(cmd)
    },
  }
}

export const appsHandler: SearchHandler = {
  id: "apps",
  defaultFor: ["inicio"],
  inlineFor: [],

  // Una sola pasada: puntúa las apps, guarda el orden y deja `build` listo para
  // materializar solo el top N si este handler entra en la mezcla. Con una sola
  // letra busca igual (es un lanzador): baja la confianza, no los resultados.
  match(query: string): HandlerMatch {
    const q = query.toLowerCase()

    const ranked = getAppInfos()
      .map(a => ({ a, s: scoreApp(a, q) }))
      .filter(({ s }) => s > 0)
      .sort((x, y) => y.s - x.s)

    const corta = q.length < 2
    const score = ranked.length > 0 ? (corta ? 0.05 : 0.75) : (corta ? 0 : 0.10)

    return {
      score,
      build: () => ranked.slice(0, MAX_RESULTADOS).map(({ a }) => crearResultado(a)),
    }
  },
}
