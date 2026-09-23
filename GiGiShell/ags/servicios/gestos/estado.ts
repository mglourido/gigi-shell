// servicios/gestos/estado.ts
//
// "¿Está el modo gestos mirando por la cámara?" — el lado AGS.
//
// Aquí no se detecta nada ni se lanza nada: se LEE lo que el demonio
// (`hypr/scripts/gestos/gestos.py`) deja escrito en
// `~/.config/gigios/gestos-estado.json`. Mismo reparto que la pareja
// `camara-monitor.sh` / `servicios/camara/uso.ts`, y por el mismo motivo: el
// trabajo caro (33 ms de inferencia por frame) no puede vivir en el proceso que
// pinta la barra.
//
// ── EL DEMONIO NO PUBLICA POR FRAME, Y ESO IMPORTA DESDE AQUÍ ────────────────
// `crearFuenteArchivoJson` reinterpreta el JSON en CADA cambio del fichero. Si
// el demonio publicara a 15 fps, esto serían 15 parseos por segundo dentro del
// shell durante todo el rato que dure el modo. Por eso el demonio solo publica
// cuando cambia algo visible y como mucho cada 200 ms (ver la clase
// `Publicador`). Al tocar cualquiera de los dos lados hay que conservar ese
// trato: no es una optimización suelta, es la razón de que el modo no se note.
import { createComputed } from "ags"
import GLib from "gi://GLib"
import { crearFuenteArchivoJson } from "../sistema/fuenteArchivoJson.ts"

/** Estados que publica la máquina de `deteccion.py`. Se refleja tal cual para
 *  poder explicar en la UI por qué el modo no reacciona ("en pausa" cuando el
 *  usuario tiene el puño cerrado es información, no ruido). */
export type EstadoGestos =
  | "apagado"
  | "buscando"     // encendido, sin mano en el cuadro
  | "neutro"       // puño cerrado: pausa pedida por el usuario
  | "armado"       // palma abierta, listo para un swipe
  | "reposo"       // acaba de actuar; espera a que la mano se pare
  | "arrastrando"  // pellizco activo moviendo una ventana
  | "espera"       // en pausa larga: solo mira el doble abrir y cerrar

export interface Gestos {
  activo: boolean
  /** Epoch en segundos en que se encendió, o `null`. */
  desde: number | null
  estado: EstadoGestos
  /** Hay una mano en el cuadro ahora mismo. */
  mano: boolean
  camara: string | null
  nombre: string | null
  /** Último gesto aceptado (`swipe-derecha`, `pellizco`…), para el tooltip. */
  ultimoGesto: string | null
  cuando: number | null
  /** Por qué NO está activo, cuando el arranque falló. Es lo que permite que
   *  Ajustes explique "la cámara la está usando firefox" en vez de dejar un
   *  interruptor que no se queda encendido y no dice por qué. */
  motivo: string | null
}

const VACIO: Gestos = {
  activo: false, desde: null, estado: "apagado", mano: false,
  camara: null, nombre: null, ultimoGesto: null, cuando: null, motivo: null,
}

const ESTADOS: EstadoGestos[] = [
  "apagado", "buscando", "neutro", "armado", "reposo", "arrastrando", "espera",
]

const RUTA = `${GLib.get_user_config_dir()}/gigios/gestos-estado.json`

const cadena = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const entero = (v: unknown): number | null => (Number.isFinite(v) ? Number(v) : null)

export const gestos = crearFuenteArchivoJson<Gestos>({
  ruta: RUTA,
  vacio: VACIO,
  etiqueta: "gestos",
  interpretar: (contenido) => {
    const datos = JSON.parse(contenido)
    if (!datos || typeof datos !== "object") return VACIO
    const estado = ESTADOS.includes(datos.estado) ? (datos.estado as EstadoGestos) : "apagado"
    // `activo` se cruza con el estado en vez de creerse el booleano a pelo: un
    // `activo:true` con `estado:"apagado"` (un fichero escrito a medias, o el
    // apagado de emergencia de gestos.sh) dejaría el indicador de la barra
    // encendido señalando a una cámara que ya nadie mira.
    const activo = datos.activo === true && estado !== "apagado"
    return {
      activo,
      desde: entero(datos.desde),
      estado: activo ? estado : "apagado",
      mano: activo && datos.mano === true,
      camara: cadena(datos.camara),
      nombre: cadena(datos.nombre),
      ultimoGesto: cadena(datos.ultimoGesto),
      cuando: entero(datos.cuando),
      motivo: cadena(datos.motivo),
    }
  },
})

/** Lo único que necesita la ranura de la barra para montar o desmontar. */
export const gestosActivos = createComputed([gestos], (g) => g.activo)

/** Motivo por el que el último encendido no llegó a cuajar, si lo hubo. */
export const gestosMotivo = createComputed([gestos], (g) => (g.activo ? null : g.motivo))

/** El modo está encendido pero PAUSADO con el gesto de doble apertura. Es un
 *  estado que hay que poder ver de un vistazo: en él no responde nada, y sin
 *  señal es indistinguible de que se haya roto. */
export const gestosEnEspera = createComputed([gestos], (g) => g.activo && g.estado === "espera")

const NOMBRES_GESTO: Record<string, string> = {
  "swipe-derecha": "escritorio siguiente",
  "swipe-izquierda": "escritorio anterior",
  pellizco: "ventana agarrada",
  espera: "pausado con la mano",
  flotar: "ventana flotante alternada",
  "espera-fin": "reanudado con la mano",
}

const NOMBRES_ESTADO: Record<EstadoGestos, string> = {
  apagado: "apagado",
  buscando: "buscando tu mano",
  neutro: "en pausa (puño cerrado)",
  armado: "listo",
  reposo: "espera a que pares la mano",
  arrastrando: "moviendo la ventana",
  espera: "EN PAUSA · abre y cierra la mano dos veces para volver",
}

/** Texto del tooltip. Dice el ESTADO y no solo "activo", porque los dos casos
 *  en que el usuario se pregunta qué pasa —el puño cerrado y la espera tras un
 *  swipe— son justo los que parecen "no funciona" sin una explicación. */
export function descripcionGestos(g: Gestos): string {
  if (!g.activo) return g.motivo ?? "Modo gestos apagado"
  const base = `Modo gestos · ${NOMBRES_ESTADO[g.estado]}`
  const ultimo = g.ultimoGesto ? NOMBRES_GESTO[g.ultimoGesto] : null
  return ultimo ? `${base} · último: ${ultimo}` : base
}
