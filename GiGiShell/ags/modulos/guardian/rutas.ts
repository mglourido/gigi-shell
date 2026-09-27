// modulos/guardian/rutas.ts — cómo se enseña una ruta en la ventana de pregunta
// y en Ajustes > Protección de archivos. Solo presentación: el daemon trabaja
// siempre con la ruta absoluta.
import GLib from "gi://GLib"

const HOME = GLib.get_home_dir()

/** Último componente de la ruta. */
export function nombreArchivo(ruta: string): string {
  return ruta.split("/").pop() || ruta
}

/** Carpeta que contiene la ruta, con `~` en lugar del HOME. */
export function carpetaCorta(ruta: string): string {
  const carpeta = ruta.slice(0, ruta.lastIndexOf("/")) || "/"
  if (carpeta === HOME) return "~"
  return carpeta.startsWith(HOME + "/") ? "~" + carpeta.slice(HOME.length) : carpeta
}

/** Nombre corto de un programa a partir de la ruta de su ejecutable. */
export function nombrePrograma(exe: string): string {
  return nombreArchivo(exe)
}
