/**
 * Item individual de notificación para el panel principal.
 *
 * La tarjeta conserva aquí solamente la composición y las interacciones que
 * coordinan varias de sus partes. El contenido, las acciones, los iconos, el
 * estado persistente de expansión y las transformaciones puras viven en sus
 * módulos específicos.
 */

import { createState } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import AccionesDbusItemNotificacion from "./AccionesDbus"
import AccionesLateralesItemNotificacion from "./AccionesLaterales"
import RespuestaItemNotificacion from "./Respuesta"
import { invocarAccionViva } from "./acciones"
import ContenidoItemNotificacion from "./Contenido"
import { usarExpansionItemNotificacion } from "./estado"
import {
  appSettings,
  markRead,
  removeNotification,
  resolveNotifColor,
  selectedIds,
  selectionMode,
  setSelectedIds,
  type StoredNotification,
} from "../../store"
import {
  esAppMensajeria,
  fondoOpacoDesdeHex,
  necesitaExpansionCuerpo,
} from "./utilidades"
import { aMarcadoPango, limpiarMarcado } from "../../marcado"

export default function ItemNotificacion({ notif }: { notif: StoredNotification }) {
  // Color de regla > color por app > valor del sistema. Se actualiza en vivo
  // cuando se edita el color global de la app en ajustes.
  const color = appSettings((ajustes) => resolveNotifColor(notif, ajustes))
  const [accionesAbiertas, establecerAccionesAbiertas] = createState(false)
  const [respuestaAbierta, establecerRespuestaAbierta] = createState(false)
  const [descartada, establecerDescartada] = createState(false)
  const expansion = usarExpansionItemNotificacion(notif.id)

  // El resumen va en texto plano (la especificación solo admite marcado en el
  // cuerpo) y el cuerpo se pinta como marcado; la versión limpia sigue haciendo
  // falta para medir cuántas líneas ocupa de verdad.
  const resumen = limpiarMarcado(notif.summary)
  const cuerpo = aMarcadoPango(notif.body)
  const necesitaExpansion = necesitaExpansionCuerpo(limpiarMarcado(notif.body))
  const esMensajeria = esAppMensajeria(notif.appName)
  const seleccionada = selectedIds((ids) => ids?.has(notif.id) ?? false)
  const silenciada = appSettings((ajustes) => ajustes?.[notif.appName]?.muted ?? false)

  function alternarSeleccion(): void {
    const siguientes = new Set(selectedIds.get())
    if (siguientes.has(notif.id)) siguientes.delete(notif.id)
    else siguientes.add(notif.id)
    setSelectedIds(siguientes)
  }

  function pulsarContenido(): void {
    establecerAccionesAbiertas(false)
    if (selectionMode.get()) {
      alternarSeleccion()
      return
    }

    markRead(notif.id)
    if (necesitaExpansion) expansion.alternar()
    expansion.restaurarFoco()
    invocarAccionViva(notif.id, "default")
  }

  function descartar(): void {
    establecerDescartada(true)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      removeNotification(notif.id)
      return GLib.SOURCE_REMOVE
    })
  }

  const indicadorNoLeida = color((colorActual) => notif.read
    ? "background: transparent;"
    : `background: ${colorActual};`)
  const tinteFondo = color((colorActual) => notif.read
    ? ""
    : `background: ${fondoOpacoDesdeHex(colorActual, 0.06)};`)

  return (
    <box
      cssClasses={["notif-item-wrapper"]}
      orientation={Gtk.Orientation.VERTICAL}
      visible={descartada((valor) => !valor)}
    >
      <Gtk.GestureClick
        button={3}
        onPressed={() => establecerAccionesAbiertas(!accionesAbiertas.get())}
      />

      <box
        cssClasses={notif.read ? ["notif-item"] : ["notif-item", "unread"]}
        css={tinteFondo}
        spacing={0}
      >
        <box cssClasses={["notif-unread-bar"]} css={indicadorNoLeida} />

        <box visible={selectionMode((valor) => valor)} cssClasses={["notif-checkbox-wrap"]}>
          <button
            cssClasses={seleccionada((valor) => valor
              ? ["notif-checkbox", "checked"]
              : ["notif-checkbox"])}
            onClicked={alternarSeleccion}
          >
            <label
              cssClasses={["notif-checkbox-icon"]}
              label={seleccionada((valor) => valor ? "󰄵" : "󰄱")}
              css={seleccionada((valor) => valor ? `color: ${color.get()};` : "")}
            />
          </button>
        </box>

        <ContenidoItemNotificacion
          notificacion={notif}
          resumen={resumen}
          cuerpo={cuerpo}
          necesitaExpansion={necesitaExpansion}
          expandida={expansion.expandida}
          alPulsar={pulsarContenido}
          alRegistrar={expansion.registrarBoton}
        />

        <AccionesLateralesItemNotificacion
          notificacion={notif}
          accionesAbiertas={accionesAbiertas}
          respuestaAbierta={respuestaAbierta}
          establecerRespuestaAbierta={establecerRespuestaAbierta}
          esMensajeria={esMensajeria}
          silenciada={silenciada}
          alDescartar={descartar}
        />
      </box>

      <AccionesDbusItemNotificacion notificacion={notif} />
      <RespuestaItemNotificacion
        notificacion={notif}
        color={color}
        abierta={respuestaAbierta}
        establecerAbierta={establecerRespuestaAbierta}
      />
    </box>
  )
}
