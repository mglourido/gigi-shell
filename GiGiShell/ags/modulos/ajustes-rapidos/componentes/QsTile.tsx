import { createComputed } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

export default function QsTile({ icon, iconWidget, label, subtitle, active, onToggle, onRightClick, subtitleWidthRequest, subtitleMaxWidthChars, claseActiva, avisoActivo, visible = true }: {
  icon: any, iconWidget?: any, label: any, subtitle: any, active: any, onToggle: () => void, onRightClick?: () => void, subtitleWidthRequest?: number,
  /** Límite del ancho natural del subtítulo, en caracteres. `ellipsize` por sí
   *  solo no basta: reduce el ancho mínimo de la etiqueta, pero el ancho natural
   *  sigue siendo el del texto completo. Como la rejilla es `homogeneous`, un
   *  subtítulo largo (por ejemplo, el nombre de una webcam) ensancha su columna,
   *  las demás columnas y el panel. Se aplica el mismo criterio que a
   *  `maxWidthChars` en el título del popup de notificaciones. */
  subtitleMaxWidthChars?: number,
  /** Clase adicional mientras `active` es cierto. La cámara la usa para indicar
   *  en rojo que hay una captura en curso, mientras que el resaltado normal
   *  significa que la cámara no está bloqueada. Se deriva junto con las demás
   *  clases para mantener una sola fuente de verdad. */
  claseActiva?: string,
  /** Condición para aplicar `claseActiva` cuando `active` no basta. En la cámara,
   *  que haya una captura en curso y que el dispositivo no esté bloqueado son
   *  hechos distintos: bloquear no detiene una captura ya abierta. `active`
   *  también debe ser un accessor para que ambas señales participen en el mismo
   *  cálculo reactivo. */
  avisoActivo?: any,
  visible?: any,
}) {
  const construir = (activo: boolean, aviso: boolean) => {
    const clases = ["qs-tile"]
    if (activo) clases.push("active")
    if (aviso && claseActiva) clases.push(claseActiva)
    return clases
  }
  const classes = avisoActivo !== undefined
    ? createComputed([active, avisoActivo], construir)
    : typeof active === "function"
      ? active((a: boolean) => construir(a, a))
      : construir(!!active, !!active)
  return (
    <button cssClasses={classes} onClicked={onToggle} hexpand visible={visible}>
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={onRightClick}
      />
      <box spacing={6} valign={Gtk.Align.CENTER} hexpand>
        {iconWidget || <label cssClasses={["qs-tile-icon"]} label={icon} />}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand>
          <label cssClasses={["qs-tile-label"]} label={label} halign={Gtk.Align.START} />
          <label
            cssClasses={["qs-tile-sub"]}
            label={subtitle}
            halign={Gtk.Align.START}
            xalign={0}
            widthRequest={subtitleWidthRequest}
            maxWidthChars={subtitleMaxWidthChars}
            ellipsize={3}
          />
        </box>
        <label cssClasses={["qs-tile-arrow"]} label="󰅂" halign={Gtk.Align.END} />
      </box>
    </button>
  )
}
