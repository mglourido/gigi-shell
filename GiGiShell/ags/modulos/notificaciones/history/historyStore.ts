// modulos/notificaciones/history/historyStore.ts
// Persistent, reactive history of unique notification types (capped). Excludes anything a rule
// matched. Populated from ingest; re-cleaned when the settings panel opens.
import { createState } from "ags"
import GLib from "gi://GLib"
import type { StoredNotification } from "../store.ts"
import { notifSettingsVisible } from "../store.ts"
import { cargarJson, crearGuardadoJsonProgramado } from "../estado/persistencia.ts"
import { ruleIndex } from "../rules/rulesStore.ts"
import { evaluate } from "../rules/engine.ts"
import { computeDedupKey } from "../rules/dedup.ts"
import {
  type HistoryEntry, type HistoryInput, HISTORY_CAP,
  upsertEntry, collapseDuplicates, trimByRecency, sortByRecency, applyRuleExclusion,
} from "./historyLogic.ts"

const HISTORY_PATH = `${GLib.get_user_config_dir()}/gigios/notif-history.json`

const historialCargado = cargarJson<{ entries?: HistoryEntry[] }>(HISTORY_PATH, {}, "history")
// Se ordena AL CARGAR, no solo al escribir: los ficheros que dejaron las versiones anteriores
// solo quedaban ordenados de rebote al desbordar el tope, así que por debajo de él se leían del
// revés (lo más viejo arriba). `upsertEntry` mantiene el orden a partir de aquí.
export const [historyEntries, setHistoryEntries] = createState<HistoryEntry[]>(
  sortByRecency(historialCargado.entries ?? []),
)

const scheduleSave = crearGuardadoJsonProgramado(
  HISTORY_PATH,
  "history",
  1500,
  () => ({ entries: historyEntries.get() }),
)

/** Record an incoming (already-stored) notification into history. No-op if a rule matched it. */
export function recordNotification(n: StoredNotification): void {
  const input: HistoryInput = {
    // History keeps its OWN dedup key (app + summary + body) so notifications that share an
    // app+summary but differ in body show as distinct entries — independent of the rule
    // engine's dedupKey (which defaults to app+summary for the active list).
    dedupKey: computeDedupKey("app+summary+body", {
      appName: n.appName, summary: n.summary, body: n.body, urgency: n.urgency,
    }),
    app: n.appName,
    summary: n.summary,
    body: n.body,
    appIcon: n.appIcon,
    matchedRulesCount: n.meta.matchedRules.length,
  }
  const prev = historyEntries.get()
  const next = upsertEntry(prev, input, Date.now(), HISTORY_CAP)
  if (next !== prev) {
    setHistoryEntries(next)
    scheduleSave()
  }
}

/** Maintenance pass: collapse dups, drop anything now covered by a rule, trim to cap. */
export function cleanHistory(): void {
  const now = Date.now()
  const idx = ruleIndex.get()
  const matchesAnyRule = (e: HistoryEntry): boolean =>
    evaluate({ appName: e.app, summary: e.summary, body: e.sampleBody, urgency: 1 }, idx, now).meta.matchedRules.length > 0
  let entries = collapseDuplicates(historyEntries.get())
  entries = applyRuleExclusion(entries, matchesAnyRule)
  entries = trimByRecency(entries, HISTORY_CAP)
  setHistoryEntries(sortByRecency(entries))
  scheduleSave()
}

/** Vacía «Detectadas» entera. Solo toca ESTE fichero (`notif-history.json`): ni las
 *  notificaciones del panel (`notifications.json`), ni las reglas, ni la configuración de los
 *  avisos del sistema (`notif-sistema.json`) — que además nunca están aquí, porque el catálogo
 *  les genera una regla a todos y el historial solo indexa lo que NO casa con ninguna. */
export function clearHistory(): void {
  if (historyEntries.get().length === 0) return
  setHistoryEntries([])
  scheduleSave()
}

// Re-clean whenever the settings panel opens.
//
// OJO: esto cubre SOLO la ventana propia (el engranaje de la cabecera del panel de
// notificaciones). La misma pestaña «Detectadas» se abre también desde Ajustes > Notificaciones,
// que va por `settingsPanelVisible` y no dispara esto — por eso `HistoryTab` llama a
// `cleanHistory()` al montarse y al volver del editor. Sin ese barrido la pestaña enseña
// entradas que YA casan con una regla, empezando por la que acabas de crear desde ahí mismo,
// que es exactamente lo que la pestaña promete no enseñar.
notifSettingsVisible.subscribe(() => { if (notifSettingsVisible.get()) cleanHistory() })
