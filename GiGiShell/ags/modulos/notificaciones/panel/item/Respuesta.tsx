import { createState, type Accessor } from "ags"
import { execAsync } from "ags/process"
import { Gtk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import type { StoredNotification } from "../../store"

interface PropiedadesRespuestaItemNotificacion {
  notificacion: StoredNotification
  color: Accessor<string>
  abierta: Accessor<boolean>
  establecerAbierta: (abierta: boolean) => void
}

/** Entrada inline y envío de respuesta para aplicaciones de mensajería. */
export default function RespuestaItemNotificacion({
  notificacion,
  color,
  abierta,
  establecerAbierta,
}: PropiedadesRespuestaItemNotificacion) {
  const [textoRespuesta, establecerTextoRespuesta] = createState("")

  // WhatsApp y Telegram no exponen una respuesta D-Bus nativa en Linux. Se usa
  // la acción publicada por la notificación o se abre la app como alternativa.
  function enviarRespuesta(): void {
    const texto = textoRespuesta.get().trim()
    if (!texto) return

    const notificacionViva = AstalNotifd.get_default().get_notification(notificacion.id)
    const accionRespuesta = notificacion.actions.find((accion) =>
      accion.id === "inline-reply" ||
      accion.id === "reply" ||
      accion.label.toLowerCase().includes("resp"))

    if (accionRespuesta && notificacionViva) {
      try {
        notificacionViva.invoke(accionRespuesta.id)
      } catch (_) {
        execAsync([
          "bash",
          "-c",
          `xdg-open ${notificacion.appName.toLowerCase()} || true`,
        ]).catch(() => {})
      }
    } else {
      execAsync(["bash", "-c", `
        app="${notificacion.appName.toLowerCase()}"
        if command -v "$app" &>/dev/null; then
          "$app" &
        else
          xdg-open . 2>/dev/null || true
        fi
      `]).catch(() => {})
    }

    establecerTextoRespuesta("")
    establecerAbierta(false)
  }

  return (
    <box cssClasses={["notif-reply-box"]} spacing={6} visible={abierta((valor) => valor)}>
      <Gtk.Entry
        cssClasses={["notif-reply-entry"]}
        placeholderText={`Responder a ${notificacion.appName}…`}
        hexpand
        onChanged={(entrada) => establecerTextoRespuesta(entrada.text)}
        onActivate={enviarRespuesta}
      />
      <button cssClasses={["notif-reply-send"]} onClicked={enviarRespuesta}>
        <label label="󰕒" css={color((colorActual) => `color: ${colorActual};`)} />
      </button>
      <button cssClasses={["notif-reply-cancel"]} onClicked={() => establecerAbierta(false)}>
        <label label="󰅖" />
      </button>
    </box>
  )
}
