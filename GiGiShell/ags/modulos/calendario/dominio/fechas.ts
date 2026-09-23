// Aritmética de fechas del calendario. Puro y probado: no importa GTK ni toca disco.
//
// **Nunca se usa `new Date(cadena)` ni `new Date(y, m, d)` para calcular.** El primero parsea
// `"2026-07-21"` como UTC y en Europa/Madrid devuelve el día anterior a las 22:00 (así comparaba
// mal la agenda del store antiguo); el segundo construye en hora local, y sumar días sobre él salta
// una hora en los cambios de horario de verano, lo que a las 00:00 se convierte en saltarse un día.
// Todo el cálculo va sobre `Date.UTC`, que es aritmética de calendario pura, y la cadena
// `YYYY-MM-DD` es la representación canónica.

export const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]

/** Semana que empieza en lunes, como en España. Índice 0 = lunes. */
export const DIAS_SEMANA_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
export const DIAS_SEMANA = [
  "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo",
]

const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/
const RE_HORA = /^(\d{2}):(\d{2})$/

export interface PartesFecha {
  anio: number
  /** 1–12, no 0–11: el desfase del `Date` de JS es la fuente número uno de errores aquí. */
  mes: number
  dia: number
}

export function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0
}

export function diasEnMes(anio: number, mes: number): number {
  if (mes < 1 || mes > 12) return 0
  const dias = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return mes === 2 && esBisiesto(anio) ? 29 : dias[mes - 1]
}

/** `2026, 7, 5` → `"2026-07-05"`. No valida: úsalo con valores ya correctos. */
export function aFechaISO(anio: number, mes: number, dia: number): string {
  const dd = (n: number) => String(n).padStart(2, "0")
  return `${String(anio).padStart(4, "0")}-${dd(mes)}-${dd(dia)}`
}

/** `"2026-07-05"` → partes, o `null` si la cadena no es una fecha real (incluye 31 de febrero). */
export function desdeFechaISO(iso: string): PartesFecha | null {
  const m = RE_FECHA.exec(iso ?? "")
  if (!m) return null
  const anio = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])
  if (mes < 1 || mes > 12) return null
  if (dia < 1 || dia > diasEnMes(anio, mes)) return null
  return { anio, mes, dia }
}

export function esFechaValida(iso: string): boolean {
  return desdeFechaISO(iso) !== null
}

export function esHoraValida(hora: string): boolean {
  const m = RE_HORA.exec(hora ?? "")
  if (!m) return false
  const h = Number(m[1])
  const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

/** `"09:30"` → 570. `-1` si la hora no es válida. */
export function horaAMinutos(hora: string): number {
  const m = RE_HORA.exec(hora ?? "")
  if (!m) return -1
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return -1
  return h * 60 + min
}

/** 570 → `"09:30"`. Se recorta al día: no existe `"24:00"`. */
export function minutosAHora(minutos: number): string {
  const total = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutos)))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/** Fecha de hoy en hora LOCAL. Se inyecta `ahora` para poder probarlo. */
export function hoyISO(ahora: Date = new Date()): string {
  return aFechaISO(ahora.getFullYear(), ahora.getMonth() + 1, ahora.getDate())
}

/** Hora actual `"HH:MM"` en hora local. */
export function horaActual(ahora: Date = new Date()): string {
  return `${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`
}

function aUTC(iso: string): number | null {
  const p = desdeFechaISO(iso)
  return p === null ? null : Date.UTC(p.anio, p.mes - 1, p.dia)
}

const MS_DIA = 86_400_000

/** Suma (o resta) días naturales. Devuelve la propia cadena si no es una fecha válida. */
export function sumarDias(iso: string, dias: number): string {
  const base = aUTC(iso)
  if (base === null) return iso
  const d = new Date(base + dias * MS_DIA)
  return aFechaISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Días de `desde` a `hasta` (positivo si `hasta` es posterior). `0` si alguna no es válida. */
export function diferenciaEnDias(desde: string, hasta: string): number {
  const a = aUTC(desde)
  const b = aUTC(hasta)
  if (a === null || b === null) return 0
  return Math.round((b - a) / MS_DIA)
}

/**
 * Comparación de fechas ISO. Es una comparación de cadenas a propósito: el formato
 * `YYYY-MM-DD` con relleno de ceros ordena lexicográficamente igual que cronológicamente,
 * así que no hace falta parsear nada.
 */
export function compararFechas(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function estaEnRango(fecha: string, desde: string, hasta: string): boolean {
  return compararFechas(fecha, desde) >= 0 && compararFechas(fecha, hasta) <= 0
}

/** Todas las fechas del intervalo, extremos incluidos. Vacío si el rango está invertido. */
export function rangoFechas(desde: string, hasta: string, tope = 3660): string[] {
  if (!esFechaValida(desde) || !esFechaValida(hasta)) return []
  const total = diferenciaEnDias(desde, hasta)
  if (total < 0) return []
  const out: string[] = []
  for (let i = 0; i <= Math.min(total, tope); i++) out.push(sumarDias(desde, i))
  return out
}

/** Día de la semana con lunes = 0 … domingo = 6. `-1` si la fecha no es válida. */
export function diaSemana(iso: string): number {
  const base = aUTC(iso)
  if (base === null) return -1
  return (new Date(base).getUTCDay() + 6) % 7
}

/** Día de la semana del día 1 del mes, lunes = 0. */
export function primerDiaSemanaDelMes(anio: number, mes: number): number {
  return (new Date(Date.UTC(anio, mes - 1, 1)).getUTCDay() + 6) % 7
}

export interface CeldaMes {
  fecha: string
  dia: number
  anio: number
  mes: number
  /** `false` para los días de relleno del mes anterior o siguiente (se pintan atenuados). */
  delMes: boolean
}

/**
 * Cuadrícula del mes: SIEMPRE 42 celdas (6 semanas × 7 días).
 *
 * El tamaño es fijo a propósito. Un mes ocupa 4, 5 o 6 semanas según en qué día caiga el 1, y con la
 * rejilla variable el panel cambiaba de alto al pasar de mes — un salto visual en cada clic de la
 * flecha. Cuarenta y dos celdas cubren el peor caso (31 días empezando en domingo) y el relleno se
 * marca con `delMes: false`.
 */
export function construirCuadriculaMes(anio: number, mes: number): CeldaMes[] {
  const celdas: CeldaMes[] = []
  const desplazamiento = primerDiaSemanaDelMes(anio, mes)
  const primera = sumarDias(aFechaISO(anio, mes, 1), -desplazamiento)
  for (let i = 0; i < 42; i++) {
    const fecha = sumarDias(primera, i)
    const p = desdeFechaISO(fecha)!
    celdas.push({
      fecha,
      dia: p.dia,
      anio: p.anio,
      mes: p.mes,
      delMes: p.mes === mes && p.anio === anio,
    })
  }
  return celdas
}

/** Mes anterior/siguiente sin desbordar el año. */
export function desplazarMes(anio: number, mes: number, delta: number): { anio: number; mes: number } {
  const total = anio * 12 + (mes - 1) + delta
  return { anio: Math.floor(total / 12), mes: (total % 12) + 1 }
}

export function nombreMes(mes: number): string {
  return MESES[mes - 1] ?? ""
}

/** `"2026-07-21"` → `"Martes 21 de julio de 2026"`. */
export function formatearFechaLarga(iso: string): string {
  const p = desdeFechaISO(iso)
  if (!p) return iso
  const dia = DIAS_SEMANA[diaSemana(iso)] ?? ""
  return `${dia} ${p.dia} de ${nombreMes(p.mes).toLowerCase()} de ${p.anio}`
}

/**
 * Clave de orden de un instante: fecha + hora. Para eventos de día completo la hora va vacía, y
 * como `""` ordena antes que cualquier `"HH:MM"`, quedan los primeros del día sin ningún caso
 * especial en el comparador.
 */
export function claveInstante(fecha: string, hora?: string): string {
  return `${fecha}T${hora ?? ""}`
}
