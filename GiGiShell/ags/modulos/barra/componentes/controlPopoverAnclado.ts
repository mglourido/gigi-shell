import { onCleanup } from "ags"

import type { ControlVisibilidadBarra } from "../../../estado/visibilidadBarra"

/**
 * Empareja la retención local de una barra con el ciclo de vida de un popover.
 * `abrir` y `cerrar` son idempotentes porque GTK puede comunicar el mismo cierre
 * por `notify::active`, `closed` y por el desmontaje de la rama reactiva. */
export function crearControlPopoverAnclado(
  visibilidad: ControlVisibilidadBarra,
  alCambiar?: (abierto: boolean) => void,
) {
  let abierto = false
  let liberarRetencion: (() => void) | null = null

  const establecer = (siguiente: boolean) => {
    if (siguiente === abierto) return
    abierto = siguiente
    if (siguiente) liberarRetencion = visibilidad.retenerPorMenu()
    else {
      liberarRetencion?.()
      liberarRetencion = null
    }
    alCambiar?.(siguiente)
  }

  const eliminar = () => establecer(false)
  onCleanup(eliminar)

  return {
    abrir: () => establecer(true),
    cerrar: () => establecer(false),
    establecer,
    estaAbierto: () => abierto,
    eliminar,
  }
}
