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
  build: () => SearchResult[]
}

export interface SearchHandler {
  readonly id: string
  /** Sections where this handler is used by default (gets a score boost) */
  readonly defaultFor: readonly SectionId[]
  /** Sections where results are shown inline — no redirect to reactive */
  readonly inlineFor: readonly SectionId[]
  match(query: string, ctx: SearchContext): HandlerMatch
}
