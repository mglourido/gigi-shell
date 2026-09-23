// Recorta la región de entrada de una ventana layer-shell a uno o varios widgets
// de contenido. Las partes transparentes de la superficie —esquinas, conectores,
// sombras y huecos entre tarjetas— dejan así pasar los clics sin alterar el dibujo.
import GLib from "gi://GLib"
import cairo from "gi://cairo"

interface OpcionesRecorteEntrada {
  /** Recorta cada contenido como un rectángulo redondeado en vez de conservar
   * las esquinas transparentes de su caja de asignación. */
  radioEsquinas?: number
  /** Deja la superficie sin entrada desde el mismo `map` hasta que GTK haya
   * asignado el contenido y pueda aplicarse su silueta definitiva. Evita que
   * aflore durante el primer frame el rectángulo predeterminado de la ventana. */
  vaciarAlMapear?: boolean
  /** Añade únicamente la silueta pintada de dos curvas laterales pegadas a las
   * esquinas inferiores, sin convertir sus anchos en franjas verticales. */
  radioCurvasInferioresLaterales?: number
  /** Mientras devuelva `true`, la región abarca la superficie entera en vez de la
   * silueta del contenido. Es para las animaciones de entrada con `transform`:
   * ahí `compute_bounds()` mide la posición DESPLAZADA (GTK4 pliega el transform
   * de CSS en la asignación del widget), así que cualquier silueta que se calcule
   * durante el recorrido deja muerta la parte del panel que aún no ha llegado. */
  superficieCompletaMientras?: () => boolean
  /** Vuelve a medir tras cada frame PINTADO y reaplica si la silueta cambió.
   * Hace falta cuando el contenido cambia de alto dentro de la ventana: al crecer,
   * `notify::height` de la superficie llega ANTES de que GTK reasigne los hijos a
   * la medida nueva (medido: superficie 348 px, contenido aún 198), así que el
   * tick+idle mide la asignación vieja, aplica una región corta y nada vuelve a
   * medir — la franja nueva de abajo se queda sin entrada. `after-paint` corre
   * con el layout ya hecho, y sin frames no corre: con la ventana quieta no cuesta
   * nada. Es opt-in porque un contenido que se mueve cada frame (el lagarto)
   * reaplicaría la región en cada uno. */
  seguirAsignacion?: boolean
}

function anadirRectanguloRedondeado(
  region: any,
  rect: { x: number; y: number; width: number; height: number },
  radioSolicitado: number,
): void {
  const radio = Math.max(0, Math.min(
    Math.floor(radioSolicitado),
    Math.floor(rect.width / 2),
    Math.floor(rect.height / 2),
  ))
  if (radio === 0) {
    region.unionRectangle(rect)
    return
  }

  // cairo.Region solo admite rectángulos enteros. Una franja por fila conserva
  // la parte clicable de la tarjeta y deja pasar los clics por sus cuatro
  // esquinas transparentes.
  for (let fila = 0; fila < rect.height; fila++) {
    const distanciaVertical = fila < radio
      ? radio - fila - 0.5
      : fila >= rect.height - radio
        ? fila - (rect.height - radio) + 0.5
        : 0
    const limiteCurva = distanciaVertical > 0
      ? radio - Math.sqrt(Math.max(0, radio * radio - distanciaVertical * distanciaVertical))
      : 0
    const recorteLateral = Math.max(0, Math.ceil(limiteCurva - 0.5))
    const ancho = rect.width - recorteLateral * 2
    if (ancho <= 0) continue

    region.unionRectangle({
      x: rect.x + recorteLateral,
      y: rect.y + fila,
      width: ancho,
      height: 1,
    })
  }
}

function anadirCurvasInferioresLaterales(
  region: any,
  rect: { x: number; y: number; width: number; height: number },
  radioSolicitado: number,
): void {
  const radio = Math.max(0, Math.min(Math.floor(radioSolicitado), rect.height))
  if (radio === 0) return

  // Las DrawingArea de Orion pintan el espacio situado debajo de un cuarto de
  // círculo. Una fila por píxel aproxima esa misma silueta en cairo.Region sin
  // conservar el cuadrado transparente que contiene cada curva.
  for (let fila = 0; fila < radio; fila++) {
    const yCentro = fila + 0.5
    const limiteCurva = Math.sqrt(Math.max(0, radio * radio - yCentro * yCentro))
    const inicioPintado = Math.min(radio, Math.ceil(limiteCurva - 0.5))
    const anchoPintado = radio - inicioPintado
    if (anchoPintado <= 0) continue

    const y = rect.y + rect.height - radio + fila
    region.unionRectangle({
      x: rect.x - radio + inicioPintado,
      y,
      width: anchoPintado,
      height: 1,
    })
    region.unionRectangle({
      x: rect.x + rect.width,
      y,
      width: anchoPintado,
      height: 1,
    })
  }
}

// Devuelve una función para volver a medir y aplicar la región. Hay que llamarla
// al terminar una animación CSS con `transform`: `compute_bounds()` devuelve la
// posición transformada y, sin esa segunda medición, el recorte quedaría desplazado.
// Los cambios de tamaño de la superficie y de visibilidad de los contenidos se
// observan automáticamente más abajo. Si cambia la geometría interna sin cambiar
// la superficie, el llamador debe invocar la función devuelta — o pedir
// `seguirAsignacion`, que además cubre el crecimiento de la superficie (ver la opción).
export function clipWindowInputToContent(
  win: any,
  contenido: any,
  opciones: OpcionesRecorteEntrada = {},
): (inmediato?: boolean) => void {
  let surfaceHandlers: { surface: any; ids: number[] } | null = null
  let framePendiente: number | null = null
  let aplicacionPendiente: number | null = null
  const contenidos = Array.isArray(contenido) ? contenido : [contenido]

  const vaciarRegionEntrada = (surface: any) => {
    if (!opciones.vaciarAlMapear || !surface) return
    try { surface.set_input_region(new (cairo as any).Region()) } catch (_) {}
  }

  // Firma de los rectángulos de la última región aplicada, para que el seguimiento
  // tras cada frame (`seguirAsignacion`) solo hable con el compositor si cambió.
  let ultimaFirma: string | null = null

  const medirContenidos = () => {
    const rectangulos: { x: number; y: number; width: number; height: number }[] = []
    for (const contenido of contenidos) {
      if (!contenido || contenido.get_visible?.() === false) continue
      const res = contenido.compute_bounds(win)
      // gjs devuelve [ok, Graphene.Rect].
      const ok = Array.isArray(res) ? res[0] : false
      const rect = Array.isArray(res) ? res[1] : null
      if (!ok || !rect) continue
      const x = Math.floor(rect.origin.x)
      const y = Math.floor(rect.origin.y)
      const w = Math.ceil(rect.size.width)
      const h = Math.ceil(rect.size.height)
      if (w <= 0 || h <= 0) continue
      rectangulos.push({ x, y, width: w, height: h })
    }
    return rectangulos
  }

  const firmaDe = (rectangulos: { x: number; y: number; width: number; height: number }[]) =>
    rectangulos.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(";")

  const apply = () => {
    try {
      const surface = win.get_surface?.()
      if (!surface) return

      if (opciones.superficieCompletaMientras?.()) {
        const ancho = surface.get_width?.() ?? 0
        const alto = surface.get_height?.() ?? 0
        // Sin medidas válidas se conserva la región anterior: la predeterminada de
        // un `map` ya es la superficie entera, que es justo lo que se busca aquí.
        if (ancho <= 0 || alto <= 0) return
        const completa = new (cairo as any).Region()
        completa.unionRectangle({ x: 0, y: 0, width: ancho, height: alto })
        surface.set_input_region(completa)
        ultimaFirma = null
        return
      }

      const rectangulos = medirContenidos()
      // No sustituir una región anterior por una vacía durante el desmontaje de
      // la ventana; el siguiente map volverá a medir todos los contenidos.
      if (rectangulos.length === 0) return

      const region = new (cairo as any).Region()
      for (const rectangulo of rectangulos) {
        if (opciones.radioEsquinas) {
          anadirRectanguloRedondeado(region, rectangulo, opciones.radioEsquinas)
        } else {
          region.unionRectangle(rectangulo)
        }
        if (opciones.radioCurvasInferioresLaterales) {
          anadirCurvasInferioresLaterales(
            region,
            rectangulo,
            opciones.radioCurvasInferioresLaterales,
          )
        }
      }
      surface.set_input_region(region)
      ultimaFirma = firmaDe(rectangulos)
    } catch (e) {
      // Si algo no está disponible, se conserva de forma segura la región predeterminada.
      console.error("[inputRegion] clip failed:", e)
    }
  }

  // `seguirAsignacion`: tras cada frame pintado el layout ya es el definitivo.
  // Si la silueta difiere de la aplicada se reaplica, y se pide un frame más para
  // que la región nueva viaje en un commit sin esperar a que otra cosa repinte.
  const alPintar = () => {
    if (opciones.superficieCompletaMientras?.()) return
    try {
      const rectangulos = medirContenidos()
      if (rectangulos.length === 0 || firmaDe(rectangulos) === ultimaFirma) return
    } catch (_) {
      return
    }
    apply()
    try { win.queue_draw?.() } catch (_) {}
  }

  let relojHandler: { reloj: any; id: number } | null = null
  const engancharReloj = () => {
    if (!opciones.seguirAsignacion) return
    const reloj = win.get_frame_clock?.()
    if (!reloj || relojHandler?.reloj === reloj) return
    if (relojHandler) {
      try { relojHandler.reloj.disconnect(relojHandler.id) } catch (_) {}
    }
    relojHandler = { reloj, id: reloj.connect("after-paint", alPintar) }
  }

  function programarAplicacionIdle(): void {
    if (aplicacionPendiente !== null) return
    aplicacionPendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      aplicacionPendiente = null
      apply()
      return GLib.SOURCE_REMOVE
    })
  }

  // Un idle pedido directamente desde el cambio reactivo puede ejecutarse antes
  // del siguiente layout. El tick entra en la fase de actualización; el idle que
  // deja programado se ejecuta cuando GTK ya ha asignado y pintado ese frame.
  // Así `compute_bounds()` ve el ancho nuevo de contenidos que crecen dentro de
  // una superficie constante, como el submenú derecho de Orion.
  // `inmediato` mide y aplica en el acto, sin esperar tick+idle. Hace falta para
  // capturar la región JUSTO antes de añadir la clase CSS que dispara el
  // transform de entrada: encolada como el resto, la medición corre en un idle
  // que puede llegar después de que el transform ya haya arrancado —
  // `compute_bounds()` devolvería entonces la posición desplazada de mitad de
  // animación, y esa sería la región que queda fija hasta el reclip final.
  const scheduleApply = (inmediato = false) => {
    if (inmediato) {
      framePendiente = null
      aplicacionPendiente = null
      apply()
      return
    }
    if (framePendiente !== null || aplicacionPendiente !== null) return
    try {
      framePendiente = win.add_tick_callback(() => {
        framePendiente = null
        programarAplicacionIdle()
        return false
      })
    } catch (_) {
      // Fail-open para superficies todavía sin reloj de frames.
      programarAplicacionIdle()
    }
  }

  // Gtk.Widget no publica la asignación como `notify::width/height` en GTK4.
  // La visibilidad sí es una propiedad observable y debe retirar o añadir el
  // widget a la región cuando el helper recibe varios contenidos.
  for (const elemento of contenidos) {
    if (!elemento?.connect) continue
    try { elemento.connect("notify::visible", scheduleApply) } catch (_) {}
  }

  const hookSurface = () => {
    const surface = win.get_surface?.()
    if (!surface) return
    // Algunas ventanas se mapean antes de que GTK termine su primera asignación
    // (el OSD, por ejemplo, aparece transitoriamente como 200×200). Vaciar aquí
    // es síncrono con `map`: no queda un frame con la región rectangular por
    // defecto mientras `scheduleApply()` espera a poder medir el contenido.
    vaciarRegionEntrada(surface)
    // Evitar manejadores duplicados si la misma superficie persiste entre mapeos.
    if (surfaceHandlers && surfaceHandlers.surface === surface) return
    if (surfaceHandlers) {
      try { for (const id of surfaceHandlers.ids) surfaceHandlers.surface.disconnect(id) } catch (_) {}
    }
    const ids = [
      surface.connect("notify::width", scheduleApply),
      surface.connect("notify::height", scheduleApply),
    ]
    surfaceHandlers = { surface, ids }
  }

  // `realize` ocurre antes del primer `map`: cuando GDK ya ofrece la superficie,
  // se elimina su rectángulo de entrada incluso antes de anunciarla visible.
  win.connect("realize", () => vaciarRegionEntrada(win.get_surface?.()))
  win.connect("map", () => { hookSurface(); engancharReloj(); scheduleApply() })
  if (win.get_mapped?.()) { hookSurface(); engancharReloj(); scheduleApply() }

  // El llamador debe invocarla al terminar cualquier animación de entrada con transform.
  return scheduleApply
}
