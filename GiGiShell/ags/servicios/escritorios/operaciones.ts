import { execAsync } from "ags/process"

import {
  crearPlanCambioIdsDesplazamiento,
  crearPlanCambioIdsIntercambio,
  crearPlanDesplazamiento,
  crearPlanIntercambio,
  invertirCambios,
  type CambioId,
  type ClienteHyprctl,
  type EscritorioHyprctl,
  type PlanCambioIds,
  type PlanMovimientoEscritorios,
} from "./plan"
import {
  iniciarOperacionEscritorios,
  obtenerHyprland,
  terminarOperacionEscritorios,
} from "./controlador"
import { esEscritorioEspecial, nombreEspecialEscritorio } from "./especiales"

let colaOperaciones: Promise<void> = Promise.resolve()

/** Lleva el foco a un escritorio. `nombreEscritorio` solo hace falta para los
 *  ESPECIALES, y ahí no es opcional de verdad:
 *  `hl.dsp.focus({workspace=-98})` sobre un especial oculto **no hace nada** y
 *  responde `ok` igualmente (medido en vivo), así que sin esto la pastilla del
 *  scratchpad en la barra era un botón muerto sin ningún error. Los especiales se
 *  muestran y se ocultan con `toggle_special`, que va por NOMBRE, no por id. */
export async function enfocarEscritorio(
  idEscritorio: number,
  nombreEscritorio?: string,
): Promise<void> {
  if (esEscritorioEspecial(idEscritorio)) {
    const nombre = nombreEspecialEscritorio(nombreEscritorio ?? "")
    // Sin un nombre utilizable no hay forma de abrirlo, y caer al focus por id
    // sería fingir que se ha hecho algo.
    if (nombre === null) return
    await execAsync([
      "hyprctl",
      "dispatch",
      `hl.dsp.workspace.toggle_special('${nombre}')`,
    ])
    return
  }
  await execAsync([
    "hyprctl",
    "dispatch",
    `hl.dsp.focus({workspace=${idEscritorio}})`,
  ])
}

async function leerClientes(): Promise<ClienteHyprctl[]> {
  const datos: unknown = JSON.parse(await execAsync(["hyprctl", "clients", "-j"]))
  if (!Array.isArray(datos)) throw new Error("hyprctl clients no devolvió una lista")
  return datos as ClienteHyprctl[]
}

async function ejecutarPlan(plan: PlanMovimientoEscritorios) {
  for (const movimiento of plan.movimientos) {
    // Equivalente Lua de `movetoworkspacesilent`: sin `follow=false`, window.move
    // ARRASTRA el foco al workspace destino (verificado en instancia anidada), que
    // es justo lo que "silent" evita.
    await execAsync([
      "hyprctl",
      "dispatch",
      `hl.dsp.window.move({workspace='${movimiento.idDestino}', window='address:${movimiento.direccion}', follow=false})`,
    ])
  }
  if (plan.idFocoDestino !== null) {
    await enfocarEscritorio(plan.idFocoDestino)
  }
}

async function leerEscritorios(): Promise<EscritorioHyprctl[]> {
  const datos: unknown = JSON.parse(await execAsync(["hyprctl", "workspaces", "-j"]))
  if (!Array.isArray(datos)) throw new Error("hyprctl workspaces no devolvió una lista")
  return datos as EscritorioHyprctl[]
}

/** Un fallo de `change_id` NO se ve en el código de salida: responde
 *  `warning: … no such workspace` / `ID is taken` con rc 0 (medido). Solo `ok`
 *  es éxito. */
async function cambiarId({ desde, hasta }: CambioId): Promise<boolean> {
  try {
    const salida = await execAsync([
      "hyprctl",
      "dispatch",
      `hl.dsp.workspace.change_id({workspace=${desde}, id=${hasta}})`,
    ])
    if (salida.trim() === "ok") return true
    console.error(`change_id ${desde}→${hasta} rechazado: ${salida.trim()}`)
  } catch (error) {
    console.error(`change_id ${desde}→${hasta} falló`, error)
  }
  return false
}

/** AstalHyprland no conoce el evento `changeworkspaceid`, así que tras renumerar
 *  sigue creyendo que cada ventana está en su id viejo y con el nombre viejo, y
 *  que cada monitor enseña el escritorio de antes. `sync_workspaces` +
 *  `sync_clients` + `sync_monitors` lo corrigen (medido). Quedan desfasados la
 *  lista `workspace.get_clients()`, que en el shell nadie lee (todo pasa por
 *  `client.workspace`), y `focused_workspace`: por eso existe
 *  `idEscritorioEnfocado()`. */
function resincronizarAstal(metodo: "sync_workspaces" | "sync_clients" | "sync_monitors"): Promise<void> {
  const hyprland = obtenerHyprland() as unknown as Record<string, (...args: unknown[]) => void>
  return new Promise((resolve) => {
    try {
      hyprland[metodo]((_origen: unknown, resultado: unknown) => {
        try { hyprland[`${metodo}_finish`](resultado) } catch (error) {
          console.error(`${metodo} falló`, error)
        }
        resolve()
      })
    } catch (error) {
      console.error(`${metodo} falló`, error)
      resolve()
    }
  })
}

/** Ejecuta la cadena de `change_id`. Devuelve `false` solo si NO se tocó nada
 *  (o se deshizo limpio) y por tanto se puede caer al plan de mover ventanas;
 *  con el estado a medias no se cae, porque el plan de mover se calcularía sobre
 *  ids que ya no son los que la barra pidió. */
async function ejecutarPlanCambioIds(plan: PlanCambioIds): Promise<boolean> {
  if (plan.cambios.length === 0) return true
  const hechos: CambioId[] = []
  for (const cambio of plan.cambios) {
    if (await cambiarId(cambio)) {
      hechos.push(cambio)
      continue
    }
    if (hechos.length === 0) return false
    let deshecho = true
    for (const inverso of invertirCambios(hechos)) {
      if (!(await cambiarId(inverso))) deshecho = false
    }
    // Deshecho entero, Hyprland está como al empezar y Astal no se enteró de
    // nada: no hay que resincronizar.
    if (deshecho) return false
    console.error("Escritorios a medio renumerar: no se pudo deshacer el cambio de ids")
    break
  }

  await resincronizarAstal("sync_workspaces")
  await resincronizarAstal("sync_clients")
  await resincronizarAstal("sync_monitors")
  return true
}

function encolarOperacion(operacion: () => Promise<void>): Promise<void> {
  const encolada = colaOperaciones.then(operacion, operacion)
  colaOperaciones = encolada.catch(() => {})
  return encolada
}

/** Primero intenta renumerar (conserva la disposición de cada escritorio); si
 *  no aplica o Hyprland lo rechaza, mueve las ventanas como siempre. */
async function conOperacionEscritorios(
  crearPlanIds: (escritorios: EscritorioHyprctl[]) => PlanCambioIds | null,
  crearPlan: (clientes: ClienteHyprctl[]) => PlanMovimientoEscritorios,
) {
  return encolarOperacion(async () => {
    iniciarOperacionEscritorios()
    try {
      const planIds = crearPlanIds(await leerEscritorios())
      if (planIds !== null && await ejecutarPlanCambioIds(planIds)) return
      const clientes = await leerClientes()
      await ejecutarPlan(crearPlan(clientes))
    } catch (error) {
      console.error("No se pudieron reordenar los escritorios", error)
    } finally {
      // Astal destruye y recrea workspaces vaciados durante el movimiento (el
      // plan de mover; al renumerar ya se ha resincronizado arriba).
      await new Promise<void>((resolve) => setTimeout(resolve, 120))
      terminarOperacionEscritorios()
    }
  })
}

export function intercambiarEscritorios(primerId: number, segundoId: number, idEnfocado: number): Promise<void> {
  return conOperacionEscritorios(
    (escritorios) => crearPlanCambioIdsIntercambio(escritorios, primerId, segundoId),
    (clientes) => crearPlanIntercambio(clientes, primerId, segundoId, idEnfocado),
  )
}

export function desplazarEscritorios(
  idOrigen: number,
  idDestino: number,
  idsOrdenados: readonly number[],
  idEnfocado: number,
): Promise<void> {
  return conOperacionEscritorios(
    (escritorios) => crearPlanCambioIdsDesplazamiento(escritorios, idOrigen, idDestino, idsOrdenados),
    (clientes) => crearPlanDesplazamiento(clientes, idOrigen, idDestino, idsOrdenados, idEnfocado),
  )
}
