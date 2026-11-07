export interface ClientePosicionado {
  x?: number | null
  y?: number | null
  address?: string | null
  /** 0 normal, 1 maximizada, 2 pantalla completa (el `fullscreen` de Hyprland). */
  fullscreen?: number | null
}

interface Punto {
  x: number
  y: number
}

/** Última posición de cada ventana FUERA de maximizado/pantalla completa, por
 *  dirección. Al maximizar, Hyprland lleva la ventana a la esquina del escritorio
 *  y, ordenada por su posición real, saltaba a la cabeza de la fila de iconos. Las
 *  demás conservan su hueco del mosaico, así que basta con ordenar la maximizada
 *  por el hueco que tenía. */
export type MemoriaPosiciones = Map<string, Punto>

const coordenada = (valor: number | null | undefined): number =>
  typeof valor === "number" && Number.isFinite(valor) ? valor : Number.MAX_SAFE_INTEGER

const esFinito = (valor: number | null | undefined): valor is number =>
  typeof valor === "number" && Number.isFinite(valor)

/** Apunta la posición de las ventanas en estado normal y olvida las que ya no
 *  están. Se llama con TODOS los clientes que ve la barra, no por escritorio, para
 *  que la poda no borre los de otro escritorio. */
export function actualizarMemoriaPosiciones(
  memoria: MemoriaPosiciones,
  clientes: Iterable<ClientePosicionado>,
): void {
  const vivas = new Set<string>()
  for (const cliente of clientes) {
    if (!cliente.address) continue
    vivas.add(cliente.address)
    if ((cliente.fullscreen ?? 0) === 0 && esFinito(cliente.x) && esFinito(cliente.y))
      memoria.set(cliente.address, { x: cliente.x, y: cliente.y })
  }
  for (const direccion of memoria.keys()) if (!vivas.has(direccion)) memoria.delete(direccion)
}

/** Orden de lectura de la disposición: filas de arriba abajo y, en cada fila,
 *  ventanas de izquierda a derecha. La dirección desempata ventanas superpuestas
 *  sin depender del orden interno (HashTable) con el que Astal entrega la lista.
 *  Con `memoria`, una ventana maximizada o en pantalla completa se ordena por su
 *  última posición normal; sin ella (nació así, o AGS arrancó con ella maximizada)
 *  cae a la real. Si se abren o cierran ventanas MIENTRAS está maximizada, su hueco
 *  real en el mosaico puede haber cambiado y Hyprland no lo expone: se usa el
 *  recordado hasta que salga del maximizado, que es cuando vuelve a verse. */
export function ordenarClientesEscritorio<T extends ClientePosicionado>(
  clientes: Iterable<T> | null | undefined,
  memoria?: MemoriaPosiciones,
): T[] {
  const posicion = (cliente: T): Punto => {
    const recordada = (cliente.fullscreen ?? 0) !== 0 && cliente.address
      ? memoria?.get(cliente.address)
      : undefined
    return recordada ?? { x: coordenada(cliente.x), y: coordenada(cliente.y) }
  }
  return [...(clientes ?? [])]
    .map((cliente) => ({ cliente, punto: posicion(cliente) }))
    .sort((primero, segundo) =>
      primero.punto.y - segundo.punto.y ||
      primero.punto.x - segundo.punto.x ||
      (primero.cliente.address ?? "").localeCompare(segundo.cliente.address ?? ""),
    )
    .map(({ cliente }) => cliente)
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
