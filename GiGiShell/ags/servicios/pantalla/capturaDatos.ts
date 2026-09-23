export type TipoCaptura = "share" | "record"
export interface FuenteCaptura { kind: TipoCaptura; app: string }
export interface DatosCaptura { active: boolean; sources: FuenteCaptura[] }

export const CAPTURA_VACIA: DatosCaptura = { active: false, sources: [] }

export function interpretarCaptura(contenido: string): DatosCaptura {
  try {
    const datos = JSON.parse(contenido)
    const sources: FuenteCaptura[] = Array.isArray(datos.sources)
      ? datos.sources.filter(
          (fuente: any) => fuente && (fuente.kind === "share" || fuente.kind === "record") &&
            typeof fuente.app === "string",
        )
      : []
    return { active: datos.active === true && sources.length > 0, sources }
  } catch (_) {
    return CAPTURA_VACIA
  }
}

const ETIQUETA_TIPO: Record<TipoCaptura, string> = {
  share: "Compartiendo pantalla",
  record: "Grabando pantalla",
}

export function tooltipCaptura(datos: DatosCaptura): string {
  const lineas: string[] = []
  for (const tipo of ["share", "record"] as const) {
    const aplicaciones = [...new Set(datos.sources.filter((fuente) => fuente.kind === tipo).map((fuente) => fuente.app))]
    if (aplicaciones.length > 0) lineas.push(`${ETIQUETA_TIPO[tipo]} · ${aplicaciones.join(", ")}`)
  }
  return lineas.join("\n")
}
