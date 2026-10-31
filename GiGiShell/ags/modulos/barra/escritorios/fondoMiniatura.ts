import Gdk from "gi://Gdk"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"

/** Ruta de la imagen que `awww query` da para una salida; null si muestra un color o no aparece.
 * Formato de cada línea: `: DP-3: 2048x1152, scale: 1.25, currently displaying: image: /ruta`. */
function rutaFondoDeSalida(consulta: string, nombreSalida: string): string | null {
  for (const linea of consulta.split("\n")) {
    const separada = /^:?\s*([^:\s]+):.*currently displaying: image: (.+)$/.exec(linea)
    if (separada?.[1] === nombreSalida) return separada[2]
  }
  return null
}

/** Pone en `alCargar` el fondo de pantalla de la salida, para ir debajo de las ventanas de la
 * captura. Se decodifica en cada apertura, sin retener nada con la miniatura cerrada. Se pide al
 * doble del tamaño porque la imagen se recorta con COVER y el lado corto debe llegar a cubrirla.
 * Si algo falla no llama a nada: queda el color de fondo de la miniatura. Devuelve cómo cancelar. */
export function cargarFondoMiniatura(
  nombreSalida: string,
  ancho: number,
  alto: number,
  alCargar: (textura: Gdk.Texture) => void,
): () => void {
  const cancelable = new Gio.Cancellable()

  void execAsync(["awww", "query"]).then((consulta) => {
    const ruta = rutaFondoDeSalida(consulta, nombreSalida)
    if (!ruta || cancelable.is_cancelled()) return
    Gio.File.new_for_path(ruta).read_async(0, cancelable, (archivo, lectura) => {
      try {
        const flujo = archivo!.read_finish(lectura)
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
          flujo, ancho * 2, alto * 2, true, cancelable,
          (_fuente, resultado) => {
            try {
              alCargar(Gdk.Texture.new_for_pixbuf(GdkPixbuf.Pixbuf.new_from_stream_finish(resultado)))
            } catch (_) {
              // Cancelado al cerrar, o imagen ilegible.
            }
          },
        )
      } catch (_) {
        // Cancelado al cerrar, o el fondo ya no existe.
      }
    })
  }).catch(() => {
    // Sin awww-daemon no hay fondo que poner.
  })

  return () => cancelable.cancel()
}
