export function agruparEnFilas<T>(elementos: readonly T[], tamano: number): T[][] {
  const longitud = Math.max(1, Math.floor(tamano))
  const filas: T[][] = []
  for (let indice = 0; indice < elementos.length; indice += longitud) {
    filas.push(elementos.slice(indice, indice + longitud))
  }
  return filas
}
