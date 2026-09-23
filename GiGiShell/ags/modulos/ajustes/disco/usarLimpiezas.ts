// modulos/ajustes/disco/usarLimpiezas.ts — el estado de "qué limpieza está corriendo y cómo acabó",
// compartido por TODAS las vistas vivas de Ajustes > Almacenamiento.
//
// ── Por qué NO vive dentro de cada fila, que es donde estaba ─────────────────
// Cada botón guardaba su `ocupado` y su `resultado` en su propio `createState`. Funcionaba hasta
// que se terminaba de limpiar: al acabar, la fila llama a `refrescar()` para que el desglose deje
// de mentir, el análisis nuevo llega ~0,6 s después y reemite el accessor del que cuelga
// `<With value={analisis}>`… que RECONSTRUYE todas las filas. Los widgets viejos se destruyen con
// su estado dentro, así que el «Se han liberado 3,4 GB» aparecía y desaparecía solo, y el usuario
// se quedaba sin saber si la limpieza había hecho algo. Lo mismo con el botón, que volvía de
// «Limpiando…» a su etiqueta normal antes de tiempo si el análisis se le adelantaba.
//
// ── Y por qué tampoco vive dentro de la VISTA, que es donde estaba después ───
// Subirlo a la vista arregló lo anterior pero dejaba una copia por instancia, y `SettingsPanel` se
// construye **una vez por monitor** (`app.ts`: `app.get_monitors().map(...)`) con
// `settingsPanelVisible` global: con dos pantallas, pulsar «Vaciar papelera» en una dejaba a la
// otra enseñando el botón normal —pulsable— mientras la limpieza corría, y el «Se han liberado
// 3,4 GB» solo salía en la pantalla donde habías pulsado. El guardia de reentrada (`if
// (ocupadas.get().has(id)) return`) tampoco cruzaba de una instancia a la otra, así que la misma
// limpieza se podía lanzar dos veces a la vez desde dos monitores.
//
// Con el estado a nivel de módulo hay un solo mapa: todas las pantallas enseñan lo mismo y el
// guardia vale para todas. Mismo contador de referencias que `usarAnalisis.ts` — ver allí por qué
// es un contador y no un booleano.
//
// ── Y por qué un mapa único y no un estado por acción ───────────────────────
// Son doce acciones. Doce pares de `createState` son veinticuatro suscripciones que hay que crear,
// recorrer y limpiar para representar algo de lo que como mucho hay una o dos entradas vivas a la
// vez. Un mapa se reemite una vez por transición y cada fila filtra lo suyo.
import { createState, onCleanup, type Accessor } from "ags"
import { ejecutarLimpieza, type ResultadoLimpieza } from "../../../servicios/disco/limpieza"
import { limpiarAhora } from "../../../servicios/disco/preferencias"
import type { IdAccion } from "../../../servicios/disco/catalogo"
import { caducarAnalisis } from "./usarAnalisis"

export interface Limpiezas {
  /** Acciones ejecutándose ahora mismo. Deshabilita su botón y le cambia la etiqueta. */
  ocupadas: Accessor<ReadonlySet<IdAccion>>
  /** Cómo acabó la última ejecución de cada acción, mientras quede alguna vista abierta. */
  resultados: Accessor<ReadonlyMap<IdAccion, ResultadoLimpieza>>
  /** Lanza una limpieza. Reentrante: una segunda pulsación mientras corre no hace nada. */
  ejecutar: (id: IdAccion) => void
}

const [ocupadas, setOcupadas] = createState<ReadonlySet<IdAccion>>(new Set())
const [resultados, setResultados] = createState<ReadonlyMap<IdAccion, ResultadoLimpieza>>(new Map())
const [autolimpiezaEnCurso, setAutolimpiezaEnCurso] = createState(false)

/** Vistas montadas ahora mismo. */
let referencias = 0

/**
 * Lanza una limpieza.
 *
 * El reanálisis (`caducarAnalisis`) se pide solo cuando terminó en `ok`: no hay nada que volver a
 * medir si el usuario canceló el diálogo de contraseña o faltaba el helper. Y se pide a
 * `usarAnalisis` en vez de llamar a `refrescar` directamente porque con Ajustes ya cerrado —una
 * limpieza de varios segundos puede terminar después— reanalizar sería medir para nadie: allí se
 * anota que la medida en caché quedó obsoleta y se rehace en la siguiente apertura. Sin eso, cerrar
 * Ajustes justo después de liberar 20 GB dejaba la sección enseñando las cifras de ANTES durante
 * los diez minutos de la ventana de frescura.
 */
function ejecutar(id: IdAccion): void {
  if (ocupadas.get().has(id)) return
  setOcupadas(new Set([...ocupadas.get(), id]))
  // El resultado anterior se borra al empezar: dejarlo puesto mientras el botón dice
  // «Limpiando…» enseña la cifra de la vez pasada como si fuera la de ahora.
  const sinPrevio = new Map(resultados.get())
  sinPrevio.delete(id)
  setResultados(sinPrevio)

  ejecutarLimpieza(id).then(r => {
    // La baja de `ocupadas` es INCONDICIONAL, aunque ya no mire nadie: es el guardia de reentrada,
    // y dejar el id dentro con Ajustes cerrado dejaría ese botón muerto —«Limpiando…» para
    // siempre— en la siguiente apertura, porque `ocupadas` sobrevive al desmontaje a propósito
    // (ver `soltar`).
    const restantes = new Set(ocupadas.get())
    restantes.delete(id)
    setOcupadas(restantes)
    // El mensaje sí es para la vista: si no queda ninguna, se descarta en vez de guardarse para
    // aparecer sin contexto la próxima vez que abras Ajustes.
    if (referencias > 0) setResultados(new Map(resultados.get()).set(id, r))
    if (r.estado === "ok") caducarAnalisis()
  })
}

/** El objeto es constante: todas las vistas comparten los mismos accessors. */
const LIMPIEZAS: Limpiezas = { ocupadas, resultados, ejecutar }

/**
 * «Limpiar ahora» de la autolimpieza (`limpieza-arranque.sh --ahora`). Vive aquí y no en la vista
 * por lo mismo que el resto: era un `createState` local, así que con dos monitores el botón se
 * quedaba en «Limpiando…» solo en uno y era pulsable en el otro mientras la limpieza corría.
 */
export function ejecutarAutolimpieza(): void {
  if (autolimpiezaEnCurso.get()) return
  setAutolimpiezaEnCurso(true)
  limpiarAhora()
    .catch(() => {})
    .finally(() => {
      setAutolimpiezaEnCurso(false)
      caducarAnalisis()
    })
}

/** Si «Limpiar ahora» está en marcha. Compartido, igual que `ocupadas`. */
export { autolimpiezaEnCurso }

function soltar(): void {
  referencias = Math.max(0, referencias - 1)
  if (referencias > 0) return

  // `ocupadas` NO se vacía: es el guardia de reentrada de limpiezas que pueden seguir corriendo
  // con Ajustes cerrado, y se vacía sola cuando resuelven. Lo que se tira son los MENSAJES, que
  // son de la sesión de la vista.
  //
  // Aplazado un tick por lo mismo que en `usarAnalisis.ts`: `soltar` corre dentro del desmontaje,
  // con las filas todavía suscritas, y escribir el estado ahí las haría repintarse a medio
  // disponer. Si la vista se está reconstruyendo (navegar entre «Almacenamiento» y «Liberar
  // espacio»), para entonces ya hay referencias otra vez y el mensaje se conserva.
  Promise.resolve().then(() => {
    if (referencias > 0) return
    if (resultados.get().size > 0) setResultados(new Map())
  })
}

/**
 * Devuelve el estado de limpiezas compartido y lo retiene mientras la vista esté montada.
 *
 * Llamarlo desde el cuerpo de un componente: usa `onCleanup`.
 */
export function usarLimpiezas(): Limpiezas {
  referencias++
  onCleanup(soltar)
  return LIMPIEZAS
}
