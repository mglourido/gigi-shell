import { Gtk } from "ags/gtk4"
import { createComputed, createState, For, onCleanup } from "ags"
import {
  activeAppFilter,
  notifications,
  type StoredNotification,
} from "../store"
import GrupoAplicacion from "./GrupoAplicacion"
import { type PropiedadesListaNotificaciones } from "./ListaPlana"

interface GrupoNotificaciones {
  appName: string
  notificaciones: StoredNotification[]
}

/** Identidad estable para un grupo que ya no está en la lista, entre que el almacén
 *  cambia y el <For> retira su fila. */
const SIN_NOTIFICACIONES: StoredNotification[] = []

function agruparNotificaciones(): GrupoNotificaciones[] {
  const grupos = new Map<string, StoredNotification[]>()
  notifications.get().forEach((notificacion) => {
    const grupo = grupos.get(notificacion.appName) ?? []
    grupo.push(notificacion)
    grupos.set(notificacion.appName, grupo)
  })
  return Array.from(grupos, ([appName, notificaciones]) => ({
    appName,
    notificaciones: notificaciones.slice().reverse(),
  }))
}

export default function ListaAgrupada({
  conservarScroll,
  limite,
}: PropiedadesListaNotificaciones) {
  // Solo existe mientras el panel está abierto en modo agrupado.
  const [grupos, setGrupos] = createState<GrupoNotificaciones[]>(agruparNotificaciones())
  onCleanup(notifications.subscribe(() => {
    conservarScroll(() => setGrupos(agruparNotificaciones()))
  }))

  // En esta vista el límite cuenta grupos, no notificaciones individuales.
  const montados = createComputed([grupos, limite], (lista, cantidad) =>
    lista.slice(0, cantidad))

  /** Notificaciones de una app como accessor vivo: el grupo ya no se reconstruye,
   *  así que es por aquí por donde le llegan las nuevas. */
  const notificacionesDeApp = (appName: string) =>
    grupos((lista) =>
      lista.find((grupo) => grupo.appName === appName)?.notificaciones ?? SIN_NOTIFICACIONES)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      {/* Indexado por `appName`: `agruparNotificaciones()` fabrica grupos NUEVOS en
          cada cambio del almacén, así que sin clave una notificación de Discord
          reconstruía también el grupo de Firefox con todas sus filas. No era solo
          coste: `plegado` es estado local del grupo, de modo que cualquier
          notificación reabría los grupos que hubieras plegado. */}
      <For each={montados} id={(grupo: GrupoNotificaciones) => grupo.appName}>
        {({ appName }: GrupoNotificaciones) => (
          <box visible={activeAppFilter((filtro) => filtro === "all" || filtro === appName)}>
            <GrupoAplicacion appName={appName} notificaciones={notificacionesDeApp(appName)} />
          </box>
        )}
      </For>
    </box>
  )
}
