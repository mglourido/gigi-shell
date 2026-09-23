/** La escala del volumen de ENTRADA, que no es la misma que la de salida.
 *
 * Puro y sin GI: se prueba con `node --test`.
 *
 * ── Por qué el micrófono tiene su propia escala ──────────────────────────────
 *
 * En este equipo (Realtek ALC897, mic frontal) PipeWire combina "Capture" +
 * "Front Mic Boost" en una única curva cúbica. Durante un tiempo el 0-100 % de
 * la UI se remapeó a `0..0.40` de esa curva ("máximo seguro" medido contra la
 * saturación al hablar de cerca), pero **el techo era demasiado bajo en uso
 * real**: el 100 % del slider dejaba el micro en el 40 % del hardware y se oía
 * muy flojo, sin manera de subir más desde la UI. Hoy `MIC_SAFE_MAX` es 1.00 —
 * el 100 % de la barra es el 100 % real de PipeWire— y la conversión queda como
 * identidad. Si alguna máquina volviera a necesitar un techo, se cambia SOLO
 * esta constante: todos los consumidores ya pasan por las funciones de abajo.
 *
 * ── Y por qué la conversión vive AQUÍ y no en cada sitio ─────────────────────
 *
 * Porque el precio de no compartirla ya se pagó dos veces. La constante estaba
 * exportada desde `QuickSettings.tsx` (4400 líneas de GTK) y la fórmula iba
 * abierta en código en cada consumidor, así que era **posible** —y pasó— que un
 * sitio pintara el valor crudo: la pastilla "Micrófono" de Quick Settings decía
 * **40** con el mismo micro que su propio submenú enseñaba como **100**, porque
 * la pastilla hacía `Math.round(v * 100)` sobre la fracción cruda de PipeWire y
 * el submenú dividía antes por `MIC_SAFE_MAX`. El fallo es silencioso por
 * naturaleza (dos números plausibles, ningún error) y solo se ve poniendo las
 * dos vistas una al lado de la otra.
 *
 * **Regla: ningún sitio nuevo puede escribir `volume * 100` para un micrófono.**
 * Todo lo que enseñe o acepte un porcentaje de entrada pasa por aquí.
 *
 * ── El techo de la UI ya no es el 100 % ──────────────────────────────────────
 *
 * Desde que los deslizadores llegan al 200 % (`volumenAmplificado.ts`), estas
 * funciones aceptan y devuelven hasta ese tope. `MIC_SAFE_MAX` sigue siendo la
 * referencia del 100 % —el punto donde el imán del deslizador clava el valor—,
 * no el máximo escribible.
 */

import { VOLUMEN_MAX } from "./volumenAmplificado.ts"

/** Techo del volumen de entrada, en fracción cruda de PipeWire (0-1).
 *
 * 1.00 = el 100 % de la UI es el 100 % del hardware (ver cabecera).
 *
 * OJO: es la referencia del **100 %**, no el máximo que se puede escribir. El
 * deslizador llega al 200 % (`VOLUMEN_MAX`, amplificación por software); lo que
 * `MIC_SAFE_MAX` fija es dónde cae la marca del 100 %. */
export const MIC_SAFE_MAX = 1.00

/** Fracción cruda de PipeWire → fracción que ve el usuario (0..VOLUMEN_MAX).
 *
 * Se recorta a `VOLUMEN_MAX` porque el valor crudo puede venir por encima de lo
 * que el deslizador puede pintar: lo pone cualquier otra herramienta
 * (pavucontrol, `wpctl set-volume`) o un preset guardado con otro tope. Enseñar
 * "400 %" sería peor que enseñar "200 %" — el deslizador ya no sube más de ahí.
 * El recorte es SOLO de presentación: no se escribe nada en el hardware. */
export function fraccionMostradaMic(crudo: number): number {
  if (!Number.isFinite(crudo) || crudo <= 0) return 0
  return Math.min(VOLUMEN_MAX, crudo / MIC_SAFE_MAX)
}

/** Fracción cruda de PipeWire → el entero 0..100 que se pinta. */
export function porcentajeMic(crudo: number): number {
  return Math.round(fraccionMostradaMic(crudo) * 100)
}

/** El 0..200 que toca el usuario → fracción cruda que se le escribe al endpoint. */
export function crudoDesdePorcentajeMic(porcentaje: number): number {
  if (!Number.isFinite(porcentaje)) return 0
  const p = Math.max(0, Math.min(VOLUMEN_MAX * 100, porcentaje))
  return (p / 100) * MIC_SAFE_MAX
}
