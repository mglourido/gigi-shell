// Lo que se pinta EN VEZ del "no hay nada" cuando el vacío no es que no haya notificaciones,
// sino que otro daemon nos ha robado el servidor de notificaciones.
// Sin esto, el síntoma ("historial vacío") es indistinguible del estado normal de reposo.
//
// Astal ya grita al no conseguir el nombre ("cannot get proxy: dunst is already running"), pero
// por el stdout de `ags`, que arrancando desde gigios/autostart.lua no acaba ni en hyprland.log ni en
// el journal — y no dice ni la consecuencia ni el arreglo. Aquí sí.
import { Gtk } from "ags/gtk4"
import type { DaemonConflict } from "./comprobacion.ts"
import EmptyState from "../../../componentes/EmptyState.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export function conflictText(c: DaemonConflict): { title: string; subtitle: string } {
  const who = c.comm || formatearTexto(textos.conflicto.pid, { pid: c.pid })
  const unit = c.comm ? `${c.comm}.service` : textos.conflicto.unidadDesconocida
  return {
    title: formatearTexto(textos.conflicto.titulo, { proceso: who }),
    subtitle: formatearTexto(textos.conflicto.detalle, { unidad: unit }),
  }
}

export default function BannerConflicto({
  conflict, wrapClass, iconClass, titleClass, subClass, vexpand,
}: {
  conflict: DaemonConflict
  wrapClass: string
  iconClass: string
  titleClass: string
  subClass: string
  vexpand?: boolean
}): Gtk.Widget {
  const { title, subtitle } = conflictText(conflict)
  return EmptyState({
    icon: "󰀦", title, subtitle, wrapClass, iconClass, titleClass, subClass, vexpand,
  })
}
