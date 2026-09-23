export interface ClienteHyprctl {
  address?: unknown
  workspace?: { id?: unknown } | null
}

export interface MovimientoEscritorio {
  direccion: string
  idDestino: number
}

export interface PlanMovimientoEscritorios {
  movimientos: MovimientoEscritorio[]
  idFocoDestino: number | null
}

const ID_ESCRITORIO_TEMPORAL = 9999

function direccionesEnEscritorio(clientes: readonly ClienteHyprctl[], idEscritorio: number): string[] {
  return clientes
    .filter((cliente) => cliente.workspace?.id === idEscritorio && typeof cliente.address === "string")
    .map((cliente) => cliente.address as string)
}

/** Plan puro del intercambio; permite comprobar que no se pierde ningún cliente
 * antes de ejecutar una orden sobre el compositor. */
export function crearPlanIntercambio(
  clientes: readonly ClienteHyprctl[],
  primerId: number,
  segundoId: number,
  idEnfocado: number,
): PlanMovimientoEscritorios {
  if (primerId === segundoId) return { movimientos: [], idFocoDestino: null }

  const direccionesPrimeras = direccionesEnEscritorio(clientes, primerId)
  const direccionesSegundas = direccionesEnEscritorio(clientes, segundoId)
  return {
    movimientos: [
      ...direccionesPrimeras.map((direccion) => ({ direccion, idDestino: ID_ESCRITORIO_TEMPORAL })),
      ...direccionesSegundas.map((direccion) => ({ direccion, idDestino: primerId })),
      ...direccionesPrimeras.map((direccion) => ({ direccion, idDestino: segundoId })),
    ],
    idFocoDestino:
      idEnfocado === primerId ? segundoId : idEnfocado === segundoId ? primerId : null,
  }
}

/** Plan puro del desplazamiento en cascada, limitado a los IDs de la vista local. */
export function crearPlanDesplazamiento(
  clientes: readonly ClienteHyprctl[],
  idOrigen: number,
  idDestino: number,
  idsOrdenados: readonly number[],
  idEnfocado: number,
): PlanMovimientoEscritorios {
  const indiceOrigen = idsOrdenados.indexOf(idOrigen)
  const indiceDestino = idsOrdenados.indexOf(idDestino)
  if (indiceOrigen < 0 || indiceDestino < 0 || indiceOrigen === indiceDestino)
    return { movimientos: [], idFocoDestino: null }

  const direccionesOrigen = direccionesEnEscritorio(clientes, idOrigen)
  const movimientos: MovimientoEscritorio[] = direccionesOrigen.map((direccion) => ({
    direccion,
    idDestino: ID_ESCRITORIO_TEMPORAL,
  }))
  const mapaFoco = new Map<number, number>([[idOrigen, idDestino]])

  if (indiceOrigen < indiceDestino) {
    for (let indice = indiceOrigen; indice < indiceDestino; indice++) {
      const idDesplazado = idsOrdenados[indice + 1]
      const destino = idsOrdenados[indice]
      movimientos.push(
        ...direccionesEnEscritorio(clientes, idDesplazado)
          .map((direccion) => ({ direccion, idDestino: destino })),
      )
      mapaFoco.set(idDesplazado, destino)
    }
  } else {
    for (let indice = indiceOrigen; indice > indiceDestino; indice--) {
      const idDesplazado = idsOrdenados[indice - 1]
      const destino = idsOrdenados[indice]
      movimientos.push(
        ...direccionesEnEscritorio(clientes, idDesplazado)
          .map((direccion) => ({ direccion, idDestino: destino })),
      )
      mapaFoco.set(idDesplazado, destino)
    }
  }

  movimientos.push(...direccionesOrigen.map((direccion) => ({ direccion, idDestino })))
  return {
    movimientos,
    idFocoDestino: mapaFoco.get(idEnfocado) ?? null,
  }
}
