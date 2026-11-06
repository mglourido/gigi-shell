// Lógica pura del velocímetro de red de Quick Settings (sin GTK: tiene test).

export interface BytesRed { bajada: number, subida: number }

/** Suma los contadores de `/proc/net/dev` de todas las interfaces salvo el
 * loopback. La comparación es EXACTA: con un `includes("lo")` se descartaban
 * también interfaces como `wlo1` (la Wi-Fi integrada de muchos portátiles
 * Intel) y el velocímetro se quedaba parado en 0 con tráfico real. */
export function sumarBytesInterfaces(texto: string): BytesRed {
  let bajada = 0
  let subida = 0
  for (const linea of texto.split("\n")) {
    const separador = linea.indexOf(":")
    if (separador < 0) continue
    if (linea.slice(0, separador).trim() === "lo") continue
    const campos = linea.slice(separador + 1).trim().split(/\s+/)
    const rx = Number.parseInt(campos[0], 10)
    const tx = Number.parseInt(campos[8], 10)
    if (Number.isFinite(rx)) bajada += rx
    if (Number.isFinite(tx)) subida += tx
  }
  return { bajada, subida }
}

/** Bytes por segundo entre dos muestras. Una interfaz que desaparece entre
 * muestras (VPN, USB tethering, reasociación) hace BAJAR el total: ese salto
 * negativo no es tráfico, así que se da 0 en vez de una velocidad negativa. */
export function bytesPorSegundo(anterior: number, actual: number, segundos: number) {
  if (!(segundos > 0)) return 0
  return Math.max(0, (actual - anterior) / segundos)
}

export function formatearVelocidad(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)}B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
