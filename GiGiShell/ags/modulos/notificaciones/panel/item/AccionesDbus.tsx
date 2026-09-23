import { invocarAccionViva } from "./acciones"
import { obtenerAccionesVisibles } from "../../popup/logica"
import { markRead, type StoredNotification } from "../../store"

/** Acciones explícitas de la notificación, limitadas a tres botones. */
export default function AccionesDbusItemNotificacion({
  notificacion,
}: { notificacion: StoredNotification }) {
  const accionesVisibles = obtenerAccionesVisibles(notificacion)
  if (accionesVisibles.length === 0) return null

  return (
    <box cssClasses={["notif-dbus-actions"]} spacing={4}>
      {accionesVisibles.slice(0, 3).map((accion) => (
        <button
          cssClasses={["notif-dbus-btn"]}
          onClicked={() => {
            invocarAccionViva(notificacion.id, accion.id)
            markRead(notificacion.id)
          }}
        >
          <label label={accion.label} />
        </button>
      ))}
    </box>
  )
}
