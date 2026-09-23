// modulos/notificaciones/history/historyLogic.ts
// Pure history logic. No runtime imports.

/** Tope de «Detectadas». FIFO por recencia: al llegar la 101 se cae la más antigua
 *  (`trimByRecency` ordena por `lastSeen` y corta). Eran 500, que llenaba la pestaña de
 *  avisos de hace semanas entre los que había que ir a buscar el de esta mañana; y como una
 *  entrada desaparece sola en cuanto se le crea una regla, lo que sobrevive ahí es
 *  precisamente lo que aún no se ha decidido — una cola corta es lo útil. */
export const HISTORY_CAP = 100

export interface HistoryEntry {
  dedupKey: string
  app: string
  summary: string
  sampleBody: string
  appIcon: string
  count: number
  firstSeen: number
  lastSeen: number
}

// The minimal incoming shape, derived from a StoredNotification by the GJS layer.
export interface HistoryInput {
  dedupKey: string
  app: string
  summary: string
  body: string
  appIcon: string
  matchedRulesCount: number
}

/** A notification belongs in history only if NO rule matched it. */
export function shouldIndex(input: HistoryInput): boolean {
  return input.matchedRulesCount === 0
}

export function trimByRecency(entries: HistoryEntry[], cap: number): HistoryEntry[] {
  if (entries.length <= cap) return entries
  return sortByRecency(entries).slice(0, cap)
}

/** Más reciente primero. `upsertEntry` mantiene ese orden por su cuenta (inserta al frente);
 *  esto es para el barrido de mantenimiento y para enderezar ficheros guardados por versiones
 *  anteriores, que solo quedaban ordenados de rebote al desbordar el tope. */
export function sortByRecency(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.lastSeen - a.lastSeen)
}

export function upsertEntry(entries: HistoryEntry[], input: HistoryInput, now: number, cap: number): HistoryEntry[] {
  // Matched by a rule → must not be in history; drop any existing entry with this key.
  if (!shouldIndex(input)) {
    const filtered = entries.filter(e => e.dedupKey !== input.dedupKey)
    return filtered.length === entries.length ? entries : filtered
  }
  // La entrada tocada va SIEMPRE al frente. La lista se lee de más reciente a más antigua, y
  // esa propiedad tiene que sostenerse en cada upsert, no solo cuando se desborda el tope:
  // `trimByRecency` devuelve el array tal cual mientras no se pase de `cap`, así que dejar la
  // entrada en su sitio significaba (a) por debajo del tope, orden de alta = lo más viejo
  // arriba; (b) en el tope, una notificación repetida se quedaba enterrada donde se vio la
  // primera vez, que es justo la que el usuario acaba de recibir y viene a buscar.
  const idx = entries.findIndex(e => e.dedupKey === input.dedupKey)
  let next: HistoryEntry[]
  if (idx >= 0) {
    const prev = entries[idx]
    const updated: HistoryEntry = {
      ...prev,
      summary: input.summary,
      sampleBody: input.body,
      appIcon: input.appIcon || prev.appIcon,
      count: prev.count + 1,
      lastSeen: now,
    }
    next = [updated, ...entries.slice(0, idx), ...entries.slice(idx + 1)]
  } else {
    next = [{
      dedupKey: input.dedupKey,
      app: input.app,
      summary: input.summary,
      sampleBody: input.body,
      appIcon: input.appIcon,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    }, ...entries]
  }
  return trimByRecency(next, cap)
}

/** Merge entries sharing a dedupKey (used as a maintenance pass). */
export function collapseDuplicates(entries: HistoryEntry[]): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>()
  for (const e of entries) {
    const ex = map.get(e.dedupKey)
    if (!ex) { map.set(e.dedupKey, { ...e }); continue }
    const newest = e.lastSeen > ex.lastSeen ? e : ex
    map.set(e.dedupKey, {
      ...ex,
      count: ex.count + e.count,
      firstSeen: Math.min(ex.firstSeen, e.firstSeen),
      lastSeen: Math.max(ex.lastSeen, e.lastSeen),
      summary: newest.summary,
      sampleBody: newest.sampleBody,
      appIcon: ex.appIcon || e.appIcon,
    })
  }
  return [...map.values()]
}

/** Keep only entries the predicate does NOT flag as matching a rule. */
export function applyRuleExclusion(
  entries: HistoryEntry[],
  matchesAnyRule: (e: HistoryEntry) => boolean,
): HistoryEntry[] {
  return entries.filter(e => !matchesAnyRule(e))
}
