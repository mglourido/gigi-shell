/** Extrae el campo starttime (22) de /proc/<pid>/stat, aun si comm contiene espacios. */
export function extraerInicioProceso(stat: string | null | undefined): string | null {
  if (!stat) return null
  const cierre = stat.lastIndexOf(")")
  if (cierre < 0) return null
  const camposDesdeEstado = stat.slice(cierre + 1).trim().split(/\s+/)
  // Tras `comm`, el índice 0 es state (campo 3); starttime (campo 22) queda en 19.
  return camposDesdeEstado[19] || null
}

/** Extrae el ppid (campo 4) de /proc/<pid>/stat, con el mismo cuidado con `comm`. */
export function extraerPadreProceso(stat: string | null | undefined): number | null {
  if (!stat) return null
  const cierre = stat.lastIndexOf(")")
  if (cierre < 0) return null
  const camposDesdeEstado = stat.slice(cierre + 1).trim().split(/\s+/)
  // Tras `comm`, el índice 0 es state (campo 3); ppid (campo 4) queda en 1.
  const ppid = parseInt(camposDesdeEstado[1] ?? "", 10)
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null
}
