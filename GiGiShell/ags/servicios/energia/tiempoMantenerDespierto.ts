// Lógica pura de «Mantener despierto»: interpreta el campo de minutos y da
// formato a la cuenta atrás. El estado y los efectos viven en mantenerDespierto.ts.

/** Techo del plazo: 24 h. Para plazos mayores se puede usar «sin límite». */
export const MAXIMO_MINUTOS = 24 * 60

/** Texto del campo de minutos → minutos, o null = sin límite. */
export function interpretarMinutos(texto: string): number | null {
  const limpio = texto.trim()
  if (limpio === "" || !/^\d+$/.test(limpio)) return null
  const minutos = Number(limpio)
  if (!Number.isFinite(minutos)) return MAXIMO_MINUTOS
  if (minutos <= 0) return null
  return Math.min(minutos, MAXIMO_MINUTOS)
}

/** Normaliza lo que se enseña en el campo tras confirmar (vacío = sin límite). */
export function normalizarTextoMinutos(texto: string): string {
  const minutos = interpretarMinutos(texto)
  return minutos === null ? "" : String(minutos)
}

/**
 * Segundos restantes → texto corto para el chip del menú.
 * Menos de una hora usa M:SS; a partir de una hora usa H:MM:SS.
 */
export function formatearTiempoRestante(segundos: number): string {
  const total = Number.isFinite(segundos) ? Math.max(0, Math.ceil(segundos)) : 0
  const horas = Math.floor(total / 3600)
  const minutos = Math.floor((total % 3600) / 60)
  const segundosRestantes = total % 60
  const dosDigitos = (numero: number) => String(numero).padStart(2, "0")
  return horas > 0
    ? `${horas}:${dosDigitos(minutos)}:${dosDigitos(segundosRestantes)}`
    : `${minutos}:${dosDigitos(segundosRestantes)}`
}

/** Texto del chip: cuenta atrás, ∞ si no hay plazo y OFF si está apagado. */
export function textoChipMantenerDespierto(
  activo: boolean,
  segundosRestantes: number | null,
): string {
  if (!activo) return "OFF"
  return segundosRestantes === null ? "∞" : formatearTiempoRestante(segundosRestantes)
}

/** Tooltip del icono de la barra. */
export function textoTooltipMantenerDespierto(
  segundosRestantes: number | null,
  mantenerPantalla: boolean,
): string {
  const cabecera = segundosRestantes === null
    ? "Wake up · sin límite"
    : `Wake up · ${formatearTiempoRestante(segundosRestantes)} restantes`
  return mantenerPantalla
    ? `${cabecera}\nLa pantalla tampoco se apaga`
    : `${cabecera}\nLa pantalla se apaga y bloquea con normalidad`
}

// ── Suspensión falsa ────────────────────────────────────────────────────────────────
// El chip vive aquí, junto al del Wake up, y no en un módulo propio, porque los dos
// enseñan LA MISMA cuenta atrás con el mismo formato: dos formateadores distintos para
// dos funciones hermanas acaban divergiendo (uno redondea, el otro trunca) y la diferencia
// solo se ve teniendo las dos filas del menú delante a la vez.

/**
 * Texto del chip de «Suspensión falsa». Tres casos, y el tercero NO es opcional:
 *
 *  - apagada                → OFF
 *  - puesta y sin plazo     → ON (no hay ninguna suspensión real programada)
 *  - puesta y con plazo     → cuenta atrás para la suspensión REAL
 *  - plazo SUPRIMIDO        → «sin suspender (Wake up)»
 *
 * El último caso es el que evita el fallo silencioso: con un Wake up vivo el plazo de
 * suspensión real queda suprimido (el Wake up promete que el equipo no se suspende), así
 * que enseñar la cuenta atrás sería anunciar algo que no va a pasar. Un plazo que
 * calladamente no se cumple es peor que no ofrecerlo, de ahí que se diga con todas las
 * letras y se nombre al culpable.
 */
export function textoChipSuspensionFalsa(
  activa: boolean,
  segundosRestantes: number | null,
  plazoSuprimido: boolean,
): string {
  if (!activa) return "OFF"
  if (plazoSuprimido) return "sin suspender (Wake up)"
  return segundosRestantes === null ? "ON" : formatearTiempoRestante(segundosRestantes)
}

/** Tooltip de la fila: explica el chip, que por sí solo no dice de qué plazo habla. */
export function textoTooltipSuspensionFalsa(
  activa: boolean,
  segundosRestantes: number | null,
  plazoSuprimido: boolean,
): string {
  if (!activa) {
    return "Apaga el escritorio sin detener el kernel.\nLas descargas, compilaciones y sesiones SSH siguen vivas."
  }
  if (plazoSuprimido) {
    return "Suspensión falsa puesta.\nEl plazo para suspender de verdad NO corre: hay un Wake up activo.\nAl apagarlo, el plazo empieza a contar desde cero."
  }
  if (segundosRestantes === null) {
    return "Suspensión falsa puesta.\nNo hay plazo: el equipo no se suspenderá de verdad por su cuenta."
  }
  return `Suspensión falsa puesta.\nSuspensión real en ${formatearTiempoRestante(segundosRestantes)}.`
}
