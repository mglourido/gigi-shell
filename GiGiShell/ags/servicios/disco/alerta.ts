// servicios/disco/alerta.ts — el EFECTO del aviso de disco casi lleno: leer la marca, decidir con
// `vigilancia.ts` (puro), emitir el `notify-send` y reescribir la marca.
//
// Va aparte de `vigilancia.ts` por la razón de siempre en este repo: ahí vive lo que se puede
// probar con `node --test`, y aquí lo que necesita GLib/Gio y no correría bajo el runner.
//
// Y va aparte de `analisis.ts` porque `analizar()` MIDE, y medir no debe notificar: quien decide
// que una medida recién tomada merece un aviso es la capa que la pidió (`usarAnalisis.ts`). Con
// la llamada dentro de `analizar()`, cualquier futuro consumidor —un preview, un test manual—
// dispararía avisos por el mero hecho de leer el disco.
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { Disco } from "./analisis"
import { componerAviso, decidirAvisos, leerAvisados, serializarAvisados } from "./vigilancia"

/**
 * Marca del último aviso por punto de montaje. **La comparte `hypr/scripts/disk-monitor.sh`**, que
 * la lee y la escribe con el mismo formato: son dos detectores del mismo evento y una espera que
 * no fuera común dejaría que el arranque y la primera apertura de Ajustes avisaran dos veces
 * seguidas de lo mismo.
 *
 * En `~/.cache` y no en `~/.config` porque es estado regenerable: perderlo solo adelanta un aviso.
 */
const MARCA = GLib.build_filenamev([GLib.get_user_cache_dir(), "gigios", "disco-avisos"])

function leerMarca(): Map<string, number> {
  try {
    const [ok, bytes] = GLib.file_get_contents(MARCA)
    if (!ok) return new Map()
    return leerAvisados(new TextDecoder().decode(bytes))
  } catch (_) {
    // Todavía no existe (primer arranque) o es ilegible: sin marca previa se avisa, que es el
    // lado seguro del error — como mucho se repite un aviso, nunca se calla uno.
    return new Map()
  }
}

function escribirMarca(avisados: ReadonlyMap<string, number>): void {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(MARCA), 0o755)
    GLib.file_set_contents(MARCA, serializarAvisados(avisados))
  } catch (e) {
    // No poder guardar la marca no puede impedir el aviso: ya se emitió. Lo peor que pasa es que
    // el siguiente análisis lo repita.
    console.error("[disco] no se pudo guardar la marca de avisos:", e)
  }
}

/**
 * Comprueba los discos de un análisis RECIÉN medido y avisa si alguno está al límite.
 *
 * No hacer nada es el caso normal y cuesta una lectura de un fichero de pocas líneas que ya está
 * en la caché de páginas. No llamarlo con un análisis leído de la caché en disco: esa medida puede
 * ser de hace días y avisaría de un disco que ya se vació.
 */
export function revisarDiscos(discos: readonly Disco[]): void {
  const ahora = Math.floor(Date.now() / 1000)
  const previos = leerMarca()
  const { avisar, avisados } = decidirAvisos(discos, previos, ahora)

  const aviso = componerAviso(avisar)
  if (aviso) {
    try {
      Gio.Subprocess.new(
        ["notify-send", "-u", "critical",
         "-h", "string:x-gigios-source:system",
         // El MISMO id que emite `disk-monitor.sh`: quien silencia el aviso del arranque quiere
         // callado también este. Ver `modulos/notificaciones/rules/catalogoSistema.ts`.
         "-h", "string:x-gigios-event:disco.casi-lleno",
         "-a", "Disco", "-i", "drive-harddisk", "-t", "15000",
         aviso.titulo, aviso.cuerpo],
        Gio.SubprocessFlags.NONE,
      )
    } catch (e) {
      console.error("[disco] no se pudo avisar de disco casi lleno:", e)
      return   // sin aviso emitido no se toca la marca: el siguiente análisis vuelve a intentarlo
    }
  }

  // Se reescribe SIEMPRE que cambie, no solo al avisar: `decidirAvisos` también BORRA las marcas
  // de los discos que ya no están al límite, y esa es la mitad que hace que un disco liberado y
  // vuelto a llenar avise en el acto en vez de esperar la ventana entera.
  if (cambiada(previos, avisados)) escribirMarca(avisados)
}

/** Comparación por CONTENIDO, no por el texto serializado: los dos mapas se construyen en órdenes
 *  distintos (el fichero conserva el de escritura, `decidirAvisos` sigue el de `df`), así que
 *  comparar cadenas reescribiría el fichero en cada análisis sin que nada hubiera cambiado. */
function cambiada(previos: ReadonlyMap<string, number>, nuevos: ReadonlyMap<string, number>): boolean {
  if (previos.size !== nuevos.size) return true
  for (const [punto, epoch] of nuevos) if (previos.get(punto) !== epoch) return true
  return false
}
