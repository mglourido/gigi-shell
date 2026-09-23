import GLib from "gi://GLib"
import { obtenerEntradaEscritorio } from "../aplicaciones/entradasEscritorio"
import { extraerInicioProceso } from "../aplicaciones/procesos"
import { esJuego, type ClienteJuegoLike, type EvidenciaJuego } from "./deteccion"

export interface ClienteConProceso extends ClienteJuegoLike {
  pid?: number | null
}

interface InfoProceso {
  inicio: string
  ejecutable: string | null
  comando: string | null
}

const cacheProcesos = new Map<number, InfoProceso>()
const TOPE_CACHE_PROCESOS = 128

function leerTexto(ruta: string): string | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(ruta)
    return ok ? new TextDecoder().decode(contenido) : null
  } catch (_) {
    return null
  }
}

function leerInicioProceso(pid: number): string | null {
  return extraerInicioProceso(leerTexto(`/proc/${pid}/stat`))
}

function obtenerInfoProceso(pid: number | null | undefined): InfoProceso | null {
  if (!pid || pid <= 0) return null

  // Un PID puede reciclarse durante una sesión. starttime identifica la encarnación
  // concreta del proceso y permite reutilizar la caché sin atribuir datos antiguos.
  const inicio = leerInicioProceso(pid)
  if (!inicio) {
    cacheProcesos.delete(pid)
    return null
  }

  const cacheado = cacheProcesos.get(pid)
  if (cacheado?.inicio === inicio) {
    cacheProcesos.delete(pid)
    cacheProcesos.set(pid, cacheado)
    return cacheado
  }

  let ejecutable: string | null = null
  try {
    ejecutable = GLib.file_read_link(`/proc/${pid}/exe`).toLowerCase()
  } catch (_) {}

  const bruto = leerTexto(`/proc/${pid}/cmdline`)
  const comando = bruto ? bruto.replace(/\0/g, " ").trim().toLowerCase() : null
  const info = { inicio, ejecutable, comando }

  if (cacheProcesos.size >= TOPE_CACHE_PROCESOS) {
    const masAntiguo = cacheProcesos.keys().next().value
    if (masAntiguo !== undefined) cacheProcesos.delete(masAntiguo)
  }
  cacheProcesos.set(pid, info)
  return info
}

export function invalidarEvidenciaProceso(pid: number | null | undefined): void {
  if (pid && pid > 0) cacheProcesos.delete(pid)
}

export function recogerEvidenciaJuego(
  cliente: ClienteConProceso | null | undefined,
): EvidenciaJuego {
  if (!cliente) return {}
  const entrada = obtenerEntradaEscritorio(cliente)
  const proceso = obtenerInfoProceso(cliente.pid)
  return {
    categories: entrada ? entrada.categorias : null,
    exe: proceso?.ejecutable ?? null,
    cmdline: proceso?.comando ?? null,
  }
}

export function esClienteJuego(cliente: ClienteConProceso | null | undefined): boolean {
  return !!cliente && esJuego(cliente, recogerEvidenciaJuego(cliente))
}
