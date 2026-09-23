import glifos from "../../config/app_icons.json" with { type: "json" }
import { candidatosIdentificadorAplicacion } from "./identificadores.ts"

const GLIFOS: Record<string, string> = glifos

/** Glifo configurado, respetando la prioridad de los identificadores recibidos. */
export function obtenerGlifoAplicacion(
  ...identificadores: Array<string | null | undefined>
): string | null {
  for (const identificador of identificadores) {
    for (const candidato of candidatosIdentificadorAplicacion(identificador)) {
      const glifo = GLIFOS[candidato]
      if (glifo) return glifo
    }
  }
  return null
}
