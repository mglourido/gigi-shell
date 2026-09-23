// Vista compacta reutilizable de una carátula local.
import { onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"

type FuenteCaratula = {
  get(): string
  subscribe(callback: () => void): () => void
}

const ANCHO = 40
const ALTO = 30

/** Carátula limitada al tamaño de la pastilla, sin propagar el tamaño natural. */
export default function CaratulaCompacta({ ruta }: { ruta: FuenteCaratula }) {
  const imagen = new Gtk.Picture({
    contentFit: Gtk.ContentFit.COVER,
    canShrink: true,
    hexpand: true,
    vexpand: true,
  })

  const limite = new Gtk.ScrolledWindow()
  limite.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER)
  limite.set_propagate_natural_width(false)
  limite.set_propagate_natural_height(false)
  limite.set_min_content_width(ANCHO)
  limite.set_max_content_width(ANCHO)
  limite.set_min_content_height(ALTO)
  limite.set_max_content_height(ALTO)
  limite.set_child(imagen)

  const aplicar = () => {
    const origen = ruta.get()
    if (!origen || origen.startsWith("http")) {
      imagen.set_paintable(null)
      return
    }

    const archivo = origen.startsWith("file://") ? origen.slice(7) : origen
    try {
      const pixbuf = GdkPixbuf.Pixbuf.new_from_file(archivo)
      imagen.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
    } catch (_) {
      imagen.set_paintable(null)
    }
  }

  const cancelar = ruta.subscribe(aplicar)
  aplicar()
  onCleanup(cancelar)

  return (
    <box cssClasses={["bar-spotify-art"]} overflow={Gtk.Overflow.HIDDEN}>
      <Gtk.Overlay $={(overlay: Gtk.Overlay) => {
        overlay.set_child(<label label="󰓇" cssClasses={["bar-spotify-placeholder"]} /> as Gtk.Widget)
        overlay.add_overlay(limite)
      }} />
    </box>
  )
}
