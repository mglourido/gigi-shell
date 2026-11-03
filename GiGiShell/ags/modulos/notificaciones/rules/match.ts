// modulos/notificaciones/rules/match.ts
// Pure matchers for the rule engine. Los campos que existen los define `coincidencias.ts`.
import type { StringMatch, MatchSpec, NotifInput } from "./types.ts"
import { COINCIDENCIAS } from "./coincidencias.ts"
import { MAXIMO_SUJETO_REGEX, regexSegura } from "./regexSegura.ts"

export function matchString(spec: StringMatch, subject: string): boolean {
  // Las reglas vienen de un JSON editable a mano: un `value` que no sea texto no casa.
  if (typeof spec?.value !== "string" || typeof subject !== "string") return false
  const ci = spec.ci !== false
  const s = ci ? subject.toLowerCase() : subject
  const v = ci ? spec.value.toLowerCase() : spec.value
  switch (spec.op) {
    case "contains": return s.includes(v)
    case "equals":   return s === v
    case "regex": {
      // Compilada una vez y nunca si es de las que congelan; el texto, acotado (`regexSegura.ts`).
      const re = regexSegura(spec.value, ci)
      return re ? re.test(subject.slice(0, MAXIMO_SUJETO_REGEX)) : false
    }
  }
}

export function matchInput(spec: MatchSpec, input: NotifInput): boolean {
  // Todos los campos rellenados tienen que casar. Un campo sin dato en la notificación compara
  // contra "", que no casa con `equals "system"` ni con un `contains` no vacío: una regla que
  // exija `event` o `source` NO casa con quien no los declara.
  for (const c of COINCIDENCIAS) {
    const condicion = spec[c.campo]
    if (condicion && !matchString(condicion, c.sujeto(input))) return false
  }
  return true
}
