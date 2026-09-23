// servicios/fondos/acento.ts
//
// Acento adaptativo: el color de acento del shell sale del fondo de escritorio.
//
// CÓMO SE APLICA SIN RECOMPILAR NADA
// ----------------------------------
// Desde que `estilos/_colores.scss` tiene las funciones `acento*()`, los ~250
// sitios del tema que llevaban un acento a mano compilan a `var(--acento…, color
// de siempre)`. Aquí solo hace falta definir esas variables: una hoja de una línea
// en un CssProvider propio, y GTK repinta el shell entero. Apagarlo es vaciar esa
// misma hoja: cada `var()` cae en su reserva y vuelven los colores de siempre.
// Nadie tiene que enumerar qué widgets llevan acento, que es justo lo que haría
// que esto se pudriera al añadir el siguiente.
//
// SON TRES ACENTOS, y ese es el arreglo del primer intento: hacer adaptativo solo
// el azul no cambiaba casi nada, porque **la barra nunca fue azul** (en su CSS el
// azul salía 2 veces frente a 4 del violeta y 3 del turquesa). Ver el reparto de
// papeles en el bloque "Acentos" de `_colores.scss`.
//
// ⚠️ NO SE USA `app.apply_css()`, Y NO ES UN CAPRICHO. Ese método CREA UN PROVIDER
// NUEVO en cada llamada y lo apila (`#cssProviders`), así que una sesión que cambie
// de fondo por franjas horarias iría acumulando providers muertos toda la tarde. Y
// su modo `reset` no sirve de escape: `reset_css()` retira TODOS los providers de
// la app, incluido el de `out.css`, o sea que dejaría el shell sin tema. Un
// provider nuestro recargado con `load_from_string()` no tiene ninguno de los dos
// problemas (comprobado en GTK 4.22: la recarga se ve al vuelo y vaciarlo devuelve
// el fallback).
//
// EL COLOR LO SACA UN SCRIPT, NO ESTE MÓDULO
// ------------------------------------------
// `ags/scripts/acento-fondo.py` (Pillow) hace la cuantización y la corrección de
// legibilidad; ahí está documentado por qué el dominante a secas no vale. Va fuera
// del proceso a propósito: son ~150 ms de CPU por fondo y en el hilo de AGS serían
// 150 ms de interfaz congelada. `execAsync` mantiene eso fuera del bucle de GTK.
//
// El extractor puede decir QUE NO HAY ACENTO (un fondo en blanco y negro, una
// captura de pantalla): sale con 1 y sin línea, y entonces el tema se queda con
// sus colores. Es deliberado que ese caso no invente una paleta.
//
// Y NO SE LE LLAMA DOS VECES POR LA MISMA IMAGEN: lo que devuelve se guarda en
// `~/.cache/gigios/acento-fondo.json`, sellado con el tamaño y el mtime de la imagen
// y los del propio extractor. Con la caché en frío un cambio de fondo cuesta lo de
// siempre (un `python3`, 150 ms fuera del hilo del shell); en caliente —o sea casi
// siempre: las franjas horarias rotan entre las MISMAS imágenes, y cada inicio de
// sesión vuelve a preguntar por el fondo que ya estaba puesto— cuesta un `stat` y se
// pinta en el acto, sin proceso. Las reglas están en `acentoCache.ts`.
//
// EN SEGUNDO PLANO ESTO NO CONSUME NADA, y no por casualidad: no hay temporizador ni
// sondeo ninguno: solo dos suscripciones. Se recalcula cuando cambia el fondo (lo
// avisa el `FileMonitor` de `wallpaper.json`, o sea inotify) y cuando se enciende o
// apaga el ajuste. Un `Accessor` de `createState` además NO notifica si el valor no
// cambia, así que reescribir `wallpaper.json` con el mismo fondo —el toggle de
// "aleatorio al iniciar", o una franja que vuelve a elegir la misma imagen— no
// dispara nada. Si algún día esto empieza a costar CPU con el escritorio quieto,
// el fallo está en quien llame a `recalcular()`, no aquí.

import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { acentoAdaptativoEnabled } from "../../modulos/ajustes/preferences"
import { currentWallpaper } from "../../modulos/orion/data/wallpaperConfig"
import {
  buscarEntrada, conEntrada, leerEntradas, sello, serializarEntradas,
  type EntradaAcento,
} from "./acentoCache"
import { hojaDePaleta, paletaDeSalida } from "./acentoCss"

const EXTRACTOR = `${GLib.get_user_config_dir()}/ags/scripts/acento-fondo.py`
const CACHE = `${GLib.get_user_cache_dir()}/gigios/acento-fondo.json`

/** Lo que el extractor escribe en stderr cuando la imagen no tiene acento. Es la
 * única forma de distinguir ese caso: `execAsync` entrega stderr, no el código de
 * salida. Ver la nota de códigos de salida de `acento-fondo.py`. */
const MARCA_SIN_ACENTO = "sin-acento"

let arrancado = false
let provider: Gtk.CssProvider | null = null

// ── Caché en disco ────────────────────────────────────────────────────────────

/** `null` mientras no se haya leído el fichero (una vez por sesión). */
let entradas: EntradaAcento[] | null = null

/** Tamaño y mtime de un fichero, o `""` si no se puede medir (que vale como "no
 * cachees esto": sin poder comprobar que la imagen sigue igual, una entrada no
 * puede caducar nunca y serviría colores viejos para siempre). */
function selloDeFichero(ruta: string): string {
  try {
    const info = Gio.File.new_for_path(ruta).query_info(
      "standard::size,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    return sello(info.get_size(), info.get_modification_date_time()?.to_unix() ?? 0)
  } catch (_) {
    return ""
  }
}

/** El sello de la imagen JUNTO CON el del extractor: tocar el script invalida la
 * caché entera, que es lo que evita seguir viendo los colores del algoritmo viejo
 * sin ningún error que lo explique. */
function selloDe(fondo: string): string {
  const imagen = selloDeFichero(fondo)
  const script = selloDeFichero(EXTRACTOR)
  return imagen === "" || script === "" ? "" : sello(imagen, script)
}

function cargarCache(): EntradaAcento[] {
  if (entradas !== null) return entradas
  try {
    const [ok, contenido] = GLib.file_get_contents(CACHE)
    entradas = ok ? leerEntradas(new TextDecoder().decode(contenido)) : []
  } catch (_) {
    entradas = []   // no existe todavía, o es ilegible: se rehará sola
  }
  return entradas
}

function guardarCache(entrada: EntradaAcento) {
  entradas = conEntrada(cargarCache(), entrada)
  try {
    const dir = GLib.path_get_dirname(CACHE)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(CACHE, serializarEntradas(entradas))
  } catch (_) { /* sin caché en disco se sigue funcionando, solo más lento */ }
}

// Cada petición se numera y solo la última puede escribir. Sin esto, dos cambios
// de fondo seguidos (aplicar un grupo desde Orion es exactamente eso) pueden
// resolverse en orden inverso —son procesos distintos y no tardan lo mismo— y
// dejar puesto el acento del fondo ANTERIOR, que además no se corregiría hasta el
// siguiente cambio. El síntoma sería un acento que no pega con nada y que
// "se arregla solo" más tarde: imposible de atribuir sin este contador.
let peticion = 0

function pintar(hoja: string) {
  if (provider === null) return
  provider.load_from_string(hoja)
}

async function recalcular() {
  const token = ++peticion

  if (!acentoAdaptativoEnabled.get()) {
    pintar(hojaDePaleta(null))
    return
  }

  const fondo = currentWallpaper.get()
  // Sin fondo conocido no hay nada que extraer, pero tampoco hay que borrar el
  // acento vigente: `wallpaper.json` se reescribe entero en cada cambio y el
  // monitor puede pillarlo a medias. Un parpadeo al azul por eso sería peor que
  // conservar un instante el color anterior, que además es el mismo casi siempre.
  if (fondo === "") return

  // La caché primero, y SIN pasar por el bucle de eventos: acertar tiene que ser
  // pintar en el acto. Un `await` aquí metería un fotograma con los colores del
  // fondo anterior en el caso normal, que es justo el que hay que dejar fino.
  const selloActual = selloDe(fondo)
  if (selloActual !== "") {
    const guardada = buscarEntrada(cargarCache(), fondo, selloActual)
    if (guardada !== null) {
      pintar(hojaDePaleta(guardada.acentos))
      return
    }
  }

  let paleta: string[] | null = null
  let cacheable = selloActual !== ""
  try {
    paleta = paletaDeSalida(await execAsync(["python3", EXTRACTOR, fondo]))
    // Salida ilegible sin fallar (no debería pasar nunca): no se cachea, porque
    // no sabemos si el problema es de la imagen o del momento.
    cacheable = cacheable && paleta !== null
  } catch (error) {
    // rc != 0. Solo `sin-acento` es una propiedad de la IMAGEN y se puede guardar;
    // lo demás (Pillow ausente, fichero a medio copiar) es del entorno y cachearlo
    // dejaría el tema de fábrica clavado hasta vaciar la caché a mano.
    paleta = null
    cacheable = cacheable && String((error as Error)?.message ?? "").includes(MARCA_SIN_ACENTO)
  }

  if (cacheable) guardarCache({ ruta: fondo, sello: selloActual, acentos: paleta })

  if (token !== peticion) return   // llegó tarde: manda una petición posterior
  pintar(hojaDePaleta(paleta))
}

/**
 * Arranca el acento adaptativo. Idempotente.
 *
 * Va con el resto de `init*` de fondo (el `setTimeout` de 4 s de `app.ts`): el
 * shell arranca con sus colores de reserva —que son un tema completo y válido, no
 * un estado a medias— y se tiñe cuando el extractor contesta. Adelantarlo solo
 * pondría a competir un `python3` con el pintado de las ventanas.
 */
export function initAcentoAdaptativo() {
  if (arrancado) return
  arrancado = true

  const display = Gdk.Display.get_default()
  if (display === null) return   // sin display no hay shell al que teñir

  provider = new Gtk.CssProvider()
  provider.connect("parsing-error", (_p, _s, error) => {
    console.error("[acento] CSS inválido:", error.message)
  })
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)

  // Los dos disparos: cambiar de fondo y encender o apagar el ajuste. El segundo
  // tiene que recalcular de verdad, no solo repintar, porque al encenderlo el
  // acento del fondo que ya está puesto todavía no se ha extraído nunca.
  currentWallpaper.subscribe(() => void recalcular())
  acentoAdaptativoEnabled.subscribe(() => void recalcular())

  void recalcular()
}
