// Migración del almacén antiguo (`~/.config/ags/calendar-events.json`) al nuevo esquema. Puro: la
// lectura y el borrado del fichero viejo los hace `repositorio.ts`.
//
// **La ruta antigua estaba DENTRO del repositorio.** `~/.config/ags` es un symlink a `~/GiGiShell/ags`,
// así que aquellos eventos —datos personales— quedaban versionados junto al código. Por eso el
// original no se conserva «por si acaso»: se copia a `~/.config/gigios/calendario.json` y se BORRA.
// No destructivo significa que no se pierde nada, no que se deje una copia dentro de git.
//
// Formato antiguo (array en la raíz):
//   { id, title, date, startTime?, endTime?, color, description?, allDay }
// Solo sabía de eventos de un día: `date` era la única fecha.

import { COLORES_EVENTO, COLOR_POR_DEFECTO, CALENDARIO_LOCAL } from "../dominio/tipos.ts"
import type { ColorEvento, EventoCalendario } from "../dominio/tipos.ts"
import { esFechaValida, esHoraValida, horaAMinutos, minutosAHora } from "../dominio/fechas.ts"
import { archivoVacio } from "./esquema.ts"
import type { ArchivoCalendario } from "./esquema.ts"

export interface ResultadoMigracion {
  archivo: ArchivoCalendario
  migrados: number
  descartados: number
}

function esColor(valor: unknown): valor is ColorEvento {
  return typeof valor === "string" && (COLORES_EVENTO as readonly string[]).includes(valor)
}

/**
 * Convierte un evento del formato antiguo.
 *
 * Dos casos que el modelo viejo permitía y el nuevo no:
 *
 * - `allDay: false` **sin `startTime`**: no era un evento con hora, era un evento a medio rellenar.
 *   Se degrada a día completo en vez de inventarle un "00:00" que la agenda ordenaría el primero.
 * - `endTime` ausente o anterior al inicio: se le da **una hora de duración**, recortada a las 23:59.
 *   Poner `fin = inicio` habría creado eventos que el propio validador rechaza, y editarlos luego
 *   obligaría a corregir un error que el usuario no cometió.
 */
export function migrarEventoAntiguo(
  crudo: unknown,
  generarId: () => string,
): EventoCalendario | null {
  if (typeof crudo !== "object" || crudo === null) return null
  const bruto = crudo as Record<string, unknown>

  const fecha = typeof bruto.date === "string" ? bruto.date : ""
  if (!esFechaValida(fecha)) return null

  const titulo = typeof bruto.title === "string" ? bruto.title : ""
  const horaInicio = typeof bruto.startTime === "string" ? bruto.startTime : ""
  const todoElDia = bruto.allDay === true || !esHoraValida(horaInicio)

  const evento: EventoCalendario = {
    id: typeof bruto.id === "string" && bruto.id !== "" ? bruto.id : generarId(),
    titulo: titulo.trim() === "" ? "(sin título)" : titulo,
    inicio: { fecha },
    fin: { fecha },
    todoElDia,
    color: esColor(bruto.color) ? bruto.color : COLOR_POR_DEFECTO,
    origen: "local",
    calendarioId: CALENDARIO_LOCAL,
    permiso: "escritura",
  }

  if (!todoElDia) {
    const horaFin = typeof bruto.endTime === "string" ? bruto.endTime : ""
    const inicioMin = horaAMinutos(horaInicio)
    const finMin = esHoraValida(horaFin) ? horaAMinutos(horaFin) : -1
    evento.inicio.hora = horaInicio
    evento.fin.hora = finMin > inicioMin ? horaFin : minutosAHora(Math.min(inicioMin + 60, 23 * 60 + 59))
    // Un inicio a las 23:30 no cabe en su propio día: el fin se recorta a 23:59, que sigue siendo
    // posterior. Solo si el inicio es 23:59 exacto no hay hueco, y entonces se pasa a día completo.
    if (horaAMinutos(evento.fin.hora!) <= inicioMin) {
      evento.todoElDia = true
      delete evento.inicio.hora
      delete evento.fin.hora
    }
  }

  return evento
}

/** Convierte el array antiguo entero. Los eventos irrecuperables se cuentan, no rompen la migración. */
export function migrarArchivoAntiguo(datos: unknown, generarId: () => string): ResultadoMigracion {
  const archivo = archivoVacio()
  if (!Array.isArray(datos)) return { archivo, migrados: 0, descartados: 0 }

  let descartados = 0
  const vistos = new Set<string>()
  for (const crudo of datos) {
    const evento = migrarEventoAntiguo(crudo, generarId)
    if (evento === null) {
      descartados++
      continue
    }
    if (vistos.has(evento.id)) evento.id = generarId()
    vistos.add(evento.id)
    archivo.eventos.push(evento)
  }
  return { archivo, migrados: archivo.eventos.length, descartados }
}
