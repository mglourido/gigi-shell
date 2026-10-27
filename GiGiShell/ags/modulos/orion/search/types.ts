// Contrato entre el motor de búsqueda (`engine.ts`) y sus handlers
// (`handlers/*.ts`). Un handler nuevo solo necesita implementar
// `SearchHandler` y registrarse en `index.ts`.

import type Gio from "gi://Gio"
import type { SectionId } from "../state"

export interface SearchResult {
  id: string
  title: string
  subtitle?: string
  icon?: Gio.Icon | null
  iconName?: string
  /** If set, ReactiveSection navigates here instead of closing the panel */
  navigateTo?: SectionId
  /** Extra metadata passed to result renderers (e.g. app exec, app id) */
  meta?: Record<string, string>
  action: () => void
}

export interface SearchContext {
  section: SectionId
}

/**
 * Resultado de evaluar un handler en UNA sola pasada. `score` es la relevancia
 * (mayor gana); `build` materializa las filas y solo lo llama el motor para el
 * handler ganador — así el perdedor nunca construye objetos `SearchResult`
 * (que en apps tocan Gio: icono, commandline…). El handler cierra sobre lo que
 * ya escaneó al puntuar, de modo que `build` no vuelve a recorrer el corpus.
 */
export interface HandlerMatch {
  score: number
  build?: () => SearchResult[]
  /**
   * Las filas de `build` van TODAS antes de la intercalación del resto, en vez
   * de repartirse por turnos. Lo usa el handler de ejecutables: quien teclea
   * ".jar" busca ese fichero, y las apps parecidas van detrás.
   */
  primero?: boolean
  /**
   * Filas que compiten POR PARECIDO con las de otros handlers en vez de por
   * turnos: el motor junta las `filas` de todos, las ordena por `similitud` y
   * esa lista única entra en la intercalación. Así un fichero que se llama
   * exactamente como lo tecleado sale antes que una app que solo lo contiene,
   * y al revés. `similitud` va en la escala de `fuzzy()` (2000 = idéntico).
   */
  filas?: FilaPuntuada[]
}

export interface FilaPuntuada {
  similitud: number
  crear: () => SearchResult
}

export interface SearchHandler {
  readonly id: string
  /** Sections where this handler is used by default (gets a score boost) */
  readonly defaultFor: readonly SectionId[]
  /** Sections where results are shown inline — no redirect to reactive */
  readonly inlineFor: readonly SectionId[]
  match(query: string, ctx: SearchContext): HandlerMatch
}
