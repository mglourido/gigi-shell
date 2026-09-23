// Proyección de los eventos sobre el calendario: qué días ocupa cada uno, cómo se ordena la agenda
// de un día y qué puntos salen en la cuadrícula del mes. Puro y probado.

import type { EventoCalendario } from "./tipos.ts"
import { claveInstante, compararFechas, estaEnRango, rangoFechas } from "./fechas.ts"

/**
 * Un evento visto desde un día concreto.
 *
 * Un evento de varios días aparece en CADA fecha que ocupa, y las banderas dicen si viene de antes o
 * sigue después — sin ellas la agenda del miércoles enseñaría «Viaje 09:00–18:00» cuando en realidad
 * el 09:00 era del lunes.
 */
export interface EventoEnDia {
  evento: EventoCalendario
  fecha: string
  esPrimerDia: boolean
  esUltimoDia: boolean
  /** Ocupa varios días. Redundante con las dos anteriores, pero es lo que la UI pregunta. */
  variosDias: boolean
}

/** Días que ocupa el evento, extremos incluidos. Un evento normal devuelve un solo día. */
export function fechasDelEvento(evento: EventoCalendario): string[] {
  const fin = compararFechas(evento.fin.fecha, evento.inicio.fecha) < 0
    ? evento.inicio.fecha // rango invertido: nos quedamos con el día de inicio en vez de no pintar nada
    : evento.fin.fecha
  return rangoFechas(evento.inicio.fecha, fin)
}

export function eventoOcupaFecha(evento: EventoCalendario, fecha: string): boolean {
  const fin = compararFechas(evento.fin.fecha, evento.inicio.fecha) < 0
    ? evento.inicio.fecha
    : evento.fin.fecha
  return estaEnRango(fecha, evento.inicio.fecha, fin)
}

function proyectar(evento: EventoCalendario, fecha: string): EventoEnDia {
  const esPrimerDia = evento.inicio.fecha === fecha
  const esUltimoDia = evento.fin.fecha === fecha || compararFechas(evento.fin.fecha, fecha) < 0
  return {
    evento,
    fecha,
    esPrimerDia,
    esUltimoDia,
    variosDias: evento.inicio.fecha !== evento.fin.fecha,
  }
}

/**
 * Orden de la agenda: primero los de día completo, luego los que tienen hora, y a igualdad por
 * título. Un evento de varios días que ya venía de ayer se trata como de día completo **en los días
 * intermedios**: su hora de inicio no ocurre hoy, así que ordenarlo por ella sería mentir.
 */
export function ordenarAgenda(items: EventoEnDia[]): EventoEnDia[] {
  const clave = (i: EventoEnDia) => {
    const sinHoraHoy = i.evento.todoElDia || !i.esPrimerDia
    return sinHoraHoy ? claveInstante("", "") : claveInstante("", i.evento.inicio.hora ?? "")
  }
  return [...items].sort((a, b) => {
    const ka = clave(a)
    const kb = clave(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.evento.titulo.localeCompare(b.evento.titulo, "es")
  })
}

/** Agenda de un día, ya ordenada. */
export function agendaDelDia(eventos: EventoCalendario[], fecha: string): EventoEnDia[] {
  const items: EventoEnDia[] = []
  for (const ev of eventos) {
    if (eventoOcupaFecha(ev, fecha)) items.push(proyectar(ev, fecha))
  }
  return ordenarAgenda(items)
}

/**
 * Índice `fecha → eventos` acotado a un rango, para pintar los puntos del mes.
 *
 * Se construye una sola vez por mes visible en lugar de filtrar 42 veces la lista entera: con un
 * evento de un año de duración, lo segundo recorre el rango completo por cada celda.
 */
export function indicePorFecha(
  eventos: EventoCalendario[],
  desde: string,
  hasta: string,
): Map<string, EventoCalendario[]> {
  const indice = new Map<string, EventoCalendario[]>()
  for (const ev of eventos) {
    for (const fecha of fechasDelEvento(ev)) {
      if (!estaEnRango(fecha, desde, hasta)) continue
      const lista = indice.get(fecha)
      if (lista) lista.push(ev)
      else indice.set(fecha, [ev])
    }
  }
  for (const [fecha, lista] of indice) {
    indice.set(fecha, ordenarAgenda(lista.map((ev) => proyectar(ev, fecha))).map((i) => i.evento))
  }
  return indice
}

/** Texto del intervalo de un evento visto desde un día. */
export function textoIntervalo(item: EventoEnDia): string {
  const { evento, esPrimerDia, esUltimoDia } = item
  if (evento.todoElDia) {
    if (!item.variosDias) return "Todo el día"
    if (esPrimerDia) return "Todo el día · empieza hoy"
    if (esUltimoDia) return "Todo el día · último día"
    return "Todo el día · continúa"
  }
  const inicio = evento.inicio.hora ?? ""
  const fin = evento.fin.hora ?? ""
  if (!item.variosDias) {
    if (inicio && fin) return `${inicio} – ${fin}`
    return inicio || fin || "Sin hora"
  }
  if (esPrimerDia) return `Desde ${inicio || "00:00"}`
  if (esUltimoDia) return `Hasta ${fin || "23:59"}`
  return "Todo el día · continúa"
}
