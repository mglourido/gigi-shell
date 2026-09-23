/** Normaliza identificadores publicados por Hyprland, MPRIS y archivos .desktop. */
export function normalizarIdentificadorAplicacion(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase()
}

/** Elimina extensiones que no forman parte del identificador lógico de la app. */
export function sinExtensionAplicacion(valor: string | null | undefined): string {
  return normalizarIdentificadorAplicacion(valor)
    .replace(/\.desktop$/i, "")
    .replace(/\.exe$/i, "")
}

/** Último segmento útil: org.mozilla.firefox -> firefox, EldenRing.exe -> eldenring. */
export function nombreBaseAplicacion(valor: string | null | undefined): string {
  const limpio = sinExtensionAplicacion(valor)
  const ultimoPunto = limpio.lastIndexOf(".")
  return ultimoPunto >= 0 ? limpio.slice(ultimoPunto + 1) : limpio
}

/**
 * Candidatos ordenados para resolver configuración e iconos sin duplicar reglas.
 * Conserva la prioridad anterior: alias conocido, id exacto, id sin extensión y base.
 */
export function candidatosIdentificadorAplicacion(
  valor: string | null | undefined,
): string[] {
  const exacto = normalizarIdentificadorAplicacion(valor)
  if (!exacto) return []

  const limpio = sinExtensionAplicacion(exacto)
  const base = nombreBaseAplicacion(limpio)
  const candidatos = exacto.includes("firefox")
    ? ["firefox", exacto, limpio, base]
    : [exacto, limpio, base]

  return [...new Set(candidatos.filter(Boolean))]
}
