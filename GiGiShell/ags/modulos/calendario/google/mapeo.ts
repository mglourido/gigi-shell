// Traducción entre los eventos de la API de Google Calendar y el dominio local. Puro y probado.
//
// Aquí se concentran las tres asimetrías del formato de Google, y ninguna es evidente:
//
// 1. **El fin de un evento de día completo es EXCLUSIVO.** Un evento del 21 al 21 se manda como
//    `end.date = "2026-07-22"`. El dominio lo guarda inclusivo porque lo que se pregunta siempre es
//    «qué días ocupa». Sin la conversión, todos los eventos de día completo se pintarían un día de
//    más — y al subirlos, uno de menos, encogiéndolos en cada ida y vuelta.
// 2. **Las horas llegan en RFC 3339 con desplazamiento** (`2026-07-21T09:00:00+02:00`) y no
//    necesariamente en la zona de este equipo. Se convierten a hora local: un evento a las 15:00 de
//    Nueva York tiene que salir a las 21:00 en un calendario de Madrid, no a las 15:00.
// 3. **`status: "cancelled"` es la forma de anunciar un borrado**, incluido en las respuestas
//    incrementales. No es un evento que no se pinta: es la instrucción de quitarlo.

import { CALENDARIO_LOCAL, COLOR_POR_DEFECTO } from "../dominio/tipos.ts"
import type { ColorEvento, EventoCalendario, PermisoEvento } from "../dominio/tipos.ts"
import { aFechaISO, esFechaValida, minutosAHora, sumarDias } from "../dominio/fechas.ts"

export interface EventoGoogle {
  id?: string
  etag?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  colorId?: string
  updated?: string
  recurringEventId?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
}

/**
 * Los once colores de Google reducidos a los seis del panel.
 *
 * La reducción pierde información y se acepta: la alternativa sería llevar el hex crudo por el
 * dominio y perder la paleta coherente del shell. Al subir se hace el camino inverso, así que un
 * evento creado aquí conserva un color reconocible allí.
 */
const COLOR_DESDE_GOOGLE: Record<string, ColorEvento> = {
  "1": "blue",   // Lavender
  "2": "teal",   // Sage
  "3": "purple", // Grape
  "4": "pink",   // Flamingo
  "5": "amber",  // Banana
  "6": "amber",  // Tangerine
  "7": "teal",   // Peacock
  "8": "purple", // Graphite
  "9": "blue",   // Blueberry
  "10": "teal",  // Basil
  "11": "red",   // Tomato
}

const COLOR_HACIA_GOOGLE: Record<ColorEvento, string> = {
  blue: "9",
  teal: "10",
  purple: "3",
  pink: "4",
  amber: "5",
  red: "11",
}

/** `2026-07-21T09:00:00+02:00` → fecha y hora LOCALES de este equipo. `null` si no parsea. */
export function desdeRFC3339(valor: string): { fecha: string; hora: string } | null {
  if (typeof valor !== "string" || valor.trim() === "") return null
  const instante = new Date(valor)
  const ms = instante.getTime()
  if (!Number.isFinite(ms)) return null
  return {
    fecha: aFechaISO(instante.getFullYear(), instante.getMonth() + 1, instante.getDate()),
    hora: minutosAHora(instante.getHours() * 60 + instante.getMinutes()),
  }
}

/**
 * Fecha y hora locales → RFC 3339 **con el desplazamiento de este equipo**.
 *
 * No se manda en «Z» (UTC) ni sin zona: sin desplazamiento, Google interpreta la hora en la zona por
 * defecto del calendario, que no tiene por qué ser la del equipo, y el evento aparece movido.
 */
export function aRFC3339(fecha: string, hora: string, ahora = new Date()): string | null {
  if (!esFechaValida(fecha)) return null
  const [h, m] = hora.split(":").map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const [anio, mes, dia] = fecha.split("-").map(Number)
  const local = new Date(anio, mes - 1, dia, h, m, 0, 0)
  // El desplazamiento se toma de la propia fecha del evento y no de `ahora`: un evento de agosto
  // creado en enero está en horario de verano aunque hoy no lo estemos.
  void ahora
  const desfaseMin = -local.getTimezoneOffset()
  const signo = desfaseMin >= 0 ? "+" : "-"
  const abs = Math.abs(desfaseMin)
  const dd = (n: number) => String(n).padStart(2, "0")
  return `${fecha}T${dd(h)}:${dd(m)}:00${signo}${dd(Math.floor(abs / 60))}:${dd(abs % 60)}`
}

export type ResultadoMapeo =
  | { tipo: "evento"; evento: EventoCalendario }
  | { tipo: "eliminado"; remotoId: string }
  | { tipo: "ignorado"; motivo: string }

/**
 * Un evento de Google → dominio local.
 *
 * `idLocalPara` permite conservar el id interno de un evento que ya conocíamos: cambiarlo en cada
 * sincronización rompería la selección de la UI y duplicaría el evento en la lista.
 */
export function desdeGoogle(
  crudo: EventoGoogle,
  calendarioId: string,
  permiso: PermisoEvento,
  idLocalPara: (remotoId: string) => string | undefined = () => undefined,
): ResultadoMapeo {
  const remotoId = typeof crudo?.id === "string" ? crudo.id : ""
  if (remotoId === "") return { tipo: "ignorado", motivo: "sin id remoto" }

  if (crudo.status === "cancelled") return { tipo: "eliminado", remotoId }

  const inicioCrudo = crudo.start ?? {}
  const finCrudo = crudo.end ?? {}

  let inicio: EventoCalendario["inicio"]
  let fin: EventoCalendario["fin"]
  let todoElDia: boolean

  if (typeof inicioCrudo.date === "string") {
    todoElDia = true
    if (!esFechaValida(inicioCrudo.date)) return { tipo: "ignorado", motivo: "fecha de inicio no válida" }
    inicio = { fecha: inicioCrudo.date }
    // Fin exclusivo → inclusivo. Un `end.date` ausente o anterior degrada a un evento de un día.
    const finExclusivo = typeof finCrudo.date === "string" && esFechaValida(finCrudo.date)
      ? sumarDias(finCrudo.date, -1)
      : inicioCrudo.date
    fin = { fecha: finExclusivo < inicioCrudo.date ? inicioCrudo.date : finExclusivo }
  } else if (typeof inicioCrudo.dateTime === "string") {
    todoElDia = false
    const i = desdeRFC3339(inicioCrudo.dateTime)
    if (!i) return { tipo: "ignorado", motivo: "dateTime de inicio no válido" }
    const f = typeof finCrudo.dateTime === "string" ? desdeRFC3339(finCrudo.dateTime) : null
    inicio = { fecha: i.fecha, hora: i.hora }
    fin = f ? { fecha: f.fecha, hora: f.hora } : { fecha: i.fecha, hora: i.hora }
    if (inicioCrudo.timeZone) inicio.zonaHoraria = inicioCrudo.timeZone
    if (finCrudo.timeZone) fin.zonaHoraria = finCrudo.timeZone
  } else {
    return { tipo: "ignorado", motivo: "sin fechas" }
  }

  const evento: EventoCalendario = {
    id: idLocalPara(remotoId) ?? `g-${calendarioId}-${remotoId}`,
    titulo: typeof crudo.summary === "string" && crudo.summary !== "" ? crudo.summary : "(sin título)",
    inicio,
    fin,
    todoElDia,
    color: (crudo.colorId && COLOR_DESDE_GOOGLE[crudo.colorId]) || COLOR_POR_DEFECTO,
    origen: "google",
    calendarioId,
    remotoId,
    // Una instancia de una serie recurrente se muestra, pero no se edita: esta versión no sabe
    // escribir reglas de recurrencia y guardar una instancia suelta rompería la serie.
    permiso: crudo.recurringEventId ? "lectura" : permiso,
    sincronizacion: {
      etag: typeof crudo.etag === "string" ? crudo.etag : undefined,
      actualizadoEn: typeof crudo.updated === "string" ? crudo.updated : undefined,
    },
  }
  if (typeof crudo.description === "string" && crudo.description !== "") evento.descripcion = crudo.description
  if (typeof crudo.location === "string" && crudo.location !== "") evento.ubicacion = crudo.location

  return { tipo: "evento", evento }
}

/** Dominio local → cuerpo JSON para crear o actualizar en Google. */
export function haciaGoogle(evento: EventoCalendario): Record<string, unknown> {
  const cuerpo: Record<string, unknown> = {
    summary: evento.titulo,
    colorId: COLOR_HACIA_GOOGLE[evento.color] ?? COLOR_HACIA_GOOGLE[COLOR_POR_DEFECTO],
  }
  if (evento.descripcion) cuerpo.description = evento.descripcion
  if (evento.ubicacion) cuerpo.location = evento.ubicacion

  if (evento.todoElDia) {
    cuerpo.start = { date: evento.inicio.fecha }
    // Inclusivo → exclusivo: se suma un día, que es la mitad que falta de la conversión de arriba.
    cuerpo.end = { date: sumarDias(evento.fin.fecha, 1) }
  } else {
    cuerpo.start = { dateTime: aRFC3339(evento.inicio.fecha, evento.inicio.hora ?? "00:00") }
    cuerpo.end = { dateTime: aRFC3339(evento.fin.fecha, evento.fin.hora ?? "23:59") }
  }
  return cuerpo
}

export interface CalendarioGoogle {
  id: string
  nombre: string
  permiso: PermisoEvento
  principal: boolean
}

/**
 * Entrada de la lista de calendarios.
 *
 * El `accessRole` decide el permiso, y solo `owner` y `writer` conceden escritura. `reader` y
 * `freeBusyReader` se muestran igualmente: un calendario compartido de solo lectura sigue siendo
 * información que quieres ver, únicamente sin botones de editar.
 */
export function calendarioDesdeGoogle(crudo: unknown): CalendarioGoogle | null {
  if (typeof crudo !== "object" || crudo === null) return null
  const b = crudo as Record<string, unknown>
  const id = typeof b.id === "string" ? b.id : ""
  if (id === "") return null
  const rol = typeof b.accessRole === "string" ? b.accessRole : ""
  return {
    id,
    nombre: typeof b.summary === "string" && b.summary !== "" ? b.summary : id,
    permiso: rol === "owner" || rol === "writer" ? "escritura" : "lectura",
    principal: b.primary === true,
  }
}

/** ¿Este evento nuestro es local puro? Los locales no viajan a Google ni se borran al sincronizar. */
export function esLocal(evento: EventoCalendario): boolean {
  return evento.origen === "local" || evento.calendarioId === CALENDARIO_LOCAL
}
