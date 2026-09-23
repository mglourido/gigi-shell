import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import cairo from "gi://cairo"
import { powerSaveActive, spectrumSuspended } from "../../../../servicios/energia/powerState"
import { clienteJuegoEnFoco } from "../../../../servicios/juegos/registro"
import { estadoSpotify } from "../../../../servicios/multimedia/mpris"
import {
  BANDAS,
  adquirirEspectro,
  espectroConSenal,
  espectroDisponible,
  nivelesEspectro,
} from "../../../../servicios/multimedia/espectro"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"

const BARRAS = BANDAS
const TRAZO = 2.4
const MINIMO = 2
const ATAQUE = 0.045
const CAIDA = 0.19
const BPM = 112
const FPS_AHORRO = 24
const FPS_MAXIMO = 60
/**
 * Constante de tiempo del cruce entre el espectro real y la animación procedimental. Sin
 * cruce, pasar la reproducción del móvil a este PC (o entrar en modo ahorro) daría un salto
 * visible en la altura de las 13 barras.
 */
const CRUCE = 0.28

function ruidoDeterminista(numero: number): number {
  const seno = Math.sin(numero * 127.1 + 311.7) * 43758.5453
  return seno - Math.floor(seno)
}

type Banda = {
  ganancia: number
  velocidad: number
  grave: number
  fases: [number, number, number]
  nivel: number
}

function crearBandas(): Banda[] {
  return Array.from({ length: BARRAS }, (_, indice) => {
    const proporcion = indice / (BARRAS - 1)
    return {
      ganancia: (0.44 + 0.56 * Math.pow(1 - proporcion, 0.8)) * (0.82 + 0.32 * ruidoDeterminista(indice + 1)),
      velocidad: 1.15 + 2.7 * proporcion,
      grave: Math.pow(1 - proporcion, 1.7),
      fases: [
        ruidoDeterminista(indice + 7) * 6.283,
        ruidoDeterminista(indice + 31) * 6.283,
        ruidoDeterminista(indice + 91) * 6.283,
      ],
      nivel: 0,
    }
  })
}

/** Único estado que permanece por monitor: la animación depende de su visibilidad. */
export default function OndaSpotify({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const bandas = crearBandas()
  let energia = 0
  let tiempo = 0
  let ultimoFrameUs = 0
  let acumulado = 0
  let idTick: number | null = null
  let barraVisible = visibilidad.visible.get()
  let reproduciendo = estadoSpotify.get()?.reproduciendo ?? false
  // 0 = manda el algoritmo procedimental, 1 = manda el espectro real. Se cruza, no se conmuta.
  let mezcla = 0
  let liberarEspectro: (() => void) | null = null

  const onda = new Gtk.DrawingArea({
    widthRequest: 54,
    heightRequest: 26,
    valign: Gtk.Align.CENTER,
  })
  onda.set_can_target(false)
  onda.set_draw_func((_area, cr, ancho, alto) => {
    const separacion = ancho / (BARRAS + 1)
    const recorrido = alto - TRAZO
    cr.setLineWidth(TRAZO)
    cr.setLineCap(cairo.LineCap.ROUND)

    for (let indice = 0; indice < bandas.length; indice++) {
      const nivel = bandas[indice].nivel * energia
      const altura = MINIMO + (recorrido - MINIMO) * nivel
      const x = separacion * (indice + 1)
      cr.setSourceRGBA(0.88, 0.88, 0.86, 0.5 + 0.45 * nivel)
      cr.moveTo(x, (alto - altura) / 2)
      cr.lineTo(x, (alto + altura) / 2)
      cr.stroke()
    }
  })

  const reposar = () => {
    energia = 0
    acumulado = 0
    mezcla = 0
    bandas.forEach((banda) => { banda.nivel = 0 })
  }

  const frame = (_widget: any, reloj: any): boolean => {
    const ahoraUs = reloj.get_frame_time()
    const transcurrido = ultimoFrameUs ? (ahoraUs - ultimoFrameUs) / 1e6 : 1 / 60
    ultimoFrameUs = ahoraUs
    acumulado += Math.min(0.1, transcurrido)
    if (acumulado < 1 / (powerSaveActive.get() ? FPS_AHORRO : FPS_MAXIMO)) return true
    const delta = acumulado
    acumulado = 0
    tiempo += delta

    const objetivo = reproduciendo ? 1 : 0
    energia += (objetivo - energia) * (1 - Math.exp(-delta / (reproduciendo ? 0.20 : 0.28)))
    // El espectro real solo manda si cava está entregando audio de verdad. Con la
    // reproducción en el móvil el sink local está mudo, así que aquí vuelve el algoritmo.
    const objetivoMezcla = liberarEspectro !== null && espectroConSenal.get() ? 1 : 0
    mezcla += (objetivoMezcla - mezcla) * (1 - Math.exp(-delta / CRUCE))
    const niveles = mezcla > 0.001 ? nivelesEspectro.get() : null
    // Con el cruce ya cerrado el algoritmo procedimental no aporta ni una milésima al
    // resultado (`sintetico * (1 - mezcla)`), así que no se calcula: son tres senos por
    // banda que se tiraban enteros mientras cava alimenta la onda, que es el caso normal.
    const soloReal = mezcla > 0.999
    const pulso = (tiempo / (60 / BPM)) % 4
    const bombo = soloReal ? 0 : Math.exp(-(pulso % 1) * 7) * (pulso < 1 ? 1 : 0.55)
    // Los dos factores de suavizado dependen solo de `delta`, igual para todas las
    // bandas: se calculan una vez por frame en vez de un `Math.exp` por banda.
    const factorAtaque = 1 - Math.exp(-delta / ATAQUE)
    const factorCaida = 1 - Math.exp(-delta / CAIDA)

    for (let indice = 0; indice < bandas.length; indice++) {
      const banda = bandas[indice]
      let sintetico = 0
      if (!soloReal) {
        const oscilacion = (
          0.55 * Math.sin(tiempo * banda.velocidad + banda.fases[0])
          + 0.30 * Math.sin(tiempo * banda.velocidad * 1.73 + banda.fases[1])
          + 0.15 * Math.sin(tiempo * banda.velocidad * 2.61 + banda.fases[2])
        ) / 0.72
        const normalizado = Math.min(1, Math.max(0, 0.5 + 0.5 * oscilacion))
        const perfil = normalizado * normalizado * (3 - 2 * normalizado)
        sintetico = Math.min(1, banda.ganancia * (0.06 + 0.94 * perfil) + 0.5 * bombo * banda.grave)
      }
      // El valor de cava ya viene normalizado por su autosens: no se le aplica `ganancia`,
      // que existe para dar forma a un espectro inventado, no para corregir uno medido.
      const real = niveles ? (niveles[indice] ?? 0) : 0
      const pico = soloReal ? real : sintetico + (real - sintetico) * mezcla
      banda.nivel += (pico - banda.nivel) * (pico > banda.nivel ? factorAtaque : factorCaida)
    }

    onda.queue_draw()
    if (!reproduciendo && energia < 0.004) {
      reposar()
      onda.queue_draw()
      idTick = null
      return false
    }
    return true
  }

  /**
   * En modo AHORRO no se captura audio **si el usuario lo ha pedido** (`spectrumSuspended`,
   * Ajustes > Energía): se cede al algoritmo procedimental, que no cuesta ni un proceso. Es
   * un escalón antes que `spotifyBarSuspended`, que desmonta la pastilla entera — aquí se
   * sigue viendo y la onda se sigue moviendo, solo deja de seguir la música. Nótese que se
   * mira `spectrumSuspended` y NO `powerSaveActive`: son dos interruptores independientes,
   * así que apagar este debe dejar el análisis vivo durante el ahorro.
   *
   * **Con un JUEGO EN FOCO tampoco, y lo que esto cubre de verdad es el juego EN VENTANA.**
   * En este equipo `barAutoHide` está en `false`, así que la barra no se esconde al apartar el
   * ratón y `barraVisible` es cierto casi siempre: no sirve de gate por sí solo. La excepción
   * es la pantalla completa REAL, que sí pone `barTapada` en `Barra.tsx` y baja la barra —
   * para ese caso esta condición es redundante. Lo que añade es el juego sin fullscreen real
   * (ventana o borderless) y los instantes en que la barra reaparece a mitad de partida. Se
   * mira el FOCO y no la mera existencia del juego, la distinción que hace
   * `lib/gaming-gate.sh` (juego abierto ≠ estás jugando): con el juego en otro escritorio la
   * barra se ve y la onda vuelve a tener sentido.
   */
  const sincronizar = () => {
    const necesario = barraVisible && (reproduciendo || energia > 0)
    if (necesario && idTick === null) {
      ultimoFrameUs = 0
      idTick = onda.add_tick_callback(frame)
    } else if (!necesario && idTick !== null) {
      onda.remove_tick_callback(idTick)
      idTick = null
    }

    // Solo mientras se reproduce: sostener cava durante el desvanecido de salida no aporta
    // nada y alarga la captura sin motivo.
    const quiereEspectro = espectroDisponible && barraVisible && reproduciendo
      && !spectrumSuspended.get() && clienteJuegoEnFoco.get() === null
    if (quiereEspectro && liberarEspectro === null) {
      liberarEspectro = adquirirEspectro()
    } else if (!quiereEspectro && liberarEspectro !== null) {
      liberarEspectro()
      liberarEspectro = null
    }
  }

  const cancelarSpotify = estadoSpotify.subscribe(() => {
    reproduciendo = estadoSpotify.get()?.reproduciendo ?? false
    if (!reproduciendo && !barraVisible) reposar()
    sincronizar()
  })
  const cancelarVisibilidad = visibilidad.visible.subscribe(() => {
    barraVisible = visibilidad.visible.get()
    if (!barraVisible && !reproduciendo) reposar()
    sincronizar()
  })
  const cancelarAhorro = spectrumSuspended.subscribe(sincronizar)
  const cancelarJuego = clienteJuegoEnFoco.subscribe(sincronizar)
  sincronizar()

  onCleanup(() => {
    cancelarSpotify()
    cancelarVisibilidad()
    cancelarAhorro()
    cancelarJuego()
    liberarEspectro?.()
    liberarEspectro = null
    if (idTick !== null) onda.remove_tick_callback(idTick)
  })

  return onda
}
