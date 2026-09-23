// Mascota decorativa: un lagarto que se pasea por debajo de la barra mientras
// el escritorio activo de esta salida no tenga clientes o no haya ninguno
// enfocado (modulos/mascotas/estado/monitorActividad.ts). Vive en su PROPIA
// ventana layer-shell, anclada justo debajo del bar — así no necesita conocer
// ni esquivar ningún widget de Barra.tsx, al revés que un cangrejo que viviera
// dentro de ella.
//
// Interactivo: un clic lo tumba un rato, un doble clic lo deja colgado (otro
// doble clic lo suelta) y se puede arrastrar con el ratón para reubicarlo. El
// hueco de clic de la ventana se recorta a la silueta real del sprite
// (clipWindowInputToContent) para que el resto de la franja bajo la barra
// siga siendo transparente a los clics.
//
// Esquiva Quick Settings, Notificaciones y el Calendario cuando se abren
// donde está: a Notificaciones y Calendario los "empuja" fuera de su hueco (y
// deja de poder volver a esa franja mientras sigan abiertos); a Quick
// Settings se sube — baja hasta su borde inferior, sigue paseándose por su
// ancho mientras esté abierto, y vuelve a subir a la barra al cerrarse.
import app from "ags/gtk4/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createComputed, createState, onCleanup } from "ags"
import GLib from "gi://GLib"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import { obtenerControlVisibilidadBarra } from "../../estado/visibilidadBarra"
import { calendarVisible, quickSettingsVisible } from "../../estado/shell"
import { notifPanelVisible } from "../notificaciones/store"
import { lagartoBarraEnabled } from "../ajustes/preferences"
import { mascotaSuspended } from "../../servicios/energia/powerState"
import { suscribirActividadMascota } from "./estado/monitorActividad"
import { avanzarPasoEnSitio, estadoAleatorio, PARAMETROS_PREDETERMINADOS, type EstadoMovimiento } from "./estado/movimiento"
import {
  ANCHO_CALENDARIO, ANCHO_NOTIFICACIONES,
  empujeDesdeDerecha, empujeDesdeIzquierda, franjaQuickSettings,
} from "./estado/paneles"

// BAR_HEIGHT debe coincidir con el de modulos/barra/Barra.tsx. Se resta 1: sin
// ese solape de un píxel quedaba una línea visible entre el borde inferior
// real de la barra y el sprite, aunque marginTop = BAR_HEIGHT "debería" tocarlo.
const BAR_HEIGHT = 38
const MARGEN_SUPERIOR = BAR_HEIGHT - 1
// Tamaño nativo de los sprites ya escalados (ver generar_lagarto.py,
// ESCALA=1.75). Caminando y tumbado comparten ancho; colgado es un cuerpo
// girado 90° -mucho más estrecho y bastante más alto, cuelga en vertical de
// las patas traseras- así que necesita su propio ancho y alto. Sin reescalar
// aquí: a este tamaño el pixel art se pinta 1:1 y no hace falta que
// Gtk.Picture reescale.
const ANCHO_CAMINANDO = 38
const ALTO_CAMINANDO = 16
const ANCHO_TUMBADO = 38
const ALTO_TUMBADO = 10
const ANCHO_COLGADO = 10
const ALTO_COLGADO = 46
const ALTO_VENTANA = Math.max(ALTO_CAMINANDO, ALTO_COLGADO, ALTO_TUMBADO)
const INTERVALO_MS = 90

// Cuánto tarda en decidirse un clic simple, por si llega un segundo clic justo
// detrás y hay que tratarlo como doble clic (mismo patrón que
// modulos/orion/components/shared/dobleClic.ts).
const ESPERA_CLIC_MS = 300
// Umbral (px) a partir del cual un gesto se considera arrastre y no clic.
const UMBRAL_ARRASTRE_PX = 4
const TUMBADO_MIN_MS = 4000
const TUMBADO_MAX_MS = 9000
// Holgura (px) que se le permite al recorte de la región de entrada antes de
// volver a calcularlo mientras el lagarto camina. Ver `pintar()`.
const HOLGURA_RECORTE_PX = 4

const ASSETS_DIR = `${GLib.get_user_config_dir()}/ags/modulos/mascotas/assets`

type Pose = "caminando" | "colgado" | "tumbado"

/** Una imagen concreta del lagarto con su tamaño ya resuelto. Las instancias
 * se crean una sola vez (ver `obtenerSprites`) y `pintar()` compara por
 * IDENTIDAD contra la del fotograma anterior: un solo `===` decide si hay algo
 * que tocar en el widget, sin componer ningún objeto por tick. */
interface Sprite {
  textura: Gdk.Texture | null
  ancho: number
  alto: number
}

function cargarSprite(nombre: string, ancho: number, alto: number): Sprite {
  let textura: Gdk.Texture | null = null
  try {
    textura = Gdk.Texture.new_from_filename(`${ASSETS_DIR}/${nombre}`)
  } catch (error) {
    console.error("[mascotas] no se pudo cargar el sprite del lagarto:", nombre, error)
  }
  return { textura, ancho, alto }
}

interface Sprites {
  /** [fotograma][sentido], sentido 0 = izquierda, 1 = derecha. */
  caminando: [[Sprite, Sprite], [Sprite, Sprite]]
  colgado: [Sprite, Sprite]
  tumbado: [Sprite, Sprite]
}

let sprites: Sprites | null = null

/** Una sola carga de las texturas, compartida por todos los monitores y
 * DIFERIDA hasta el primer fotograma que se pinta de verdad. `new_from_filename`
 * lee del disco y sube la imagen a la GPU de forma síncrona; hacerlo al importar
 * el módulo lo metía en la construcción de las ventanas del arranque incluso
 * cuando la mascota está apagada en Ajustes, que es el caso por defecto. */
function obtenerSprites(): Sprites {
  if (sprites) return sprites
  sprites = {
    caminando: [
      [cargarSprite("lagarto-a-izquierda.png", ANCHO_CAMINANDO, ALTO_CAMINANDO),
        cargarSprite("lagarto-a-derecha.png", ANCHO_CAMINANDO, ALTO_CAMINANDO)],
      [cargarSprite("lagarto-b-izquierda.png", ANCHO_CAMINANDO, ALTO_CAMINANDO),
        cargarSprite("lagarto-b-derecha.png", ANCHO_CAMINANDO, ALTO_CAMINANDO)],
    ],
    colgado: [cargarSprite("lagarto-colgado-izquierda.png", ANCHO_COLGADO, ALTO_COLGADO),
      cargarSprite("lagarto-colgado-derecha.png", ANCHO_COLGADO, ALTO_COLGADO)],
    tumbado: [cargarSprite("lagarto-tumbado-izquierda.png", ANCHO_TUMBADO, ALTO_TUMBADO),
      cargarSprite("lagarto-tumbado-derecha.png", ANCHO_TUMBADO, ALTO_TUMBADO)],
  }
  return sprites
}

// Qué franja horizontal puede recorrer el lagarto ahora mismo y por qué.
// "evitando" cubre Notificaciones y Calendario (huye del panel, no puede
// volver a esa franja mientras siga abierto); "quicksettings" es el caso
// especial en el que además cambia de superficie (sube a su borde inferior).
// `origen` distingue Notificaciones de Calendario para no revertir por error
// la exclusión de uno al cerrarse el otro (son mutuamente excluyentes, pero
// esto lo deja a prueba de una condición de carrera).
type Modo =
  | { tipo: "normal" }
  | { tipo: "evitando", origen: "notificaciones" | "calendario", limiteIzq: number, limiteDer: number }
  | { tipo: "quicksettings", limiteIzq: number, limiteDer: number }

// Tick propio (más fino que INTERVALO_MS, el de la marcha) para que la
// subida/bajada a Quick Settings se sienta pegada a la animación real del
// panel y no vaya a remolque. La curva del panel (cubic-bezier(0.16,1,0.3,1),
// en QuickSettings.tsx) es un ease-out MUY agresivo: casi todo el recorrido
// visual pasa en el primer tercio y el resto es solo el asentamiento final.
// Un reparto proporcional uniforme (p. ej. 45% del resto en cada paso)
// termina técnicamente rápido pero se SIENTE lento, porque el panel ya está
// quieto mientras el lagarto sigue deslizándose visiblemente detrás. Con
// 0.6 a 20ms el 99% del camino cae en ~100ms, calcado a esa misma sensación.
const TICK_MARGEN_MS = 20
const PASO_MARGEN_FRACCION = 0.6

function clamp(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor))
}

function enteroAleatorio(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

export default function Lagarto(gdkmonitor: Gdk.Monitor) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
  const visibilidadBarra = obtenerControlVisibilidadBarra(gdkmonitor)

  // Se activa solo con las CUATRO condiciones a la vez: preferencia encendida,
  // barra visible en esta salida (si la barra está retraída, el lagarto no
  // debe quedar flotando solo en el escritorio), escritorio inactivo y el modo
  // ahorro sin pedir que se retire. El ahorro entra aquí y no en un `visible`
  // aparte porque desmontar es lo único que de verdad ahorra: el paseo son ~11
  // fotogramas/s, y cada uno es un commit de esta capa que Hyprland recompone.
  // Mismo gesto que `spotifyBarSuspended` en `Barra.tsx`.
  const [mostrarPorActividad, setMostrarPorActividad] = createState(false)
  const visible = createComputed(
    [lagartoBarraEnabled, visibilidadBarra.visible, mostrarPorActividad, mascotaSuspended],
    (activado, barraVisible, inactivo, ahorro) => activado && barraVisible && inactivo && !ahorro,
  )

  let picture: Gtk.Picture | null = null
  let reclip: ((inmediato?: boolean) => void) | null = null
  // Franja horizontal vigente y por qué (ver tipo Modo). Empieza en "normal";
  // las suscripciones a los paneles más abajo la actualizan.
  let modo: Modo = { tipo: "normal" }
  // Ancho de la salida cacheado: `get_geometry()` es una llamada a GI que
  // devuelve un rectángulo nuevo, y esto se consultaba en CADA tick de la
  // marcha para un dato que solo cambia al reconfigurar la pantalla (se
  // refresca abajo con `notify::geometry`).
  let anchoMonitor = gdkmonitor.get_geometry().width
  // Franja recorrible ya resuelta a dos números. Se recalcula solo al cambiar
  // de modo o de ancho de pantalla, no once veces por segundo.
  let limiteMin = 0
  let limiteMax = Math.max(0, anchoMonitor - ANCHO_CAMINANDO)
  // Espejo simple de `visible`: `pintar()` lo consulta en cada tick y leer un
  // booleano local es más barato que resolver el estado reactivo compuesto.
  let esVisible = false
  // Celda ÚNICA del modelo de movimiento durante toda una aparición: el bucle
  // la muta en sitio (ver `avanzarPasoEnSitio`). Se resiembra en cada aparición
  // (ver bajaVisibilidad más abajo): así no sale siempre del mismo punto ni
  // mirando siempre hacia el mismo lado.
  let m: EstadoMovimiento = estadoAleatorio(limiteMax, Math.random, limiteMin)
  let pose: Pose = "caminando"
  let timerId: number | null = null
  let poseTimerId: number | null = null
  let clicPendienteId: number | null = null
  let margenTimerId: number | null = null
  let arrastrando = false
  // Se pone a `true` en cuanto el arrastre supera el umbral EN CUALQUIER
  // momento de la pulsación actual, y se consulta al soltar para saber si lo
  // que acaba de pasar fue un clic o un arrastre. Separado de `arrastrando`
  // (que solo dice si el arrastre está en curso AHORA) porque `onReleased`
  // necesita la respuesta de toda la pulsación, no del instante final.
  let huboArrastre = false
  let xLagartoAlAgarrar = 0

  // Margen superior real de la ventana: MARGEN_SUPERIOR (bajo el bar) salvo
  // mientras está subido a Quick Settings, donde `asegurarTimerMargen` lo desliza
  // hasta el borde inferior del panel y de vuelta.
  const [margenSuperior, setMargenSuperior] = createState(MARGEN_SUPERIOR)

  /** Único punto que toca `modo`: deja la franja recorrible ya resuelta en
   * `limiteMin`/`limiteMax` para que el bucle no tenga que deducirla. */
  function establecerModo(nuevo: Modo) {
    modo = nuevo
    recalcularLimites()
  }

  function recalcularLimites() {
    if (modo.tipo === "normal") {
      limiteMin = 0
      limiteMax = Math.max(0, anchoMonitor - ANCHO_CAMINANDO)
      return
    }
    limiteMin = modo.limiteIzq
    limiteMax = Math.max(modo.limiteIzq, modo.limiteDer)
  }

  /** Borde inferior real de Quick Settings, leído de su propia ventana para
   * no duplicar un alto que cambia con la vista (main/wifi/bluetooth/...).
   * Repliegue razonable si todavía no se ha asignado (panel recién mapeado). */
  function margenBajoQuickSettings(): number {
    const ventanaQs = app.get_window("quick-settings") as unknown as
      { get_surface?: () => { get_height?: () => number } | null } | null
    const alto = ventanaQs?.get_surface?.()?.get_height?.()
    const altoQs = typeof alto === "number" && alto > 0 ? alto : 400
    return MARGEN_SUPERIOR + altoQs - 1
  }

  function detenerTimerMargen() {
    if (margenTimerId === null) return
    GLib.source_remove(margenTimerId)
    margenTimerId = null
  }

  /** Acerca `margenSuperior` un paso hacia su objetivo (la barra, o el borde
   * de Quick Settings si está subido a él) y avisa si ya llegó. El objetivo
   * se recalcula EN CADA LLAMADA a propósito: la superficie de Quick Settings
   * puede no tener aún su asignación real nada más abrirse (mismo caso que
   * documenta OSD.tsx sobre su primer frame a 200×200), así que si esa
   * primera lectura llega antes de tiempo, los siguientes pasos la corrigen
   * solos en cuanto la medida real está disponible — y de paso sigue un
   * cambio de alto del panel (p. ej. al entrar en un submenú) mientras siga
   * abierto, no solo el tramo de apertura. */
  function pasoMargen(): boolean {
    const objetivo = modo.tipo === "quicksettings" ? margenBajoQuickSettings() : MARGEN_SUPERIOR
    const actual = margenSuperior.get()
    if (actual === objetivo) return true
    const paso = Math.max(1, Math.ceil(Math.abs(objetivo - actual) * PASO_MARGEN_FRACCION))
    setMargenSuperior(actual < objetivo ? Math.min(objetivo, actual + paso) : Math.max(objetivo, actual - paso))
    return false
  }

  function asegurarTimerMargen() {
    if (margenTimerId !== null) return
    margenTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MARGEN_MS, () => {
      if (pasoMargen()) {
        margenTimerId = null
        return GLib.SOURCE_REMOVE
      }
      return GLib.SOURCE_CONTINUE
    })
  }

  /** El sprite que toca ahora mismo: una de las ocho instancias fijas de la
   * tabla, elegida con dos índices y sin construir nada. */
  function spriteActual(): Sprite {
    const tabla = obtenerSprites()
    const sentido = m.direccion === 1 ? 1 : 0
    if (pose === "colgado") return tabla.colgado[sentido]
    if (pose === "tumbado") return tabla.tumbado[sentido]
    return tabla.caminando[m.fotograma][sentido]
  }

  // Último fotograma realmente escrito en el widget. `pintar()` se llama en
  // CADA tick de la marcha (~11 veces por segundo) y casi siempre con parte de
  // esos valores sin cambiar, así que se comparan antes de tocar nada.
  //
  // Lo caro no son los setters —GTK ya ignora una asignación idéntica— sino el
  // `reclip()`: mide con `compute_bounds()`, construye una `cairo.Region` y la
  // manda al compositor con `set_input_region`, y para hacerlo **pide un tick
  // callback a la ventana**, o sea que mantiene vivo el reloj de FRAMES de la
  // superficie. Llamarlo a ciegas 11 veces por segundo dejaba a la mascota
  // despertando el reloj de frames sin parar incluso con el lagarto quieto — y
  // está quieto a menudo, porque el modelo de movimiento se para a propósito
  // (`estado: "parado"`, de 20 a 70 ticks, o sea entre 1,8 y 6,3 s) y porque
  // colgado y tumbado no se mueven en absoluto. Con la guarda, esos ratos no
  // cuestan ni una medición ni un frame. Es el mismo principio que ya aplica el
  // temporizador al esconderse la ventana, un escalón más adentro.
  let ultimoSprite: Sprite | null = null
  let ultimoMargen = Number.NaN
  // Margen con el que se calculó la región de entrada vigente, que ya no tiene
  // por qué ser el del último fotograma pintado (ver abajo).
  let margenRecortado = Number.NaN

  function pintar() {
    // Oculta no hay nada que pintar: la ventana está desmapeada y al volver a
    // mapearse el helper de recorte remide sola. Los `ultimo*` se conservan,
    // así que reaparecer en la misma pose tampoco cuesta ni un setter.
    if (!picture || !esVisible) return
    const sprite = spriteActual()
    // `m.x` es la posición de referencia del "carril" de la marcha (ancho
    // ANCHO_CAMINANDO). Colgado es mucho más estrecho: centrarlo dentro de
    // ese mismo carril evita que salte hacia la izquierda al cambiar de pose.
    // Se redondea aquí y solo aquí: de la marcha para adentro todo son floats
    // pequeños (décimas de píxel por tick), y a la pantalla solo llega el
    // entero — de ahí que un tick "parado" no llegue a tocar el widget.
    const margen = Math.round(m.x + (ANCHO_CAMINANDO - sprite.ancho) / 2)
    const anterior = ultimoSprite
    if (sprite === anterior && margen === ultimoMargen) return

    const cambiaTamano = anterior === null
      || sprite.ancho !== anterior.ancho
      || sprite.alto !== anterior.alto

    if (anterior === null || sprite.textura !== anterior.textura) picture.set_paintable(sprite.textura)
    if (cambiaTamano) {
      picture.widthRequest = sprite.ancho
      picture.heightRequest = sprite.alto
    }
    if (margen !== ultimoMargen) picture.marginStart = margen
    ultimoSprite = sprite
    ultimoMargen = margen

    // La región de entrada es la silueta del sprite DENTRO de la ventana, así
    // que la mueve tanto el tamaño de la pose como la posición horizontal. El
    // tamaño obliga a rehacerla en el acto; la posición NO tiene por qué
    // seguirse al píxel: a velocidad de crucero (0,9 px por tick) el margen
    // cambia casi en cada fotograma, y con eso volvía el reclip a ser
    // constante durante todo el paseo. Se le da HOLGURA_RECORTE_PX de
    // desfase —imperceptible al pulsar un bicho de 38 px de ancho, y baja las
    // mediciones de ~11 a ~2,5 por segundo— y se salda la deuda en cuanto se
    // queda quieto, que es cuando el recorte tiene que ser exacto porque es
    // cuando lo van a pulsar.
    const desvio = Math.abs(margen - margenRecortado)
    const quieto = !arrastrando && (pose !== "caminando" || Math.abs(m.vx) < 0.05)
    if (cambiaTamano || desvio >= HOLGURA_RECORTE_PX || (quieto && desvio > 0)) {
      margenRecortado = margen
      reclip?.()
    }
  }

  function cancelarTemporizadorPose() {
    if (poseTimerId === null) return
    GLib.source_remove(poseTimerId)
    poseTimerId = null
  }

  function volverACaminar() {
    cancelarTemporizadorPose()
    pose = "caminando"
    m.vx = 0
    m.estado = "caminando"
    pintar()
    arrancarBucle()
  }

  function tumbarseUnRato() {
    cancelarTemporizadorPose()
    // Tumbado y colgado no se mueven: el bucle de la marcha solo serviría para
    // despertar el bucle principal once veces por segundo y salir por la
    // guarda de `avanzar()`. Colgado además puede durar lo que el usuario
    // quiera. Se para aquí y lo repone `volverACaminar()`.
    detenerTimer()
    pose = "tumbado"
    pintar()
    poseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, enteroAleatorio(TUMBADO_MIN_MS, TUMBADO_MAX_MS), () => {
      poseTimerId = null
      volverACaminar()
      return GLib.SOURCE_REMOVE
    })
  }

  function alternarColgado() {
    cancelarTemporizadorPose()
    if (pose === "colgado") volverACaminar()
    else { detenerTimer(); pose = "colgado"; pintar() }
  }

  function cancelarClicPendiente() {
    if (clicPendienteId === null) return
    GLib.source_remove(clicPendienteId)
    clicPendienteId = null
  }

  function avanzar() {
    // La física de la marcha se congela mientras el usuario está arrastrando al
    // lagarto a mano. Con una pose fija el bucle ya está parado; la guarda se
    // mantiene por si un tick en vuelo llega justo después de cambiar de pose.
    if (arrastrando || pose !== "caminando") return
    avanzarPasoEnSitio(m, limiteMax, PARAMETROS_PREDETERMINADOS, Math.random, limiteMin)
    pintar()
  }

  function detenerTimer() {
    if (timerId === null) return
    GLib.source_remove(timerId)
    timerId = null
  }

  function arrancarBucle() {
    if (timerId !== null || !esVisible) return
    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVALO_MS, () => {
      avanzar()
      return GLib.SOURCE_CONTINUE
    })
  }

  function aparecer() {
    // Punto de partida nuevo en cada aparición, no solo la primera vez. Si ya
    // hay un panel abierto (modo distinto de "normal"), respeta su franja
    // desde el primer fotograma.
    m = estadoAleatorio(limiteMax, Math.random, limiteMin)
    pose = "caminando"
    // Salto directo sin animar: si ya tocaba estar subido a Quick Settings
    // (reaparece con el panel ya abierto), no había nada visible que animar.
    setMargenSuperior(modo.tipo === "quicksettings" ? margenBajoQuickSettings() : MARGEN_SUPERIOR)
    pintar()
    arrancarBucle()
  }

  // El temporizador solo corre mientras la ventana está visible: oculto no
  // cuesta ni un timeout, mismo principio que la onda de Spotify.
  const bajaVisibilidad = visible.subscribe(() => {
    esVisible = visible.get()
    if (esVisible) aparecer()
    else {
      detenerTimer()
      cancelarTemporizadorPose()
      cancelarClicPendiente()
    }
  })

  // La escucha del escritorio solo se mantiene mientras la mascota pueda
  // llegar a salir. Con la preferencia apagada -el caso por defecto- o en modo
  // ahorro, esto no cuesta ni una consulta a Hyprland: `suscribirActividadMascota`
  // se ejecuta ante CUALQUIER evento de ventana (abrir, cerrar, mover, cambiar
  // el foco, que con `follow_mouse` salta al cruzar el puntero de una ventana a
  // otra), y hacerlo para alimentar un widget que nadie va a ver es trabajo
  // puro por monitor. Al volver a suscribirse el valor llega de nuevo en el
  // acto, así que no hace falta sembrar nada a mano.
  let bajaActividad: (() => void) | null = null
  function sincronizarEscuchaActividad() {
    const debeEscuchar = lagartoBarraEnabled.get() && !mascotaSuspended.get()
    if (debeEscuchar === (bajaActividad !== null)) return
    if (debeEscuchar) {
      bajaActividad = suscribirActividadMascota(gdkmonitor, setMostrarPorActividad)
      return
    }
    const baja = bajaActividad
    bajaActividad = null
    baja?.()
  }
  const bajaPreferencia = lagartoBarraEnabled.subscribe(sincronizarEscuchaActividad)
  const bajaAhorro = mascotaSuspended.subscribe(sincronizarEscuchaActividad)
  sincronizarEscuchaActividad()

  // El ancho de la salida solo cambia al reconfigurar la pantalla. Se recoge
  // por señal en vez de releerlo en cada tick; si encoge, se reencaja al
  // lagarto dentro de la franja nueva.
  let idGeometria: number | null = null
  try {
    idGeometria = gdkmonitor.connect("notify::geometry", () => {
      anchoMonitor = gdkmonitor.get_geometry().width
      recalcularLimites()
      const x = clamp(m.x, limiteMin, limiteMax)
      if (x === m.x) return
      m.x = x
      pintar()
    })
  } catch (_) {
    // Sin la señal se conserva el ancho del arranque: el paseo sigue acotado a
    // una franja válida, solo que no sigue un cambio de resolución en caliente.
  }

  // Notificaciones y Calendario: si el lagarto está donde va a aparecer el
  // panel, lo empuja fuera de ese hueco y no lo deja volver mientras siga
  // abierto (mismo patrón para los dos, solo cambia el borde y el sentido).
  function alAbrirseEvitando(
    origen: "notificaciones" | "calendario",
    calcular: (x: number, anchoTotal: number) => { empuje: { x: number, direccion: 1 | -1 } | null, limiteIzq: number, limiteDer: number },
  ) {
    const { empuje, limiteIzq, limiteDer } = calcular(m.x, anchoMonitor)
    establecerModo({ tipo: "evitando", origen, limiteIzq, limiteDer })
    if (empuje) {
      m.x = empuje.x
      m.direccion = empuje.direccion
      m.vx = 0
      m.estado = "caminando"
    }
    pintar()
  }

  function alCerrarseEvitando(origen: "notificaciones" | "calendario") {
    if (modo.tipo === "evitando" && modo.origen === origen) establecerModo({ tipo: "normal" })
  }

  const bajaNotif = notifPanelVisible.subscribe(() => {
    if (notifPanelVisible.get()) {
      alAbrirseEvitando("notificaciones", (x, anchoTotal) => {
        const { empuje, limiteDerecho } = empujeDesdeDerecha(x, ANCHO_CAMINANDO, anchoTotal, ANCHO_NOTIFICACIONES)
        return { empuje, limiteIzq: 0, limiteDer: limiteDerecho }
      })
    } else {
      alCerrarseEvitando("notificaciones")
    }
  })
  const bajaCalendario = calendarVisible.subscribe(() => {
    if (calendarVisible.get()) {
      alAbrirseEvitando("calendario", (x, anchoTotal) => {
        const { empuje, limiteIzquierdo } = empujeDesdeIzquierda(x, anchoTotal, ANCHO_CALENDARIO)
        return { empuje, limiteIzq: limiteIzquierdo, limiteDer: Math.max(limiteIzquierdo, anchoTotal - ANCHO_CAMINANDO) }
      })
    } else {
      alCerrarseEvitando("calendario")
    }
  })

  // Quick Settings: en vez de esquivarlo, el lagarto se sube a su borde
  // inferior y sigue paseándose por su ancho hasta que se cierra.
  const bajaQuickSettings = quickSettingsVisible.subscribe(() => {
    if (quickSettingsVisible.get()) {
      const { minX, maxX } = franjaQuickSettings(ANCHO_CAMINANDO, anchoMonitor)
      establecerModo({ tipo: "quicksettings", limiteIzq: minX, limiteDer: maxX })
      m.x = clamp(m.x, minX, maxX)
      m.vx = 0
      m.estado = "caminando"
      asegurarTimerMargen()
      pintar()
    } else if (modo.tipo === "quicksettings") {
      establecerModo({ tipo: "normal" })
      asegurarTimerMargen()
    }
  })

  onCleanup(() => {
    detenerTimer()
    cancelarTemporizadorPose()
    cancelarClicPendiente()
    detenerTimerMargen()
    if (idGeometria !== null) {
      try { gdkmonitor.disconnect(idGeometria) } catch (_) {}
    }
    bajaVisibilidad()
    bajaPreferencia()
    bajaAhorro()
    bajaActividad?.()
    bajaNotif()
    bajaCalendario()
    bajaQuickSettings()
  })

  const win = (
    <window
      name="lagarto-mascota"
      namespace="gigios-mascotas"
      visible={visible}
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.IGNORE}
      focusable={false}
      anchor={TOP | LEFT | RIGHT}
      application={app}
      marginTop={margenSuperior}
      heightRequest={ALTO_VENTANA}
      cssClasses={["lagarto-window"]}
    >
      <box hexpand vexpand={false}>
        <Gtk.Picture
          $={(self: Gtk.Picture) => { picture = self }}
          contentFit={Gtk.ContentFit.CONTAIN}
          canShrink={false}
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          widthRequest={ANCHO_CAMINANDO}
          heightRequest={ALTO_CAMINANDO}
        >
          {/* Fase CAPTURE en los dos gestos, mismo patrón que
              BotonEscritorio.tsx. La decisión de clic/doble clic se toma
              SIEMPRE al soltar ("released"), nunca al pulsar: si se decidiera
              al pulsar (como antes), un temporizador de clic disparado a
              mitad de un arrastre lento le cambiaba la pose por debajo y el
              arrastre dejaba de tener efecto visible. Al mirar `huboArrastre`
              —que cubre TODA la pulsación, no solo el instante final— un
              arrastre real nunca compite con la acción de clic. */}
          <Gtk.GestureClick
            button={Gdk.BUTTON_PRIMARY}
            $={(self: Gtk.GestureClick) => self.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)}
            onPressed={() => {
              huboArrastre = false
            }}
            onReleased={(_gesto: Gtk.GestureClick, pulsaciones: number) => {
              if (huboArrastre) return
              if (pulsaciones >= 2) {
                cancelarClicPendiente()
                alternarColgado()
                return
              }
              // Doble clic real: GTK dispara "released" con pulsaciones=1 y
              // luego, si llega el segundo clic a tiempo, otra vez con
              // pulsaciones=2. Se retrasa la acción del primero por si ese
              // segundo clic aparece, para no tumbarlo un instante y colgarlo
              // justo después.
              cancelarClicPendiente()
              clicPendienteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ESPERA_CLIC_MS, () => {
                clicPendienteId = null
                tumbarseUnRato()
                return GLib.SOURCE_REMOVE
              })
            }}
          />
          <Gtk.GestureDrag
            $={(self: Gtk.GestureDrag) => self.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)}
            onDragBegin={() => {
              arrastrando = false
              xLagartoAlAgarrar = m.x
            }}
            onDragUpdate={(_gesto: Gtk.GestureDrag, offsetX: number, offsetY: number) => {
              if (!arrastrando) {
                if (Math.abs(offsetX) < UMBRAL_ARRASTRE_PX && Math.abs(offsetY) < UMBRAL_ARRASTRE_PX) return
                arrastrando = true
                huboArrastre = true
                cancelarClicPendiente()
              }
              m.x = clamp(xLagartoAlAgarrar + offsetX, limiteMin, limiteMax)
              pintar()
            }}
            onDragEnd={() => {
              if (!arrastrando) return
              arrastrando = false
              // Solo retoma la física de la marcha si no quedó colgado ni
              // tumbado: arrastrar en esas poses solo lo reubica.
              if (pose === "caminando") {
                m.vx = 0
                m.estado = "caminando"
              }
              pintar()
            }}
          />
        </Gtk.Picture>
      </box>
    </window>
  ) as Gtk.Window

  // El hueco de clic se recorta a la silueta real del sprite (se
  // recalcula en cada pintar()): el resto de la franja bajo la barra sigue
  // siendo transparente a los clics.
  reclip = clipWindowInputToContent(win, [picture], { vaciarAlMapear: true })

  // `subscribe` no emite al suscribirse: si al construir la ventana ya se dan
  // las cuatro condiciones (el shell se recarga con el escritorio vacío y la
  // mascota encendida), nadie llamaría a `aparecer()` y el lagarto saldría
  // quieto y sin sprite hasta el primer cambio de estado.
  if (visible.get()) {
    esVisible = true
    aparecer()
  }

  return win
}
