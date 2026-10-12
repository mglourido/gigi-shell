import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import GLib from "gi://GLib"
import AstalNotifd from "gi://AstalNotifd"
import {
  notifications,
  notifPanelVisible,
  activeAppFilter,
  setActiveAppFilter,
  selectionMode,
  setSelectionMode,
  setSelectedIds,
  groupByApp,
  setGroupByApp,
  notifSettingsVisible,
  setNotifSettingsVisible,
  clearAllNotifications,
  markAllRead,
  getAppsWithNotifs,
} from "../store"
import AppFilterBar from "../settings/AppFilterBar"

function FiltrosAplicaciones() {
  const obtenerAplicaciones = (): string[] => getAppsWithNotifs().slice(1).sort()
  const [aplicaciones, setAplicaciones] = createState<string[]>(obtenerAplicaciones())

  // No recalcular la lista de apps mientras el panel está oculto; ponerla al día al abrir.
  const reconstruir = () => {
    if (notifPanelVisible.get()) setAplicaciones(obtenerAplicaciones())
  }
  notifications.subscribe(reconstruir)
  notifPanelVisible.subscribe(reconstruir)

  return (
    <AppFilterBar
      apps={aplicaciones}
      active={activeAppFilter}
      onSelect={setActiveAppFilter}
    />
  )
}

export default function CabeceraPanel() {
  const notifd = AstalNotifd.get_default()

  // Los contadores no se recalculan con el panel cerrado: se ponen al día al abrir.
  // Ambos valores se obtienen en un solo recorrido y solo controlan widgets invisibles
  // mientras el panel permanece cerrado.
  const contarNotificaciones = () => {
    const lista = notifications.get() ?? []
    let noLeidas = 0
    for (const notificacion of lista) if (!notificacion.read) noLeidas++
    return { noLeidas, hayNotificaciones: lista.length > 0 }
  }
  const [contadores, setContadores] = createState(contarNotificaciones())
  const actualizarContadores = () => {
    if (notifPanelVisible.get()) setContadores(contarNotificaciones())
  }
  notifications.subscribe(actualizarContadores)
  notifPanelVisible.subscribe(actualizarContadores)

  const noLeidas = contadores((valor) => valor.noLeidas)
  const hayNotificaciones = contadores((valor) => valor.hayNotificaciones)
  const [noMolestar, setNoMolestar] = createState(notifd.dontDisturb)
  const [confirmarBorrado, setConfirmarBorrado] = createState(false)
  let temporizadorConfirmacion: number | null = null
  notifd.connect("notify::dont-disturb", () => setNoMolestar(notifd.dontDisturb))

  function borrarTodasConConfirmacion(): void {
    if (confirmarBorrado.get()) {
      clearAllNotifications()
      setConfirmarBorrado(false)
      if (temporizadorConfirmacion !== null) GLib.source_remove(temporizadorConfirmacion)
      return
    }

    setConfirmarBorrado(true)
    if (temporizadorConfirmacion !== null) GLib.source_remove(temporizadorConfirmacion)
    temporizadorConfirmacion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      setConfirmarBorrado(false)
      temporizadorConfirmacion = null
      return GLib.SOURCE_REMOVE
    })
  }

  return (
    <box cssClasses={["np-header"]} spacing={0} orientation={Gtk.Orientation.VERTICAL}>
      <box spacing={2} valign={Gtk.Align.CENTER}>
        <label cssClasses={["np-title"]} label="Notificaciones" hexpand halign={Gtk.Align.START} />

        <button
          cssClasses={["np-icon-btn", "np-unread-badge-btn"]}
          valign={Gtk.Align.CENTER}
          visible={noLeidas((cantidad) => cantidad > 0)}
          tooltipText="Marcar todas como leídas"
          onClicked={markAllRead}
        >
          <label cssClasses={["np-unread-count"]} label={noLeidas((cantidad) => String(cantidad))} />
        </button>

        <button
          cssClasses={["np-icon-btn"]}
          valign={Gtk.Align.CENTER}
          visible={noLeidas((cantidad) => cantidad > 0)}
          tooltipText="Marcar todas como leídas"
          onClicked={markAllRead}
        >
          <label cssClasses={["np-btn-icon"]} label="󰄵" />
        </button>

        <button
          cssClasses={confirmarBorrado((confirmar) => confirmar
            ? ["np-icon-btn", "danger", "confirm"]
            : ["np-icon-btn", "danger"])}
          valign={Gtk.Align.CENTER}
          visible={hayNotificaciones}
          tooltipText={confirmarBorrado((confirmar) => confirmar
            ? "Pulsa de nuevo para confirmar"
            : "Borrar todas")}
          onClicked={borrarTodasConConfirmacion}
        >
          <label
            cssClasses={["np-btn-icon"]}
            label={confirmarBorrado((confirmar) => confirmar ? "󰃰" : "󰮚")}
          />
        </button>

        <button
          cssClasses={noMolestar((activo) => activo
            ? ["np-icon-btn", "dnd-active"]
            : ["np-icon-btn"])}
          valign={Gtk.Align.CENTER}
          tooltipText={noMolestar((activo) => activo ? "Desactivar no molestar" : "Activar no molestar")}
          onClicked={() => { notifd.dontDisturb = !notifd.dontDisturb }}
        >
          <label cssClasses={["np-btn-icon"]} label={noMolestar((activo) => activo ? "󰪑" : "󰂚")} />
        </button>

        <button
          cssClasses={selectionMode((activo) => activo
            ? ["np-icon-btn", "active"]
            : ["np-icon-btn"])}
          valign={Gtk.Align.CENTER}
          tooltipText={selectionMode((activo) => activo ? "Salir del modo selección" : "Seleccionar notificaciones")}
          onClicked={() => {
            const siguiente = !selectionMode.get()
            setSelectionMode(siguiente)
            if (!siguiente) setSelectedIds(new Set())
          }}
        >
          <label cssClasses={["np-btn-icon"]} label="󰒆" />
        </button>

        <button
          cssClasses={groupByApp((activo) => activo
            ? ["np-icon-btn", "active"]
            : ["np-icon-btn"])}
          valign={Gtk.Align.CENTER}
          tooltipText={groupByApp((activo) => activo ? "Mostrar sin agrupar" : "Agrupar por aplicación")}
          onClicked={() => setGroupByApp(!groupByApp.get())}
        >
          <label cssClasses={["np-btn-icon"]} label="󰉋" />
        </button>

        <button
          cssClasses={notifSettingsVisible((visible) => visible
            ? ["np-icon-btn", "active"]
            : ["np-icon-btn"])}
          valign={Gtk.Align.CENTER}
          tooltipText={notifSettingsVisible((visible) => visible ? "Cerrar ajustes de notificaciones" : "Abrir ajustes de notificaciones")}
          onClicked={() => setNotifSettingsVisible(!notifSettingsVisible.get())}
        >
          <label cssClasses={["np-btn-icon"]} label="󰒓" />
        </button>
      </box>

      <FiltrosAplicaciones />
    </box>
  )
}
