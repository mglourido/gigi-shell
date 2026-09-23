import type { Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import IconoAppNotificacion from "./IconoAplicacion"
import { getRelativeTime, timeTick, type StoredNotification } from "../../store"

interface PropiedadesContenidoItemNotificacion {
  notificacion: StoredNotification
  resumen: string
  /** Cuerpo ya convertido a marcado de Pango (ver `../../marcado.ts`). */
  cuerpo: string
  necesitaExpansion: boolean
  expandida: Accessor<boolean>
  alPulsar: () => void
  alRegistrar: (boton: Gtk.Button) => void
}

/** Botón principal de la tarjeta: encabezado, cuerpo y control de expansión. */
export default function ContenidoItemNotificacion({
  notificacion,
  resumen,
  cuerpo,
  necesitaExpansion,
  expandida,
  alPulsar,
  alRegistrar,
}: PropiedadesContenidoItemNotificacion) {
  return (
    <button
      cssClasses={expandida((estaExpandida) => estaExpandida
        ? ["notif-item-btn", "expanded"]
        : ["notif-item-btn"])}
      onClicked={alPulsar}
      hexpand
      $={alRegistrar}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={5} hexpand>
        {/* El indicador solo ocupa espacio en la fila superior. */}
        <box spacing={6} hexpand>
          <label
            cssClasses={expandida((estaExpandida) => estaExpandida
              ? ["notif-expand-indicator", "expanded"]
              : ["notif-expand-indicator"])}
            label="󰅀"
            visible={necesitaExpansion}
            valign={Gtk.Align.CENTER}
          />
          <box spacing={4} valign={Gtk.Align.CENTER} hexpand>
            <IconoAppNotificacion iconoApp={notificacion.appIcon} />
            {/* Sin tope, el nombre de app pedía su ancho natural entero y compartía a
                medias el déficit con el título: dos etiquetas elipsables con el mismo
                hueco enorme hacen que `gtk_distribute_natural_allocation` las trate por
                igual, así que un remitente largo recortaba el asunto por la mitad aunque
                la fila tuviera sitio. Acotado a 14 caracteres su hueco pasa a ser el más
                pequeño, se satisface primero y el resto va entero al título. */}
            <label
              cssClasses={["notif-app-name"]}
              label={notificacion.appName}
              tooltipText={notificacion.appName}
              halign={Gtk.Align.START}
              ellipsize={3}
              maxWidthChars={14}
              visible={!!notificacion.appName}
            />
            <label
              cssClasses={["notif-dot"]}
              label="·"
              visible={!!notificacion.appName && !!notificacion.summary}
            />
            <label
              cssClasses={["notif-summary"]}
              label={resumen}
              tooltipText={resumen}
              hexpand
              halign={Gtk.Align.START}
              ellipsize={3}
              visible={!!notificacion.summary}
            />
            {!notificacion.summary && <box hexpand />}
            <label
              cssClasses={["notif-timestamp"]}
              label={timeTick(() => getRelativeTime(notificacion.timestamp))}
              halign={Gtk.Align.END}
              valign={Gtk.Align.CENTER}
            />
          </box>
        </box>
        <label
          cssClasses={["notif-body"]}
          label={cuerpo}
          useMarkup={true}
          halign={Gtk.Align.START}
          wrap={true}
          wrapMode={Pango.WrapMode.WORD_CHAR}
          xalign={0}
          lines={expandida((estaExpandida) => estaExpandida ? -1 : 2)}
          ellipsize={expandida((estaExpandida) => estaExpandida
            ? Pango.EllipsizeMode.NONE
            : Pango.EllipsizeMode.END)}
          visible={!!notificacion.body}
        />
      </box>
    </button>
  )
}
