import Gdk from "gi://Gdk"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

/** Foto fija de la salida para cuando el ayudante en vivo no está disponible. grim solo ve lo que
 * hay en pantalla, así que únicamente sirve para el escritorio activo. Devuelve null si falla. */
export async function capturarSalidaConGrim(
  nombreSalida: string,
  ancho: number,
  alto: number,
): Promise<Gdk.Texture | null> {
  const nombreSeguro = nombreSalida.replace(/[^a-zA-Z0-9_.-]+/g, "-")
  const ruta = `${GLib.get_user_runtime_dir()}/gigishell-vista-previa-${nombreSeguro}.jpg`
  try {
    await execAsync(["grim", "-o", nombreSalida, "-t", "jpeg", "-q", "75", ruta])
    return Gdk.Texture.new_for_pixbuf(
      GdkPixbuf.Pixbuf.new_from_file_at_scale(ruta, ancho, alto, false),
    )
  } catch (_) {
    return null
  } finally {
    try { Gio.File.new_for_path(ruta).delete(null) } catch (_) {}
  }
}
