import type { Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import {
  appSettings,
  markRead,
  updateAppSettings,
  type StoredNotification,
} from "../../store"
import { abrirEdicionNotificacion } from "../../settings/edicionDirecta.ts"

interface PropiedadesAccionesLaterales {
  notificacion: StoredNotification
  accionesAbiertas: Accessor<boolean>
  respuestaAbierta: Accessor<boolean>
  establecerRespuestaAbierta: (abierta: boolean) => void
  esMensajeria: boolean
  silenciada: Accessor<boolean>
  alDescartar: () => void
}

/** Controles que aparecen a la derecha de la tarjeta. */
export default function AccionesLateralesItemNotificacion({
  notificacion,
  accionesAbiertas,
  respuestaAbierta,
  establecerRespuestaAbierta,
  esMensajeria,
  silenciada,
  alDescartar,
}: PropiedadesAccionesLaterales) {
  return (
    <Gtk.Revealer
      revealChild={accionesAbiertas((abiertas) => abiertas)}
      transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
      transitionDuration={150}
      valign={Gtk.Align.CENTER}
    >
      <box cssClasses={["notif-hover-actions"]} spacing={2}>
        {esMensajeria && (
          <button
            cssClasses={["notif-action-btn", "reply"]}
            tooltipText="Responder"
            onClicked={() => {
              establecerRespuestaAbierta(!respuestaAbierta.get())
              markRead(notificacion.id)
            }}
          >
            <label label="󰔈" />
          </button>
        )}

        <button
          cssClasses={silenciada((estaSilenciada) => estaSilenciada
            ? ["notif-action-btn", "active"]
            : ["notif-action-btn"])}
          tooltipText={silenciada((estaSilenciada) => estaSilenciada
            ? "Activar app"
            : "Silenciar app")}
          onClicked={() => updateAppSettings(notificacion.appName, {
            muted: !appSettings.get()?.[notificacion.appName]?.muted,
          })}
        >
          <label label={silenciada((estaSilenciada) => estaSilenciada ? "󰂛" : "󰂚")} />
        </button>

        {/* Editar: abre los ajustes de notificaciones ya dentro del editor de ESTA
            notificación (su aviso del sistema, la regla que la gestiona, o una nueva
            prerrellenada). Es el atajo para "esta que dure menos / que no suene / que no
            salga" sin tener que ir a buscarla por las pestañas. */}
        <button
          cssClasses={["notif-action-btn"]}
          tooltipText="Editar en ajustes"
          onClicked={() => abrirEdicionNotificacion(notificacion)}
        >
          <label label="󰏫" />
        </button>

        {!notificacion.read && (
          <button
            cssClasses={["notif-action-btn"]}
            tooltipText="Marcar leída"
            onClicked={() => markRead(notificacion.id)}
          >
            <label label="󰄵" />
          </button>
        )}

        <button
          cssClasses={["notif-action-btn", "dismiss"]}
          tooltipText="Descartar"
          onClicked={alDescartar}
        >
          <label label="󰅖" />
        </button>
      </box>
    </Gtk.Revealer>
  )
}
