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

  let ultimoOrigen = "\0"
  let ultimaEscala = 0
  let superficie: Gdk.Surface | null = null
  let idEscala: number | null = null

  const aplicar = () => {
    const origen = ruta.get()
    const escala = superficie?.get_scale?.() ?? imagen.get_scale_factor()
    if (origen === ultimoOrigen && escala === ultimaEscala) return
    ultimoOrigen = origen
    ultimaEscala = escala
    if (!origen || origen.startsWith("http")) {
      imagen.set_paintable(null)
      return
    }

    const archivo = origen.startsWith("file://") ? origen.slice(7) : origen
    try {
      const [, ancho, alto] = GdkPixbuf.Pixbuf.get_file_info(archivo)
      if (ancho <= 0 || alto <= 0) throw new Error("Carátula inválida")
      // COVER conserva el encuadre. Se reduce a píxeles físicos, incluida la
      // escala fraccionaria, antes de entregar la textura a GTK.
      const factor = Math.min(1, Math.max(ANCHO * escala / ancho, ALTO * escala / alto))
      const anchoDestino = Math.ceil(ancho * factor)
      const altoDestino = Math.ceil(alto * factor)
      // Acotar la decodificación evita retener una portada grande. El margen
      // del doble deja detalle para la reducción final con el filtro HYPER.
      const pixbuf = factor < 0.5
        ? GdkPixbuf.Pixbuf.new_from_file_at_scale(archivo, anchoDestino * 2, altoDestino * 2, true)
        : GdkPixbuf.Pixbuf.new_from_file(archivo)
      const ajustado = factor < 1
        ? pixbuf.scale_simple(anchoDestino, altoDestino, GdkPixbuf.InterpType.HYPER) ?? pixbuf
        : pixbuf
      imagen.set_paintable(Gdk.Texture.new_for_pixbuf(ajustado))
    } catch (_) {
      imagen.set_paintable(null)
    }
  }

  const desconectarEscala = () => {
    if (superficie && idEscala !== null) superficie.disconnect(idEscala)
    idEscala = null
    superficie = null
  }

  const idRealizar = imagen.connect("realize", () => {
    desconectarEscala()
    superficie = imagen.get_native()?.get_surface() ?? null
    if (superficie) {
      // GTK anterior a 4.12 solo publica el factor entero.
      idEscala = superficie.connect(superficie.get_scale ? "notify::scale" : "notify::scale-factor", aplicar)
    }
    aplicar()
  })
  const idDesrealizar = imagen.connect("unrealize", desconectarEscala)
  const cancelar = ruta.subscribe(aplicar)
  aplicar()
  onCleanup(() => {
    cancelar()
    desconectarEscala()
    imagen.disconnect(idRealizar)
    imagen.disconnect(idDesrealizar)
  })

  return (
    <box cssClasses={["bar-spotify-art"]} overflow={Gtk.Overflow.HIDDEN}>
      <Gtk.Overlay $={(overlay: Gtk.Overlay) => {
        overlay.set_child(<label label="󰓇" cssClasses={["bar-spotify-placeholder"]} /> as Gtk.Widget)
        overlay.add_overlay(limite)
      }} />
    </box>
  )
}
