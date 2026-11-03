import { createState } from "ags"
import GLib from "gi://GLib"
import type { NotifMeta } from "../rules/types.ts"
import type { AppSettings, StoredNotification } from "./modelos.ts"
import { cargarJson, crearGuardadoJsonProgramado, saveJsonAsync } from "./persistencia.ts"
import { selectedIds, setSelectedIds } from "./panel.ts"
import { sanearMapaObjetos, sanearNotificaciones } from "./saneado.ts"

interface DatosAlmacen {
  notifications?: StoredNotification[]
  appSettings?: Record<string, AppSettings>
}

const RUTA_ALMACEN = `${GLib.get_user_config_dir()}/gigishell/notifications.json`
export const NOTIF_CAP = 200

const META_PREDETERMINADA: NotifMeta = {
  lifetime: "persistent",
  clearOnBoot: false,
  noHistory: false,
  muteAudio: false,
  dontShow: false,
  dedupKey: "",
  conditions: [],
  matchedRules: [],
}

function completarMeta(notificacion: StoredNotification): StoredNotification {
  if (notificacion.meta) return notificacion
  return {
    ...notificacion,
    meta: {
      ...META_PREDETERMINADA,
      dedupKey: `${(notificacion.appName ?? "").toLowerCase()} ${(notificacion.summary ?? "").toLowerCase()}`,
    },
  }
}

const datosIniciales = cargarJson<DatosAlmacen>(RUTA_ALMACEN, {}, "store")
export const [notifications, setNotifications] = createState<StoredNotification[]>(
  (sanearNotificaciones(datosIniciales.notifications, Date.now()) as unknown as StoredNotification[])
    .map(completarMeta),
)
export const [appSettings, setAppSettings] = createState<Record<string, AppSettings>>(
  sanearMapaObjetos(datosIniciales.appSettings) as unknown as Record<string, AppSettings>,
)

function datosAlmacen(): DatosAlmacen {
  return {
    notifications: notifications.get().slice(-NOTIF_CAP),
    appSettings: appSettings.get(),
  }
}

export const scheduleStoreSave = crearGuardadoJsonProgramado(RUTA_ALMACEN, "store", 1500, datosAlmacen)

/** Guarda ya, sin el retardo, y avisa cuando está en disco. Lo usa `procesamiento/drenado.ts`, que
 *  no puede borrar las pendientes del respaldo hasta que están a salvo aquí. Si queda un guardado
 *  programado, escribirá lo mismo (o algo más nuevo) después: no se pisa nada. */
export function guardarAlmacenYa(alTerminar: (ok: boolean) => void): void {
  saveJsonAsync(RUTA_ALMACEN, datosAlmacen(), "store", alTerminar)
}

export function getAppsWithNotifs(): string[] {
  return ["all", ...new Set(notifications.get().map((notificacion) => notificacion.appName))]
}

export function markRead(id: number): void {
  setNotifications(notifications.get().map((notificacion) =>
    notificacion.id === id ? { ...notificacion, read: true } : notificacion))
  scheduleStoreSave()
}

export function markAllRead(): void {
  setNotifications(notifications.get().map((notificacion) => ({ ...notificacion, read: true })))
  scheduleStoreSave()
}

export function removeNotification(id: number): void {
  setNotifications(notifications.get().filter((notificacion) => notificacion.id !== id))
  const seleccion = new Set(selectedIds.get())
  seleccion.delete(id)
  setSelectedIds(seleccion)
  scheduleStoreSave()
}

export function clearAllNotifications(): void {
  setNotifications([])
  setSelectedIds(new Set())
  scheduleStoreSave()
}

export function clearSelected(): void {
  const seleccion = selectedIds.get()
  setNotifications(notifications.get().filter((notificacion) => !seleccion.has(notificacion.id)))
  setSelectedIds(new Set())
  scheduleStoreSave()
}

export function updateAppSettings(appName: string, patch: Partial<AppSettings>): void {
  const actuales = appSettings.get()
  const existentes = actuales[appName] ?? {
    muted: false,
    importance: "normal",
    showOnLockscreen: true,
  }
  setAppSettings({ ...actuales, [appName]: { ...existentes, ...patch } })
  scheduleStoreSave()
}

export function replaceNotifications(next: StoredNotification[]): void {
  setNotifications(next)
  scheduleStoreSave()
}
