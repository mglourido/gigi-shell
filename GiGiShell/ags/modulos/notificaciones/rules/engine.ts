// modulos/notificaciones/rules/engine.ts
// Pure rule engine: compile rules into an app-indexed structure, then evaluate a notification.
import type { EffectSpec, NotifRule, NotifInput, NotifMeta, EvalResult } from "./types.ts"
import { EFECTOS } from "./efectos/index.ts"
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
    // Una regla rota no puede tumbar el índice entero: sin índice no se ingiere nada.
    if (!rule || !rule.enabled || typeof rule.match !== "object" || rule.match === null) continue
    const compiled: CompiledRule = { rule, test: (input) => matchInput(rule.match, input) }
    const app = rule.match.app
    const event = rule.match.event
    // El `event` va PRIMERO: es la clave más selectiva que hay (identifica un único aviso),
    // mientras que `app` agrupa decenas. Una regla con los dos se indexa por `event` y su
    // `test` sigue comprobando el `app` igual, así que no se pierde ninguna condición.
    if (event && event.op === "equals" && typeof event.value === "string") {
      indexar(byEvent, event.ci !== false ? event.value.toLowerCase() : event.value, compiled)
    } else if (app && app.op === "equals" && typeof app.value === "string") {
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
      // Las reglas ci=false se indexan con el valor original; las demás, en minúsculas.
      // Consultar ambas claves evita descartar una regla exacta antes de ejecutar su matcher.
      const porEvento = event
        ? [...(byEvent.get(event) ?? []), ...(byEvent.get(event.toLowerCase()) ?? [])]
        : []
      const porApp = [...(byApp.get(appName) ?? []), ...(byApp.get(appName.toLowerCase()) ?? [])]
      return [...new Set([...porEvento, ...porApp, ...rest])]
    },
  }
}

const DEFAULT_DEDUP = "app+summary" as const

/** Combina los efectos de las reglas que casan, de mayor a menor prioridad, según la
 *  `combinar` de cada efecto del registro (`efectos/`). El motor no nombra ningún efecto
 *  aquí: uno nuevo se pliega solo. */
function plegarEfectos(reglas: NotifRule[]): Record<string, unknown> {
  const plegado: Record<string, unknown> = {}
  for (const def of EFECTOS) {
    const modo = def.combinar ?? "prioridad"
    if (modo === "union") {
      const todos = new Set<unknown>()
      for (const r of reglas) {
        const v = (r.effects as Record<string, unknown> | undefined)?.[def.clave]
        if (Array.isArray(v)) for (const x of v) todos.add(x)
      }
      if (todos.size) plegado[def.clave] = [...todos]
    } else if (modo === "por-campo") {
      const campos: Record<string, unknown> = {}
      for (const r of reglas) {
        const v = (r.effects as Record<string, unknown> | undefined)?.[def.clave]
        if (!v || typeof v !== "object") continue
        for (const [k, x] of Object.entries(v)) if (campos[k] === undefined && x !== undefined) campos[k] = x
      }
      if (Object.keys(campos).length) plegado[def.clave] = campos
    } else {
      for (const r of reglas) {
        const v = (r.effects as Record<string, unknown> | undefined)?.[def.clave]
        if (v !== undefined) { plegado[def.clave] = v; break }
      }
    }
  }
  return plegado
}

export function evaluate(input: NotifInput, index: RuleIndex, now: number): EvalResult {
  // Matched rules, highest priority first. stopOnMatch cuts the rest.
  const matched: NotifRule[] = []
  const candidates = index.candidatesFor(input.appName, input.event)
    .filter(c => c.test(input))
    .sort((a, b) => (Number(b.rule.priority) || 0) - (Number(a.rule.priority) || 0))
  for (const c of candidates) {
    matched.push(c.rule)
    if (c.rule.stopOnMatch) break
  }

  const e = plegarEfectos(matched) as EffectSpec

  // Lo que calcula el propio motor (efectos con destino `motor`).
  const lifetime = e.lifetime ?? "persistent"
  const meta: NotifMeta = {
    lifetime,
    clearOnBoot: (e.clearOnBoot ?? false) || lifetime === "clear-on-boot",
    noHistory: false,
    muteAudio: false,
    dontShow: false,
    dedupKey: computeDedupKey(e.dedupKey ?? DEFAULT_DEDUP, input),
    conditions: [],
    matchedRules: matched.map(r => r.id),
  }
  if (lifetime === "timed" && e.ttlMs !== undefined) meta.expiresAt = now + e.ttlMs

  // El resto lo reparte el registro: cada efecto dice si va a la meta o al resultado.
  const result: EvalResult = { meta, suppress: false }
  for (const def of EFECTOS) {
    if (def.destino === "motor") continue
    const v = (e as Record<string, unknown>)[def.clave] ?? def.porDefecto
    if (v === undefined) continue
    const destino = (def.destino === "meta" ? meta : result) as unknown as Record<string, unknown>
    destino[def.clave] = Array.isArray(v) ? [...v] : v
  }
  return result
}
