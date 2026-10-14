import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"

const CajaAnchoQs = GObject.registerClass(
  class CajaAnchoQs extends Gtk.Box {
    ancho = 0

    vfunc_get_request_mode() {
      return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH
    }

    vfunc_measure(orientacion: Gtk.Orientation, paraTamano: number): [number, number, number, number] {
      if (orientacion === Gtk.Orientation.HORIZONTAL) return [this.ancho, this.ancho, -1, -1]
      return this.get_first_child()?.measure(
        orientacion, paraTamano < 0 ? this.ancho : Math.min(paraTamano, this.ancho),
      ) ?? [0, 0, -1, -1]
    }

    vfunc_size_allocate(ancho: number, alto: number, linea: number) {
      this.get_first_child()?.allocate(Math.min(ancho, this.ancho), alto, linea, null)
    }
  },
)

/** Ancho estable para todas las vistas; la altura sigue la del contenido. */
export default function ContenedorAnchoQs({ ancho, children }: { ancho: number; children: any }) {
  return (
    <CajaAnchoQs
      $={(self) => {
        // Patrón de CajaFija en Orion: sin BoxLayout se usan estas vfuncs;
        // Gtk.Box conserva la limpieza nativa de sus hijos, sin dispose en JS.
        self.set_layout_manager(null)
        self.ancho = ancho
      }}
    >
      {children}
    </CajaAnchoQs>
  )
}
