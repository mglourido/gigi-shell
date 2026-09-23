// Modelo de movimiento puro del lagarto: aceleración/frenado suaves, paradas
// aleatorias y giros aleatorios en mitad del recorrido (no solo al chocar con
// un borde). `azar` se inyecta para poder testear las ramas aleatorias de
// forma determinista; en producción es `Math.random`.
export type EstadoAndar = "caminando" | "parado"

export interface EstadoMovimiento {
  x: number
  direccion: 1 | -1
  vx: number
  estado: EstadoAndar
  ticksParado: number
  distanciaAcumulada: number
  fotograma: 0 | 1
}

export function estadoInicial(): EstadoMovimiento {
  return {
    x: 0,
    direccion: 1,
    vx: 0,
    estado: "caminando",
    ticksParado: 0,
    distanciaAcumulada: 0,
    fotograma: 0,
  }
}

/** Mismo estado inicial, pero con posición y sentido al azar dentro de
 * [minX, maxX]. Para que cada aparición de la mascota (se activa y desactiva
 * con la actividad del escritorio) no arranque siempre en el mismo punto
 * mirando hacia el mismo lado. `minX` por defecto 0 cubre el caso normal
 * (todo el ancho disponible); solo hace falta cuando ya hay un panel
 * ocupando parte de la pantalla al aparecer (ver estado/paneles.ts). */
export function estadoAleatorio(maxX: number, azar: () => number = Math.random, minX = 0): EstadoMovimiento {
  const limiteMax = Math.max(minX, maxX)
  return {
    ...estadoInicial(),
    x: limiteMax > minX ? minX + azar() * (limiteMax - minX) : minX,
    direccion: azar() < 0.5 ? 1 : -1,
  }
}

export interface ParametrosMovimiento {
  /** Velocidad de crucero, en px por tick. */
  velocidadMax: number
  /** Cuánto se acerca `vx` a su objetivo en cada tick (rampa de aceleración/frenado). */
  aceleracion: number
  /** Probabilidad por tick de iniciar una parada mientras camina a velocidad de crucero. */
  probParada: number
  /** Probabilidad por tick de invertir el sentido a media marcha (no al chocar con un borde). */
  probGiro: number
  paradaTicksMin: number
  paradaTicksMax: number
  /** Distancia acumulada (px) que dispara el cambio de fotograma de las patas. */
  umbralFotograma: number
}

// Más tranquilo que un paseo cualquiera: crucero lento, rampa suave, paradas
// largas y poco frecuentes, y casi ningún giro a media marcha (el sentido
// cambia sobre todo al chocar con un borde, no porque decida girarse solo).
export const PARAMETROS_PREDETERMINADOS: ParametrosMovimiento = {
  velocidadMax: 0.9,
  aceleracion: 0.07,
  probParada: 0.004,
  probGiro: 0.0006,
  paradaTicksMin: 20,
  paradaTicksMax: 70,
  umbralFotograma: 2.2,
}

function amortiguar(actual: number, objetivo: number, paso: number): number {
  const delta = objetivo - actual
  if (Math.abs(delta) <= paso) return objetivo
  return actual + Math.sign(delta) * paso
}

function enteroAleatorioCon(azar: () => number, min: number, max: number): number {
  return Math.floor(min + azar() * (max - min + 1))
}

/** Un paso del modelo. No muta `estado`: devuelve el siguiente. `minX` (0 por
 * defecto) desplaza el borde izquierdo del recorrido: lo usa la mascota
 * cuando un panel anclado a la izquierda (el calendario) le tiene vetada esa
 * franja mientras está abierto (ver estado/paneles.ts).
 *
 * Envoltorio puro sobre `avanzarPasoEnSitio`: copia y delega. El bucle de la
 * mascota usa la variante en sitio (ver allí el porqué); esta queda para los
 * tests y para cualquier uso donde la inmutabilidad importe más que el coste
 * de una copia. */
export function avanzarPaso(
  estado: EstadoMovimiento,
  maxX: number,
  params: ParametrosMovimiento = PARAMETROS_PREDETERMINADOS,
  azar: () => number = Math.random,
  minX = 0,
): EstadoMovimiento {
  return avanzarPasoEnSitio({ ...estado }, maxX, params, azar, minX)
}

/** Mismo paso, MUTANDO el estado recibido (y devolviéndolo por comodidad).
 * El bucle de la mascota corre a ~11 ticks/s por monitor y mientras la
 * mascota esté a la vista no para nunca: con la versión pura cada tick
 * dejaba atrás un objeto de siete campos para el GC de gjs sin que nadie
 * mirara nunca el estado anterior. Aquí el estado es una única celda
 * reutilizada durante toda la aparición.
 *
 * Precisión: son píxeles de pantalla que acaban redondeados al pintar, así
 * que todo el modelo trabaja con magnitudes pequeñas y acotadas —`x` dentro
 * de [minX, maxX], `vx` dentro de ±velocidadMax y `distanciaAcumulada`
 * descontando su umbral en vez de crecer sin fin— y no hace falta ninguna
 * corrección de error acumulado. */
export function avanzarPasoEnSitio(
  estado: EstadoMovimiento,
  maxX: number,
  params: ParametrosMovimiento = PARAMETROS_PREDETERMINADOS,
  azar: () => number = Math.random,
  minX = 0,
): EstadoMovimiento {
  const limiteMax = maxX > minX ? maxX : minX

  if (estado.estado === "parado") {
    estado.vx = amortiguar(estado.vx, 0, params.aceleracion)
    if (--estado.ticksParado <= 0) estado.estado = "caminando"
  } else {
    estado.vx = amortiguar(estado.vx, estado.direccion * params.velocidadMax, params.aceleracion)
    // Las decisiones aleatorias solo se toman a velocidad de crucero: decidir
    // pararse o girar en plena rampa de aceleración se vería como un tirón.
    // Un ÚNICO sorteo decide entre las dos (los intervalos [0, probParada) y
    // [probParada, probParada + probGiro) son disjuntos): son sucesos rarísimos
    // -0,4% y 0,06% por tick- y encadenar dos llamadas a `azar()` por tick
    // gastaba el doble de aleatoriedad para el mismo comportamiento.
    const vxAbs = estado.vx < 0 ? -estado.vx : estado.vx
    if (vxAbs > params.velocidadMax * 0.8) {
      const sorteo = azar()
      if (sorteo < params.probParada) {
        estado.estado = "parado"
        estado.ticksParado = enteroAleatorioCon(azar, params.paradaTicksMin, params.paradaTicksMax)
      } else if (sorteo < params.probParada + params.probGiro) {
        estado.direccion = estado.direccion === 1 ? -1 : 1
      }
    }
  }

  estado.x += estado.vx
  if (estado.x <= minX) {
    estado.x = minX
    estado.direccion = 1
    estado.vx = 0
    estado.estado = "parado"
    estado.ticksParado = enteroAleatorioCon(azar, params.paradaTicksMin, params.paradaTicksMax)
  } else if (estado.x >= limiteMax) {
    estado.x = limiteMax
    estado.direccion = -1
    estado.vx = 0
    estado.estado = "parado"
    estado.ticksParado = enteroAleatorioCon(azar, params.paradaTicksMin, params.paradaTicksMax)
  }

  // Las patas solo se animan si de verdad hay movimiento apreciable: paradas
  // (incluida la del frenado, que tarda unos ticks en llegar a 0) se congelan.
  const avance = estado.vx < 0 ? -estado.vx : estado.vx
  if (avance > 0.15) {
    estado.distanciaAcumulada += avance
    if (estado.distanciaAcumulada >= params.umbralFotograma) {
      estado.distanciaAcumulada -= params.umbralFotograma
      estado.fotograma = estado.fotograma === 0 ? 1 : 0
    }
  }

  return estado
}
