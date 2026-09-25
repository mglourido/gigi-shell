import { createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import { notifications, notifPanelVisible } from "../../../notificaciones/store"
import { alternarPanelNotificaciones } from "../../../../estado/shell"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { ESLABON, SensorCadena, type CadenaEstado } from "../../componentes/cadenaEstado"
import { tituloBarra } from "../../componentes/tituloBarra"

export default function BotonNotificaciones({ cadena }: { cadena: CadenaEstado }) {
  const cicloVida = crearCicloVida()
  const indice = ESLABON.notificaciones
  const notifd = AstalNotifd.get_default()

  const getResumenNotificaciones = () => {
    const lista = notifications.get()
    let noLeidas = 0
    for (const notificacion of lista) {
      if (!notificacion.read) noLeidas++
    }
    return { noLeidas, hayNotificaciones: lista.length > 0 }
  }
  const getDnd       = () => notifd.dontDisturb
  const getPanelOpen = () => notifPanelVisible.get()

  const resumenInicial = getResumenNotificaciones()
  const getIconLabel   = (noLeidas: number) => getDnd() ? "󰪑" : noLeidas > 0 ? "󰂚" : "󰂜"
  const getIconClasses = (noLeidas: number) => getDnd() ? ["nb-icon", "dnd"] : noLeidas > 0 ? ["nb-icon", "has-notifs"] : ["nb-icon"]

  const [unread,      setUnread]      = createState(resumenInicial.noLeidas)
  const [panelOpen,   setPanelOpen]   = createState(getPanelOpen())
  const [iconLabel,   setIconLabel]   = createState(getIconLabel(resumenInicial.noLeidas))
  const [iconClasses, setIconClasses] = createState(getIconClasses(resumenInicial.noLeidas))
  const [hasNotifs,   setHasNotifs]   = createState(resumenInicial.hayNotificaciones)

  const update = () => {
    const resumen = getResumenNotificaciones()
    setUnread(resumen.noLeidas)
    setPanelOpen(getPanelOpen())
    setIconLabel(getIconLabel(resumen.noLeidas))
    setIconClasses(getIconClasses(resumen.noLeidas))
    setHasNotifs(resumen.hayNotificaciones)
  }

  cicloVida.conectarSenales(notifd, ["notify::dont-disturb", "notified", "resolved"], update)
  cicloVida.suscribir(notifications, update)
  cicloVida.suscribir(notifPanelVisible, update)

  // `panel-open` deja la pastilla realzada aunque el cursor esté lejos; se compone
  // con el realce de la cadena en vez de encadenar transformaciones, porque una
  // transformación solo reacciona al accessor del que cuelga.
  const clasesPastilla = createComputed(
    [cadena.clases(indice, ["bar-pill", "nb-pill"]), panelOpen],
    // Parte de las clases QUE DA LA CADENA, no de una lista propia: así llegan también
    // las que decide ella (`cadena-continua`) sin tener que enumerarlas aquí.
    (clases, abierto) => (abierto ? [...clases, "panel-open"] : clases),
  )

  return (
    <button
      visible={hasNotifs((hn) => hn)}
      cssClasses={["bar-pill-btn"]}
      $={(self: Gtk.Widget) => tituloBarra(self, unread((u) => String(u)))}
      onClicked={alternarPanelNotificaciones}
    >
      <Gtk.GestureClick
        button={3}
        onPressed={() => { notifd.dontDisturb = !notifd.dontDisturb }}
      />
      <SensorCadena cadena={cadena} indice={indice} />
      <box
        cssClasses={clasesPastilla}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <label
          cssClasses={iconClasses}
          label={iconLabel}
          hexpand
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        />
      </box>
    </button>
  )
}
