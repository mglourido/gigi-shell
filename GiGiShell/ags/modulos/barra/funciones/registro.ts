import { createComputed, type Accessor } from "ags"
import {
  fijarMantenerDespiertoActivo,
  mantenerDespiertoActivo,
  tiempoRestanteMantenerDespierto,
} from "../../../servicios/energia/mantenerDespierto"
import {
  textoChipMantenerDespierto,
  textoChipSuspensionFalsa,
} from "../../../servicios/energia/tiempoMantenerDespierto"
import {
  alternarSuspensionFalsa,
  plazoSuprimidoPorWakeUp,
  segundosParaSuspensionReal,
  suspensionFalsaActiva,
} from "../../../servicios/energia/suspensionFalsa"
import OpcionesMantenerDespierto from "./OpcionesMantenerDespierto"
import OpcionesSuspensionFalsa from "./OpcionesSuspensionFalsa"
import { cpuRamHabilitado, fijarCpuRamHabilitado } from "./estado"

export type EstadoReactivo<T> = Accessor<T>

export type FuncionBarra = {
  etiqueta: string
  habilitada: EstadoReactivo<boolean>
  alternar: (activa: boolean) => void
  /** Texto del chip derecho. Si falta, la fila enseña ON/OFF. */
  estado?: EstadoReactivo<string>
  /** Contenido desplegable bajo la fila mientras la función está encendida. */
  expandir?: () => any
}

const chipMantenerDespierto = createComputed(
  [mantenerDespiertoActivo, tiempoRestanteMantenerDespierto],
  (activo: boolean, restante: number | null) =>
    textoChipMantenerDespierto(activo, restante),
)

// El chip de la suspensión falsa depende de TRES cosas y no de dos: además de estar puesta
// y de cuánto falta, hace falta saber si el plazo está suprimido por un Wake up vivo. Sin
// ese tercer estado el chip enseñaría una cuenta atrás que no va a saltar — el fallo
// silencioso que la regla 3 de docs/suspension-falsa.md existe para evitar.
const chipSuspensionFalsa = createComputed(
  [suspensionFalsaActiva, segundosParaSuspensionReal, plazoSuprimidoPorWakeUp],
  (activa: boolean, restante: number | null, suprimido: boolean) =>
    textoChipSuspensionFalsa(activa, restante, suprimido),
)

/** Registro de funciones visibles en el menú de la barra. */
export const FUNCIONES_BARRA: FuncionBarra[] = [
  {
    etiqueta: "CPU / RAM",
    habilitada: cpuRamHabilitado,
    alternar: fijarCpuRamHabilitado,
  },
  {
    etiqueta: "Wake up",
    habilitada: mantenerDespiertoActivo,
    alternar: fijarMantenerDespiertoActivo,
    estado: chipMantenerDespierto,
    expandir: OpcionesMantenerDespierto,
  },
  {
    etiqueta: "Suspensión falsa",
    habilitada: suspensionFalsaActiva,
    // Pulsar ENTRA al instante, sin esperar a ninguna inactividad: es literalmente lo que
    // se está pidiendo al pulsarla («me voy»). La entrada delegada por inactividad es la
    // otra puerta, y vive dentro del Wake up (ver OpcionesMantenerDespierto).
    //
    // Se ignora el booleano que llega y se llama a `alternarSuspensionFalsa()`: el estado
    // real lo publica el servicio de forma asíncrona (los efectores lanzan procesos y hay
    // guarda de reentrada), así que un `fijar(activa)` que decidiera aquí podría contradecir
    // lo que el servicio acabe haciendo. La fila se pinta de `suspensionFalsaActiva`, que
    // es la única fuente de verdad.
    alternar: () => { alternarSuspensionFalsa() },
    estado: chipSuspensionFalsa,
    expandir: OpcionesSuspensionFalsa,
  },
]
