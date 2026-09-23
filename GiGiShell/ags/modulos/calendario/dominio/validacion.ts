// Validación del formulario de eventos. Pura: devuelve errores, no toca la UI ni notifica.

import type { BorradorEvento } from "./tipos.ts"
import { compararFechas, esFechaValida, esHoraValida, horaAMinutos } from "./fechas.ts"

export type CampoEvento = "titulo" | "inicio" | "fin"

export interface ErrorValidacion {
  campo: CampoEvento
  mensaje: string
}

/**
 * Valida un borrador.
 *
 * La regla de las fechas es distinta según el tipo, y confundirlas es el error clásico: en un evento
 * de día completo `fin === inicio` es lo NORMAL (dura ese día), mientras que en uno con hora
 * significa duración cero, que no es un evento. Por eso una comparación única no vale para los dos.
 */
export function validarEvento(borrador: BorradorEvento): ErrorValidacion[] {
  const errores: ErrorValidacion[] = []

  if (!borrador.titulo || borrador.titulo.trim() === "") {
    errores.push({ campo: "titulo", mensaje: "El título no puede estar vacío" })
  }

  const inicioOk = esFechaValida(borrador.inicio?.fecha ?? "")
  const finOk = esFechaValida(borrador.fin?.fecha ?? "")
  if (!inicioOk) errores.push({ campo: "inicio", mensaje: "Fecha de inicio no válida" })
  if (!finOk) errores.push({ campo: "fin", mensaje: "Fecha de fin no válida" })

  if (!inicioOk || !finOk) return errores

  if (compararFechas(borrador.fin.fecha, borrador.inicio.fecha) < 0) {
    errores.push({ campo: "fin", mensaje: "La fecha de fin no puede ser anterior a la de inicio" })
    return errores
  }

  if (borrador.todoElDia) return errores

  const horaInicio = borrador.inicio.hora ?? ""
  const horaFin = borrador.fin.hora ?? ""
  if (!esHoraValida(horaInicio)) {
    errores.push({ campo: "inicio", mensaje: "Hora de inicio no válida" })
  }
  if (!esHoraValida(horaFin)) {
    errores.push({ campo: "fin", mensaje: "Hora de fin no válida" })
  }
  if (errores.some((e) => e.mensaje.startsWith("Hora"))) return errores

  const mismoDia = borrador.inicio.fecha === borrador.fin.fecha
  if (mismoDia && horaAMinutos(horaFin) <= horaAMinutos(horaInicio)) {
    errores.push({ campo: "fin", mensaje: "La hora de fin debe ser posterior a la de inicio" })
  }

  return errores
}

export function esBorradorValido(borrador: BorradorEvento): boolean {
  return validarEvento(borrador).length === 0
}

/** Primer error de un campo, para pintarlo debajo del control. */
export function errorDeCampo(errores: ErrorValidacion[], campo: CampoEvento): string | null {
  return errores.find((e) => e.campo === campo)?.mensaje ?? null
}
