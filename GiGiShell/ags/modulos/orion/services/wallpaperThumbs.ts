// modulos/orion/services/wallpaperThumbs.ts
//
// Caché de miniaturas en disco para la rejilla de fondos (RiceSection).
//
// El problema: los fondos son enormes (hasta 8192x6144 PNG, ~200 MB la carpeta).
// Para pintar una miniatura de 168x96, GdkPixbuf tiene que descomprimir la
// imagen COMPLETA en RAM y luego escalarla — el coste no depende del tamaño al
// que se muestre, sino del original. Haciéndolo en el hilo principal
// (`new_from_file_at_scale`) el shell se congelaba ~3,8 s al abrir la sección en
// cada sesión nueva.
//
// Aquí, en tres pasos:
//   1. Cada fondo tiene su miniatura en ~/.cache/gigios/wp-thumbs/, con clave =
//      hash(ruta|tamaño|mtime|dimensiones). La caché es por fichero, así que se
//      genera SOLO lo que falta: añadir un fondo nuevo, o borrar media caché a
//      mano, solo cuesta regenerar eso. Y si un fondo se edita, cambian tamaño y
//      mtime => cambia la clave => la miniatura se rehace sola.
//   2. Lo cacheado se carga con Gdk.Texture sobre un JPEG de 336x192 — 30 ms los
//      42 fondos, contra 3813 ms del código anterior. Este es el caso normal.
//   3. Lo que falta se genera en un SUBPROCESO (`magick`), no en el hilo del
//      shell: la primera pasada baja a ~2,2 s y, sobre todo, el main loop se
//      queda libre al 97% (medido) en vez de bloqueado, así que la UI sigue
//      fluida mientras las miniaturas van apareciendo. Sin ImageMagick se cae al
//      decodificado asíncrono de GdkPixbuf (más lento, pero sin dependencias).
//
// Tolerancia a caché corrupta: una miniatura ilegible (0 bytes, escritura a
// medias por un apagón, PNG truncado…) hace que Gdk.Texture lance; se captura,
// se borra el fichero y se re-encola la generación desde el original. Nunca es
// fatal: en el peor caso una miniatura no se pinta y el fondo sigue siendo
// clicable. Al terminar se podan las miniaturas huérfanas (fondos ya borrados).

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gdk from "gi://Gdk"
import GdkPixbuf from "gi://GdkPixbuf"

const CACHE_DIR = `${GLib.get_user_cache_dir()}/gigios/wp-thumbs`

// Tamaño lógico de la miniatura en la rejilla.
export const THUMB_W = 168
export const THUMB_H = 96

// Se cachea al doble para que se vea nítida en pantallas HiDPI (scale 2).
const PIX_W = THUMB_W * 2
const PIX_H = THUMB_H * 2

// Generaciones simultáneas. Con subproceso es paralelismo real; en el fallback
// cada 8K en vuelo son ~200 MB de RAM, así que no conviene subirlo.
const MAX_INFLIGHT = 4

// Miniaturas cacheadas que se cargan por iteración de idle.
const CACHED_PER_TICK = 6

// Las miniaturas se guardan en JPEG, no en PNG: a este tamaño la caché entera
// pasa de 3,1 MB a 580 KB (medido con 42 fondos) y a simple vista son idénticas.
// Comprimir los ficheros con gzip, en cambio, no ahorraría NADA — un PNG ya es
// un flujo deflate — y añadiría una descompresión en cada carga.
const JPEG_QUALITY = 85

const HAS_MAGICK = GLib.find_program_in_path("magick") !== null

type OnThumb = (path: string, texture: Gdk.Texture) => void
type Job = { path: string; file: string }

function cacheKeyFor(path: string): string | null {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "standard::size,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const mtime = info.get_modification_date_time()?.to_unix() ?? 0
    const key = `${path}|${info.get_size()}|${mtime}|${PIX_W}x${PIX_H}`
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1) + ".jpg"
  } catch (_) {
    return null // fondo ilegible o desaparecido entre el listado y ahora
  }
}

function discard(file: string) {
  try { Gio.File.new_for_path(file).delete(null) } catch (_) {}
}

// Borra miniaturas que ya no corresponden a ningún fondo actual: fondos
// eliminados, o versiones viejas de uno que se editó. Mantiene la caché acotada.
function prune(valid: Set<string>) {
  try {
    const enumr = Gio.File.new_for_path(CACHE_DIR)
      .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: Gio.FileInfo | null
    while ((info = enumr.next_file(null)) !== null) {
      const name = info.get_name()
      if (!valid.has(name)) discard(`${CACHE_DIR}/${name}`)
    }
  } catch (_) { /* caché aún inexistente o ilegible: nada que podar */ }
}

/**
 * Carga las miniaturas de `paths` y llama a `onThumb(path, texture)` según van
 * estando listas: las cacheadas casi de inmediato, el resto conforme se generan.
 * Nunca bloquea el hilo principal.
 *
 * ⚠️ `podar` (por defecto `true`) BORRA de la caché todo lo que no esté en
 * `paths`. Es correcto para la rejilla, que pasa la lista completa de fondos y
 * así se lleva por delante lo que ya no existe. Pero llamar a esto con un
 * SUBCONJUNTO —una sola imagen para un chip del editor de grupos— borraría el
 * resto de la caché en silencio, y las 41 miniaturas restantes se regenerarían
 * en la siguiente apertura (~2 s de `magick`). Quien pida un subconjunto tiene
 * que pasar `podar: false`.
 */
export function loadThumbnails(paths: string[], onThumb: OnThumb, opciones?: { podar?: boolean }) {
  try { GLib.mkdir_with_parents(CACHE_DIR, 0o755) } catch (_) {}

  const cached: Job[] = []
  const missing: Job[] = []
  const valid = new Set<string>()

  for (const path of paths) {
    const key = cacheKeyFor(path)
    if (!key) continue
    valid.add(key)
    const file = `${CACHE_DIR}/${key}`
    if (GLib.file_test(file, GLib.FileTest.EXISTS)) cached.push({ path, file })
    else missing.push({ path, file })
  }

  if (opciones?.podar !== false) prune(valid)

  // ── Cola de generación ─────────────────────────────────────────────────────
  // `missing` puede CRECER mientras se vacía: una miniatura cacheada que resulte
  // estar corrupta se re-encola aquí abajo. Por eso `pump` se define antes que el
  // idle que la lee, y el idle lo vuelve a llamar tras encolar — si no, una
  // corrupta descubierta después de que la cola se vaciara no se regeneraría
  // nunca (y con la caché entera corrupta, `missing` empezaría vacío y no habría
  // ningún `done()` que reactivara la bomba).
  let next = 0
  let inflight = 0

  const pump = () => {
    while (inflight < MAX_INFLIGHT && next < missing.length) {
      const { path, file } = missing[next++]
      inflight++
      const done = () => { inflight--; pump() }
      const show = () => {
        try {
          onThumb(path, Gdk.Texture.new_from_filename(file))
        } catch (_) {
          discard(file) // se generó algo ilegible: fuera, no la damos por buena
        }
      }
      if (HAS_MAGICK) generateWithMagick(path, file, show, done)
      else            generateWithPixbuf(path, file, onThumb, done)
    }
  }

  // ── 1. Lo ya cacheado: lectura directa, en tandas ───────────────────────────
  let i = 0
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    let requeued = false
    for (let n = 0; n < CACHED_PER_TICK && i < cached.length; n++) {
      const { path, file } = cached[i++]
      try {
        onThumb(path, Gdk.Texture.new_from_filename(file))
      } catch (_) {
        // Miniatura corrupta o truncada: se tira y se regenera del original.
        discard(file)
        missing.push({ path, file })
        requeued = true
      }
    }
    if (requeued) pump()
    return i < cached.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
  })

  // ── 2. Lo que falta: generar fuera del hilo principal ───────────────────────
  pump()
}

// Camino normal: ImageMagick en un proceso aparte. El shell no decodifica nada.
function generateWithMagick(path: string, file: string, show: () => void, done: () => void) {
  try {
    // `[0]` = primer fotograma (webp/gif animados). `-thumbnail` escala y tira
    // los metadatos; conserva la proporción y encaja dentro de PIX_W x PIX_H.
    // `-alpha remove` aplana la transparencia (algún fondo PNG la trae y JPEG no
    // la soporta: sin esto los huecos saldrían en blanco).
    const proc = Gio.Subprocess.new(
      [
        "magick", `${path}[0]`,
        "-thumbnail", `${PIX_W}x${PIX_H}`,
        "-background", "black", "-alpha", "remove", "-alpha", "off",
        "-quality", String(JPEG_QUALITY), "-strip",
        file,
      ],
      Gio.SubprocessFlags.STDERR_SILENCE,
    )
    proc.wait_async(null, (p, res) => {
      try {
        const sub = p as Gio.Subprocess
        sub.wait_finish(res)
        if (sub.get_successful()) show()
        else discard(file) // magick falló a media escritura: no dejar restos
      } catch (_) {
        discard(file)
      }
      done()
    })
  } catch (_) {
    done() // no se pudo lanzar el proceso: ese fondo se queda sin miniatura
  }
}

// JPEG no admite transparencia y su codificador la rechaza de plano ("does not
// support the color type Rgba8"), así que un fondo PNG con alpha se quedaría sin
// miniatura. Se compone sobre negro, igual que hace `-alpha remove` en magick.
function flatten(pb: GdkPixbuf.Pixbuf): GdkPixbuf.Pixbuf {
  if (!pb.get_has_alpha()) return pb
  const w = pb.get_width()
  const h = pb.get_height()
  const flat = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h)
  if (!flat) return pb
  flat.fill(0x000000ff)
  pb.composite(flat, 0, 0, w, h, 0, 0, 1, 1, GdkPixbuf.InterpType.NEAREST, 255)
  return flat
}

// Fallback sin ImageMagick: GdkPixbuf en su thread pool (no en el main loop).
function generateWithPixbuf(path: string, file: string, onThumb: OnThumb, done: () => void) {
  let stream: Gio.FileInputStream
  try {
    stream = Gio.File.new_for_path(path).read(null)
  } catch (_) {
    done()
    return
  }

  GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
    stream, PIX_W, PIX_H, true, null,
    (_src, res) => {
      try {
        const pb = flatten(GdkPixbuf.Pixbuf.new_from_stream_finish(res)!)
        onThumb(path, Gdk.Texture.new_for_pixbuf(pb))
        // Guardar la miniatura cuesta ~nada; la próxima sesión ya la usa.
        try {
          pb.savev(file, "jpeg", ["quality"], [String(JPEG_QUALITY)])
        } catch (_) { discard(file) }
      } catch (_) { /* imagen ilegible => se omite */ }
      try { stream.close(null) } catch (_) {}
      done()
    },
  )
}
