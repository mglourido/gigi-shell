// modulos/notificaciones/rules/engine.ts
// Pure rule engine: compile rules into an app-indexed structure, then evaluate a notification.
import type { NotifRule, NotifInput, NotifMeta, EvalResult, PopupStyle } from "./types.ts"
import { matchInput } from "./match.ts"
import { computeDedupKey } from "./dedup.ts"

export interface CompiledRule {
  rule: NotifRule
  test(input: NotifInput): boolean
}

export interface RuleIndex {
  byApp: Map<string, CompiledRule[]>
  /** Reglas ancladas a un `event` exacto — el catálogo del sistema son ~100 de estas y
   *  meterlas en `rest` habría hecho que CADA notificación las probara todas una a una.
   *  Con el índice, una notificación sin identidad ni siquiera las mira. */
  byEvent: Map<string, CompiledRule[]>
  rest: CompiledRule[]
  candidatesFor(appName: string, event?: string): CompiledRule[]
}

export function compileRules(rules: NotifRule[]): RuleIndex {
  const byApp = new Map<string, CompiledRule[]>()
  const byEvent = new Map<string, CompiledRule[]>()
  const rest: CompiledRule[] = []
  const indexar = (mapa: Map<string, CompiledRule[]>, clave: string, compiled: CompiledRule) => {
    const arr = mapa.get(clave) ?? []
    arr.push(compiled)
    mapa.set(clave, arr)
  }
  for (const rule of rules) {
    if (!rule.enabled) continue
    const compiled: CompiledRule = { rule, test: (input) => matchInput(rule.match, input) }
    const app = rule.match.app
    const event = rule.match.event
    // El `event` va PRIMERO: es la clave más selectiva que hay (identifica un único aviso),
    // mientras que `app` agrupa decenas. Una regla con los dos se indexa por `event` y su
    // `test` sigue comprobando el `app` igual, así que no se pierde ninguna condición.
    if (event && event.op === "equals") {
      indexar(byEvent, event.ci !== false ? event.value.toLowerCase() : event.value, compiled)
    } else if (app && app.op === "equals") {
      indexar(byApp, app.ci !== false ? app.value.toLowerCase() : app.value, compiled)
    } else {
      rest.push(compiled)
    }
  }
  return {
    byApp,
    byEvent,
    rest,
    candidatesFor(appName: string, event?: string) {
      const porEvento = event ? (byEvent.get(event.toLowerCase()) ?? []) : []
      const porApp = byApp.get(appName.toLowerCase()) ?? []
      return [...porEvento, ...porApp, ...rest]
    },
  }
}

const DEFAULT_DEDUP = "app+summary" as const

export function evaluate(input: NotifInput, index: RuleIndex, now: number): EvalResult {
  // Matched rules, highest priority first. stopOnMatch cuts the rest.
  const matched: NotifRule[] = []
  const candidates = index.candidatesFor(input.appName, input.event)
    .filter(c => c.test(input))
    .sort((a, b) => b.rule.priority - a.rule.priority)
  for (const c of candidates) {
    matched.push(c.rule)
    if (c.rule.stopOnMatch) break
  }

  // Fold effects: iterate high→low, only set a field if not already set (higher priority wins).
  let lifetime: NotifMeta["lifetime"] | undefined
  let ttlMs: number | undefined
  let popupMs: number | undefined
  let clearOnBoot: boolean | undefined
  let noHistory: boolean | undefined
  let muteAudio: boolean | undefined
  let dontShow: boolean | undefined
  let soundFile: string | undefined
  let suppress: boolean | undefined
  let dedupSpec: NotifRule["effects"]["dedupKey"] | undefined
  let rewriteAppName: string | undefined
  let rewriteSummary: string | undefined
  let rewriteBody: string | undefined
  let color: string | undefined
  let style: PopupStyle | undefined
  const conditions = new Set<string>()

  const setOnce = <T>(cur: T | undefined, val: T | undefined): T | undefined =>
    cur !== undefined ? cur : val

  for (const r of matched) {
    const e = r.effects
    lifetime    = setOnce(lifetime, e.lifetime)
    ttlMs       = setOnce(ttlMs, e.ttlMs)
    popupMs     = setOnce(popupMs, e.popupMs)
    clearOnBoot = setOnce(clearOnBoot, e.clearOnBoot)
    noHistory   = setOnce(noHistory, e.noHistory)
    muteAudio   = setOnce(muteAudio, e.muteAudio)
    dontShow    = setOnce(dontShow, e.dontShow)
    soundFile   = setOnce(soundFile, e.soundFile)
    suppress    = setOnce(suppress, e.suppress)
    dedupSpec      = setOnce(dedupSpec, e.dedupKey)
    rewriteAppName = setOnce(rewriteAppName, r.effects.rewrite?.appName)
    rewriteSummary = setOnce(rewriteSummary, r.effects.rewrite?.summary)
    rewriteBody    = setOnce(rewriteBody, r.effects.rewrite?.body)
    color       = setOnce(color, e.color)
    style       = setOnce(style, e.style)
    for (const cond of e.conditions ?? []) conditions.add(cond)
  }

  const finalLifetime = lifetime ?? "persistent"
  const finalClearOnBoot = (clearOnBoot ?? false) || finalLifetime === "clear-on-boot"
  const meta: NotifMeta = {
    lifetime: finalLifetime,
    clearOnBoot: finalClearOnBoot,
    noHistory: noHistory ?? false,
    muteAudio: muteAudio ?? false,
    dontShow: dontShow ?? false,
    dedupKey: computeDedupKey(dedupSpec ?? DEFAULT_DEDUP, input),
    conditions: [...conditions],
    matchedRules: matched.map(r => r.id),
  }
  if (color !== undefined) meta.color = color
  if (style !== undefined) meta.style = style
  if (popupMs !== undefined) meta.popupMs = popupMs
  if (finalLifetime === "timed" && ttlMs !== undefined) {
    meta.expiresAt = now + ttlMs
  }
  const result: EvalResult = { meta, suppress: suppress ?? false }
  if (soundFile !== undefined) result.soundFile = soundFile
  if (rewriteAppName !== undefined || rewriteSummary !== undefined || rewriteBody !== undefined) {
    result.rewrite = {}
    if (rewriteAppName !== undefined) result.rewrite.appName = rewriteAppName
    if (rewriteSummary !== undefined) result.rewrite.summary = rewriteSummary
    if (rewriteBody !== undefined) result.rewrite.body = rewriteBody
  }
  return result
}
