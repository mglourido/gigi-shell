export interface ClientePosicionado {
  x?: number | null
  y?: number | null
  address?: string | null
}

const coordenada = (valor: number | null | undefined): number =>
  typeof valor === "number" && Number.isFinite(valor) ? valor : Number.MAX_SAFE_INTEGER

/** Orden de lectura de la disposición: filas de arriba abajo y, en cada fila,
 *  ventanas de izquierda a derecha. La dirección desempata ventanas superpuestas
 *  sin depender del orden interno (HashTable) con el que Astal entrega la lista. */
export function ordenarClientesEscritorio<T extends ClientePosicionado>(
  clientes: Iterable<T> | null | undefined,
): T[] {
  return [...(clientes ?? [])].sort((primero, segundo) =>
    coordenada(primero.y) - coordenada(segundo.y) ||
    coordenada(primero.x) - coordenada(segundo.x) ||
    (primero.address ?? "").localeCompare(segundo.address ?? ""),
  )
}

export interface ReferenciaEscritorio {
  id: number
}

/** Devuelve el historial con el workspace indicado como el más reciente. */
export function recordarEscritorioReciente(
  idsRecientes: Iterable<number>,
  idEscritorio: number,
): number[] {
  if (!Number.isFinite(idEscritorio) || idEscritorio <= 0 || idEscritorio >= 9000) {
    return [...idsRecientes]
  }
  return [idEscritorio, ...[...idsRecientes].filter((id) => id !== idEscritorio)]
}

/** Conserva los workspaces usados más recientemente y completa los huecos con
 *  los demás candidatos. La salida se ordena por ID para que los botones no
 *  cambien de posición cada vez que se enfoca otro workspace. */
export function seleccionarEscritoriosRecientes<T extends ReferenciaEscritorio>(
  escritorios: Iterable<T> | null | undefined,
  idsRecientes: Iterable<number> | null | undefined,
  idEnfocado: number,
  limiteSolicitado: number,
): T[] {
  const ordenados = [...(escritorios ?? [])].sort((primero, segundo) => primero.id - segundo.id)
  const limite = Number.isFinite(limiteSolicitado)
    ? Math.max(1, Math.round(limiteSolicitado))
    : 1
  if (ordenados.length <= limite) return ordenados

  const porId = new Map(ordenados.map((escritorio) => [escritorio.id, escritorio]))
  const idsSeleccionados: number[] = []
  const agregarSiDisponible = (id: number) => {
    if (porId.has(id) && !idsSeleccionados.includes(id)) idsSeleccionados.push(id)
  }

  agregarSiDisponible(idEnfocado)
  for (const id of idsRecientes ?? []) agregarSiDisponible(id)
  for (const escritorio of ordenados) agregarSiDisponible(escritorio.id)

  const visibles = new Set(idsSeleccionados.slice(0, limite))
  return ordenados.filter((escritorio) => visibles.has(escritorio.id))
}
