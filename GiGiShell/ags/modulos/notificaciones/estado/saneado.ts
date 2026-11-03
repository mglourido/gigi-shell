// Saneado de lo que se lee de disco. Puro (sin GTK) y con test: `saneado.test.ts`.
//
// POR QUÉ EXISTE. Los almacenes se cargan al IMPORTAR su módulo (`almacen.ts`, `rulesStore.ts`,
// `historyStore.ts`, `sistemaStore.ts`), así que una excepción ahí no rompe una función: rompe la
// importación de `store.ts` y, con ella, el arranque entero del shell. `cargarJson` ya cubre el
// fichero ilegible o con JSON inválido, pero NO un JSON válido con otra forma — `null`, un array
// donde se esperaba objeto, una regla editada a mano sin `match`, una notificación con `meta: 3` —
// y eso es justo lo que deja un editor a medias o una versión vieja del esquema. Aquí se descarta
// la ENTRADA rota y se conserva el resto: perder una notificación es aceptable, quedarse sin
// escritorio no.

import { CAMPOS_COINCIDENCIA } from "../rules/coincidencias.ts"
import { EFECTOS, efecto } from "../rules/efectos/index.ts"
import type { DefinicionEfecto, TipoValor } from "../rules/efectos/tipos.ts"

export type Objeto = Record<string, unknown>

export function esObjeto(valor: unknown): valor is Objeto {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}

const texto = (valor: unknown, porDefecto = ""): string =>
  typeof valor === "string" ? valor : porDefecto

const numero = (valor: unknown, porDefecto: number): number =>
  typeof valor === "number" && Number.isFinite(valor) ? valor : porDefecto

const arrayDeTextos = (valor: unknown): string[] =>
  Array.isArray(valor) ? valor.filter((x): x is string => typeof x === "string") : []

/** ¿La forma del JSON leído coincide con la del valor por defecto (objeto vs array)? */
export function mismaForma(leido: unknown, porDefecto: unknown): boolean {
  if (Array.isArray(porDefecto)) return Array.isArray(leido)
  if (esObjeto(porDefecto)) return esObjeto(leido)
  return typeof leido === typeof porDefecto
}

const LIFETIMES = ["persistent", "timed", "clear-on-boot", "flash"]

/** Un valor del tipo que declara el efecto, o `undefined` si no lo es. */
function valorDelTipo(tipo: TipoValor, v: unknown): unknown {
  switch (tipo) {
    case "booleano": return v === true ? true : v === false ? false : undefined
    case "numero": return typeof v === "number" && Number.isFinite(v) ? v : undefined
    case "texto": return typeof v === "string" ? v : undefined
    case "lista-texto": return Array.isArray(v) ? arrayDeTextos(v) : undefined
    case "objeto": return esObjeto(v) ? v : undefined
    case "cualquiera": return v === null ? undefined : v
  }
}

/** Un valor de efecto limpio según su descriptor: primero el tipo (`valor`), luego el dominio
 *  (`sanear`). `undefined` = descartarlo. Si `sanear` lanza, se descarta: un descriptor con un
 *  fallo no puede tumbar la carga de un almacén. */
export function sanearValorEfecto(def: DefinicionEfecto, v: unknown): unknown {
  if (v === undefined) return undefined
  const delTipo = valorDelTipo(def.valor, v)
  if (delTipo === undefined || !def.sanear) return delTipo
  try { return def.sanear(delTipo) } catch { return undefined }
}

/** Los efectos de una regla, limpios: cada clave pasa por su descriptor y las que no están en el
 *  registro se quitan (un `suppres` mal escrito no hace nada salvo engañar al que lo lee). Lo que
 *  se descarta se anota en `descartes`, para que quien llama lo registre: descartar en silencio
 *  dejaría al usuario sin saber por qué su regla «no hace nada». */
export function sanearEfectos(valor: unknown, descartes?: string[]): Objeto {
  if (!esObjeto(valor)) return {}
  const salida: Objeto = {}
  for (const [clave, v] of Object.entries(valor)) {
    const def = efecto(clave)
    if (!def) { descartes?.push(`efecto desconocido «${clave}»`); continue }
    const limpio = sanearValorEfecto(def, v)
    if (limpio !== undefined) salida[clave] = limpio
    else if (v !== undefined) descartes?.push(`«${clave}» con valor no válido ${JSON.stringify(v)?.slice(0, 60)}`)
  }
  return salida
}

/** `meta` mínima válida. Las claves que calcula el motor se sanean aquí a mano; las que pone cada
 *  efecto (`destino: "meta"`) se sanean según el `valor` que declara en `rules/efectos/`, así un
 *  efecto nuevo queda cubierto sin tocar este fichero. */
function sanearMeta(meta: unknown, appName: string, summary: string): Objeto {
  const m = esObjeto(meta) ? meta : {}
  const saneada: Objeto = {
    ...m,
    lifetime: LIFETIMES.includes(m.lifetime as string) ? m.lifetime : "persistent",
    clearOnBoot: m.clearOnBoot === true,
    dedupKey: typeof m.dedupKey === "string"
      ? m.dedupKey
      : `${appName.toLowerCase()} ${summary.toLowerCase()}`,
    matchedRules: arrayDeTextos(m.matchedRules),
  }
  if ("expiresAt" in saneada && valorDelTipo("numero", saneada.expiresAt) === undefined) delete saneada.expiresAt
  for (const def of EFECTOS) {
    if (def.destino !== "meta") continue
    const v = sanearValorEfecto(def, m[def.clave])
    if (v !== undefined) saneada[def.clave] = v
    else if (def.porDefecto !== undefined) saneada[def.clave] = def.porDefecto
    else delete saneada[def.clave]
  }
  return saneada
}

/** Notificaciones guardadas en `notifications.json`. Sin `id` numérico no hay forma de
 *  retirarla ni de deduplicarla, así que se descarta; el resto se rellena con valores neutros. */
export function sanearNotificaciones(valor: unknown, ahora: number): Objeto[] {
  if (!Array.isArray(valor)) return []
  const salida: Objeto[] = []
  for (const n of valor) {
    if (!esObjeto(n) || typeof n.id !== "number" || !Number.isFinite(n.id)) continue
    const appName = texto(n.appName)
    const summary = texto(n.summary)
    salida.push({
      ...n,
      appName,
      appIcon: texto(n.appIcon),
      summary,
      body: texto(n.body),
      // Un `timestamp` no numérico daba NaN en la limpieza (`cleanup/schedule.ts`) y el
      // temporizador acababa programado con un retardo absurdo.
      timestamp: numero(n.timestamp, ahora),
      read: n.read === true,
      urgency: numero(n.urgency, 1),
      actions: Array.isArray(n.actions)
        ? n.actions
          .filter(esObjeto)
          .filter((a) => typeof a.id === "string")
          .map((a) => ({ id: a.id as string, label: texto(a.label, a.id as string) }))
        : [],
      meta: sanearMeta(n.meta, appName, summary),
    })
  }
  return salida
}

/** Mapa `app → ajustes`; descarta los valores que no sean objeto. */
export function sanearMapaObjetos(valor: unknown): Record<string, Objeto> {
  if (!esObjeto(valor)) return {}
  const salida: Record<string, Objeto> = {}
  for (const [clave, v] of Object.entries(valor)) if (esObjeto(v)) salida[clave] = v
  return salida
}

const OPERADORES = ["contains", "equals", "regex"]
const CAMPOS_MATCH: string[] = CAMPOS_COINCIDENCIA

/** `match` de una regla: cada campo presente tiene que ser `{op, value: string}` válido. Un campo
 *  roto se QUITA (no se arregla): una condición inventada podría casar con lo que no debía. */
function sanearMatch(valor: unknown): Objeto | null {
  if (!esObjeto(valor)) return null
  const salida: Objeto = {}
  for (const campo of CAMPOS_MATCH) {
    const spec = valor[campo]
    if (spec === undefined) continue
    if (!esObjeto(spec) || typeof spec.value !== "string" || !OPERADORES.includes(spec.op as string)) {
      return null
    }
    // Solo las tres claves que existen: lo demás iría a parar al editor y al JSON sin significado.
    salida[campo] = { op: spec.op, value: spec.value, ...(typeof spec.ci === "boolean" ? { ci: spec.ci } : {}) }
  }
  return salida
}

/** Reglas de usuario de `notif-rules.json`. Una regla con `match` roto se descarta ENTERA: quitarle
 *  solo la condición rota la haría más amplia de lo que el usuario escribió. Un EFECTO roto, en
 *  cambio, se quita solo: sin él la regla hace menos, nunca algo distinto de lo escrito. */
export function sanearReglasUsuario(valor: unknown, descartes?: string[]): Objeto[] {
  if (!Array.isArray(valor)) return []
  const salida: Objeto[] = []
  for (const r of valor) {
    if (!esObjeto(r) || typeof r.id !== "string") { descartes?.push(`regla sin id: ${JSON.stringify(r)?.slice(0, 60)}`); continue }
    const match = sanearMatch(r.match)
    if (!match) { descartes?.push(`regla «${r.id}» descartada: \`match\` no válido`); continue }
    const efectosRotos: string[] = []
    const effects = sanearEfectos(r.effects, efectosRotos)
    for (const d of efectosRotos) descartes?.push(`regla «${r.id}»: ${d}`)
    salida.push({
      id: r.id,
      name: texto(r.name, r.id),
      enabled: r.enabled !== false,
      priority: numero(r.priority, 100),
      source: "user",
      match,
      effects,
      ...(r.stopOnMatch === true ? { stopOnMatch: true } : {}),
    })
  }
  return salida
}

/** Overrides de las builtin. Se fusionan SOBRE la predefinida, así que cada campo es opcional y
 *  uno roto simplemente se quita (vuelve a valer el de fábrica). Solo pasan los campos que el
 *  editor sabe guardar: un `id` o un `source` aquí cambiarían qué regla es. */
export function sanearOverrides(valor: unknown, descartes?: string[]): Record<string, Objeto> {
  const salida: Record<string, Objeto> = {}
  for (const [id, ov] of Object.entries(sanearMapaObjetos(valor))) {
    const limpio: Objeto = {}
    if (typeof ov.name === "string") limpio.name = ov.name
    if (typeof ov.enabled === "boolean") limpio.enabled = ov.enabled
    if (typeof ov.stopOnMatch === "boolean") limpio.stopOnMatch = ov.stopOnMatch
    if (typeof ov.priority === "number" && Number.isFinite(ov.priority)) limpio.priority = ov.priority
    if ("match" in ov) {
      const match = sanearMatch(ov.match)
      if (match) limpio.match = match
      else descartes?.push(`predefinida «${id}»: \`match\` no válido (se usa el de fábrica)`)
    }
    if ("effects" in ov && !esObjeto(ov.effects)) {
      descartes?.push(`predefinida «${id}»: \`effects\` no es un objeto (se usan los de fábrica)`)
    } else if ("effects" in ov) {
      const efectosRotos: string[] = []
      limpio.effects = sanearEfectos(ov.effects, efectosRotos)
      for (const d of efectosRotos) descartes?.push(`predefinida «${id}»: ${d}`)
    }
    salida[id] = limpio
  }
  return salida
}

/** Entradas de «Detectadas» (`notif-history.json`). */
export function sanearHistorial(valor: unknown, ahora: number): Objeto[] {
  if (!Array.isArray(valor)) return []
  const salida: Objeto[] = []
  for (const e of valor) {
    if (!esObjeto(e) || typeof e.dedupKey !== "string") continue
    const lastSeen = numero(e.lastSeen, ahora)
    salida.push({
      ...e,
      app: texto(e.app),
      summary: texto(e.summary),
      sampleBody: texto(e.sampleBody),
      appIcon: texto(e.appIcon),
      count: Math.max(1, numero(e.count, 1)),
      firstSeen: numero(e.firstSeen, lastSeen),
      lastSeen,
    })
  }
  return salida
}
