/** Referencias compartidas, acotadas por cantidad y ordenadas por último uso. */
export function crearCacheIconos<T>(limite = 128) {
  const entradas = new Map<string, T>()
  return {
    obtener(clave: string, resolver: () => T): T {
      if (entradas.has(clave)) {
        const valor = entradas.get(clave)!
        entradas.delete(clave)
        entradas.set(clave, valor)
        return valor
      }
      const valor = resolver()
      if (entradas.size >= limite) entradas.delete(entradas.keys().next().value!)
      entradas.set(clave, valor)
      return valor
    },
    invalidar(): void { entradas.clear() },
  }
}
