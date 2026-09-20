import { createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import textos from "../../../textos/ajustes/cuenta.json" with { type: "json" }

// XDG_DATA_HOME, no el cache: la foto se elige en Ajustes y no se regenera desde
// ningún master, así que en ~/.cache un limpiador la borraría para siempre. La
// comparten hyprlock (hyprlock.conf) y bin/link.sh (que migra la ruta vieja).
export const AVATAR_PATH = `${GLib.get_user_data_dir()}/gigios/face.png`

// Lado de la copia que se guarda. Los consumidores pintan círculos pequeños —AGS a
// 30 px (barra) y 46 px (Ajustes > Cuenta), hyprlock a 26 px con `rounding = -1`—,
// así que 1024 es holgado a propósito: la foto se importa UNA vez y es la única que
// queda (el original puede desaparecer), mientras que guardarla a la medida de hoy
// obligaría a volver a pedirla el día que un consumidor crezca o el monitor tenga
// más escala. Lo que sí se recorta es lo que no aporta nada: una foto de móvil de
// 12 MP se decodificaba entera —en AGS, en cada redibujado— para caber en un botón.
const LADO_AVATAR = 1024

// El recorte cuadrado se hace AQUÍ, al importar, y no al pintar: con la copia ya
// cuadrada los tres consumidores enseñan el mismo encuadre sin ponerse de acuerdo
// (AGS lo recorta por código en `AvatarPerfil.tsx`; hyprlock, con lo que decida su
// bloque `image`). Una foto apaisada es donde se nota.
function cuadrarYReducir(origen: string): GdkPixbuf.Pixbuf {
  const [, anchoOrigen, altoOrigen] = GdkPixbuf.Pixbuf.get_file_info(origen)
  if (!anchoOrigen || !altoOrigen || anchoOrigen < 0 || altoOrigen < 0) {
    throw new Error(textos.avisos.imagenInvalida)
  }

  // UNA sola reducción de calidad, y al final. Aquí solo se acota lo que llega a
  // memoria: `new_from_file_at_scale` engancha `size-prepared`, así que una foto de
  // 50 MP nunca se decodifica entera. El techo es el DOBLE del objetivo porque
  // reducir en dos pasos (decodificar justo a 1024 y volver a escalar) emborrona, y
  // porque al filtro final le viene bien tener de sobra. Con `preserve_aspect_ratio`
  // la caja AMPLIARÍA una imagen ya pequeña, así que solo se aplica si hay que tirar.
  const menorLado = Math.min(anchoOrigen, altoOrigen)
  const techo = LADO_AVATAR * 2
  const factor = menorLado > techo ? techo / menorLado : 1
  const pixbuf = factor < 1
    ? GdkPixbuf.Pixbuf.new_from_file_at_scale(origen, Math.ceil(anchoOrigen * factor), Math.ceil(altoOrigen * factor), true)
    : GdkPixbuf.Pixbuf.new_from_file(origen)
  if (!pixbuf) throw new Error(textos.avisos.imagenInvalida)

  // Las fotos de móvil vienen derechas por EXIF, no por píxeles: sin esto una
  // vertical se guarda TUMBADA, y el recorte cuadrado se lleva media cara. GdkPixbuf
  // no lo aplica solo, solo deja la etiqueta como opción del pixbuf.
  const derecho = pixbuf.apply_embedded_orientation() ?? pixbuf

  const lado = Math.min(derecho.get_width(), derecho.get_height())
  // Método del pixbuf, no función estática con el origen de primer argumento: eso
  // es la forma de PyGObject y aquí sale como `new_subpixbuf is not a function`.
  const recorte = derecho.new_subpixbuf(
    Math.floor((derecho.get_width() - lado) / 2),
    Math.floor((derecho.get_height() - lado) / 2),
    lado,
    lado,
  )
  // Nada que reducir: una foto ya pequeña se guarda tal cual antes que ampliarla.
  if (lado <= LADO_AVATAR) return recorte
  // HYPER y no BILINEAR: el bilineal de GdkPixbuf está pensado para ampliar y al
  // encoger deja la cara lavada; HYPER es el que la documentación manda para
  // reducir. Es el filtro caro, pero corre una sola vez, al elegir la foto.
  return recorte.scale_simple(LADO_AVATAR, LADO_AVATAR, GdkPixbuf.InterpType.HYPER) ?? recorte
}

/**
 * Importa `origen` como foto de perfil: recorte cuadrado centrado, reducción a
 * {@link LADO_AVATAR} y PNG en {@link AVATAR_PATH}.
 *
 * La escritura es en un temporal + `move`, no directa sobre el destino: hyprlock o
 * el propio AGS pueden estar leyendo el fichero, y un PNG a medio escribir se lee
 * como imagen corrupta (avatar en blanco) en vez de dar un error.
 */
export function importarFotoPerfil(origen: string): void {
  const destino = Gio.File.new_for_path(AVATAR_PATH)
  const temporal = Gio.File.new_for_path(`${AVATAR_PATH}.nuevo`)
  GLib.mkdir_with_parents(GLib.path_get_dirname(AVATAR_PATH), 0o700)
  cuadrarYReducir(origen).savev(temporal.get_path()!, "png", [], [])
  temporal.move(destino, Gio.FileCopyFlags.OVERWRITE, null, null)
}

export const [avatarRevision, setAvatarRevision] = createState(0)

export function refreshAvatar(): void {
  setAvatarRevision(avatarRevision.get() + 1)
}
