// utilidades/rutas.ts
//
// Raíz del repositorio (`~/GiGiShell`), para lo que AGS lee directamente del árbol sin pasar
// por una ruta XDG: `Wallpapers/`, `audio/`, `install.sh`, `system/`.
//
// Se DERIVA de dónde vive el propio shell en vez de escribirse a mano: `~/.config/ags` es un
// symlink a `<raíz>/ags` (lo crea `bin/link.sh`), así que la raíz es el padre de su destino.
// Con la ruta fija, mover o renombrar la carpeta del repo dejaba fondos y sonidos apuntando a un
// directorio que ya no existe — sin error: la galería salía vacía y las alarmas mudas.
// Si el symlink no está (AGS lanzado desde el árbol, instalación a medias) se cae a la ruta
// canónica, que es donde la deja `install.sh`.

import GLib from "gi://GLib"

function resolverRaiz(): string {
  const enlace = `${GLib.get_user_config_dir()}/ags`
  try {
    const destino = GLib.file_read_link(enlace)
    const absoluto = GLib.path_is_absolute(destino)
      ? destino
      : GLib.build_filenamev([GLib.path_get_dirname(enlace), destino])
    return GLib.path_get_dirname(GLib.canonicalize_filename(absoluto, null))
  } catch {
    return `${GLib.get_home_dir()}/GiGiShell`
  }
}

export const RAIZ_REPO = resolverRaiz()
