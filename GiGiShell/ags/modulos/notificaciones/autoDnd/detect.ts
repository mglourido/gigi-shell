// Pure predicate for the automatic "Do Not Disturb" watcher. No GTK/GLib
// imports — unit-tested with node:test.
//
// Three conditions, each with its own policy (see ./politica.ts):
//   1. a running client is a game (reuses the games heuristic in
//      servicios/juegos/deteccion.ts),
//   2. a running client is fullscreen AND its class matches one of the
//      user-configured "fullscreen apps" (e.g. mpv, a browser watching a movie), or
//   3. any other client is fullscreen.
//
// Workspace awareness: in Hyprland a game can sit fullscreen on workspace 1
// while you're browsing on workspace 2. DND must only kick in for the game you
// are actually looking at, so shouldSilence() filters clients to the focused
// workspace (see the `activeWorkspaceId` argument).

import {
  esJuego,
  PANTALLA_COMPLETA_REAL,
  type ClienteJuegoLike,
} from "../../../servicios/juegos/deteccion.ts"
import { claseCoincide } from "../../../servicios/ventanas/coincidenciaClases.ts"
import type { CondicionSilencio } from "./politica.ts"

export interface WorkspaceRef {
  id?: number | null
}

export type DndClientLike = ClienteJuegoLike & {
  workspace?: WorkspaceRef | null
}

/**
 * True if `c` lives on the currently focused workspace. When we don't know the
 * active workspace (`activeWorkspaceId` null/undefined) we don't filter — the
 * caller opted out of workspace awareness. A client whose workspace is unknown
 * is also kept, to avoid silently regressing to "never silence".
 */
function onActiveWorkspace(
  c: DndClientLike | null | undefined,
  activeWorkspaceId: number | null | undefined,
): boolean {
  if (activeWorkspaceId == null) return true
  const wsId = c?.workspace?.id
  if (wsId == null) return true
  return wsId === activeWorkspaceId
}

/** True if `c` is fullscreen and its class matches any entry in `apps`.
 *
 * `fullscreen` es un MODO (0 nada, 1 maximizado, 2 pantalla completa), no un bool:
 * con `!== 0` una ventana simplemente maximizada de la lista silenciaba las
 * notificaciones. La función se llama "fullscreen apps", así que exige el 2.
 *
 * La comparación de clases es la compartida (`servicios/ventanas/coincidenciaClases.ts`):
 * la misma que usa la pausa manual de la luz nocturna, que es la otra lista de clases que
 * escribe el usuario. Aquí solo se le añade el requisito de pantalla completa. */
export function matchesFullscreenApp(
  c: DndClientLike | null | undefined,
  apps: readonly string[],
): boolean {
  if (!c) return false
  if ((c.fullscreen ?? 0) < PANTALLA_COMPLETA_REAL) return false
  return claseCoincide(c, apps)
}

/**
 * Condiciones de silencio activas en el workspace enfocado. Cada ventana cuenta solo por la más
 * específica: un juego a pantalla completa es "juego", para que su política no la pise la
 * genérica de pantalla completa.
 *
 * `isGameFn` existe para que el watcher pueda pasar la versión que consulta la entrada .desktop
 * y /proc, que por eso no puede vivir en un módulo puro.
 */
export function condicionesActivas(
  clients: readonly (DndClientLike | null | undefined)[] | null | undefined,
  apps: readonly string[],
  activeWorkspaceId?: number | null,
  isGameFn: (c: DndClientLike | null | undefined) => boolean = esJuego,
): Set<CondicionSilencio> {
  const activas = new Set<CondicionSilencio>()
  for (const c of clients ?? []) {
    if (!c || !onActiveWorkspace(c, activeWorkspaceId)) continue
    if (isGameFn(c)) activas.add("juego")
    else if (matchesFullscreenApp(c, apps)) activas.add("apps")
    else if ((c.fullscreen ?? 0) >= PANTALLA_COMPLETA_REAL) activas.add("pantallaCompleta")
  }
  return activas
}
