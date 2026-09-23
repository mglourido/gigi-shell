// modulos/notificaciones/settings/ruleFactory.ts
// Pure helpers to build and describe rules.
import type { NotifRule, StringMatch } from "../rules/types.ts"
import { formatDuration } from "../rules/duration.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

const OP_TXT: Record<StringMatch["op"], string> = {
  contains: textos.resumen.operadores.contiene,
  equals: textos.resumen.operadores.igual,
  regex: textos.resumen.operadores.expresionRegular,
}
const LIFE_TXT: Record<string, string> = {
  flash: textos.resumen.ciclos.hastaCondicion,
  persistent: textos.resumen.ciclos.hastaSieteDias,
  "clear-on-boot": textos.resumen.ciclos.limpiarReinicio,
}
const COND_TXT: Record<string, string> = {
  "battery-resolved": textos.resumen.condiciones.bateria,
  "update-applied": textos.resumen.condiciones.actualizacion,
}

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
 *  "Si <condiciones> → <acciones>". */
export function summarizeRule(rule: NotifRule): string {
  const m: string[] = []
  if (rule.match.app) m.push(formatearTexto(textos.resumen.coincidencias.app, {
    operador: OP_TXT[rule.match.app.op], valor: rule.match.app.value,
  }))
  if (rule.match.summary) m.push(formatearTexto(textos.resumen.coincidencias.titulo, {
    operador: OP_TXT[rule.match.summary.op], valor: rule.match.summary.value,
  }))
  if (rule.match.body) m.push(formatearTexto(textos.resumen.coincidencias.cuerpo, {
    operador: OP_TXT[rule.match.body.op], valor: rule.match.body.value,
  }))
  // El id del aviso identifica UNA notificación del sistema, así que no se enseña con
  // operador ("el aviso contiene…" no aporta nada): se enseña el id, que es lo que se busca.
  if (rule.match.event) m.push(formatearTexto(textos.resumen.coincidencias.evento, {
    valor: rule.match.event.value,
  }))
  if (rule.match.source) {
    m.push(rule.match.source.op === "equals" && rule.match.source.value === "system"
      ? textos.resumen.coincidencias.origenSistema
      : formatearTexto(textos.resumen.coincidencias.origen, {
          operador: OP_TXT[rule.match.source.op], valor: rule.match.source.value,
        }))
  }
  const matchStr = m.length
    ? formatearTexto(textos.resumen.coincidencias.si, { condiciones: m.join(textos.resumen.separadorCondiciones) })
    : textos.resumen.coincidencias.cualquiera

  const e: string[] = []
  const lt = rule.effects.lifetime
  if (lt === "timed") {
    e.push(rule.effects.ttlMs
      ? formatearTexto(textos.resumen.efectos.expira, { duracion: formatDuration(rule.effects.ttlMs) })
      : textos.resumen.efectos.expiraSinDuracion)
  } else if (lt) {
    e.push(LIFE_TXT[lt] ?? lt)
  }
  if (rule.effects.popupMs) {
    e.push(formatearTexto(textos.resumen.efectos.popup, { duracion: formatDuration(rule.effects.popupMs) }))
  }
  if (rule.effects.clearOnBoot) e.push(textos.resumen.efectos.limpiarReinicio)
  if (rule.effects.suppress) e.push(textos.resumen.efectos.descartar)
  if (rule.effects.dontShow) e.push(textos.resumen.efectos.sinPopup)
  const rw = rule.effects.rewrite
  if (rw && rw.appName === "") e.push(textos.resumen.efectos.ocultarApp)
  else if (rw && rw.appName !== undefined) e.push(textos.resumen.efectos.renombrarApp)
  if (rw && (rw.summary !== undefined || rw.body !== undefined)) e.push(textos.resumen.efectos.reescribir)
  if (rule.effects.muteAudio) e.push(textos.resumen.efectos.sinAudio)
  // Del sonido se enseña solo el nombre del fichero: la ruta completa desbordaría la fila y lo
  // que identifica al audio es el nombre.
  if (rule.effects.soundFile) {
    e.push(formatearTexto(textos.resumen.efectos.sonido, {
      archivo: rule.effects.soundFile.split("/").filter(Boolean).pop() ?? rule.effects.soundFile,
    }))
  }
  if (rule.effects.color) e.push(formatearTexto(textos.resumen.efectos.color, { color: rule.effects.color }))
  if (rule.effects.style === "dunst") e.push(textos.resumen.efectos.dunst)
  else if (rule.effects.style === "default") e.push(textos.resumen.efectos.gigios)
  if (rule.effects.conditions && rule.effects.conditions.length) {
    const conditions = rule.effects.conditions
      .filter(c => c !== "superseded")
      .map(c => COND_TXT[c] ?? c)
    if (conditions.length) e.push(conditions.join(textos.resumen.separadorEfectos))
  }
  const effStr = e.length ? e.join(textos.resumen.separadorEfectos) : textos.resumen.efectos.ninguno

  return formatearTexto(textos.resumen.frase, { coincidencia: matchStr, efecto: effStr })
}
