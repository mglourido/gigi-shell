// Punto de entrada del buscador de Orion: registra los handlers y expone
// `resolveSearch`. Añadir un dominio de búsqueda nuevo es: crear `handlers/x.ts`
// implementando `SearchHandler` y añadirlo a `handlers`.
import type { SectionId } from "../state"
import { resolve, type ResolveResult } from "./engine"
import type { SearchHandler } from "./types"
import { appsHandler } from "./handlers/apps"
import { keybindsHandler } from "./handlers/keybinds"

const handlers: readonly SearchHandler[] = [keybindsHandler, appsHandler]

export function resolveSearch(query: string, section: SectionId): ResolveResult {
  return resolve(handlers, query, section)
}

export type { ResolveResult }
export type { SearchResult, SearchHandler, SearchContext } from "./types"
