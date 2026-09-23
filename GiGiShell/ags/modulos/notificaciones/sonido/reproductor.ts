// Reproducción de los sonidos de notificación. Es la única pieza con efectos del subsistema de
// audio de notificaciones; la decisión de si suena vive en `decision.ts`, que es puro y probado.
//
// **Falla en silencio a propósito.** Sin `canberra-gtk-play`, sin el fichero o con el sonido ausente
// del tema, no se notifica el error: una notificación que no suena es un inconveniente, pero una
// notificación de error *sobre* una notificación que no suena es un bucle de ruido. El fallo queda
// en el log y nada más.

import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { candidatosTema, comandoReproduccion, decidirSonido, expandirRuta } from "./decision.ts"
import type { DecisionSonido, EntradaSonido } from "./decision.ts"
import { RAIZ_REPO } from "../../../utilidades/rutas"

/**
 * Los audios que van dentro del repo (`~/GiGiShell/audio`). Se usa la ruta directa, sin symlink,
 * igual que `Wallpapers/`: es contenido del repositorio, no configuración XDG.
 */
export const DIR_AUDIO = `${RAIZ_REPO}/audio`

const cacheProgramas = new Map<string, boolean>()

/**
 * Convierte un nombre de tema en la ruta de la biblioteca propia, si la carpeta lo lleva.
 *
 * No se cachea: la carpeta es del usuario y puede ganar o perder ficheros con la sesión abierta,
 * y un `file_test` por sonido reproducido no se nota al lado de arrancar un proceso de audio.
 */
function resolverTema(decision: DecisionSonido): DecisionSonido {
  if (!decision.reproducir || decision.tipo !== "tema") return decision
  for (const ruta of candidatosTema(decision.recurso, DIR_AUDIO)) {
    if (GLib.file_test(ruta, GLib.FileTest.EXISTS)) {
      return { reproducir: true, tipo: "archivo", recurso: ruta }
    }
  }
  return decision
}

function disponible(programa: string): boolean {
  const memo = cacheProgramas.get(programa)
  if (memo !== undefined) return memo
  const existe = GLib.find_program_in_path(programa) !== null
  cacheProgramas.set(programa, existe)
  return existe
}

/**
 * Reproduce el sonido que pida la notificación, si procede.
 *
 * No espera al proceso ni encadena reproducciones: una ráfaga de notificaciones sonoras se solapa,
 * que es lo que hace también cualquier otro escritorio. Serializar obligaría a mantener una cola y
 * a decidir qué hacer con la que llega la número quince.
 */
export function reproducirSonidoNotificacion(entrada: EntradaSonido): void {
  // El `~` se expande aquí y no en `decision.ts`: la decisión es pura y no puede preguntar por el
  // directorio del usuario. Las rutas las teclea una persona en Ajustes, así que llegan con `~`.
  const home = GLib.get_home_dir()
  const decision = decidirSonido({
    ...entrada,
    soundFile: entrada.soundFile ? expandirRuta(entrada.soundFile, home) : entrada.soundFile,
    sonidoRegla: entrada.sonidoRegla ? expandirRuta(entrada.sonidoRegla, home) : entrada.sonidoRegla,
  })
  if (!decision.reproducir) return

  // La biblioteca propia gana al tema instalado: es la que se versiona con el sistema, así que es
  // la que suena igual en cualquier máquina — y la que hace que las alarmas suenen sin depender de
  // que `sound-theme-freedesktop` esté instalado.
  const efectiva = resolverTema(decision)
  const comando = comandoReproduccion(efectiva, disponible)
  if (comando === null) {
    console.warn(
      `[notif sonido] no hay reproductor para ${efectiva.tipo} «${efectiva.recurso}»` +
        (efectiva.tipo === "tema" ? " (requiere canberra-gtk-play, paquete libcanberra)" : ""),
    )
    return
  }

  execAsync(comando).catch((e) => {
    console.warn(`[notif sonido] ${comando[0]} falló:`, e)
  })
}

/**
 * Reproduce un fichero ya, sin pasar por ninguna guarda. Es el botón «Probar» de Ajustes y del
 * formulario de alarmas: ahí el usuario está pidiendo *este* audio a propósito, así que ni el No
 * molestar ni las reglas pintan nada — lo que quiere saber es si la ruta que ha escrito suena.
 *
 * Devuelve `false` si no hay con qué reproducir; el fallo posterior (fichero ilegible, formato
 * raro) sigue muriendo en el log, como en el resto del módulo.
 */
export function reproducirArchivo(ruta: string): boolean {
  const expandida = expandirRuta(ruta.trim(), GLib.get_home_dir())
  if (expandida === "") return false
  const comando = comandoReproduccion(
    { reproducir: true, tipo: "archivo", recurso: expandida },
    disponible,
  )
  if (comando === null) return false
  execAsync(comando).catch((e) => console.warn(`[notif sonido] prueba de «${expandida}» falló:`, e))
  return true
}

/** ¿Existe el fichero de audio? Para avisar en el editor de una ruta mal escrita — nunca para
 *  impedir guardarla (ver `rules/validate.ts`). */
export function existeAudio(ruta: string): boolean {
  const expandida = expandirRuta(ruta.trim(), GLib.get_home_dir())
  return expandida !== "" && GLib.file_test(expandida, GLib.FileTest.EXISTS)
}
