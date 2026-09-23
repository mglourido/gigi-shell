// Temporizador y cronómetro: lógica pura. Ninguna de estas funciones cuenta ticks.
//
// **Todo se calcula contra marcas de tiempo absolutas, nunca acumulando intervalos.** Un contador
// que suma 1 s por tick se desfasa con cada tick perdido —y GLib los pierde: el equipo suspende, el
// bucle principal se retrasa bajo carga, la barra se oculta y el widget deja de pintarse—. Con
// marcas, el error es siempre cero por muchos frames que se salten, y los ticks pasan a ser lo que
// deben ser: presentación, no medida.

import type { Cronometro, Temporizador } from "./tipos.ts"

// ── Temporizador ─────────────────────────────────────────────────────────────

export function iniciarTemporizador(t: Temporizador, ahoraMs: number): Temporizador {
  const duracion = t.duracionMs > 0 ? t.duracionMs : 0
  if (duracion === 0) return t
  return { ...t, estado: "corriendo", venceEn: ahoraMs + duracion, restanteMs: duracion }
}

export function pausarTemporizador(t: Temporizador, ahoraMs: number): Temporizador {
  if (t.estado !== "corriendo") return t
  return { ...t, estado: "pausado", restanteMs: restanteTemporizador(t, ahoraMs), venceEn: null }
}

export function continuarTemporizador(t: Temporizador, ahoraMs: number): Temporizador {
  if (t.estado !== "pausado") return t
  return { ...t, estado: "corriendo", venceEn: ahoraMs + t.restanteMs }
}

export function cancelarTemporizador(t: Temporizador): Temporizador {
  return { ...t, estado: "parado", venceEn: null, restanteMs: t.duracionMs }
}

/** Milisegundos que faltan. Nunca negativo: vencido es 0. */
export function restanteTemporizador(t: Temporizador, ahoraMs: number): number {
  if (t.estado === "corriendo" && t.venceEn !== null) return Math.max(0, t.venceEn - ahoraMs)
  if (t.estado === "pausado") return Math.max(0, t.restanteMs)
  return Math.max(0, t.duracionMs)
}

export function haVencido(t: Temporizador, ahoraMs: number): boolean {
  return t.estado === "corriendo" && t.venceEn !== null && ahoraMs >= t.venceEn
}

/** Ajusta la duración configurada. Con el temporizador parado también mueve lo que se muestra. */
export function fijarDuracion(t: Temporizador, duracionMs: number): Temporizador {
  const duracion = Math.max(0, Math.round(duracionMs))
  if (t.estado === "corriendo") return { ...t, duracionMs: duracion }
  return { ...t, duracionMs: duracion, restanteMs: duracion }
}

// ── Cronómetro ───────────────────────────────────────────────────────────────

export function iniciarCronometro(c: Cronometro, ahoraMs: number): Cronometro {
  if (c.estado === "corriendo") return c
  return { estado: "corriendo", desde: ahoraMs, acumuladoMs: c.acumuladoMs }
}

export function pausarCronometro(c: Cronometro, ahoraMs: number): Cronometro {
  if (c.estado !== "corriendo") return c
  return { estado: "pausado", desde: null, acumuladoMs: transcurrido(c, ahoraMs) }
}

export function reiniciarCronometro(): Cronometro {
  return { estado: "parado", desde: null, acumuladoMs: 0 }
}

/** Milisegundos medidos, sumando el tramo en curso si lo hay. */
export function transcurrido(c: Cronometro, ahoraMs: number): number {
  if (c.estado === "corriendo" && c.desde !== null) {
    return c.acumuladoMs + Math.max(0, ahoraMs - c.desde)
  }
  return c.acumuladoMs
}

// ── Formato ──────────────────────────────────────────────────────────────────

/** `MM:SS`, o `H:MM:SS` a partir de una hora. Se redondea hacia arriba: un temporizador nunca
 *  debe enseñar 0:00 mientras todavía queda algo. */
export function formatearRestante(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const horas = Math.floor(total / 3600)
  const minutos = Math.floor((total % 3600) / 60)
  const segundos = total % 60
  const dd = (n: number) => String(n).padStart(2, "0")
  return horas > 0 ? `${horas}:${dd(minutos)}:${dd(segundos)}` : `${dd(minutos)}:${dd(segundos)}`
}

/** `MM:SS.d` (décimas), o `H:MM:SS.d`. El cronómetro sí redondea hacia abajo: mide lo transcurrido. */
export function formatearCronometro(ms: number): string {
  const total = Math.max(0, ms)
  const decimas = Math.floor((total % 1000) / 100)
  const segundosTotales = Math.floor(total / 1000)
  const horas = Math.floor(segundosTotales / 3600)
  const minutos = Math.floor((segundosTotales % 3600) / 60)
  const segundos = segundosTotales % 60
  const dd = (n: number) => String(n).padStart(2, "0")
  return horas > 0
    ? `${horas}:${dd(minutos)}:${dd(segundos)}.${decimas}`
    : `${dd(minutos)}:${dd(segundos)}.${decimas}`
}

/**
 * `MM:SS`, o `H:MM:SS`. Mismo redondeo hacia abajo que `formatearCronometro`, pero sin décimas.
 *
 * Es el formato del reloj de la BARRA, que sustituye a la hora mientras el cronómetro corre. Ahí las
 * décimas no se pueden enseñar: obligarían a repintar a 10 Hz —y por monitor— una etiqueta que está
 * siempre en pantalla, para un dígito que a ese tamaño no se lee. En el panel, donde el cronómetro es
 * lo que estás mirando, se siguen enseñando.
 */
export function formatearCronometroCorto(ms: number): string {
  const segundosTotales = Math.floor(Math.max(0, ms) / 1000)
  const horas = Math.floor(segundosTotales / 3600)
  const minutos = Math.floor((segundosTotales % 3600) / 60)
  const segundos = segundosTotales % 60
  const dd = (n: number) => String(n).padStart(2, "0")
  return horas > 0 ? `${horas}:${dd(minutos)}:${dd(segundos)}` : `${dd(minutos)}:${dd(segundos)}`
}

/**
 * Milisegundos hasta el próximo cambio VISIBLE de la etiqueta.
 *
 * Se usa para alinear el tick con el reloj en vez de disparar cada 1000 ms desde un origen
 * arbitrario: si no, la cifra salta a destiempo y se ve saltarse un segundo cada minuto.
 */
export function msHastaSiguienteTick(ms: number, resolucionMs = 1000): number {
  const resto = Math.max(0, ms) % resolucionMs
  return resto === 0 ? resolucionMs : resto
}

/**
 * Lo mismo, pero para una cuenta que SUBE (el cronómetro) en vez de bajar.
 *
 * No vale la función de arriba: contando hacia atrás, la etiqueta cambia cuando pasa el resto;
 * contando hacia delante, cuando pasa lo que falta para el siguiente múltiplo. Usar la de la cuenta
 * atrás aquí daría un tick anticipado y otro tardío alternándose.
 *
 * Hace falta porque el cronómetro repetía cada 100 ms con `SOURCE_CONTINUE`, y GLib cuenta ese
 * intervalo **desde que el callback anterior terminó**: cada vuelta acumula el retraso de la
 * anterior, así que las décimas se veían saltar de dos en dos cada pocos segundos. Realineando
 * contra `Date.now()` en cada vuelta, la deriva no se acumula.
 */
export function msHastaSiguienteTickAscendente(ms: number, resolucionMs = 100): number {
  return resolucionMs - (Math.max(0, ms) % resolucionMs)
}
