// modulos/notificaciones/rules/validate.ts
// Pure validation of a rule before saving. Returns a list of human-readable error messages
// (empty array = valid). Lo que se valida de cada campo y de cada efecto lo declara su entrada en
// `coincidencias.ts` y en `efectos/`: aquí solo se recorren.
import type { NotifRule } from "./types.ts"
import { COINCIDENCIAS } from "./coincidencias.ts"
import { EFECTOS } from "./efectos/index.ts"
import { esRegexPeligrosa } from "./regexSegura.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

function regexValid(value: string): boolean {
  try { new RegExp(value); return true } catch { return false }
}

export function validateRule(rule: NotifRule): string[] {
  const errors: string[] = []
  const efectos = rule.effects ?? {}

  // Una expresión regular que no compila no casaría nunca, y en silencio.
  for (const c of COINCIDENCIAS) {
    const spec = rule.match?.[c.campo]
    if (spec && spec.op === "regex" && !regexValid(spec.value)) {
      errors.push(formatearTexto(textos.validacion.expresion, { campo: c.etiquetaValidacion, valor: spec.value }))
    } else if (spec && spec.op === "regex" && esRegexPeligrosa(spec.value)) {
      // Compila, pero puede congelar el escritorio: `regexSegura.ts` la ignoraría al evaluar, así
      // que guardarla sería una regla que en silencio no hace nada.
      errors.push(formatearTexto(textos.validacion.expresionPeligrosa, { campo: c.etiquetaValidacion, valor: spec.value }))
    }
  }

  for (const def of EFECTOS) {
    if (!def.validar) continue
    errors.push(...def.validar((efectos as Record<string, unknown>)[def.clave], efectos))
  }
  return errors
}
