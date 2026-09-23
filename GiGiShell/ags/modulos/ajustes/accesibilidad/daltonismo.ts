export const MODOS_DALTONISMO = ["protanopia", "deuteranopia", "tritanopia"] as const

export type ModoDaltonismoActivo = typeof MODOS_DALTONISMO[number]
export type ModoDaltonismo = "ninguno" | ModoDaltonismoActivo

/** Convierte datos persistidos desconocidos en un modo seguro. */
export function normalizarModoDaltonismo(valor: unknown): ModoDaltonismo {
  return valor === "ninguno" || MODOS_DALTONISMO.some((modo) => modo === valor)
    ? valor as ModoDaltonismo
    : "ninguno"
}

/**
 * Selección exclusiva: elegir otro modo lo sustituye y pulsar el activo lo apaga.
 */
export function alternarModoDaltonismo(
  actual: ModoDaltonismo,
  solicitado: ModoDaltonismoActivo,
): ModoDaltonismo {
  return actual === solicitado ? "ninguno" : solicitado
}
