// Recordatorios de eventos: cuándo avisa cada uno y con qué texto. Puro, sin GLib: el planificador
// que arma el temporizador y manda la notificación vive en `../avisos.ts`.
//
// **`aviso` son minutos ANTES del inicio, con la misma convención que Google Calendar**, para que el
// valor viaje tal cual en los dos sentidos sin tabla de conversión:
// - evento con hora → antes de su hora de inicio (`10` = diez minutos antes);
// - evento de día completo → antes de las **00:00** del primer día (`900` = el día anterior a las
//   9:00). Por eso las opciones de los dos tipos son listas distintas: «10 min antes» de un evento
//   de día completo serían las 23:50 de la víspera.
//
// **Los instantes se calculan en hora LOCAL de pared** (`new Date(a, m, d, h, min)`), como las
// alarmas y al contrario que la aritmética de días del resto de `dominio/`: un aviso a las 9:00 tiene
// que salir a las 9:00 también el día del cambio de hora, no a las 8:00 ni a las 10:00.

import type { EventoCalendario } from "./tipos.ts"
import { hoyISO, horaAMinutos, minutosAHora } from "./fechas.ts"

/** Tope de Google para `reminders.overrides[].minutes` (cuatro semanas). */
export const AVISO_MAX_MIN = 40_320

export interface OpcionAviso {
  /** Minutos antes del inicio. `undefined` = sin aviso. */
  minutos: number | undefined
  etiqueta: string
}

export const OPCIONES_AVISO_CON_HORA: readonly OpcionAviso[] = [
  { minutos: undefined, etiqueta: "Sin aviso" },
  { minutos: 0, etiqueta: "Al empezar" },
  { minutos: 5, etiqueta: "5 min antes" },
  { minutos: 10, etiqueta: "10 min antes" },
  { minutos: 15, etiqueta: "15 min antes" },
  { minutos: 30, etiqueta: "30 min antes" },
  { minutos: 60, etiqueta: "1 h antes" },
  { minutos: 1440, etiqueta: "1 día antes" },
]

export const OPCIONES_AVISO_DIA_COMPLETO: readonly OpcionAviso[] = [
  { minutos: undefined, etiqueta: "Sin aviso" },
  { minutos: 0, etiqueta: "El mismo día a las 0:00" },
  { minutos: 360, etiqueta: "El día antes a las 18:00" },
  { minutos: 900, etiqueta: "El día antes a las 9:00" },
  { minutos: 2340, etiqueta: "2 días antes a las 9:00" },
  { minutos: 9540, etiqueta: "1 semana antes a las 9:00" },
]

/** Aviso con el que nace un evento nuevo, o el que se le pone al cambiar de tipo. */
export function avisoPorDefecto(todoElDia: boolean): number {
  return todoElDia ? 900 : 10
}

/**
 * Opciones del desplegable para un tipo de evento. Si el valor actual no está en la lista (llegó de
 * Google con otro número) se añade con una etiqueta genérica: perderlo al abrir el formulario y
 * guardar sin tocarlo cambiaría el aviso a espaldas del usuario.
 */
export function opcionesAviso(todoElDia: boolean, actual: number | undefined): OpcionAviso[] {
  const base = [...(todoElDia ? OPCIONES_AVISO_DIA_COMPLETO : OPCIONES_AVISO_CON_HORA)]
  if (base.some((o) => o.minutos === actual)) return base
  return [...base, { minutos: actual, etiqueta: etiquetaGenerica(actual!, todoElDia) }]
}

function etiquetaGenerica(minutos: number, todoElDia: boolean): string {
  if (todoElDia) {
    // Minutos antes de las 00:00 → «N días antes a las HH:MM».
    const dias = Math.ceil(minutos / 1440)
    const hora = minutosAHora(dias * 1440 - minutos)
    return dias === 0 ? "El mismo día a las 0:00" : `${dias === 1 ? "El día" : `${dias} días`} antes a las ${hora}`
  }
  return `${formatearDuracion(minutos)} antes`
}

/** `90` → `1 h 30 min`. */
function formatearDuracion(minutos: number): string {
  const d = Math.floor(minutos / 1440)
  const h = Math.floor((minutos % 1440) / 60)
  const m = minutos % 60
  const partes: string[] = []
  if (d > 0) partes.push(`${d} ${d === 1 ? "día" : "días"}`)
  if (h > 0) partes.push(`${h} h`)
  if (m > 0 || partes.length === 0) partes.push(`${m} min`)
  return partes.join(" ")
}

/** Normaliza un valor leído de fuera (JSON, Google). `undefined` si no es un aviso válido. */
export function sanearAviso(valor: unknown): number | undefined {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return undefined
  const entero = Math.round(valor)
  if (entero < 0 || entero > AVISO_MAX_MIN) return undefined
  return entero
}

function instanteLocal(fecha: string, minutosDelDia: number): number {
  const [anio, mes, dia] = fecha.split("-").map(Number)
  return new Date(anio, mes - 1, dia, Math.floor(minutosDelDia / 60), minutosDelDia % 60, 0, 0).getTime()
}

/** Inicio del evento en ms de época, hora local. */
export function instanteInicio(evento: EventoCalendario): number {
  return instanteLocal(evento.inicio.fecha, evento.todoElDia ? 0 : horaAMinutos(evento.inicio.hora ?? "00:00"))
}

/** Fin del evento en ms. El de día completo acaba a las 00:00 del día siguiente a `fin` (inclusivo). */
export function instanteFin(evento: EventoCalendario): number {
  if (evento.todoElDia) return instanteLocal(evento.fin.fecha, 24 * 60)
  return instanteLocal(evento.fin.fecha, horaAMinutos(evento.fin.hora ?? "23:59"))
}

/** Momento en que avisa el evento, o `null` si no avisa (sin aviso, o pendiente de borrar). */
export function instanteAviso(evento: EventoCalendario): number | null {
  if (evento.aviso === undefined) return null
  if (evento.sincronizacion?.pendiente === "eliminar") return null
  return instanteInicio(evento) - evento.aviso * 60_000
}

/**
 * Eventos cuyo aviso cae en `(desdeMs, hastaMs]` y que todavía no han terminado.
 *
 * El intervalo es abierto por abajo para que dos revisiones seguidas no avisen dos veces del mismo
 * evento. Que el evento siga vivo es lo que decide si un aviso **atrasado** (vencido durante una
 * suspensión) aún vale: recordarte una reunión que está en curso sirve; una que ya acabó, no.
 */
export function avisosQueVencen(eventos: EventoCalendario[], desdeMs: number, hastaMs: number): EventoCalendario[] {
  return eventos.filter((ev) => {
    const cuando = instanteAviso(ev)
    return cuando !== null && cuando > desdeMs && cuando <= hastaMs && instanteFin(ev) > hastaMs
  })
}

/** Próximo aviso estrictamente posterior a `ahoraMs`, o `null` si no queda ninguno. */
export function siguienteAviso(eventos: EventoCalendario[], ahoraMs: number): number | null {
  let proximo: number | null = null
  for (const ev of eventos) {
    const cuando = instanteAviso(ev)
    if (cuando !== null && cuando > ahoraMs && (proximo === null || cuando < proximo)) proximo = cuando
  }
  return proximo
}

/** Cuerpo de la notificación: cuándo empieza, relativo a `ahoraMs`, y dónde. */
export function textoAviso(evento: EventoCalendario, ahoraMs: number): string {
  const inicio = instanteInicio(evento)
  const partes: string[] = []
  if (evento.todoElDia) {
    // `round` y no `floor`: entre medianoche y medianoche hay 23 o 25 h el día del cambio de hora.
    const dias = Math.round((inicio - instanteLocal(hoyISO(new Date(ahoraMs)), 0)) / 86_400_000)
    partes.push(dias <= 0 ? "Hoy, todo el día" : dias === 1 ? "Mañana, todo el día" : `En ${dias} días, todo el día`)
  } else {
    const faltan = Math.round((inicio - ahoraMs) / 60_000)
    const hora = evento.inicio.hora ?? ""
    if (faltan <= 0) partes.push(faltan < -1 ? `Empezó a las ${hora}` : `Empieza ahora (${hora})`)
    else partes.push(`Empieza en ${formatearDuracion(faltan)} (${hora})`)
  }
  if (evento.ubicacion) partes.push(evento.ubicacion)
  return partes.join(" · ")
}
