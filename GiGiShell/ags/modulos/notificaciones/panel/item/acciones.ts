import AstalNotifd from "gi://AstalNotifd"

/** Invoca una acción si la notificación sigue viva en el daemon. */
export function invocarAccionViva(idNotificacion: number, idAccion: string): void {
  try {
    AstalNotifd.get_default().get_notification(idNotificacion)?.invoke(idAccion)
  } catch (_) {}
}
