// Parseo puro de `hyprctl monitors -j`. Se mantiene separado de la vista para
// poder verificar campos ausentes y formatos de color sin cargar GTK/GLib.

export interface MonitorDetectado {
  conector: string
  fabricante: string
  modelo: string
  ancho: number
  alto: number
  anchoFisico: number
  altoFisico: number
  frecuencia: number
  escala: number
  formatoColor: string
}

function cadena(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : ""
}

function numeroPositivo(valor: unknown): number {
  const numero = typeof valor === "number" ? valor : Number(valor)
  return Number.isFinite(numero) && numero > 0 ? numero : 0
}

/** Convierte la salida cruda de Hyprland sin asumir que todas sus claves existen. */
export function parsearMonitores(raw: string): MonitorDetectado[] {
  try {
    const datos: unknown = JSON.parse(raw)
    if (!Array.isArray(datos)) return []

    return datos.flatMap((dato): MonitorDetectado[] => {
      if (!dato || typeof dato !== "object") return []
      const monitor = dato as Record<string, unknown>
      const detectado = {
        conector: cadena(monitor.name),
        fabricante: cadena(monitor.make),
        modelo: cadena(monitor.model),
        ancho: numeroPositivo(monitor.width),
        alto: numeroPositivo(monitor.height),
        anchoFisico: numeroPositivo(monitor.physicalWidth),
        altoFisico: numeroPositivo(monitor.physicalHeight),
        frecuencia: numeroPositivo(monitor.refreshRate),
        escala: numeroPositivo(monitor.scale),
        formatoColor: cadena(monitor.currentFormat),
      }

      return detectado.conector || detectado.fabricante || detectado.modelo
        ? [detectado]
        : []
    })
  } catch (_) {
    return []
  }
}

/** Evita repetir el fabricante cuando el propio modelo ya lo incluye. */
export function identidadMonitor(monitor: MonitorDetectado): string {
  const fabricante = monitor.fabricante.trim()
  const modelo = monitor.modelo.trim()
  if (fabricante && modelo) {
    const normalizar = (valor: string) => valor.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
    return normalizar(modelo).startsWith(normalizar(fabricante)) ? modelo : `${fabricante} ${modelo}`
  }
  return fabricante || modelo || monitor.conector
}

/** Diagonal calculada a partir de los milímetros declarados por el EDID. */
export function diagonalPulgadas(monitor: MonitorDetectado): number | null {
  if (!monitor.anchoFisico || !monitor.altoFisico) return null
  return Math.hypot(monitor.anchoFisico, monitor.altoFisico) / 25.4
}

/** Profundidad por canal para los formatos DRM que expone Hyprland. */
export function bitsPorCanal(formato: string): number | null {
  const normalizado = formato.trim().toUpperCase()
  if (/^[AX](?:RGB|BGR)8888$/.test(normalizado)) return 8
  if (/^[AX](?:RGB|BGR)2101010$/.test(normalizado)) return 10
  if (/^[AX](?:RGB|BGR)16161616F?$/.test(normalizado)) return 16
  return null
}
