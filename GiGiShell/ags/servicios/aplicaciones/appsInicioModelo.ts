// servicios/aplicaciones/appsInicioModelo.ts — el modelo de la lista de apps
// de inicio: saneado, validación e ids. Sin GTK ni gi:// para que corra bajo
// `node --test`; el estado y la persistencia viven en `appsInicio.ts`.
//
// Lo que se valida aquí no es paranoia de esquema: el mismo JSON lo lee un
// script de shell (`inicializador/apps-inicio.sh`) que mete `comando` dentro de
// un literal de Lua y de un `sh -c`. Una entrada con un salto de línea no da un
// error, da DOS comandos.

export interface AppInicio {
  id: string
  nombre: string
  comando: string
  /** Nombre de icono del tema; "" si la entrada no tiene ninguno (comando manual). */
  icono: string
  activo: boolean
  /** 0 = el escritorio activo al abrirse. 1..ESCRITORIO_MAX = ese escritorio. */
  escritorio: number
  silencioso: boolean
}

export const ESCRITORIO_ACTIVO = 0
export const ESCRITORIO_MAX = 99

/**
 * Deja el comando en una sola línea utilizable.
 *
 * Los saltos de línea y las tabulaciones se van, no se escapan: el script de
 * arranque pasa este texto por `sh -c`, donde un salto de línea convierte una
 * entrada en dos comandos, y por un literal de Lua, donde lo rompe. Nada de lo
 * que sale de un `.desktop` los trae, así que quitarlos no pierde nada real —
 * pero un comando escrito a mano y pegado sí puede traerlos.
 *
 * Los códigos de campo de la Desktop Entry Spec (%u, %F, %i, %c, %k…) también
 * se quitan: son marcadores que el lanzador debe sustituir por los ficheros o
 * URLs que se abren, y aquí no se abre ninguno. Sin quitarlos, la app recibiría
 * un `%U` literal como argumento.
 *
 * Se recorre `%` a `%` en UNA pasada, y no con un `replace` por código, porque
 * `%%` es un porcentaje escapado: encadenando reemplazos, el `%%` de un
 * `awk '{print 100%%2}'` se quedaría a medias y el `%` superviviente podría
 * leerse como el comienzo de otro código en la pasada siguiente. Con el
 * recorrido único, cada `%` se decide una sola vez.
 */
export function sanearComando(bruto: string): string {
  return bruto
    .replace(/%(.)/g, (coincidencia, codigo: string) => {
      if (codigo === "%") return "%"
      return /[fFuUdDnNickvmb]/.test(codigo) ? " " : coincidencia
    })
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Recorta el número de escritorio al rango que el script sabe despachar. */
export function sanearEscritorio(valor: unknown): number {
  const n = typeof valor === "number" && Number.isFinite(valor) ? Math.round(valor) : ESCRITORIO_ACTIVO
  if (n <= 0) return ESCRITORIO_ACTIVO
  return Math.min(n, ESCRITORIO_MAX)
}

/**
 * Una entrada del JSON → una entrada utilizable, o `null` si no lo es.
 *
 * Sin comando no hay nada que lanzar y sin id no hay nada que borrar, así que
 * las dos ausencias descartan la fila entera en vez de inventarse un valor: una
 * entrada muda en la lista sería peor que no verla.
 */
export function normalizarAppInicio(bruto: unknown): AppInicio | null {
  if (!bruto || typeof bruto !== "object") return null
  const entrada = bruto as Record<string, unknown>

  const id = typeof entrada.id === "string" ? entrada.id.trim() : ""
  const comando = sanearComando(typeof entrada.comando === "string" ? entrada.comando : "")
  if (!id || !comando) return null

  const nombre = typeof entrada.nombre === "string" && entrada.nombre.trim()
    ? entrada.nombre.trim()
    : comando

  const escritorio = sanearEscritorio(entrada.escritorio)
  return {
    id,
    nombre,
    comando,
    icono: typeof entrada.icono === "string" ? entrada.icono : "",
    // Ausente = activa. Una entrada guardada por una versión anterior del
    // esquema, sin esta clave, tiene que seguir arrancando.
    activo: entrada.activo !== false,
    escritorio,
    // Sin escritorio fijado la regla `silent` no llega a emitirse; guardarlo
    // encendido enseñaría un ajuste que no se está aplicando.
    silencioso: escritorio !== ESCRITORIO_ACTIVO && entrada.silencioso === true,
  }
}

/** Descarta duplicados por id: el segundo se lanzaría igual y no se podría borrar por separado. */
export function normalizarListaAppsInicio(bruto: unknown): AppInicio[] {
  if (!Array.isArray(bruto)) return []
  const vistos = new Set<string>()
  const lista: AppInicio[] = []
  for (const fila of bruto) {
    const app = normalizarAppInicio(fila)
    if (!app || vistos.has(app.id)) continue
    vistos.add(app.id)
    lista.push(app)
  }
  return lista
}

/**
 * Id estable y legible a partir del nombre, con sufijo numérico si ya existe.
 *
 * No se usa el id del `.desktop`: la misma app puede añadirse dos veces a
 * propósito (dos perfiles de navegador, dos comandos distintos del mismo
 * binario) y ahí el `.desktop` sería idéntico. El id solo identifica la FILA.
 */
export function idLibreAppInicio(nombre: string, ocupados: readonly string[]): string {
  const base = nombre.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app"
  if (!ocupados.includes(base)) return base
  for (let n = 2; ; n++) {
    const candidato = `${base}-${n}`
    if (!ocupados.includes(candidato)) return candidato
  }
}
