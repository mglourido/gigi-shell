import { createState } from "ags"

export interface EstadoBooleanoReactivo {
  (): boolean
  get(): boolean
  subscribe(callback: () => void): () => void
}

/** Estado local de una barra concreta; nunca debe compartirse entre monitores. */
export interface EstadoVisibilidadBarra {
  visible: EstadoBooleanoReactivo
  refrescar: EstadoBooleanoReactivo
  menuAbierto: EstadoBooleanoReactivo
}

export interface ControlVisibilidadBarra extends EstadoVisibilidadBarra {
  fijarVisible: (visible: boolean) => void
  fijarRefrescar: (refrescar: boolean) => void
  retenerPorMenu: () => () => void
}

const controlesPorMonitor = new WeakMap<object, ControlVisibilidadBarra>()

/** Devuelve el estado exclusivo de una salida; nunca se comparte entre monitores. */
export function obtenerControlVisibilidadBarra(monitor: object): ControlVisibilidadBarra {
  const existente = controlesPorMonitor.get(monitor)
  if (existente) return existente

  const [visible, fijarVisible] = createState(true)
  const [refrescar, fijarRefrescar] = createState(true)
  const [menuAbierto, fijarMenuAbierto] = createState(false)
  let menusAbiertos = 0
  const retenerPorMenu = () => {
    menusAbiertos++
    if (menusAbiertos === 1) fijarMenuAbierto(true)
    let retenido = true
    return () => {
      if (!retenido) return
      retenido = false
      menusAbiertos = Math.max(0, menusAbiertos - 1)
      if (menusAbiertos === 0) fijarMenuAbierto(false)
    }
  }
  const control = {
    visible,
    refrescar,
    menuAbierto,
    fijarVisible,
    fijarRefrescar,
    retenerPorMenu,
  }
  controlesPorMonitor.set(monitor, control)
  return control
}
