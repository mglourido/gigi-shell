import { Gtk } from "ags/gtk4"
import { createComputed, createState, With, type Accessor } from "ags"
import GLib from "gi://GLib"
import {
  groupByApp,
  notifications,
  type StoredNotification,
} from "../store"
import EmptyState from "../../../componentes/EmptyState"
import { notifDaemonConflict, type DaemonConflict } from "../daemon/comprobacion"
import BannerConflicto from "../daemon/BannerConflicto"
import ListaPlana from "./ListaPlana"
import ListaAgrupada from "./ListaAgrupada"

type VistaLista = "oculta" | "plana" | "agrupada"

const TAMANO_TRAMO = 20
const MARGEN_CRECIMIENTO_PX = 300

export default function ListaPanel({
  maxContentHeight,
  rendered,
}: {
  maxContentHeight: number
  rendered: Accessor<boolean>
}) {
  const vacia = notifications((lista) => (lista?.length ?? 0) === 0)
  let scrollRef: Gtk.ScrolledWindow | null = null

  // Montaje incremental, sin reciclado: limita el coste de apertura sin destruir
  // widgets bajo el puntero durante el desplazamiento.
  const [limite, setLimite] = createState(TAMANO_TRAMO)
  let creciendo = false

  /** Total montable en la vista activa: notificaciones en plana, aplicaciones en agrupada.
   *  Memoizado por identidad: `ajuste.connect("value-changed"/"changed")` dispara esto en
   *  cada tick de un scroll (hasta 60/s), y sin caché cada uno recorría la lista entera para
   *  construir un Set de apps aunque las notificaciones no hubieran cambiado desde el tick
   *  anterior. */
  let cacheListaTotal: StoredNotification[] | null = null
  let cacheAgrupadoTotal: boolean | null = null
  let cacheValorTotal = 0
  const totalMontable = (): number => {
    const lista = notifications.get() ?? []
    const agrupado = groupByApp.get()
    if (lista === cacheListaTotal && agrupado === cacheAgrupadoTotal) return cacheValorTotal
    cacheListaTotal = lista
    cacheAgrupadoTotal = agrupado
    if (!agrupado) {
      cacheValorTotal = lista.length
    } else {
      const aplicaciones = new Set<string>()
      lista.forEach((notificacion) => aplicaciones.add(notificacion.appName))
      cacheValorTotal = aplicaciones.size
    }
    return cacheValorTotal
  }

  // Amplía el tramo cerca del final o cuando el tramo actual aún no llena la ventana.
  function ampliarSiNecesario(): void {
    if (creciendo || !rendered.get()) return
    const ajuste = scrollRef?.get_vadjustment()
    if (!ajuste || limite.get() >= totalMontable()) return

    const desplazable = ajuste.get_upper() > ajuste.get_page_size() + 1
    const noLlena = !desplazable
    const cercaDelFinal = desplazable
      && ajuste.get_value() + ajuste.get_page_size()
        >= ajuste.get_upper() - MARGEN_CRECIMIENTO_PX
    if (!cercaDelFinal && !noLlena) return

    // Ampliar reconstruye el <For>; se difiere para salir del layout actual de GTK.
    creciendo = true
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      setLimite(limite.get() + TAMANO_TRAMO)
      creciendo = false
      return GLib.SOURCE_REMOVE
    })
  }

  function observarScroll(scroll: Gtk.ScrolledWindow): void {
    scrollRef = scroll
    const ajuste = scroll.get_vadjustment()
    if (!ajuste) return
    ajuste.connect("value-changed", ampliarSiNecesario)
    ajuste.connect("changed", ampliarSiNecesario)
  }

  // Cada apertura y cada cambio de vista vuelven al primer tramo y al inicio.
  const reiniciarLimite = () => {
    setLimite(TAMANO_TRAMO)
    scrollRef?.get_vadjustment()?.set_value(0)
  }
  rendered.subscribe(reiniciarLimite)
  groupByApp.subscribe(reiniciarLimite)

  // Las listas reinsertan widgets al cambiar su array. Restaurar el ajuste impide
  // que GTK salte al primer elemento enfocable al marcar una notificación como leída.
  function conservarPosicionScroll(actualizar: () => void): void {
    const ajuste = scrollRef?.get_vadjustment()
    const posicionAnterior = ajuste?.get_value() ?? 0
    actualizar()
    if (!ajuste) return
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      ajuste.set_value(posicionAnterior)
      return GLib.SOURCE_REMOVE
    })
  }

  // Un solo <With> combina visibilidad y agrupación para evitar fragments anidados,
  // no soportados por gnim. Al ocultar, se destruyen todos los widgets de elementos.
  const obtenerVista = (): VistaLista =>
    !rendered.get() ? "oculta" : groupByApp.get() ? "agrupada" : "plana"
  const [vista, setVista] = createState<VistaLista>(obtenerVista())
  const actualizarVista = () => setVista(obtenerVista())
  rendered.subscribe(actualizarVista)
  groupByApp.subscribe(actualizarVista)

  const conflictoVacio = createComputed(
    [vacia, notifDaemonConflict],
    (estaVacia, conflicto) => (estaVacia && conflicto) || null,
  )
  const mostrarVacio = createComputed(
    [vacia, notifDaemonConflict],
    (estaVacia, conflicto) => estaVacia && !conflicto,
  )

  return (
    <Gtk.ScrolledWindow
      cssClasses={["np-list-scroll"]}
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      propagateNaturalHeight={true}
      maxContentHeight={maxContentHeight}
      vexpand
      $={observarScroll}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
        {/* Si otro daemon posee org.freedesktop.Notifications, mostrar el conflicto
            en vez de afirmar que no hay notificaciones. */}
        <With value={conflictoVacio}>
          {(conflicto: DaemonConflict | null) => conflicto
            ? BannerConflicto({
                conflict: conflicto,
                wrapClass: "np-empty-state",
                iconClass: "np-empty-icon",
                titleClass: "np-empty-title",
                subClass: "np-empty-sub",
                vexpand: true,
              })
            : <box visible={false} />
          }
        </With>
        <EmptyState
          icon="󰂚"
          title="Sin notificaciones"
          subtitle="Aquí aparecerán tus notificaciones"
          wrapClass="np-empty-state"
          iconClass="np-empty-icon"
          titleClass="np-empty-title"
          subClass="np-empty-sub"
          spacing={10}
          vexpand
          visible={mostrarVacio}
        />

        <With value={vista}>
          {(valor) => valor === "plana"
            ? <ListaPlana conservarScroll={conservarPosicionScroll} limite={limite} />
            : valor === "agrupada"
              ? <ListaAgrupada conservarScroll={conservarPosicionScroll} limite={limite} />
              : null}
        </With>
      </box>
    </Gtk.ScrolledWindow>
  )
}
