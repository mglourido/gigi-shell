import { createComputed, createState, type Accessor } from "ags"

/** Solo se construyen las filas de la página visible. El índice se acota también
 * cuando la fuente pierde elementos por una búsqueda, borrado o actualización. */
export default function usarPaginacion<T>(elementos: Accessor<T[]>, porPagina = 25) {
  const [solicitada, establecerSolicitada] = createState(0)
  const paginas = createComputed(() => Math.max(1, Math.ceil(elementos().length / porPagina)))
  const pagina = createComputed(() => Math.max(0, Math.min(solicitada(), paginas() - 1)))
  const visibles = createComputed(() => elementos().slice(pagina() * porPagina, (pagina() + 1) * porPagina))
  const irAPagina = (numero: number) => establecerSolicitada(Math.max(0, Math.min(numero, paginas.get() - 1)))
  return { pagina, paginas, visibles, irAPagina }
}
