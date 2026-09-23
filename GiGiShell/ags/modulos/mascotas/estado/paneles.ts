// Geometría de los paneles de la barra que el lagarto debe esquivar (Quick
// Settings y Notificaciones, anclados al borde DERECHO; el calendario, al
// IZQUIERDO) y lógica pura de a dónde reubicarlo cuando uno se abre justo
// donde está.
//
// Los anchos están DUPLICADOS a propósito desde sus paneles reales (mismo
// patrón que BAR_HEIGHT en Lagarto.tsx) en vez de importarlos: son
// `const` locales dentro de cada componente, no exports, y desenterrarlos
// añadiría acoplamiento a cambio de nada — si alguno cambia de ancho, este
// fichero debe actualizarse a mano:
//   - QuickSettings.tsx      → PANEL_TOTAL_WIDTH
//   - NotificationPanel.tsx  → PANEL_TOTAL_WIDTH
//   - PanelCalendario.tsx    → widthRequest
export const ANCHO_QUICK_SETTINGS = 350
export const ANCHO_NOTIFICACIONES = 407
export const ANCHO_CALENDARIO = 428

// Deja al lagarto un pequeño respiro entre él y el borde del panel del que
// huye, para que no quede pegado a su sombra.
export const MARGEN_ESQUIVAR = 6

// Duración de las animaciones de apertura/cierre de Quick Settings
// (PANEL_ENTER_MS/PANEL_EXIT_MS en QuickSettings.tsx), que el lagarto imita
// al subirse a su borde inferior.
export const DURACION_ANIMACION_QS_MS = 280

export interface Empuje {
  x: number
  direccion: 1 | -1
}

/**
 * El lagarto (en `x`, ancho `anchoLagarto`) y un panel anclado al borde
 * DERECHO de una pantalla de `anchoTotal`, que ocupa `anchoPanel` px desde
 * ese borde. Si se solapan, devuelve dónde reubicarlo —justo a la izquierda
 * del panel, mirando hacia la izquierda, como si lo empujara al abrirse— y
 * el límite derecho que debe respetar mientras el panel siga abierto.
 * `null` si no hacía falta tocarlo.
 */
export function empujeDesdeDerecha(
  x: number,
  anchoLagarto: number,
  anchoTotal: number,
  anchoPanel: number,
): { empuje: Empuje | null, limiteDerecho: number } {
  const inicioPanel = anchoTotal - anchoPanel
  const limiteDerecho = Math.max(0, inicioPanel - MARGEN_ESQUIVAR - anchoLagarto)
  if (x + anchoLagarto <= inicioPanel) return { empuje: null, limiteDerecho }
  return { empuje: { x: limiteDerecho, direccion: -1 }, limiteDerecho }
}

/**
 * Mismo cálculo para un panel anclado al borde IZQUIERDO (el calendario):
 * empuja hacia la derecha, mirando hacia la derecha.
 */
export function empujeDesdeIzquierda(
  x: number,
  anchoTotal: number,
  anchoPanel: number,
): { empuje: Empuje | null, limiteIzquierdo: number } {
  const limiteIzquierdo = anchoPanel + MARGEN_ESQUIVAR
  if (x >= anchoPanel) return { empuje: null, limiteIzquierdo }
  return { empuje: { x: limiteIzquierdo, direccion: 1 }, limiteIzquierdo }
}

/**
 * Franja horizontal ([minX, maxX]) en la que puede pasearse el lagarto
 * mientras está "subido" a Quick Settings: el propio panel, con el mismo
 * margen de respiro a ambos lados.
 */
export function franjaQuickSettings(
  anchoLagarto: number,
  anchoTotal: number,
): { minX: number, maxX: number } {
  const inicioPanel = anchoTotal - ANCHO_QUICK_SETTINGS
  const minX = inicioPanel + MARGEN_ESQUIVAR
  const maxX = Math.max(minX, anchoTotal - anchoLagarto - MARGEN_ESQUIVAR)
  return { minX, maxX }
}
