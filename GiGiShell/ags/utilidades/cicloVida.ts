import { onCleanup } from "ags"

type Limpieza = () => void

interface EmisorSenales {
  connect(senal: string, callback: (...argumentos: any[]) => void): number
  disconnect(id: number): void
}

interface Suscribible<T> {
  get(): T
  subscribe(callback: () => void): unknown
}

/**
 * Grupo de recursos cuyo registro puede ocurrir también desde callbacks tardíos.
 * A diferencia de llamar `onCleanup` al reenganchar un dispositivo, el scope se
 * captura una sola vez durante el montaje del componente.
 */
export function crearCicloVida() {
  const limpiezas = new Set<Limpieza>()
  let activo = true

  onCleanup(() => {
    activo = false
    for (const limpiar of [...limpiezas]) limpiar()
    limpiezas.clear()
  })

  const registrar = (limpiar: Limpieza): Limpieza => {
    let pendiente = true
    const limpiarUnaVez = () => {
      if (!pendiente) return
      pendiente = false
      limpiezas.delete(limpiarUnaVez)
      limpiar()
    }
    if (activo) limpiezas.add(limpiarUnaVez)
    else limpiarUnaVez()
    return limpiarUnaVez
  }

  return {
    registrar,
    conectarSenales: (
      emisor: EmisorSenales,
      senales: readonly string[],
      callback: (...argumentos: any[]) => void,
    ) => {
      const ids: number[] = []
      // Algunos backends no exponen todas las señales en todas sus versiones.
      // Una señal ausente no debe impedir registrar ni limpiar las compatibles.
      for (const senal of senales) {
        try { ids.push(emisor.connect(senal, callback)) } catch (_) {}
      }
      return registrar(() => {
        for (const id of ids) {
          try { emisor.disconnect(id) } catch (_) {}
        }
      })
    },
    suscribir: <T>(suscribible: Suscribible<T>, callback: (valor: T) => void) => {
      const desconectar = suscribible.subscribe(() => callback(suscribible.get()))
      return registrar(() => {
        if (typeof desconectar === "function") desconectar()
      })
    },
  }
}
