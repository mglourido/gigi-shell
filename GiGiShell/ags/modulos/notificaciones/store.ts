/**
 * Fachada pública del estado de notificaciones.
 * Las responsabilidades viven en módulos separados para que los consumidores existentes no
 * tengan que conocer cómo se organiza internamente el almacén.
 */
import { appSettings } from "./estado/almacen.ts"
import type { AppSettings } from "./estado/modelos.ts"
import {
  resolveAppColor as resolverColorAplicacion,
  resolveNotifColor as resolverColorNotificacion,
} from "./estado/presentacion.ts"

export type { AppSettings, StoredNotification } from "./estado/modelos.ts"
export * from "./estado/almacen.ts"
export * from "./estado/panel.ts"
export { getAppColor, getAppIcon, getRelativeTime } from "./estado/presentacion.ts"

export function resolveNotifColor(
  notif: { appName: string; meta?: { color?: string } },
  settings: Record<string, AppSettings> = appSettings.get(),
): string {
  return resolverColorNotificacion(notif, settings)
}

export function resolveAppColor(
  appName: string,
  settings: Record<string, AppSettings> = appSettings.get(),
): string {
  return resolverColorAplicacion(appName, settings)
}
