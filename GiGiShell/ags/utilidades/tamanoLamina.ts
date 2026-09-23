import type { Gdk, Gtk } from "ags/gtk4"
import { onCleanup } from "ags"

/**
 * Acota una lámina centrada (las dos ventanas de ajustes) al tamaño de SU pantalla.
 *
 * **Los dos ejes no son simétricos, y no es un descuido**: el ANCHO es fijo —el de diseño—
 * y aquí solo se recorta si no cabe en la pantalla; el ALTO sí es un intervalo, del de
 * diseño al que quepa, y quien lo estira es la nav de secciones (ver `SettingsPanel.tsx`).
 *
 * Lo que ninguna de las dos medidas puede hacer es pedir un mínimo que no quepa: ese era el
 * fallo original, con el tamaño declarado como `min-width`/`min-height` en CSS —un suelo que
 * GTK nunca baja— sin nadie que lo recortara, así que en un monitor pequeño la lámina se
 * salía por abajo y por los lados. Aquí el mínimo se recorta a la geometría del monitor y el
 * contenido se desplaza por dentro, que es lo que ya sabe hacer.
 *
 * El sitio donde se nota es una pantalla pequeña, así que el fallo **no se reproduce** en
 * un monitor grande: ahí el diseño cabe de sobra y todo parece correcto.
 */

/** Aire mínimo entre la lámina y los bordes de la pantalla, repartido entre los dos lados. */
const MARGEN_PANTALLA = 48
/** Por debajo de esto la lámina deja de ser usable; mejor recortarla por dentro. */
const ANCHO_MINIMO = 360
const ALTO_MINIMO = 320

export interface TamanoLamina {
  ancho: number
  alto: number
}

/** Lo más grande que puede llegar a ser una lámina en este monitor. */
export function espacioDisponible(gdkmonitor: Gdk.Monitor): TamanoLamina {
  const geo = gdkmonitor.get_geometry()
  return {
    ancho: Math.max(ANCHO_MINIMO, geo.width - MARGEN_PANTALLA),
    alto: Math.max(ALTO_MINIMO, geo.height - MARGEN_PANTALLA),
  }
}

/** El tamaño de diseño recortado a lo que quepa: ancho definitivo y alto de partida. */
export function medidasLamina(gdkmonitor: Gdk.Monitor, diseno: TamanoLamina): TamanoLamina {
  const max = espacioDisponible(gdkmonitor)
  return {
    ancho: Math.min(diseno.ancho, max.ancho),
    alto: Math.min(diseno.alto, max.alto),
  }
}

/** Reacciona a un cambio de resolución (Ajustes > Pantalla lo hace en caliente, sin
 *  reconstruir la ventana). Devuelve un `$`, así que se cuelga del widget que toque. */
export function seguirGeometriaMonitor(gdkmonitor: Gdk.Monitor, alCambiar: () => void) {
  return (_self: Gtk.Widget) => {
    const id = gdkmonitor.connect("notify::geometry", alCambiar)
    onCleanup(() => gdkmonitor.disconnect(id))
  }
}

/**
 * `$` que mantiene al día el tamaño MÍNIMO de la lámina. El tamaño inicial se pide aparte
 * con `medidasLamina`, para que el primer frame ya salga bien.
 */
export function seguirTamanoLamina(gdkmonitor: Gdk.Monitor, diseno: TamanoLamina) {
  return (self: Gtk.Widget) => {
    seguirGeometriaMonitor(gdkmonitor, () => {
      const m = medidasLamina(gdkmonitor, diseno)
      self.set_size_request(m.ancho, m.alto)
    })(self)
  }
}
