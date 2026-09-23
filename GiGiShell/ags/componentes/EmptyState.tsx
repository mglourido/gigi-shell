import { Gtk } from "ags/gtk4"

// Patrón "icono grande + título + subtítulo opcional" usado por varios paneles
// (notificaciones, historial, apps, agenda). Cada sitio mantiene sus propias
// clases SCSS (np-*/ns-*/cal-*) vía props, así que este componente no fuerza
// una convención de nombres nueva. Devuelve Gtk.Widget (no solo JSX.Element)
// para poder usarse tanto embebido en JSX como llamado directamente en código
// imperativo (ver modulos/calendario/calendario/AgendaDia.tsx).
export default function EmptyState({
  icon,
  title,
  subtitle,
  iconClass,
  titleClass,
  subClass,
  wrapClass,
  spacing = 8,
  vexpand,
  visible,
}: {
  icon: string
  title: string
  subtitle?: string
  iconClass: string
  titleClass: string
  subClass?: string
  wrapClass: string
  spacing?: number
  vexpand?: boolean
  visible?: any
}): Gtk.Widget {
  return (
    <box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={spacing}
      valign={Gtk.Align.CENTER}
      halign={Gtk.Align.CENTER}
      vexpand={vexpand}
      visible={visible}
      cssClasses={[wrapClass]}
    >
      <label cssClasses={[iconClass]} label={icon} />
      <label cssClasses={[titleClass]} label={title} />
      {subtitle && <label cssClasses={[subClass!]} label={subtitle} />}
    </box>
  ) as unknown as Gtk.Widget
}
