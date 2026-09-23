import { Gdk, Gtk } from "ags/gtk4"
import { With } from "ags"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { AVATAR_PATH, avatarRevision } from "./avatar"

interface ProfileAvatarProps {
  size: number
  fallbackLabel: string
  fallbackCssClasses: string[]
  borderWidth: number
  borderRgba: [number, number, number, number]
}

/**
 * Decodifica la foto a la medida en la que se va a pintar.
 *
 * El fichero se guarda a 1024 px (`avatar.ts`) para no depender del tamaño que
 * pidan los consumidores de hoy, pero aquí cabe en un círculo de 30 o 46 px: leerlo
 * entero son ~4 MB de pixbuf por avatar vivo, y se rehace en cada cambio de foto.
 * El triple del lado cubre cualquier escala de monitor razonable. Se comprueba el
 * tamaño real antes: con `preserve_aspect_ratio` la caja AMPLIARÍA una foto puesta a
 * mano más pequeña que el objetivo, que es emborronarla para luego reducirla otra vez.
 */
function cargarAjustado(size: number): GdkPixbuf.Pixbuf {
  const objetivo = size * 3
  const [, ancho, alto] = GdkPixbuf.Pixbuf.get_file_info(AVATAR_PATH)
  return ancho && alto && Math.min(ancho, alto) > objetivo
    ? GdkPixbuf.Pixbuf.new_from_file_at_scale(AVATAR_PATH, objetivo, objetivo, true)
    : GdkPixbuf.Pixbuf.new_from_file(AVATAR_PATH)
}

function CircularAvatarImage({
  size,
  borderWidth,
  borderRgba,
}: Pick<ProfileAvatarProps, "size" | "borderWidth" | "borderRgba">): Gtk.DrawingArea {
  const pixbuf = cargarAjustado(size)
  const area = new Gtk.DrawingArea({
    widthRequest: size,
    heightRequest: size,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })
  area.set_content_width(size)
  area.set_content_height(size)

  area.set_draw_func((_area, cr, width, height) => {
    const diameter = Math.min(width, height)
    const cx = width / 2
    const cy = height / 2
    const imageWidth = pixbuf.get_width()
    const imageHeight = pixbuf.get_height()
    const scale = Math.max(width / imageWidth, height / imageHeight)
    const paintedWidth = imageWidth * scale
    const paintedHeight = imageHeight * scale

    cr.save()
    cr.arc(cx, cy, diameter / 2, 0, Math.PI * 2)
    cr.clip()
    cr.translate((width - paintedWidth) / 2, (height - paintedHeight) / 2)
    cr.scale(scale, scale)
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0)
    cr.paint()
    cr.restore()

    cr.arc(cx, cy, Math.max(0, diameter / 2 - borderWidth / 2), 0, Math.PI * 2)
    cr.setSourceRGBA(...borderRgba)
    cr.setLineWidth(borderWidth)
    cr.stroke()
  })

  return area
}

/**
 * Mantiene un widget estable en el layout mientras se recarga la imagen.
 *
 * `With` vuelve a insertar su hijo al actualizarse. Si el fragmento es hijo
 * directo de una caja con más widgets, GTK lo añade al final y cambia el orden
 * visual. Este contenedor hace que la sustitución ocurra dentro de un slot que
 * nunca cambia de posición.
 */
export default function ProfileAvatar({
  size,
  fallbackLabel,
  fallbackCssClasses,
  borderWidth,
  borderRgba,
}: ProfileAvatarProps) {
  const fallback = () => <label
    cssClasses={fallbackCssClasses}
    label={fallbackLabel}
    widthRequest={size}
    heightRequest={size}
    halign={Gtk.Align.CENTER}
    valign={Gtk.Align.CENTER}
    overflow={Gtk.Overflow.HIDDEN}
    xalign={0.5}
    yalign={0.5}
  />

  return (
    <box
      widthRequest={size}
      heightRequest={size}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
    >
      <With value={avatarRevision}>{(_revision: number) => {
        if (!GLib.file_test(AVATAR_PATH, GLib.FileTest.EXISTS)) return fallback()
        try {
          return <CircularAvatarImage
            size={size}
            borderWidth={borderWidth}
            borderRgba={borderRgba}
          />
        } catch (_) {
          return fallback()
        }
      }}</With>
    </box>
  )
}
