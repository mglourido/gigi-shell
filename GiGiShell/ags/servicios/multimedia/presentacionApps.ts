// Nombre e icono con los que se pinta cada fila de la "mezcla de aplicaciones".
// La parte pura (candidatos, limpieza, filtro de infraestructura) y el porqué del fallo
// están en `identidadApps.ts`; aquí solo queda lo que necesita GTK: el índice de
// `.desktop` y el tema de iconos.
//
// **Los JUEGOS no tienen `.desktop`, y por eso salían con el icono genérico de audio.**
// Un juego de Steam se anuncia por PipeWire con `application.name` = el nombre del
// ejecutable de Windows (o directamente el nombre de la app tal cual lo pone el motor), y
// no hay ninguna entrada de escritorio instalada con ese id: `nombreIconoDesdeCandidatos`
// devuelve `null` y la fila caía al `audio-x-generic-symbolic`. La barra sí sabe pintarlo
// —`servicios/juegos/iconos.ts` resuelve `steam_icon_<appid>` desde la clase de la ventana
// (`steam_app_2050650`)—, pero desde el stream de audio no hay clase de ventana ninguna.
// El puente son TRES intentos, y los tres hacen falta — medido con Rocket League:
//   1. **El PID.** PipeWire publica `application.process.id` y el registro de juegos guarda
//      el `pid` de cada cliente de Hyprland. Exacto cuando está, pero **no siempre está**:
//      solo lo traen los clientes que hablan por `pipewire-pulse` (Discord, wine); un
//      cliente nativo de PipeWire (Spotify) publica el nodo **sin** pid, solo con
//      `client.id`, que AstalWp no permite seguir.
//   2. **Los ANTEPASADOS de ese PID.** Un juego de wine reparte el audio entre
//      subprocesos (el overlay de Epic, sin ir más lejos) que no son el proceso de la
//      ventana pero cuelgan de él. Se sube por `/proc/<pid>/stat` unos pocos escalones.
//   3. **El NOMBRE contra el título de la ventana.** Es el que salva el caso real: el
//      stream se anuncia `Rocket League`, la ventana tiene clase `steam_app_252950` y
//      título `Rocket League (64-bit, DX11, Cooked)` — **no hay un solo identificador en
//      común**, solo el nombre dentro del título (`nombreCasaConJuego`, puro y con test).
// Y si el juego no tiene icono en ningún sitio, se pinta el **glifo** de juego de la barra
// en vez del icono de audio: dice más.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
  obtenerEntradaEscritorio,
  obtenerEntradaEscritorioPorCandidatos,
} from "../aplicaciones/entradasEscritorio"
import {
  nombreIconoDesdeCandidatos,
  obtenerIconoOriginalAplicacion,
  obtenerNombreIconoAplicacion,
} from "../aplicaciones/iconos"
import { candidatosIdentificadorAplicacion } from "../aplicaciones/identificadores"
import { extraerPadreProceso } from "../aplicaciones/procesos"
import { GLIFO_JUEGO } from "../juegos/iconos"
import { clientesJuego } from "../juegos/registro"
import type { ClienteConProceso } from "../juegos/evidencia"
import {
  candidatosApp,
  claveApp,
  nombreCasaConJuego,
  nombreCrudoApp,
  pidDeProps,
  type PropsAudio,
} from "./identidadApps"
import type { TipoMezcla } from "./presetsApps"

export interface PresentacionApp {
  nombre: string
  icono: string
  /** Icono de recurso (PNG/SVG de hicolor) cuando el tema no tiene el nombre. */
  gicono: Gio.Icon | null
  /** Glifo de juego cuando no hay icono de ninguna clase. Excluyente con los otros dos. */
  glifo: string | null
}

const ICONO_GENERICO: Record<TipoMezcla, string> = {
  speaker: "audio-x-generic-symbolic",
  mic: "audio-input-microphone-symbolic",
}

// El sondeo repasa la lista cada 2 s y cada repaso recorrería el índice de `.desktop` y
// preguntaría al tema por cada candidato. La caché se invalida cuando cambian las apps
// instaladas, igual que el índice al que envuelve, y cuando cambia la lista de juegos:
// una ventana de juego puede registrarse después de que su stream ya haya sonado, y sin
// esa segunda invalidación la fila se quedaría con el genérico hasta reiniciar el shell.
const cache = new Map<string, PresentacionApp>()
let monitor: Gio.AppInfoMonitor | null = null
let vigilandoJuegos = false

function vigilarInstalaciones() {
  if (!monitor) {
    monitor = Gio.AppInfoMonitor.get()
    monitor.connect("changed", () => cache.clear())
  }
  if (!vigilandoJuegos) {
    vigilandoJuegos = true
    clientesJuego.subscribe(() => cache.clear())
  }
}

/** Escalones que se suben por el árbol de procesos buscando el PID de una ventana. */
const MAX_ANTEPASADOS = 6

function padreDe(pid: number): number | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(`/proc/${pid}/stat`)
    return ok ? extraerPadreProceso(new TextDecoder().decode(contenido)) : null
  } catch {
    return null
  }
}

/** El PID y sus antepasados, para casar el subproceso que suena con la ventana. */
function linajeProceso(pid: number): number[] {
  const linaje = [pid]
  let actual: number | null = pid
  for (let salto = 0; salto < MAX_ANTEPASADOS; salto++) {
    actual = padreDe(actual)
    // PID 1 corta: de ahí para arriba todo el mundo es antepasado de todo el mundo.
    if (!actual || actual <= 1) break
    linaje.push(actual)
  }
  return linaje
}

/** Cómo se llama esa ventana para un humano: su `.desktop` si lo hay, y su título. */
function senasDeVentana(cliente: ClienteConProceso): Array<string | null | undefined> {
  return [
    obtenerEntradaEscritorio(cliente)?.nombre,
    cliente.title,
    (cliente as any).initialTitle,
  ]
}

/**
 * La ventana de juego que corresponde a este stream, si la hay. Por orden de fiabilidad:
 * PID exacto, PID de un antepasado, identificadores contra la clase y —el que salva a los
 * juegos de Steam— el nombre contra el título de la ventana.
 */
function clienteJuegoDeProps(props: PropsAudio, candidatos: string[]): ClienteConProceso | null {
  const juegos = clientesJuego.get()
  if (!juegos.length) return null

  const pid = pidDeProps(props)
  if (pid) {
    const porPid = juegos.find((juego) => juego.pid === pid)
    if (porPid) return porPid
    const linaje = linajeProceso(pid)
    const porLinaje = juegos.find((juego) => !!juego.pid && linaje.includes(juego.pid))
    if (porLinaje) return porLinaje
  }

  if (candidatos.length) {
    const porClase = juegos.find((juego) => {
      const clases = [juego.class, juego.initialClass ?? juego.initial_class]
        .flatMap((clase) => candidatosIdentificadorAplicacion(clase))
      return clases.some((clase) => candidatos.includes(clase))
    })
    if (porClase) return porClase
  }

  const nombre = nombreCrudoApp(props)
  return juegos.find((juego) => nombreCasaConJuego(nombre, senasDeVentana(juego))) ?? null
}

/** Icono del juego: nombre del tema (incluye `steam_icon_<appid>`), recurso, o glifo. */
function iconoDeJuego(cliente: ClienteConProceso): Partial<PresentacionApp> {
  const nombreIcono = obtenerNombreIconoAplicacion(cliente)
  if (nombreIcono) return { icono: nombreIcono }
  const gicono = obtenerIconoOriginalAplicacion(cliente)
  if (gicono) return { gicono }
  return { glifo: GLIFO_JUEGO }
}

export function presentacionApp(props: PropsAudio, tipo: TipoMezcla): PresentacionApp {
  vigilarInstalaciones()
  const clave = `${tipo}:${claveApp(props)}`
  const cacheado = cache.get(clave)
  if (cacheado) return cacheado

  const candidatos = candidatosApp(props)
  const entrada = obtenerEntradaEscritorioPorCandidatos(candidatos)
  const presentacion: PresentacionApp = {
    nombre: entrada?.nombre?.trim() || nombreCrudoApp(props),
    icono: ICONO_GENERICO[tipo],
    gicono: null,
    glifo: null,
  }

  const delTema = nombreIconoDesdeCandidatos(candidatos)
  if (delTema) {
    presentacion.icono = delTema
  } else {
    const juego = clienteJuegoDeProps(props, candidatos)
    if (juego) Object.assign(presentacion, iconoDeJuego(juego))
  }

  cache.set(clave, presentacion)
  return presentacion
}

/**
 * ¿Hay un `.desktop` instalado detrás de este cliente? Es el filtro de las apps "en
 * silencio": un proceso que abre el servidor de sonido sin ser una aplicación lanzada por
 * el usuario (un ayudante, una herramienta de línea de órdenes) no tiene entrada de
 * escritorio, y una fila de volumen con su nombre de proceso no le dice nada a nadie.
 */
export function tieneEntradaEscritorio(props: PropsAudio): boolean {
  return obtenerEntradaEscritorioPorCandidatos(candidatosApp(props)) !== null
}
