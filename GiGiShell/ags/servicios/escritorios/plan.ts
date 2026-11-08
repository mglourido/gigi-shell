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

/** Escritorios intermedios de un desplazamiento en cascada, en el orden en que
 *  hay que correrlos: cada uno ocupa el sitio que acaba de dejar libre el
 *  anterior. `null` si origen o destino no están en la vista o coinciden. */
function cascadaDesplazamiento(
  idOrigen: number,
  idDestino: number,
  idsOrdenados: readonly number[],
): CambioId[] | null {
  const indiceOrigen = idsOrdenados.indexOf(idOrigen)
  const indiceDestino = idsOrdenados.indexOf(idDestino)
  if (indiceOrigen < 0 || indiceDestino < 0 || indiceOrigen === indiceDestino) return null

  const paso = indiceOrigen < indiceDestino ? 1 : -1
  const cascada: CambioId[] = []
  for (let indice = indiceOrigen; indice !== indiceDestino; indice += paso) {
    cascada.push({ desde: idsOrdenados[indice + paso], hasta: idsOrdenados[indice] })
  }
  return cascada
}

/** Plan puro del desplazamiento en cascada, limitado a los IDs de la vista local. */
export function crearPlanDesplazamiento(
  clientes: readonly ClienteHyprctl[],
  idOrigen: number,
  idDestino: number,
  idsOrdenados: readonly number[],
  idEnfocado: number,
): PlanMovimientoEscritorios {
  const cascada = cascadaDesplazamiento(idOrigen, idDestino, idsOrdenados)
  if (cascada === null) return { movimientos: [], idFocoDestino: null }

  const direccionesOrigen = direccionesEnEscritorio(clientes, idOrigen)
  const movimientos: MovimientoEscritorio[] = direccionesOrigen.map((direccion) => ({
    direccion,
    idDestino: ID_ESCRITORIO_TEMPORAL,
  }))
  for (const { desde, hasta } of cascada) {
    movimientos.push(
      ...direccionesEnEscritorio(clientes, desde).map((direccion) => ({ direccion, idDestino: hasta })),
    )
  }
  movimientos.push(...direccionesOrigen.map((direccion) => ({ direccion, idDestino })))
  return {
    movimientos,
    idFocoDestino: focoTrasDesplazamiento(idOrigen, idDestino, cascada, idEnfocado),
  }
}

function focoTrasDesplazamiento(
  idOrigen: number,
  idDestino: number,
  cascada: readonly CambioId[],
  idEnfocado: number,
): number | null {
  if (idEnfocado === idOrigen) return idDestino
  return cascada.find(({ desde }) => desde === idEnfocado)?.hasta ?? null
}

// ── Plan por cambio de id ────────────────────────────────────────────────────
//
// Mover ventanas (los planes de arriba) DESORDENA los escritorios: para dwindle
// un `window.move` es sacar la ventana de su árbol y reinsertarla en el destino
// como si naciera allí, así que columnas y pilas se rehacen a suertes (medido:
// una rejilla de 239x128 acaba en tiras de 488x61). Redimensionar después no lo
// arregla, porque lo que cambia es la FORMA del árbol, no sus proporciones.
// `hl.dsp.workspace.change_id` (Hyprland 0.57) renumera el escritorio entero sin
// tocar sus ventanas: la disposición queda exacta y son tres órdenes en vez de
// una por ventana. Los planes de mover quedan de reserva para lo que este no
// cubre (ver `crearPlanCambioIdsIntercambio`).

export interface EscritorioHyprctl {
  id?: unknown
  monitorID?: unknown
}

export interface CambioId {
  desde: number
  hasta: number
}

/** Sin foco que restaurar, a diferencia de los planes de mover: el escritorio
 *  que se está viendo conserva sus ventanas y solo cambia de número, así que la
 *  vista ya "sigue" a las ventanas sin despachar nada. Enfocar aquí sería un
 *  cambio de escritorio real, y se ve: medido, la pantalla parpadeaba. */
export interface PlanCambioIds {
  cambios: CambioId[]
}

/** Si TODOS los ids pedidos existen, son normales (>0) y comparten monitor, y
 *  el temporal está libre. */
function idsUtilizables(
  escritorios: readonly EscritorioHyprctl[],
  idsPedidos: readonly number[],
): boolean {
  const monitorPorId = new Map<number, unknown>()
  for (const escritorio of escritorios) {
    if (typeof escritorio.id === "number") monitorPorId.set(escritorio.id, escritorio.monitorID)
  }
  if (monitorPorId.has(ID_ESCRITORIO_TEMPORAL)) return false
  const monitores = new Set<unknown>()
  for (const id of idsPedidos) {
    if (id <= 0 || !monitorPorId.has(id)) return false
    monitores.add(monitorPorId.get(id))
  }
  return monitores.size <= 1
}

/** Intercambio renumerando: A → temporal, B → A, temporal → B. Devuelve `null`
 *  —y se usa el plan de mover— cuando no aplica:
 *  - el destino NO existe (renumerar a un número libre): `change_id` hacia un id
 *    nuevo no emite `createworkspace`/`destroyworkspace`, y AstalHyprland, que
 *    no conoce `changeworkspaceid`, se quedaría con el id viejo para siempre y
 *    las ventanas sin escritorio (medido). Con los dos ids existentes el
 *    conjunto de ids no cambia y basta resincronizar;
 *  - están en monitores distintos (renumerar no los cambia de monitor);
 *  - el temporal está ocupado, o alguno es especial. */
export function crearPlanCambioIdsIntercambio(
  escritorios: readonly EscritorioHyprctl[],
  primerId: number,
  segundoId: number,
): PlanCambioIds | null {
  if (primerId === segundoId) return { cambios: [] }
  if (!idsUtilizables(escritorios, [primerId, segundoId])) return null
  return {
    cambios: [
      { desde: primerId, hasta: ID_ESCRITORIO_TEMPORAL },
      { desde: segundoId, hasta: primerId },
      { desde: ID_ESCRITORIO_TEMPORAL, hasta: segundoId },
    ],
  }
}

/** Desplazamiento en cascada renumerando, con las mismas condiciones que el
 *  intercambio: todos los ids del tramo deben existir. */
export function crearPlanCambioIdsDesplazamiento(
  escritorios: readonly EscritorioHyprctl[],
  idOrigen: number,
  idDestino: number,
  idsOrdenados: readonly number[],
): PlanCambioIds | null {
  const cascada = cascadaDesplazamiento(idOrigen, idDestino, idsOrdenados)
  if (cascada === null) return { cambios: [] }
  if (!idsUtilizables(escritorios, [idOrigen, ...cascada.map(({ desde }) => desde)])) return null
  return {
    cambios: [
      { desde: idOrigen, hasta: ID_ESCRITORIO_TEMPORAL },
      ...cascada,
      { desde: ID_ESCRITORIO_TEMPORAL, hasta: idDestino },
    ],
  }
}

/** Cambios que deshacen los ya hechos, del último al primero. */
export function invertirCambios(hechos: readonly CambioId[]): CambioId[] {
  return [...hechos].reverse().map(({ desde, hasta }) => ({ desde: hasta, hasta: desde }))
}
