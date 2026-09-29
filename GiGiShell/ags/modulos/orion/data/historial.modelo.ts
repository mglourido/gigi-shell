// Lógica pura del historial de actividad de Orion (sin GLib ni GTK, para que
// corra bajo `node --test`). La E/S y el estado reactivo viven en `historial.ts`.
//
// El historial NO es un registro de búsquedas: una consulta que no acaba en nada
// no deja rastro. Solo entra lo que el usuario HIZO — abrir una app, fijarla en
// Inicio o pulsar un atajo entre los resultados —, que es lo único que merece
// tenerse a mano la próxima vez.

export type AccionApp = "abierta" | "fijada"

export interface EntradaApp {
  tipo: "app"
  accion: AccionApp
  /** Id del `.desktop` (o, en su defecto, el binario): la identidad de la app. */
  id: string
  nombre: string
  exec: string
  icono: string
  /** Epoch en milisegundos. */
  ts: number
}

export interface EntradaAtajo {
  tipo: "atajo"
  binding: string
  descripcion: string
  ts: number
}

export type EntradaHistorial = EntradaApp | EntradaAtajo

/** Lo que se guarda en disco. Bastante más de lo que se pinta: es barato. */
export const TOPE_HISTORIAL = 30

/**
 * Identidad de una entrada. Una app ocupa UNA fila aunque se haya abierto y
 * fijado: la acción más reciente es la que cuenta, igual que en el historial de
 * un navegador una URL visitada dos veces no sale dos veces.
 */
export function claveEntrada(e: EntradaHistorial): string {
  return e.tipo === "app" ? `app:${e.id}` : `kb:${e.binding}`
}

/** Añade `entrada` al frente, quitando la anterior con la misma clave y recortando. */
export function registrar(
  lista: EntradaHistorial[],
  entrada: EntradaHistorial,
  tope = TOPE_HISTORIAL,
): EntradaHistorial[] {
  const clave = claveEntrada(entrada)
  return [entrada, ...lista.filter(e => claveEntrada(e) !== clave)].slice(0, tope)
}

export function olvidarApp(lista: EntradaHistorial[], id: string): EntradaHistorial[] {
  const clave = `app:${id}`
  const resto = lista.filter(e => claveEntrada(e) !== clave)
  return resto.length === lista.length ? lista : resto
}

function texto(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Sanea lo leído de disco: el fichero es del usuario y puede venir editado a
 * mano, truncado o de una versión anterior. Lo que no se entiende se descarta
 * entrada a entrada en vez de tirar el historial entero.
 */
export function normalizarHistorial(bruto: unknown): EntradaHistorial[] {
  const lista = Array.isArray(bruto)
    ? bruto
    : Array.isArray((bruto as any)?.entradas) ? (bruto as any).entradas : []
  const salida: EntradaHistorial[] = []
  const vistas = new Set<string>()
  for (const e of lista) {
    if (!e || typeof e !== "object") continue
    const ts = typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : 0
    let entrada: EntradaHistorial | null = null
    if (e.tipo === "app" && texto(e.id) && texto(e.nombre)) {
      entrada = {
        tipo: "app",
        accion: e.accion === "fijada" ? "fijada" : "abierta",
        id: e.id, nombre: e.nombre, exec: texto(e.exec), icono: texto(e.icono), ts,
      }
    } else if (e.tipo === "atajo" && texto(e.binding)) {
      entrada = { tipo: "atajo", binding: e.binding, descripcion: texto(e.descripcion), ts }
    }
    if (!entrada) continue
    const clave = claveEntrada(entrada)
    if (vistas.has(clave)) continue
    vistas.add(clave)
    salida.push(entrada)
  }
  return salida.sort((a, b) => b.ts - a.ts).slice(0, TOPE_HISTORIAL)
}

/** "ahora", "5 min", "3 h", "ayer", "4 d", "3 sem". Corto a propósito: va en una fila estrecha. */
export function tiempoRelativo(ts: number, ahora: number): string {
  const s = Math.max(0, Math.round((ahora - ts) / 1000))
  if (s < 60) return "ahora"
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d === 1) return "ayer"
  if (d < 7) return `${d} d`
  return `${Math.floor(d / 7)} sem`
}
