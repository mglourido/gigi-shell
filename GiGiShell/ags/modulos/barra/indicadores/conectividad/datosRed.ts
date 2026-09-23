/** Lógica pura del indicador de red. */
export type TipoRed = "wired" | "wifi" | "none"
export type CalidadRed = "connected" | "portal" | "limited" | "offline"

export function barrasActivas(intensidad: number): number {
  if (intensidad >= 80) return 4
  if (intensidad >= 60) return 3
  if (intensidad >= 35) return 2
  if (intensidad >= 15) return 1
  return 0
}

export function determinarTipoRed(
  primaria: "wired" | "wifi" | "unknown",
  cableActivo: boolean,
  wifiActiva: boolean,
): TipoRed {
  if (primaria === "wired" && cableActivo) return "wired"
  if (primaria === "wifi" && wifiActiva) return "wifi"
  if (cableActivo) return "wired"
  if (wifiActiva) return "wifi"
  return "none"
}

export function clasesBarrasRed(intensidad: number, tipo: TipoRed): string[][] {
  const activas = tipo === "wifi" ? barrasActivas(intensidad) : 0
  return Array.from({ length: 4 }, (_, indice) => {
    const clases = ["network-bar", `bar-${indice + 1}`]
    if (indice < activas) clases.push("active")
    return clases
  })
}
