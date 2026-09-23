// Planificador de alarmas. Puro: decide CUÁNDO debe sonar cada cosa; quién arma el temporizador y
// quién notifica vive en `estadoReloj.ts`.
//
// **Se programa un único vencimiento: el más próximo de todas las alarmas.** No hay un bucle que
// repase la lista cada segundo. Al cambiar cualquier alarma se recalcula ese vencimiento y se
// rearma el temporizador — el mismo patrón que el resto del shell, donde sondear es la excepción.
//
// La aritmética aquí SÍ usa fechas locales (`new Date(y, m, d, h, min)`), al revés que
// `dominio/fechas.ts`. Es lo correcto: una alarma es hora de pared. «Las 7:00» tienen que ser las
// 7:00 también el domingo que cambia la hora, aunque esa noche dure 23 o 25 horas.

import { desdeFechaISO, esHoraValida, horaAMinutos } from "../dominio/fechas.ts"
import type { Alarma, DiaSemana } from "./tipos.ts"

/** Lunes = 0 … domingo = 6, a partir del `getDay()` de JS (domingo = 0). */
export function diaSemanaDe(fecha: Date): DiaSemana {
  return ((fecha.getDay() + 6) % 7) as DiaSemana
}

function instanteLocal(anio: number, mes: number, dia: number, hora: string): number {
  const minutos = horaAMinutos(hora)
  return new Date(anio, mes - 1, dia, Math.floor(minutos / 60), minutos % 60, 0, 0).getTime()
}

/**
 * Próxima activación de una alarma, en epoch ms. `null` = no volverá a sonar.
 *
 * Una alarma puntual ya pasada devuelve `null`, y ese `null` es lo que se usa al cargar para
 * desactivarlas en silencio. Una semanal sin días también: activarla sin marcar ningún día no puede
 * significar «todos», eso sería inventarse la intención del usuario.
 */
export function proximaActivacion(alarma: Alarma, ahoraMs: number): number | null {
  if (!alarma.activa) return null
  if (!esHoraValida(alarma.hora)) return null

  if (alarma.tipo === "puntual") {
    const partes = desdeFechaISO(alarma.fecha)
    if (!partes) return null
    const instante = instanteLocal(partes.anio, partes.mes, partes.dia, alarma.hora)
    return instante > ahoraMs ? instante : null
  }

  if (alarma.dias.length === 0) return null

  const ahora = new Date(ahoraMs)
  // Ocho iteraciones y no siete: si hoy es lunes y la alarma es de los lunes pero ya pasó su hora,
  // la respuesta es el lunes que viene, que es el desplazamiento 7.
  for (let salto = 0; salto <= 7; salto++) {
    const dia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + salto)
    if (!alarma.dias.includes(diaSemanaDe(dia))) continue
    const instante = instanteLocal(dia.getFullYear(), dia.getMonth() + 1, dia.getDate(), alarma.hora)
    if (instante > ahoraMs) return instante
  }
  return null
}

export interface Vencimiento {
  alarma: Alarma
  /** Epoch ms. */
  cuando: number
}

/** La alarma que vencerá antes. `null` si ninguna volverá a sonar. */
export function siguienteVencimiento(alarmas: Alarma[], ahoraMs: number): Vencimiento | null {
  let mejor: Vencimiento | null = null
  for (const alarma of alarmas) {
    const cuando = proximaActivacion(alarma, ahoraMs)
    if (cuando === null) continue
    if (mejor === null || cuando < mejor.cuando) mejor = { alarma, cuando }
  }
  return mejor
}

/** Todas las que vencen en el mismo instante (± tolerancia): dos alarmas a las 7:00 suenan las dos. */
export function alarmasQueVencen(alarmas: Alarma[], ahoraMs: number, toleranciaMs = 30_000): Alarma[] {
  return alarmas.filter((a) => {
    if (!a.activa || !esHoraValida(a.hora)) return false
    if (a.tipo === "puntual") {
      const partes = desdeFechaISO(a.fecha)
      if (!partes) return false
      const instante = instanteLocal(partes.anio, partes.mes, partes.dia, a.hora)
      return instante <= ahoraMs && ahoraMs - instante <= toleranciaMs
    }
    const ahora = new Date(ahoraMs)
    if (!a.dias.includes(diaSemanaDe(ahora))) return false
    const instante = instanteLocal(ahora.getFullYear(), ahora.getMonth() + 1, ahora.getDate(), a.hora)
    return instante <= ahoraMs && ahoraMs - instante <= toleranciaMs
  })
}

/**
 * Estado de la alarma después de sonar.
 *
 * La puntual queda desactivada —ya cumplió—; la semanal sigue viva y su siguiente activación se
 * recalcula sola, sin guardar nada. Ese cálculo derivado es justo lo que NO se persiste: guardar la
 * «próxima activación» en disco crea dos fuentes de verdad que se contradicen en cuanto cambia la
 * hora del sistema o el usuario edita los días.
 */
export function trasSonar(alarma: Alarma): Alarma {
  return alarma.tipo === "puntual" ? { ...alarma, activa: false } : alarma
}

export interface LimpiezaCarga {
  alarmas: Alarma[]
  /** Ids de las puntuales que se desactivaron por haber vencido con AGS apagado. */
  desactivadas: string[]
}

/**
 * Saneado al cargar: las alarmas puntuales cuya hora ya pasó se desactivan **en silencio**.
 *
 * No se emite la alarma atrasada. Avisar a las 9:00 de una alarma de las 7:00 no cumple ninguna
 * función —la mañana ya pasó— y en un arranque tras varios días apagado saldrían varias de golpe.
 * Se desactivan, no se borran: el usuario sigue viendo que la puso y puede reactivarla.
 */
export function sanearAlCargar(alarmas: Alarma[], ahoraMs: number): LimpiezaCarga {
  const desactivadas: string[] = []
  const saneadas = alarmas.map((a) => {
    if (a.tipo !== "puntual" || !a.activa) return a
    if (proximaActivacion(a, ahoraMs) !== null) return a
    desactivadas.push(a.id)
    return { ...a, activa: false }
  })
  return { alarmas: saneadas, desactivadas }
}

const NOMBRES_DIA = ["L", "M", "X", "J", "V", "S", "D"]

/** Texto del chip de repetición: «Una vez», «Todos los días», «L M X J V», … */
export function textoRepeticion(alarma: Alarma): string {
  if (alarma.tipo === "puntual") return "Una vez"
  const dias = [...alarma.dias].sort((a, b) => a - b)
  if (dias.length === 0) return "Sin días"
  if (dias.length === 7) return "Todos los días"
  if (dias.length === 5 && dias.every((d) => d <= 4)) return "Entre semana"
  if (dias.length === 2 && dias[0] === 5 && dias[1] === 6) return "Fin de semana"
  return dias.map((d) => NOMBRES_DIA[d]).join(" ")
}

/** «En 3 h 12 min», «En 45 min», «En menos de un minuto». `null` si no volverá a sonar. */
export function textoProximaActivacion(alarma: Alarma, ahoraMs: number): string | null {
  const cuando = proximaActivacion(alarma, ahoraMs)
  if (cuando === null) return null
  const minutos = Math.round((cuando - ahoraMs) / 60_000)
  if (minutos < 1) return "En menos de un minuto"
  if (minutos < 60) return `En ${minutos} min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  if (horas < 24) return resto === 0 ? `En ${horas} h` : `En ${horas} h ${resto} min`
  const dias = Math.floor(horas / 24)
  return dias === 1 ? "Mañana" : `En ${dias} días`
}

// ── Aviso de alarmas próximas (indicador de la barra) ────────────────────────

/** Ventana en la que una alarma ya se anuncia en la barra. */
export const VENTANA_AVISO_ALARMA_MS = 60 * 60_000
/** Dentro de esta, el aviso pasa a urgente (naranja). */
export const VENTANA_ALARMA_INMINENTE_MS = 15 * 60_000

export interface AvisoAlarmas {
  /** Las que sonarán dentro de la ventana, de la más próxima a la más lejana. */
  proximas: Vencimiento[]
  /** Si alguna cae dentro de la ventana corta. */
  inminente: boolean
}

/**
 * Qué alarmas hay que anunciar y con cuánta urgencia.
 *
 * **Recalcula desde `alarmas` en cada llamada en vez de derivarse de `siguienteVencimiento`.** Ese
 * devuelve UNA, la más próxima, y el indicador tiene que listar todas las de la hora siguiente: dos
 * alarmas a las 7:00 y a las 7:30 son dos líneas del tooltip, no una. Es un recorrido sobre una
 * lista de unidades de elementos, una vez por minuto — no hay nada que memoizar aquí.
 *
 * `inminente` se calcula sobre la MÁS PRÓXIMA y no sobre «alguna»: son lo mismo, porque la lista
 * viene ordenada, pero dejarlo escrito evita que alguien lo cambie a un `some()` sobre la ventana
 * larga, que pondría el icono naranja por una alarma a 50 minutos.
 */
export function avisoAlarmas(
  alarmas: Alarma[],
  ahoraMs: number,
  ventanaMs: number = VENTANA_AVISO_ALARMA_MS,
  ventanaInminenteMs: number = VENTANA_ALARMA_INMINENTE_MS,
): AvisoAlarmas {
  const proximas: Vencimiento[] = []
  for (const alarma of alarmas) {
    const cuando = proximaActivacion(alarma, ahoraMs)
    if (cuando === null) continue
    if (cuando - ahoraMs > ventanaMs) continue
    proximas.push({ alarma, cuando })
  }
  proximas.sort((a, b) => a.cuando - b.cuando)
  return {
    proximas,
    inminente: proximas.length > 0 && proximas[0].cuando - ahoraMs <= ventanaInminenteMs,
  }
}

/** Una línea por alarma: «07:00 · Despertar · en 12 min». Sin etiqueta se omite ese tramo. */
export function lineaAvisoAlarma(vencimiento: Vencimiento, ahoraMs: number): string {
  const minutos = Math.max(0, Math.round((vencimiento.cuando - ahoraMs) / 60_000))
  const cuanto = minutos < 1 ? "ahora mismo" : minutos === 1 ? "en 1 min" : `en ${minutos} min`
  const etiqueta = vencimiento.alarma.etiqueta.trim()
  return etiqueta === ""
    ? `${vencimiento.alarma.hora} · ${cuanto}`
    : `${vencimiento.alarma.hora} · ${etiqueta} · ${cuanto}`
}
