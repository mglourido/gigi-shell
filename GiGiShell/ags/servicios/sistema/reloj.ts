import GLib from "gi://GLib"
import { createState } from "ags"
import { alReanudar } from "./reanudacion.ts"

/** Tic global alineado al minuto; todos los monitores comparten este único timer. */
export const [ticReloj, establecerTicReloj] = createState(0)

// El temporizador vivo, sea el de alineación inicial o el encadenado de 60 s. Uno
// solo: la cadena reasigna esta variable, así que `cancelar()` siempre alcanza al
// que esté armado en ese momento.
let idTic: number | null = null

function tic() {
  establecerTicReloj(ticReloj.get() + 1)
}

function cancelar() {
  if (idTic !== null) {
    GLib.source_remove(idTic)
    idTic = null
  }
}

/**
 * Programa el próximo tic en el cambio de minuto **de pared** y encadena uno por
 * minuto a partir de ahí.
 *
 * Se descuentan los microsegundos del segundo en curso además de los segundos: sin
 * eso el tic cae hasta ~1 s antes del cambio de minuto y el reloj enseña el minuto
 * viejo durante ese hueco.
 */
function alinear() {
  cancelar()
  const ahora = GLib.DateTime.new_now_local()
  const restanteMs = (60 - ahora.get_second()) * 1000 - Math.floor(ahora.get_microsecond() / 1000)
  idTic = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, restanteMs), () => {
    tic()
    idTic = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60_000, () => {
      tic()
      return GLib.SOURCE_CONTINUE
    })
    return GLib.SOURCE_REMOVE
  })
}

alinear()

/**
 * La alineación al minuto se hacía UNA sola vez, al arrancar, y de ahí en adelante
 * la cadena de 60 s era monotónica — o sea que **cada suspensión desplazaba la fase
 * de forma permanente**, hasta reiniciar AGS. Con los 127,8 s suspendidos que medí
 * en un arranque cualquiera, el tic pasaba a caer ~7,8 s después de cada minuto de
 * pared (127,8 mod 60), y el desfase se acumula con cada suspensión siguiente.
 *
 * Además, justo al despertar el temporizador pendiente reanudaba con el resto que
 * le quedaba: la barra podía enseñar **el minuto anterior hasta 60 s** después de
 * volver, que es la parte que se ve.
 *
 * Al reanudar se hace lo uno y lo otro: un tic inmediato (para que la hora salte ya)
 * y una realineación (para volver a caer en el segundo :00). De este tic cuelgan el
 * reloj de la barra, el indicador de alarma, el «hoy» del calendario y QuickSettings.
 */
alReanudar(() => {
  tic()
  alinear()
})
