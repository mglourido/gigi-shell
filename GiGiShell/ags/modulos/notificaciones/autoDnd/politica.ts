// Qué deja pasar el silencio automático. Módulo puro, sin GTK ni GLib.
//
// Cada condición (juego, app marcada, pantalla completa) tiene su propia política, y una
// notificación solo pasa si la permiten TODAS las condiciones activas en ese momento.

export type CondicionSilencio = "juego" | "apps" | "pantallaCompleta"
export type ModoSilencio = "todo" | "sistema" | "apps" | "nada"

export interface PoliticaSilencio {
  modo: ModoSilencio
  /** Apps permitidas con `modo: "apps"`. */
  apps: string[]
}

export type PoliticasSilencio = Record<CondicionSilencio, PoliticaSilencio>

export const CONDICIONES_SILENCIO: CondicionSilencio[] = ["juego", "apps", "pantallaCompleta"]
export const MODOS_SILENCIO: ModoSilencio[] = ["todo", "sistema", "apps", "nada"]

interface NotificacionFiltrable {
  appName: string
  source?: string
}

/** Las entradas pueden ser una clase de ventana (`com.rtosta.zapzap`) y el nombre de la
 *  notificación otra forma de lo mismo (`ZapZap`): se compara en los dos sentidos. */
export function appCoincide(nombreApp: string, entradas: readonly string[]): boolean {
  const nombre = nombreApp.toLowerCase().replace(/\s+/g, "")
  if (!nombre) return false
  return entradas.some((entrada) => {
    const limpia = entrada.trim().toLowerCase().split(".").pop() ?? ""
    return limpia !== "" && (nombre.includes(limpia) || limpia.includes(nombre))
  })
}

export function permitidaPorPolitica(
  notificacion: NotificacionFiltrable,
  politica: PoliticaSilencio,
): boolean {
  switch (politica.modo) {
    case "todo": return true
    case "nada": return false
    // Las alarmas del reloj cuentan como sistema: no son de ninguna app.
    case "sistema": return notificacion.source === "system" || notificacion.source === "alarm"
    case "apps": return appCoincide(notificacion.appName, politica.apps)
  }
}

export function permitidaEnCondiciones(
  notificacion: NotificacionFiltrable,
  activas: ReadonlySet<CondicionSilencio>,
  politicas: PoliticasSilencio,
): boolean {
  for (const condicion of activas) {
    if (!permitidaPorPolitica(notificacion, politicas[condicion])) return false
  }
  return true
}
