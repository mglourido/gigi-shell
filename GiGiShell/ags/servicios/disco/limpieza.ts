// servicios/disco/limpieza.ts — puente entre los botones de Ajustes y
// `hypr/scripts/limpiar-almacenamiento.sh`.
//
// El script ya decide el nivel de privilegio de cada acción y ya mide lo liberado; aquí no se
// duplica nada de eso. Lo único que aporta este módulo es traducir su JSON a algo que la UI pueda
// pintar sin volver a pensar, y **envolver las acciones de pkexec en `withPrivilegedPrompt`**.
//
// Esa envoltura no es opcional: la ventana de Ajustes es una capa OVERLAY y el diálogo de polkit
// es un toplevel normal, así que sin apartar la ventana el diálogo queda DETRÁS y el usuario ve
// cómo el botón se queda pensando para siempre. Es exactamente el problema que documentan
// `servicios/dispositivos/printers.ts` y `modulos/ajustes/fecha-idioma/fechaHora.ts`.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { withPrivilegedPrompt } from "../../estado/shell"
import { accion, type IdAccion } from "./catalogo"

const SCRIPT = `${GLib.get_user_config_dir()}/hypr/scripts/limpiar-almacenamiento.sh`

export type EstadoLimpieza = "ok" | "omitida" | "cancelado" | "sin-permisos" | "error"

export interface ResultadoLimpieza {
  accion: string
  estado: EstadoLimpieza
  liberado: number
  mensaje: string
}

const ESTADOS: EstadoLimpieza[] = ["ok", "omitida", "cancelado", "sin-permisos", "error"]

function normalizar(crudo: unknown): ResultadoLimpieza[] {
  if (!Array.isArray(crudo)) return []
  const salida: ResultadoLimpieza[] = []
  for (const item of crudo) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const estado = ESTADOS.includes(o.estado as EstadoLimpieza) ? (o.estado as EstadoLimpieza) : "error"
    salida.push({
      accion: typeof o.accion === "string" ? o.accion : "",
      estado,
      liberado: typeof o.liberado === "number" && Number.isFinite(o.liberado) ? o.liberado : 0,
      mensaje: typeof o.mensaje === "string" ? o.mensaje : "",
    })
  }
  return salida
}

/**
 * Ejecuta una acción y devuelve su resultado.
 *
 * Un fallo de `execAsync` (script ausente, sin permiso de ejecución, JSON ilegible) se convierte
 * en un `ResultadoLimpieza` con estado `error` en vez de propagarse: quien llama es un `onClicked`,
 * y una promesa rechazada ahí se pierde en la consola dejando el botón en "Limpiando…" para
 * siempre. Todo camino tiene que terminar en algo que se pueda pintar.
 */
export async function ejecutarLimpieza(id: IdAccion): Promise<ResultadoLimpieza> {
  const meta = accion(id)
  const invocar = () => execAsync([SCRIPT, id])

  try {
    const salida = meta?.privilegio === "pkexec"
      ? await withPrivilegedPrompt(invocar)
      : await invocar()
    const resultados = normalizar(JSON.parse(salida))
    return resultados[0] ?? { accion: id, estado: "error", liberado: 0, mensaje: "sin respuesta" }
  } catch (e) {
    return { accion: id, estado: "error", liberado: 0, mensaje: String(e) }
  }
}
