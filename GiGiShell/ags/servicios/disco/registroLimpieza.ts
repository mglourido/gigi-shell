// servicios/disco/registroLimpieza.ts — cuándo se limpió por última vez, y cuándo toca.
//
// El dato vive en `~/.cache/gigishell/limpieza.json`, el MISMO fichero que usa
// `hypr/scripts/limpieza-arranque.sh` para su intervalo, con tres marcas (epoch en segundos):
//
//   ultima        la que cuenta para el intervalo: la escribe el script al limpiar el lote,
//                 sea en el arranque o con «Ejecutar ahora».
//   ultimaAuto    la última autolimpieza al iniciar sesión.
//   ultimaManual  la última limpieza pedida a mano: «Ejecutar ahora» (la anota el script) o un
//                 botón suelto de «Liberar espacio» (la anota `marcarLimpiezaManual`, aquí).
//
// No se vigila el fichero: el script escribe a t=12 del arranque, con AGS ya levantado, así que la
// vista llama a `releerRegistroLimpieza()` al montarse. Leerlo son unos bytes, síncrono.
import GLib from "gi://GLib"
import { createState } from "ags"

const RUTA = `${GLib.get_user_cache_dir()}/gigishell/limpieza.json`

export interface RegistroLimpieza {
  ultima: number
  ultimaAuto: number
  ultimaManual: number
}

const VACIO: RegistroLimpieza = { ultima: 0, ultimaAuto: 0, ultimaManual: 0 }

export const [registroLimpieza, setRegistroLimpieza] = createState<RegistroLimpieza>(VACIO)

function marca(valor: unknown): number {
  return typeof valor === "number" && Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : 0
}

function leer(): RegistroLimpieza {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA)
    if (!ok) return VACIO
    const g = JSON.parse(new TextDecoder().decode(contenido))
    const ultima = marca(g.ultima)
    return {
      ultima,
      // Un fichero de antes de existir `ultimaAuto` solo tiene `ultima`, que casi siempre fue la
      // del arranque: se toma como automática en vez de enseñar «nunca» hasta la siguiente.
      ultimaAuto: "ultimaAuto" in g ? marca(g.ultimaAuto) : ultima,
      ultimaManual: marca(g.ultimaManual),
    }
  } catch (_) {
    return VACIO
  }
}

export function releerRegistroLimpieza(): void {
  setRegistroLimpieza(leer())
}

/**
 * Anota una limpieza manual suelta. Se relee el fichero justo antes de escribir para no pisar una
 * marca que el script haya puesto mientras tanto, y `ultima` se conserva: una acción suelta no
 * reinicia el intervalo de la automática.
 */
export function marcarLimpiezaManual(): void {
  const actual = { ...leer(), ultimaManual: Math.floor(Date.now() / 1000) }
  try {
    const dir = GLib.path_get_dirname(RUTA)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(RUTA, JSON.stringify(actual) + "\n")
  } catch (_) {
    /* perder la marca solo deja la cabecera desfasada */
  }
  setRegistroLimpieza(actual)
}

/** Lo que falta hasta que el intervalo deje de frenar la autolimpieza; 0 si ya toca. */
export function segundosHastaAutolimpieza(r: RegistroLimpieza, intervaloHoras: number, ahora: number): number {
  return Math.max(0, r.ultima + intervaloHoras * 3600 - ahora)
}

/** «3 d 4 h», «5 h 12 min», «8 min». Nunca «0 min»: por debajo del minuto se redondea a 1. */
export function formatearDuracion(segundos: number): string {
  const minutos = Math.max(1, Math.ceil(segundos / 60))
  const d = Math.floor(minutos / 1440)
  const h = Math.floor((minutos % 1440) / 60)
  const m = minutos % 60
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`
  return `${m} min`
}

releerRegistroLimpieza()
