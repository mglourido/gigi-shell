/** Lógica pura del indicador de volumen. */
export interface SalidaAudio {
  icon?: string | null
  name?: string | null
  description?: string | null
  route?: { name?: string | null; description?: string | null } | null
  mute: boolean
  volume: number
}

export const ICONO_AURICULARES = "󰋋"

export function esAuricular(salida: SalidaAudio | null): boolean {
  if (!salida) return false
  const ruta = salida.route
  const texto = `${salida.icon ?? ""} ${salida.name ?? ""} ${salida.description ?? ""} ` +
    `${ruta?.name ?? ""} ${ruta?.description ?? ""}`
  return /head(set|phone)|auric|earbud|earphone|hands[-_ ]?free/.test(texto.toLowerCase())
}

export function estaSilenciada(salida: SalidaAudio): boolean {
  return salida.mute || salida.volume === 0
}

export function iconoVolumen(salida: SalidaAudio | null): string {
  if (!salida) return "󰝟"
  const auricular = esAuricular(salida)
  if (estaSilenciada(salida)) return auricular ? ICONO_AURICULARES : "󰝟"
  if (auricular) return ICONO_AURICULARES
  if (salida.volume < 0.25) return "󰕿"
  if (salida.volume < 0.50) return "󰖀"
  return "󰕾"
}

export function auricularSilenciado(salida: SalidaAudio | null): boolean {
  return !!salida && esAuricular(salida) && estaSilenciada(salida)
}
