/** Coincidencia de una ventana contra una lista de clases escrita por el usuario.
 *
 * Dos funciones de Ajustes dejan al usuario apuntar apps por su clase de ventana —el
 * No molestar automático (`modulos/notificaciones/autoDnd/detect.ts`) y la pausa manual
 * de la luz nocturna (`servicios/pantalla/service.ts`)— y las dos necesitan exactamente
 * la misma comparación. Vive aquí, en `servicios/ventanas/`, y no dentro de una de las
 * dos, porque un servicio no debe importar de `modulos/notificaciones/`.
 *
 * Tres detalles que no son cosméticos:
 *
 *  - Se compara contra `class` **y** `initialClass`. Una app que renombra su ventana al
 *    abrir (los juegos de wine lo hacen constantemente) dejaría de casar a mitad de
 *    sesión si solo se mirase la actual, y al revés: apuntarla desde "ventana actual"
 *    guarda la que se ve ahora, que puede no ser la inicial.
 *  - Es por **subcadena**, no por igualdad: el usuario escribe "steam" a mano y espera
 *    que cubra `steam_app_252950`. Al contrario que las listas de `servicios/juegos/
 *    deteccion.ts`, que casan por nombre justamente para que `"st"` (el terminal) no
 *    entre dentro de `"counter-strike"` — allí las escribe el sistema y son cortas;
 *    aquí las escribe el usuario y las mira.
 *  - Una entrada vacía **no casa con todo**. Es el modo de fallo peligroso de un
 *    `includes()`: una cadena en blanco colada en el JSON (o un espacio suelto) haría
 *    que cualquier ventana coincidiera y la función se quedaría enganchada para siempre.
 */

export interface ClienteClaseLike {
  class?: string | null
  initialClass?: string | null
  initial_class?: string | null
}

/** ¿La clase (actual o inicial) de `cliente` contiene alguna entrada de `clases`? */
export function claseCoincide(
  cliente: ClienteClaseLike | null | undefined,
  clases: readonly string[] | null | undefined,
): boolean {
  if (!cliente || !clases || clases.length === 0) return false

  const actual = (cliente.class ?? "").toLowerCase()
  const inicial = (cliente.initialClass ?? cliente.initial_class ?? "").toLowerCase()
  if (!actual && !inicial) return false

  return clases.some((entrada) => {
    const aguja = String(entrada ?? "").trim().toLowerCase()
    return aguja.length > 0 && (actual.includes(aguja) || inicial.includes(aguja))
  })
}

/** ¿Hay ALGUNA ventana abierta cuya clase case con la lista? */
export function algunaVentanaCoincide(
  clientes: readonly (ClienteClaseLike | null | undefined)[] | null | undefined,
  clases: readonly string[] | null | undefined,
): boolean {
  if (!clientes) return false
  return clientes.some((c) => claseCoincide(c, clases))
}
