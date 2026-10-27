// Resuelve una búsqueda de Orion. Dos modos:
//
//  - **Inline**: si el handler más confiado para la sección actual se pinta en
//    sitio (Atajos dentro de su propia pestaña), esa sección filtra sola y no se
//    redirige a la lista reactiva.
//  - **Fusión**: en cualquier otra sección se MEZCLAN los resultados de todos
//    los handlers relevantes (apps + atajos…), intercalados, en vez de que gane
//    uno solo y oculte a los demás. El empujón +0.3 de `defaultFor` decide quién
//    encabeza la intercalación y quién gobierna la decisión inline. Un handler
//    que marca `primero` (ejecutables) no se intercala: va entero delante. Las
//    `filas` puntuadas (apps y ficheros sin prioridad) se ordenan juntas por
//    parecido y entran en la intercalación como UNA sola lista.
//
// Cada handler puntúa en UNA pasada (`match`) y devuelve un `build` perezoso;
// las filas solo se materializan para los handlers que aportan a la mezcla.

import type { SectionId } from "../state"
import type { FilaPuntuada, HandlerMatch, SearchHandler, SearchResult } from "./types"

/**
 * Tope de filas que se muestran en la lista reactiva. La lista vive dentro del
 * `Gtk.ScrolledWindow` de `NavSections`, así que lo que no entra en el viewport
 * se alcanza con rueda/touchpad y con las flechas (cada salto hace `grab_focus`,
 * y el scroll sigue al hijo enfocado). Subir este número muestra más resultados;
 * es el único sitio que hay que tocar.
 */
export const MAX_RESULTADOS = 24

export interface ResolveResult {
  inline: boolean
  results: SearchResult[]
  handlerId: string | null
}

const vacio = (): ResolveResult => ({ inline: false, results: [], handlerId: null })

// Round-robin: toma el 1.º de cada lista, luego el 2.º de cada una… hasta el
// tope. Así ninguna fuente queda hambrienta bajo el tope (24 apps no entierran
// a los atajos), y como las listas vienen ordenadas por su fuente, lo más
// relevante de cada dominio sube primero.
function intercalar(listas: SearchResult[][], tope: number): SearchResult[] {
  const salida: SearchResult[] = []
  for (let i = 0; salida.length < tope; i++) {
    let quedaAlguna = false
    for (const lista of listas) {
      if (i < lista.length) {
        salida.push(lista[i])
        quedaAlguna = true
        if (salida.length >= tope) break
      }
    }
    if (!quedaAlguna) break
  }
  return salida
}

// Junta las filas puntuadas de todos los handlers y las ordena por parecido.
// `sort` es estable: a igual similitud manda el orden de las fuentes (el
// handler más confiado primero), que en Inicio deja las apps delante.
function mezclarPorSimilitud(matches: HandlerMatch[], tope: number): SearchResult[] {
  const todas: FilaPuntuada[] = matches.flatMap(m => m.filas ?? [])
  return todas
    .sort((a, b) => b.similitud - a.similitud)
    .slice(0, tope)
    .map(f => f.crear())
}

export function resolve(
  handlers: readonly SearchHandler[],
  query: string,
  section: SectionId,
): ResolveResult {
  const q = query.trim()
  if (!q) return vacio()

  const ctx = { section }
  const evaluados = handlers.map(h => {
    const m = h.match(q, ctx)
    const boosted = m.score + (h.defaultFor.includes(section) ? 0.3 : 0)
    return { h, m, boosted }
  })

  // El más confiado decide si la sección filtra en sitio (inline).
  let lider = evaluados[0]
  for (const e of evaluados) if (e.boosted > lider.boosted) lider = e
  if (!lider || lider.boosted <= 0) return vacio()

  if (lider.h.inlineFor.includes(section)) {
    return { inline: true, results: [], handlerId: lider.h.id }
  }

  // Mezcla de todos los handlers con señal, encabezada por el de mayor puntuación.
  const fuentes = evaluados
    .filter(e => e.m.score > 0)
    .sort((a, b) => b.boosted - a.boosted)

  const delante = fuentes
    .filter(e => e.m.primero)
    .flatMap(e => e.m.build?.() ?? [])
    .slice(0, MAX_RESULTADOS)
  const tope = MAX_RESULTADOS - delante.length

  // La lista mezclada por parecido ocupa el turno del primer handler que la
  // alimenta; el resto se intercala por turnos como siempre.
  const listas: SearchResult[][] = []
  let mezclada = false
  for (const e of fuentes) {
    if (e.m.filas && !mezclada) {
      mezclada = true
      listas.push(mezclarPorSimilitud(fuentes.map(f => f.m), tope))
    }
    if (!e.m.primero && e.m.build) listas.push(e.m.build())
  }
  const results = [...delante, ...intercalar(listas, tope)]
  if (results.length === 0) return vacio()

  return { inline: false, results, handlerId: fuentes[0].h.id }
}
