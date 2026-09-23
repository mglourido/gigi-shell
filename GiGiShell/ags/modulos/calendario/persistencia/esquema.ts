// Esquema versionado de `~/.config/gigios/calendario.json` y su lectura defensiva. Puro: recibe el
// `JSON.parse` ya hecho y devuelve datos de dominio, sin tocar disco.
//
// **Un JSON corrupto no puede impedir que arranque AGS.** El panel se construye dentro del try/catch
// de `app.ts`, pero eso solo evita que el fallo se lleve el shell: el usuario se quedaría igualmente
// sin calendario. Aquí se degrada más fino — se descartan los eventos ilegibles UNO A UNO y se
// conservan los demás, informando de cuántos cayeron. Un evento con la fecha rota no se lleva por
// delante los otros cuarenta.

import {
  COLORES_EVENTO,
  COLOR_POR_DEFECTO,
  CALENDARIO_LOCAL,
  configuracionPorDefecto,
} from "../dominio/tipos.ts"
import type {
  ColorEvento,
  ConfiguracionCalendario,
  EventoCalendario,
  MomentoEvento,
  OrigenEvento,
  PermisoEvento,
  SincronizacionEvento,
} from "../dominio/tipos.ts"
import { esFechaValida, esHoraValida } from "../dominio/fechas.ts"

export const VERSION_ESQUEMA = 1

export interface ArchivoCalendario {
  version: number
  eventos: EventoCalendario[]
  configuracion: ConfiguracionCalendario
}

export interface ResultadoLectura {
  archivo: ArchivoCalendario
  /** Descripciones legibles de lo que se descartó. Vacío = el fichero estaba impecable. */
  problemas: string[]
}

export function archivoVacio(): ArchivoCalendario {
  return { version: VERSION_ESQUEMA, eventos: [], configuracion: configuracionPorDefecto() }
}

function textoOpcional(valor: unknown): string | undefined {
  return typeof valor === "string" && valor.trim() !== "" ? valor : undefined
}

function esColor(valor: unknown): valor is ColorEvento {
  return typeof valor === "string" && (COLORES_EVENTO as readonly string[]).includes(valor)
}

function leerMomento(valor: unknown, todoElDia: boolean): MomentoEvento | null {
  if (typeof valor !== "object" || valor === null) return null
  const bruto = valor as Record<string, unknown>
  const fecha = typeof bruto.fecha === "string" ? bruto.fecha : ""
  if (!esFechaValida(fecha)) return null
  const momento: MomentoEvento = { fecha }
  if (!todoElDia) {
    const hora = typeof bruto.hora === "string" ? bruto.hora : ""
    // Sin hora válida el evento deja de ser "con hora"; quien llama lo degrada a día completo.
    if (!esHoraValida(hora)) return null
    momento.hora = hora
  }
  const zona = textoOpcional(bruto.zonaHoraria)
  if (zona) momento.zonaHoraria = zona
  return momento
}

function leerSincronizacion(valor: unknown): SincronizacionEvento | undefined {
  if (typeof valor !== "object" || valor === null) return undefined
  const bruto = valor as Record<string, unknown>
  const out: SincronizacionEvento = {}
  const etag = textoOpcional(bruto.etag)
  if (etag) out.etag = etag
  const actualizado = textoOpcional(bruto.actualizadoEn)
  if (actualizado) out.actualizadoEn = actualizado
  if (bruto.pendiente === "crear" || bruto.pendiente === "editar" || bruto.pendiente === "eliminar") {
    out.pendiente = bruto.pendiente
  }
  if (bruto.conflicto === true) out.conflicto = true
  return Object.keys(out).length > 0 ? out : undefined
}

/** Un evento suelto. `null` = irrecuperable; el llamante lo cuenta como problema y sigue. */
export function leerEvento(valor: unknown): EventoCalendario | null {
  if (typeof valor !== "object" || valor === null) return null
  const bruto = valor as Record<string, unknown>

  const id = typeof bruto.id === "string" && bruto.id !== "" ? bruto.id : null
  const titulo = typeof bruto.titulo === "string" ? bruto.titulo : null
  if (id === null || titulo === null) return null

  // El día completo se decide ANTES de leer los momentos porque cambia qué se considera válido.
  let todoElDia = bruto.todoElDia === true
  let inicio = leerMomento(bruto.inicio, todoElDia)
  let fin = leerMomento(bruto.fin, todoElDia)
  if ((inicio === null || fin === null) && !todoElDia) {
    // Degradar a día completo en vez de tirar el evento: la fecha suele estar bien y es la hora la
    // que falta. Perder el título y la fecha por un "09:5" es peor que perder la hora.
    todoElDia = true
    inicio = leerMomento(bruto.inicio, true)
    fin = leerMomento(bruto.fin, true)
  }
  if (inicio === null || fin === null) return null

  const origen: OrigenEvento = bruto.origen === "google" ? "google" : "local"
  const permiso: PermisoEvento = bruto.permiso === "lectura" ? "lectura" : "escritura"

  const evento: EventoCalendario = {
    id,
    titulo,
    inicio,
    fin,
    todoElDia,
    color: esColor(bruto.color) ? bruto.color : COLOR_POR_DEFECTO,
    origen,
    calendarioId: textoOpcional(bruto.calendarioId) ?? CALENDARIO_LOCAL,
    permiso,
  }
  const descripcion = textoOpcional(bruto.descripcion)
  if (descripcion) evento.descripcion = descripcion
  const ubicacion = textoOpcional(bruto.ubicacion)
  if (ubicacion) evento.ubicacion = ubicacion
  const remotoId = textoOpcional(bruto.remotoId)
  if (remotoId) evento.remotoId = remotoId
  const sincronizacion = leerSincronizacion(bruto.sincronizacion)
  if (sincronizacion) evento.sincronizacion = sincronizacion
  return evento
}

function leerConfiguracion(valor: unknown): ConfiguracionCalendario {
  const base = configuracionPorDefecto()
  if (typeof valor !== "object" || valor === null) return base
  const bruto = valor as Record<string, unknown>
  if (Array.isArray(bruto.calendariosVisibles)) {
    base.calendariosVisibles = bruto.calendariosVisibles.filter(
      (c): c is string => typeof c === "string" && c !== "",
    )
  }
  return base
}

/**
 * Lee el contenido completo del fichero.
 *
 * Acepta también un ARRAY en la raíz: así era el formato antiguo (`calendar-events.json`), y aunque
 * la migración lo convierte, un fichero traído a mano de otra máquina sigue abriéndose.
 */
export function leerArchivo(datos: unknown): ResultadoLectura {
  const problemas: string[] = []

  if (Array.isArray(datos)) {
    return { archivo: archivoVacio(), problemas: ["formato antiguo (array): usa migrarArchivoAntiguo"] }
  }
  if (typeof datos !== "object" || datos === null) {
    return { archivo: archivoVacio(), problemas: ["el fichero no contiene un objeto JSON"] }
  }

  const bruto = datos as Record<string, unknown>
  const version = typeof bruto.version === "number" ? bruto.version : 0
  if (version > VERSION_ESQUEMA) {
    // Un fichero de una versión FUTURA no se toca: se lee lo que se entienda, pero avisando. No se
    // reescribe a ciegas, que sería tirar campos que otra versión sí conoce.
    problemas.push(`versión ${version} desconocida (esta build entiende hasta la ${VERSION_ESQUEMA})`)
  }

  const eventos: EventoCalendario[] = []
  let descartados = 0
  const vistos = new Set<string>()
  if (Array.isArray(bruto.eventos)) {
    for (const crudo of bruto.eventos) {
      const evento = leerEvento(crudo)
      if (evento === null) {
        descartados++
        continue
      }
      // Ids duplicados: se queda el primero. Un id repetido rompe el borrado (se irían los dos).
      if (vistos.has(evento.id)) {
        descartados++
        continue
      }
      vistos.add(evento.id)
      eventos.push(evento)
    }
  } else if (bruto.eventos !== undefined) {
    problemas.push("«eventos» no es una lista")
  }
  if (descartados > 0) problemas.push(`${descartados} evento(s) ilegibles descartados`)

  return {
    archivo: { version: VERSION_ESQUEMA, eventos, configuracion: leerConfiguracion(bruto.configuracion) },
    problemas,
  }
}

/** Serializable: lo que se escribe en disco. */
export function escribirArchivo(archivo: ArchivoCalendario): ArchivoCalendario {
  return { ...archivo, version: VERSION_ESQUEMA }
}
