// Pure predicate for the automatic "Do Not Disturb" watcher. No GTK/GLib
// imports — unit-tested with node:test.
//
// DND should be silenced when either:
//   1. a running client is a game (reuses the games heuristic in
//      servicios/juegos/deteccion.ts), or
//   2. a running client is fullscreen AND its class matches one of the
//      user-configured "fullscreen apps" (e.g. mpv, a browser watching a movie).
//
// The configured-apps path deliberately bypasses the game heuristic's
// fullscreen blocklist: adding "mpv" here means a fullscreen movie silences
// notifications even though mpv is not a game.
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
 * True if any client on the focused workspace warrants auto-DND (a game, or a
 * configured fullscreen app). Pass `activeWorkspaceId` to restrict evaluation to
 * that workspace; omit it (or pass null) to consider every client.
 *
 * `isGameFn` existe para que el watcher pueda pasar `isGameClient` (la versión que
 * consulta la entrada .desktop y /proc, y que por eso no puede vivir en un módulo
 * puro). Por defecto cae en `isGame` a secas, que es lo que usan los tests.
 */
export function shouldSilence(
  clients: readonly (DndClientLike | null | undefined)[] | null | undefined,
  apps: readonly string[],
  activeWorkspaceId?: number | null,
  isGameFn: (c: DndClientLike | null | undefined) => boolean = esJuego,
): boolean {
  if (!clients) return false
  for (const c of clients) {
    if (!onActiveWorkspace(c, activeWorkspaceId)) continue
    if (isGameFn(c)) return true
    if (matchesFullscreenApp(c, apps)) return true
  }
  return false
}
