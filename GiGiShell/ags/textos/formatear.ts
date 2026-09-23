export type ValorPlantilla = string | number

/** Sustituye marcadores {{nombre}} sin evaluar contenido ni alterar los ausentes. */
export function formatearTexto(
  plantilla: string,
  valores: Record<string, ValorPlantilla>,
): string {
  return plantilla.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (marcador, clave: string) =>
    Object.prototype.hasOwnProperty.call(valores, clave) ? String(valores[clave]) : marcador)
}
