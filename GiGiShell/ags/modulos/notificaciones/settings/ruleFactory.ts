// modulos/notificaciones/settings/ruleFactory.ts
// Pure helpers to build and describe rules.
import type { NotifRule } from "../rules/types.ts"
import { COINCIDENCIAS } from "../rules/coincidencias.ts"
import { EFECTOS } from "../rules/efectos/index.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export function blankRule(id: string): NotifRule {
  return { id, name: textos.resumen.nuevaRegla, enabled: true, priority: 100, source: "user", match: {}, effects: {} }
}

export function ruleFromHistoryEntry(id: string, entry: { app: string; summary: string; sampleBody?: string }): NotifRule {
  const name = `${entry.app}: ${entry.summary}`.slice(0, 60)
  const match: NotifRule["match"] = {
    app: { op: "equals", value: entry.app },
    summary: { op: "contains", value: entry.summary },
  }
  // Carry the body so the rule targets this exact variant — history differentiates by body,
  // and without this a created rule would match (and hide) every body under the same app+title.
  if (entry.sampleBody) match.body = { op: "contains", value: entry.sampleBody }
  return { id, name, enabled: true, priority: 100, source: "user", match, effects: {} }
}

/** One-line human-readable summary (Spanish) for list rows. Reads like a sentence:
 *  "Si <condiciones> → <acciones>". Cada campo y cada efecto pone su propia frase (ver
 *  `rules/coincidencias.ts` y `rules/efectos/`), en el orden de sus registros. */
export function summarizeRule(rule: NotifRule): string {
  const m: string[] = []
  for (const c of COINCIDENCIAS) {
    const spec = rule.match[c.campo]
    if (spec) m.push(c.resumen(spec))
  }
  const matchStr = m.length
    ? formatearTexto(textos.resumen.coincidencias.si, { condiciones: m.join(textos.resumen.separadorCondiciones) })
    : textos.resumen.coincidencias.cualquiera

  const e: string[] = []
  const efectos = rule.effects ?? {}
  for (const def of EFECTOS) {
    if (!def.resumen) continue
    const valor = (efectos as Record<string, unknown>)[def.clave]
    if (valor === undefined) continue
    const frase = def.resumen(valor, efectos)
    if (Array.isArray(frase)) e.push(...frase)
    else if (frase) e.push(frase)
  }
  const effStr = e.length ? e.join(textos.resumen.separadorEfectos) : textos.resumen.efectos.ninguno

  return formatearTexto(textos.resumen.frase, { coincidencia: matchStr, efecto: effStr })
}
