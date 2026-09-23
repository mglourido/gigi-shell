// modulos/notificaciones/rules/validate.ts
// Pure validation of a rule before saving. Returns a list of human-readable error messages
// (empty array = valid). No imports beyond types.
import type { NotifRule, StringMatch } from "./types.ts"
import { POPUP_STYLES } from "./types.ts"
import { isValidHex } from "./color.ts"
import { esRuta } from "../sonido/decision.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

function regexValid(value: string): boolean {
  try { new RegExp(value); return true } catch { return false }
}

export function validateRule(rule: NotifRule): string[] {
  const errors: string[] = []
  const e = rule.effects

  // A "timed" rule needs a positive duration.
  if (e.lifetime === "timed" && !(typeof e.ttlMs === "number" && e.ttlMs > 0)) {
    errors.push(textos.validacion.duracion)
  }

  // Una duración de popup, si se indica, tiene que ser un número positivo: el campo del
  // editor deja `undefined` cuando no se entiende lo tecleado, así que un valor presente y
  // no válido solo puede venir del JSON editado a mano.
  if (e.popupMs !== undefined && !(typeof e.popupMs === "number" && e.popupMs > 0)) {
    errors.push(textos.validacion.duracionPopup)
  }

  // Regex match fields must compile.
  const fields: [string, StringMatch | undefined][] = [
    [textos.validacion.campos.aplicacion, rule.match.app],
    [textos.validacion.campos.titulo, rule.match.summary],
    [textos.validacion.campos.cuerpo, rule.match.body],
    [textos.validacion.campos.origen, rule.match.source],
    [textos.validacion.campos.evento, rule.match.event],
  ]
  for (const [label, sm] of fields) {
    if (sm && sm.op === "regex" && !regexValid(sm.value)) {
      errors.push(formatearTexto(textos.validacion.expresion, { campo: label, valor: sm.value }))
    }
  }

  // El sonido propio tiene que ser una RUTA, absoluta o desde `~`. Se comprueba la forma y no
  // que el fichero exista: un audio en un disco que ahora no está montado sigue siendo una regla
  // válida, y bloquear el guardado por eso obligaría a borrar la configuración para poder salir.
  // El editor avisa aparte de que la ruta no existe, que es donde ese aviso sirve de algo.
  if (e.soundFile !== undefined && !esRuta(e.soundFile.trim())) {
    errors.push(formatearTexto(textos.validacion.sonido, { valor: e.soundFile }))
  }

  // A color effect, if present, must be a valid hex.
  if (e.color !== undefined && !isValidHex(e.color)) {
    errors.push(formatearTexto(textos.validacion.color, { valor: e.color }))
  }

  // A style effect, if present, must be a known skin (el JSON de reglas es editable a mano).
  if (e.style !== undefined && !POPUP_STYLES.includes(e.style)) {
    errors.push(formatearTexto(textos.validacion.estilo, {
      valor: e.style,
      opciones: POPUP_STYLES.join(textos.validacion.separadorOpciones),
    }))
  }

  return errors
}
