// modulos/orion/data/wallpaperSchedule.ts
//
// Modelo de las franjas horarias y los grupos de fondos, y las consultas que la
// UI de Orion necesita para PINTARLOS. Puro: ni GTK, ni GLib, ni procesos.
//
// ⚠️ ESTO NO DECIDE QUÉ FONDO SE APLICA. Quien decide es
// `hypr/scripts/lib/seleccion_fondos.py`, y tiene que seguir siendo el único:
// la elección se dispara desde dos sitios (el arranque de la sesión, en bash y
// antes de que AGS exista, y el cambio de franja, desde AGS), así que dos
// implementaciones acabarían discrepando en silencio.
//
// Lo que sí se reimplementa aquí es la aritmética CÍCLICA de las franjas, y solo
// para enseñarla: qué franja rige ahora, qué variante de un grupo está vigente,
// si un fondo es apto. Es deliberado y acotado — la alternativa era lanzar un
// subproceso por tarjeta en cada repintado, y encima sin reactividad. El peor
// fallo posible por esta duplicación es una etiqueta equivocada, nunca un fondo
// equivocado. Si tocas la regla de vigencia, tócala en los dos sitios.
//
// EL MODELO, en corto (el porqué completo está en el .py):
//   * FRANJAS GLOBALES (día/tarde/noche, N libres): gobiernan los fondos
//     SUELTOS, que declaran en cuáles son aptos. Sin declaración: aptos siempre.
//   * LÍNEA DE 24 H PROPIA de cada GRUPO: gobierna sus variantes, y es
//     independiente de las globales. Cada tramo lleva una LISTA de fondos; si
//     hay varios, el motor sortea entre ellos.
//   * Un grupo es UNA entidad de cara al sorteo, y sus imágenes no compiten
//     además como fondos sueltos.
//   * Un tramo con `paths` vacío = "este grupo no sale a estas horas".
//
// Ambas listas se definen solo por el INICIO de cada entrada y llegan hasta el
// comienzo de la siguiente, envolviendo la medianoche.

export const MINUTOS_DIA = 24 * 60

export interface Franja  { id: string; nombre: string; start: string }
export interface Tramo   { start: string; paths: string[] }
export interface Grupo   { id: string; nombre: string; tramos: Tramo[] }
export interface AjusteFondo { franjas: string[] }

export interface WallpapersConfig {
  version: number
  franjas: Franja[]
  grupos:  Grupo[]
  fondos:  Record<string, AjusteFondo>
}

export const CONFIG_VACIA: WallpapersConfig = {
  version: 1, franjas: [], grupos: [], fondos: {},
}

/** Las tres de fábrica. Solo se escriben cuando el usuario estrena la función. */
export const FRANJAS_POR_DEFECTO: Franja[] = [
  { id: "dia",   nombre: "Día",   start: "07:00" },
  { id: "tarde", nombre: "Tarde", start: "18:30" },
  { id: "noche", nombre: "Noche", start: "21:30" },
]

// ── Horas ─────────────────────────────────────────────────────────────────────

/** "HH:MM" -> minutos del día, o null ante cualquier cosa mal formada. */
export function aMinutos(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function aHora(minutos: number): string {
  const m = ((Math.round(minutos) % MINUTOS_DIA) + MINUTOS_DIA) % MINUTOS_DIA
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

/** Minutos del día de una fecha, en hora LOCAL: "de noche" es hora de reloj. */
export function minutosDe(fecha: Date): number {
  return fecha.getHours() * 60 + fecha.getMinutes()
}

/**
 * De una lista cíclica de entradas con `start`, la vigente a `ahora`.
 *
 * Antes del primer inicio del día manda la ÚLTIMA: es la que viene de ayer. Sin
 * esa vuelta, a las 00:30 con la primera franja a las 07:00 no regiría ninguna
 * — el caso que se olvida al escribir esto a mano.
 */
export function vigente<T extends { start: string }>(entradas: T[], ahora: number): T | null {
  const validas = entradas
    .map(e => ({ e, min: aMinutos(e.start) }))
    .filter((x): x is { e: T; min: number } => x.min !== null)
    .sort((a, b) => a.min - b.min)
  if (validas.length === 0) return null
  let elegida = validas[validas.length - 1].e
  for (const { e, min } of validas) {
    if (min <= ahora) elegida = e
    else break
  }
  return elegida
}

// ── Consultas ─────────────────────────────────────────────────────────────────

export function franjaActual(cfg: WallpapersConfig, ahora: number): Franja | null {
  return vigente(cfg.franjas ?? [], ahora)
}

/** Toda ruta que pertenece a algún grupo: no compite como fondo suelto. */
export function rutasAgrupadas(cfg: WallpapersConfig): Set<string> {
  const dentro = new Set<string>()
  for (const g of cfg.grupos ?? [])
    for (const t of g.tramos ?? [])
      for (const p of t.paths ?? []) dentro.add(p)
  return dentro
}

export function grupoDe(cfg: WallpapersConfig, path: string): Grupo | null {
  return (cfg.grupos ?? []).find(g =>
    (g.tramos ?? []).some(t => (t.paths ?? []).includes(path))) ?? null
}

/**
 * ¿Es apto este fondo suelto a esta hora? Sin franjas globales, sin declaración
 * o con la lista vacía: apto siempre. El default permisivo evita que un fondo
 * recién copiado a la carpeta quede invisible sin que nadie lo pida.
 */
export function esApto(cfg: WallpapersConfig, path: string, ahora: number): boolean {
  const actual = franjaActual(cfg, ahora)
  if (!actual) return true
  const declaradas = cfg.fondos?.[path]?.franjas
  if (!Array.isArray(declaradas) || declaradas.length === 0) return true
  return declaradas.includes(actual.id)
}

/** Rutas que un grupo ofrece a esta hora. Vacío = no sale ahora. */
export function tramoVigente(grupo: Grupo, ahora: number): string[] {
  return vigente(grupo.tramos ?? [], ahora)?.paths ?? []
}

/**
 * La imagen con la que representar un grupo en la rejilla: la de su tramo
 * vigente. Si ahora no sale, se enseña la primera que tenga, para que la tarjeta
 * no aparezca vacía — el estado "ahora no sale" se comunica atenuándola, no
 * dejándola en blanco.
 */
export function portadaGrupo(grupo: Grupo, ahora: number): string | null {
  const activo = tramoVigente(grupo, ahora)
  if (activo.length > 0) return activo[0]
  for (const t of grupo.tramos ?? []) if ((t.paths ?? []).length > 0) return t.paths[0]
  return null
}

export function variantesDe(grupo: Grupo): string[] {
  const vistas: string[] = []
  for (const t of grupo.tramos ?? [])
    for (const p of t.paths ?? []) if (!vistas.includes(p)) vistas.push(p)
  return vistas
}

// ── La rejilla ────────────────────────────────────────────────────────────────

export type Entidad =
  | { tipo: "grupo"; grupo: Grupo; portada: string | null; activo: boolean }
  | { tipo: "fondo"; path: string; activo: boolean }

/**
 * Lo que se pinta en la rejilla de Orion: un grupo es UNA tarjeta, y sus
 * imágenes no aparecen además sueltas. `activo` = sale a esta hora, y es lo que
 * la UI atenúa.
 */
export function entidades(
  cfg: WallpapersConfig, disponibles: string[], ahora: number,
): Entidad[] {
  const agrupadas = rutasAgrupadas(cfg)
  const existe = new Set(disponibles)
  const salida: Entidad[] = []

  for (const grupo of cfg.grupos ?? []) {
    const activas = tramoVigente(grupo, ahora).filter(p => existe.has(p))
    salida.push({
      tipo: "grupo",
      grupo,
      portada: portadaGrupo(grupo, ahora),
      activo: activas.length > 0,
    })
  }
  for (const path of disponibles) {
    if (agrupadas.has(path)) continue
    salida.push({ tipo: "fondo", path, activo: esApto(cfg, path, ahora) })
  }
  return salida
}

// ── Próximo límite ────────────────────────────────────────────────────────────

/**
 * Todos los instantes del día en que la decisión (o esta vista) puede cambiar.
 *
 * NO existe aquí el "próximo cambio": esa cuenta atrás depende de QUÉ fondo hay
 * puesto (con un grupo mandan solo sus tramos; con un fondo suelto, solo las
 * franjas globales) y es la que arma el temporizador del planificador, así que
 * vive donde vive la decisión — `proximo_cambio` en `seleccion_fondos.py`.
 * Duplicarla aquí sería una segunda cuenta atrás capaz de discrepar de la que de
 * verdad se usa.
 */
export function limites(cfg: WallpapersConfig): number[] {
  const marcas = new Set<number>()
  for (const f of cfg.franjas ?? []) {
    const m = aMinutos(f.start); if (m !== null) marcas.add(m)
  }
  for (const g of cfg.grupos ?? [])
    for (const t of g.tramos ?? []) {
      const m = aMinutos(t.start); if (m !== null) marcas.add(m)
    }
  return [...marcas].sort((a, b) => a - b)
}


// ── Edición ───────────────────────────────────────────────────────────────────

/**
 * Normaliza lo que se lee del disco. El fichero lo escribe Orion, pero también
 * puede editarlo el usuario a mano o venir de otra máquina: nada de aquí abajo
 * puede lanzar ante una clave ausente o de tipo raro, y lo inservible se cae en
 * vez de contaminar la config.
 */
export function normalizar(bruto: unknown): WallpapersConfig {
  const cfg = (bruto ?? {}) as Partial<WallpapersConfig>
  const franjas: Franja[] = []
  for (const f of Array.isArray(cfg.franjas) ? cfg.franjas : []) {
    if (!f || typeof f !== "object") continue
    const { id, start } = f as Franja
    if (typeof id !== "string" || !id || aMinutos(start) === null) continue
    if (franjas.some(x => x.id === id)) continue
    franjas.push({ id, nombre: typeof (f as Franja).nombre === "string" ? (f as Franja).nombre : id, start })
  }

  const grupos: Grupo[] = []
  for (const g of Array.isArray(cfg.grupos) ? cfg.grupos : []) {
    if (!g || typeof g !== "object") continue
    const { id } = g as Grupo
    if (typeof id !== "string" || !id) continue
    if (grupos.some(x => x.id === id)) continue
    const tramos: Tramo[] = []
    for (const t of Array.isArray((g as Grupo).tramos) ? (g as Grupo).tramos : []) {
      if (!t || typeof t !== "object" || aMinutos((t as Tramo).start) === null) continue
      const paths = (Array.isArray((t as Tramo).paths) ? (t as Tramo).paths : [])
        .filter((p): p is string => typeof p === "string")
      tramos.push({ start: (t as Tramo).start, paths })
    }
    tramos.sort((a, b) => (aMinutos(a.start)! - aMinutos(b.start)!))
    grupos.push({ id, nombre: typeof (g as Grupo).nombre === "string" ? (g as Grupo).nombre : id, tramos })
  }

  const fondos: Record<string, AjusteFondo> = {}
  const bruteFondos = (cfg.fondos && typeof cfg.fondos === "object") ? cfg.fondos : {}
  const idsValidos = new Set(franjas.map(f => f.id))
  for (const [path, ajuste] of Object.entries(bruteFondos)) {
    const lista = (ajuste as AjusteFondo)?.franjas
    if (!Array.isArray(lista)) continue
    // Una franja borrada deja referencias huérfanas; se limpian al leer para que
    // un fondo no quede apto "para una franja que ya no existe", que en la
    // práctica lo dejaría fuera de la selección para siempre.
    const franjasFondo = lista.filter(x => typeof x === "string" && idsValidos.has(x))
    if (franjasFondo.length > 0) fondos[path] = { franjas: franjasFondo }
  }

  return { version: 1, franjas, grupos, fondos }
}

/** Ids cortos y estables; no se enseñan, solo enlazan grupos y franjas. */
export function nuevoId(prefijo: string, existentes: string[]): string {
  let n = 1
  while (existentes.includes(`${prefijo}${n}`)) n++
  return `${prefijo}${n}`
}

/**
 * Quita una ruta de todos los tramos de todos los grupos, y borra los grupos que
 * se queden sin ninguna imagen. Es lo que se ejecuta al sacar un fondo de un
 * grupo y también al desaparecer un fichero del disco: un grupo vacío no es una
 * entidad que se pueda elegir, solo una tarjeta muerta en la rejilla.
 */
export function sinRuta(cfg: WallpapersConfig, path: string): WallpapersConfig {
  const grupos = cfg.grupos
    .map(g => ({ ...g, tramos: g.tramos.map(t => ({ ...t, paths: t.paths.filter(p => p !== path) })) }))
    .filter(g => g.tramos.some(t => t.paths.length > 0))
  const fondos = { ...cfg.fondos }
  delete fondos[path]
  return { ...cfg, grupos, fondos }
}
