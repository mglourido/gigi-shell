export interface MuestraCpu { total: number; inactivo: number }

export function interpretarMuestraCpu(contenido: string): MuestraCpu | null {
  const partes = contenido.split("\n")[0]?.trim().split(/\s+/).slice(1).map(Number) ?? []
  if (partes.length < 4 || partes.some((valor) => !Number.isFinite(valor))) return null
  return {
    inactivo: partes[3] + (partes[4] || 0),
    total: partes.reduce((total, valor) => total + valor, 0),
  }
}

export function calcularUsoCpu(anterior: MuestraCpu, actual: MuestraCpu): number | null {
  const total = actual.total - anterior.total
  const inactivo = actual.inactivo - anterior.inactivo
  if (total <= 0) return null
  return Math.max(0, Math.min(100, Math.round(100 * (1 - inactivo / total))))
}

export function interpretarRamUsadaGiB(contenido: string): number | null {
  const valores = new Map<string, number>()
  for (const linea of contenido.split("\n")) {
    const coincidencia = linea.match(/^(MemTotal|MemAvailable):\s+(\d+)/)
    if (coincidencia) valores.set(coincidencia[1], Number(coincidencia[2]))
  }
  const total = valores.get("MemTotal")
  const disponible = valores.get("MemAvailable")
  if (total === undefined || disponible === undefined || total < disponible) return null
  return (total - disponible) / 1024 / 1024
}

export function formatearProcesoCpu(salida: string): string | null {
  const partes = salida.trim().split(/\s+/)
  const uso = Number(partes[0])
  if (partes.length < 2 || !Number.isFinite(uso)) return null
  return `${partes.slice(1).join(" ")} (${partes[0]}%)`
}

export function formatearProcesoRam(salida: string): string | null {
  const partes = salida.trim().split(/\s+/)
  const kib = Number(partes[0])
  if (partes.length < 2 || !Number.isFinite(kib)) return null
  return `${partes.slice(1).join(" ")} (${(kib / 1024 / 1024).toFixed(1)}G)`
}
