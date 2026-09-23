// servicios/disco/analisis.ts — el sondeo de disco de Ajustes > Almacenamiento.
//
// Mismo esquema que `modulos/ajustes/sistema/informacion.ts`, y por la misma razón: el análisis
// obliga a recorrer el sistema de ficheros (`du` sobre ~/.cache, /var/cache/pacman, el hogar) y
// eso cuesta segundos con la caché de inodos fría. Se **cachea en disco**, así que al abrir la
// sección se pinta el análisis anterior de inmediato y el nuevo entra por detrás cuando llega.
//
// LA CACHÉ VA EN ~/.cache/gigios/, NO en ~/.config/gigios/: es una medición, o sea justo lo que
// se puede volver a obtener. En `config` acabaría restaurándose desde un backup y enseñando el
// desglose de otro momento —o de otro equipo— como si fuera el de ahora.
//
// El sondeo NO se memoiza en RAM: la sección se desmonta al cerrar Ajustes y mantener vivos los
// ~1500 paquetes del catálogo el resto de la sesión no compra nada. Releer el JSON es una lectura
// que ya está en la caché de páginas.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import type { MedidaCategoria } from "./catalogo"

export interface Disco {
  dispositivo: string
  punto: string
  fs: string
  total: number
  usado: number
  libre: number
  porcentaje: number
}

export interface App {
  nombre: string
  bytes: number
  origen: "repo" | "aur"
  explicito: boolean
  fecha: string
  descripcion: string
}

export interface Analisis {
  version: number
  epoch: number
  discos: Disco[]
  categorias: MedidaCategoria[]
  apps: App[]
}

// 2: cada categoría lleva además `liberable` (lo que se liberaría al limpiarla, no lo que ocupa).
// Subirlo INVALIDA la caché en disco: `normalizar` devuelve `null` ante otra versión, así que un
// análisis de la versión 1 —sin esa columna— se descarta y se vuelve a medir, en vez de alimentar
// la estimación con `liberable: null` en todo y dejarla en "no se ha podido calcular" para siempre.
const VERSION_CACHE = 2
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), "gigios", "almacenamiento.json"])
const SCRIPT = `${GLib.get_user_config_dir()}/hypr/scripts/analizar-almacenamiento.sh`

export const ANALISIS_VACIO: Analisis = { version: VERSION_CACHE, epoch: 0, discos: [], categorias: [], apps: [] }

/**
 * Normaliza lo que venga del script o de la caché. Todo campo ausente cae a un valor neutro en vez
 * de propagar `undefined` a la UI: el script es un contrato de texto, no de tipos, y una versión
 * antigua suya (o una caché de antes de un cambio de formato) tiene que degradar a "no medido", no
 * romper la sección entera.
 */
function normalizar(crudo: unknown): Analisis | null {
  if (!crudo || typeof crudo !== "object") return null
  const o = crudo as Record<string, unknown>
  if (o.version !== VERSION_CACHE) return null

  const lista = <T>(valor: unknown, mapa: (item: Record<string, unknown>) => T | null): T[] => {
    if (!Array.isArray(valor)) return []
    const salida: T[] = []
    for (const item of valor) {
      if (!item || typeof item !== "object") continue
      const convertido = mapa(item as Record<string, unknown>)
      if (convertido) salida.push(convertido)
    }
    return salida
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const txt = (v: unknown): string => (typeof v === "string" ? v : "")

  return {
    version: VERSION_CACHE,
    epoch: num(o.epoch),
    discos: lista<Disco>(o.discos, d => txt(d.punto) ? {
      dispositivo: txt(d.dispositivo), punto: txt(d.punto), fs: txt(d.fs),
      total: num(d.total), usado: num(d.usado), libre: num(d.libre), porcentaje: num(d.porcentaje),
    } : null),
    categorias: lista<MedidaCategoria>(o.categorias, m => txt(m.id) ? {
      id: txt(m.id),
      // `null` sobrevive: es "no se ha podido medir", que no es 0. Ver formatearBytes.
      bytes: typeof m.bytes === "number" && Number.isFinite(m.bytes) ? m.bytes : null,
      detalle: txt(m.detalle),
      limpiable: m.limpiable === true,
      // Igual que `bytes`: `null` sobrevive porque significa "no se ha podido saber cuánto
      // liberaría", que la estimación trata distinto de un 0.
      liberable: typeof m.liberable === "number" && Number.isFinite(m.liberable) ? m.liberable : null,
    } : null),
    apps: lista<App>(o.apps, p => txt(p.nombre) ? {
      nombre: txt(p.nombre), bytes: num(p.bytes),
      origen: p.origen === "aur" ? "aur" : "repo",
      explicito: p.explicito === true,
      fecha: txt(p.fecha), descripcion: txt(p.descripcion),
    } : null),
  }
}

/** El análisis anterior, o `null` si no hay ninguno utilizable. Lectura síncrona de un JSON. */
export function leerCache(): Analisis | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(CACHE)
    if (!ok) return null
    return normalizar(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (_) {
    return null
  }
}

function guardarCache(analisis: Analisis): void {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE), 0o755)
    GLib.file_set_contents(CACHE, JSON.stringify(analisis))
  } catch (_) {
    /* la caché es una comodidad: si falla, se vuelve a sondear */
  }
}

/**
 * Lanza el análisis y guarda el resultado. Rechaza solo si el script no llegó a producir JSON;
 * un análisis parcial (categorías que salen a `null` porque `du` agotó su timeout) es un éxito.
 */
export async function analizar(): Promise<Analisis> {
  const salida = await execAsync([SCRIPT, "todo"])
  const analisis = normalizar(JSON.parse(salida))
  if (!analisis) throw new Error("análisis de almacenamiento ilegible")
  guardarCache(analisis)
  return analisis
}
