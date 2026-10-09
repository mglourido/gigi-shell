import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { withPrivilegedPrompt } from "../../../estado/shell"
import textos from "../../../textos/ajustes/cuenta.json" with { type: "json" }

/** El diálogo es una ventana normal: apartar la capa OVERLAY lo deja accesible.
 * Cancelar no altera la foto ni se trata como un fallo. */
export default function elegirFotoPerfil(cancelacion: Gio.Cancellable): Promise<string | null> {
  return withPrivilegedPrompt(() => new Promise((resolve, reject) => {
    const filtro = new Gtk.FileFilter({ name: textos.perfil.foto.imagenes })
    filtro.add_pixbuf_formats()
    const filtros = new Gio.ListStore({ item_type: Gtk.FileFilter })
    filtros.append(filtro)
    const dialogo = new Gtk.FileDialog({
      title: textos.perfil.foto.dialogo, modal: true, filters: filtros, defaultFilter: filtro,
    })
    dialogo.open(null, cancelacion, (_dialogo, resultado) => {
      try {
        resolve(dialogo.open_finish(resultado)?.get_path() ?? null)
      } catch (error) {
        if (cancelacion.is_cancelled() || (error instanceof GLib.Error && (
          error.matches(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED)
          || error.matches(Gtk.dialog_error_quark(), Gtk.DialogError.CANCELLED)
        ))) resolve(null)
        else reject(error)
      }
    })
  }))
}
