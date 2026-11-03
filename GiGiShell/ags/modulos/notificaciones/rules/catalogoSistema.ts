// modulos/notificaciones/rules/catalogoSistema.ts
// Cargador del CATÁLOGO de avisos del sistema. Módulo puro, sin GTK (tiene test).
//
// LA DEFINICIÓN NO VIVE AQUÍ: vive en `ags/config/avisos-sistema.json`, una entrada por aviso y
// agrupadas por categoría, con TODO lo suyo junto — id, nombre visible, quién lo emite, efectos
// por defecto, a qué otros avisos anula y qué ids tuvo antes. Antes ese mismo aviso estaba
// repartido en cuatro sitios (este fichero, el nombre en `textos/`, `EVENTOS_QUE_ANULA` en
// `popup/logica.ts` y el emisor), y renombrar uno obligaba a tocarlos todos sin que nada avisara
// si se olvidaba alguno. Ahora añadir, renombrar o retocar un aviso es editar SOLO ese JSON (y
// el emisor, si cambia el id que manda).
//
// POR QUÉ HAY CATÁLOGO. El hint `x-gigishell-event` (ver `hypr/scripts/lib/notif.sh`) da
// identidad a cada aviso, pero eso solo sirve para CASAR: sin una lista, Ajustes no podría
// enseñar un aviso que aún no se ha disparado nunca — y ese es justo el que interesa configurar.
//
// RENOMBRAR UN ID: se cambia `id` y el viejo se añade a `antes`. Con eso (1) un emisor que aún
// mande el id viejo sigue casando —`ingesta.ts` lo traduce con `idCanonico()` antes de evaluar—,
// así que el script se puede actualizar después; y (2) la configuración del usuario guardada con
// el id viejo en `notif-sistema.json` se migra sola al cargar (`sistemaStore.ts`). Sin `antes`,
// las dos cosas se perderían en silencio.
//
// NO es la configuración del usuario: aquí van los DEFAULTS. Lo que el usuario cambia vive en
// `~/.config/gigishell/notif-sistema.json` y reemplaza los efectos de su aviso.
//
// `catalogoSistema.test.ts` comprueba la forma del JSON (`validarCatalogo`) y, además, que todo
// id que emiten `hypr/scripts/`, `eventd/` y los servicios de AGS esté catalogado.
import type { EffectSpec } from "./types.ts"
import datos from "../../../config/avisos-sistema.json" with { type: "json" }
import { sanearEfectos } from "../estado/saneado.ts"

/** El id de una categoría. Ya no es una unión literal: las categorías las define el JSON. */
export type CategoriaSistema = string

export interface EventoSistema {
  /** El hint `x-gigishell-event` que manda el emisor. Clave primaria. */
  id: string
  nombre: string
  categoria: CategoriaSistema
  /** Fichero que lo emite, para ir a la fuente sin grepear. Se enseña en la UI. */
  origen: string
  /** Efectos por defecto. Vacío = comportamiento normal (popup + panel). */
  efectos?: EffectSpec
  /** Avisos que este deja sin sentido: «Wi-Fi reconectado» retira «Wi-Fi desconectado». */
  anula: string[]
  /** Ids anteriores del mismo aviso. Siguen casando y migran la configuración guardada. */
  antes: string[]
  /** Por qué el aviso tiene los defaults que tiene. Solo documentación. */
  nota?: string
}

export interface CategoriaCatalogo {
  categoria: CategoriaSistema
  nombre: string
  eventos: EventoSistema[]
}

/** Mismo formato que valida `hypr/scripts/lib/notif.sh` (`_notif_id_valido`). */
const FORMATO_ID = /^[a-z0-9]+([.-][a-z0-9]+)*$/

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const textos = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** Lista de errores del JSON del catálogo (vacía = válido). Pura, la usa el test. */
export function validarCatalogo(crudo: unknown): string[] {
  const errores: string[] = []
  if (!esObjeto(crudo) || !Array.isArray(crudo.categorias)) return ["falta el array `categorias`"]

  const categorias = new Set<string>()
  const ids = new Map<string, string>() // id o alias → aviso que lo reclama
  const anulaciones: [string, string][] = []
  const reclamar = (id: string, duenio: string) => {
    if (!FORMATO_ID.test(id)) errores.push(`id con formato inválido: «${id}»`)
    const previo = ids.get(id)
    if (previo) errores.push(`«${id}» lo reclaman «${previo}» y «${duenio}»`)
    else ids.set(id, duenio)
  }

  for (const c of crudo.categorias) {
    if (!esObjeto(c) || typeof c.id !== "string" || typeof c.nombre !== "string" || !Array.isArray(c.avisos)) {
      errores.push(`categoría mal formada: ${JSON.stringify(c)?.slice(0, 80)}`)
      continue
    }
    if (categorias.has(c.id)) errores.push(`categoría repetida: «${c.id}»`)
    categorias.add(c.id)
    if (c.avisos.length === 0) errores.push(`categoría vacía: «${c.id}»`)

    for (const a of c.avisos) {
      if (!esObjeto(a) || typeof a.id !== "string" || typeof a.nombre !== "string" || typeof a.origen !== "string") {
        errores.push(`aviso mal formado en «${c.id}»: ${JSON.stringify(a)?.slice(0, 80)}`)
        continue
      }
      reclamar(a.id, a.id)
      for (const viejo of textos(a.antes)) reclamar(viejo, a.id)
      if (a.efectos !== undefined && !esObjeto(a.efectos)) errores.push(`«${a.id}»: \`efectos\` no es un objeto`)
      else if (a.efectos !== undefined) {
        // Un efecto mal escrito o con un valor imposible se descartaría en silencio al cargar:
        // aquí es donde tiene que saltar, en el test, antes de llegar a nadie.
        const descartes: string[] = []
        sanearEfectos(a.efectos, descartes)
        for (const d of descartes) errores.push(`«${a.id}»: ${d}`)
      }
      for (const otro of textos(a.anula)) anulaciones.push([a.id, otro])
    }
  }

  // Al final, con todos los ids ya conocidos: una anulación puede apuntar a un aviso posterior.
  // Un id ANTIGUO vale como destino (`anulaA` lo traduce): así renombrar un aviso no obliga a
  // tocar las `anula` de los demás.
  for (const [quien, aQuien] of anulaciones) {
    if (!ids.has(aQuien)) errores.push(`«${quien}» anula a «${aQuien}», que no existe`)
  }
  return errores
}

/** Lee el JSON tolerando entradas rotas: se salta la entrada, nunca tumba el módulo (lo importa
 *  el motor de reglas al arrancar). Los errores los señala `validarCatalogo` en el test. */
function cargar(crudo: unknown): CategoriaCatalogo[] {
  if (!esObjeto(crudo) || !Array.isArray(crudo.categorias)) return []
  const vistos = new Set<string>()
  const salida: CategoriaCatalogo[] = []
  for (const c of crudo.categorias) {
    if (!esObjeto(c) || typeof c.id !== "string" || !Array.isArray(c.avisos)) continue
    const eventos: EventoSistema[] = []
    for (const a of c.avisos) {
      if (!esObjeto(a) || typeof a.id !== "string" || vistos.has(a.id)) continue
      vistos.add(a.id)
      eventos.push({
        id: a.id,
        // Sin nombre se cae al id: feo pero legible, nunca una fila vacía.
        nombre: typeof a.nombre === "string" && a.nombre ? a.nombre : a.id,
        categoria: c.id,
        origen: typeof a.origen === "string" ? a.origen : "",
        ...(esObjeto(a.efectos) ? { efectos: sanearEfectos(a.efectos) as EffectSpec } : {}),
        anula: textos(a.anula),
        antes: textos(a.antes),
        ...(typeof a.nota === "string" ? { nota: a.nota } : {}),
      })
    }
    if (eventos.length > 0) {
      salida.push({ categoria: c.id, nombre: typeof c.nombre === "string" ? c.nombre : c.id, eventos })
    }
  }
  return salida
}

const GRUPOS = cargar(datos)

/** El orden del JSON ES el orden en pantalla, de lo que más importa vigilar a lo más accesorio. */
export const CATEGORIAS_SISTEMA: CategoriaSistema[] = GRUPOS.map(g => g.categoria)

export const CATALOGO_SISTEMA: EventoSistema[] = GRUPOS.flatMap(g => g.eventos)

const PORID = new Map(CATALOGO_SISTEMA.map(e => [e.id, e]))
/** Id antiguo → id actual. Un alias nunca pisa a un id vigente. */
const ALIAS = new Map<string, string>()
for (const e of CATALOGO_SISTEMA) {
  for (const viejo of e.antes) if (!PORID.has(viejo) && !ALIAS.has(viejo)) ALIAS.set(viejo, e.id)
}

/** El id vigente de un aviso: traduce un id de `antes` y deja igual todo lo demás (incluidos
 *  los ids que no están catalogados, que siguen casando con reglas escritas a mano). */
export function idCanonico(id: string): string {
  return ALIAS.get(id) ?? id
}

export function eventoSistema(id: string): EventoSistema | undefined {
  return PORID.get(idCanonico(id))
}

/** Avisos que `id` deja sin sentido (ya en su id vigente). */
export function anulaA(id: string): string[] {
  return eventoSistema(id)?.anula.map(idCanonico) ?? []
}

/** Pares `[id antiguo, id vigente]`, para migrar configuración guardada. */
export function aliasDelCatalogo(): [string, string][] {
  return [...ALIAS.entries()]
}

/** Catálogo agrupado y en el orden del JSON. Las categorías vacías no salen. */
export function catalogoPorCategoria(): CategoriaCatalogo[] {
  return GRUPOS
}
