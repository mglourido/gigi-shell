export interface ElementoNavegacionBusqueda {
  marcarSeleccionado: (seleccionado: boolean) => void
  activar: () => void
  previsualizar?: () => void
  enfocar?: () => void
}

type ZonaNavegacion = "resultados" | "submenu"
export type DireccionCuadricula = "arriba" | "abajo" | "izquierda" | "derecha"

/**
 * Fuente única de verdad para navegar resultados y submenús de Orion.
 *
 * El foco de GTK permanece libre para la entrada de texto y la accesibilidad;
 * la selección visible y la activación dependen exclusivamente de este modelo.
 */
export class NavegacionBusqueda {
  private resultados: ElementoNavegacionBusqueda[] = []
  private acciones: ElementoNavegacionBusqueda[] = []
  private indiceResultado = -1
  private indiceAccion = -1
  private columnasResultados = 1
  private zona: ZonaNavegacion = "resultados"

  establecerResultados(
    resultados: ElementoNavegacionBusqueda[],
    seleccionarPrimero = true,
    columnas = 1,
  ): void {
    this.desmarcarTodos()
    this.resultados = resultados
    this.indiceResultado = seleccionarPrimero && resultados.length > 0 ? 0 : -1
    this.columnasResultados = Math.max(1, Math.trunc(columnas))
    this.zona = "resultados"
    this.marcarResultadoActual()
  }

  establecerAcciones(acciones: ElementoNavegacionBusqueda[]): void {
    for (const accion of this.acciones) accion.marcarSeleccionado(false)
    this.acciones = acciones
    this.indiceAccion = acciones.length > 0 ? 0 : -1

    if (this.zona !== "submenu") return
    if (acciones.length === 0) {
      this.zona = "resultados"
      this.marcarResultadoActual()
      return
    }
    this.marcarAccionActual()
  }

  seleccionarResultado(
    resultado: ElementoNavegacionBusqueda,
    previsualizar = true,
  ): boolean {
    const indice = this.resultados.indexOf(resultado)
    if (indice < 0) return false
    this.seleccionarIndiceResultado(indice, previsualizar)
    return true
  }

  seleccionarAccion(accion: ElementoNavegacionBusqueda): boolean {
    const indice = this.acciones.indexOf(accion)
    if (indice < 0) return false

    this.desmarcarResultadoActual()
    this.desmarcarAccionActual()
    this.zona = "submenu"
    this.indiceAccion = indice
    this.marcarAccionActual()
    return true
  }

  moverResultados(direccion: 1 | -1, previsualizar = true): boolean {
    if (this.resultados.length === 0) return false
    if (this.indiceResultado < 0) {
      this.seleccionarIndiceResultado(0, previsualizar)
      this.enfocarResultadoActual()
      return true
    }
    const base = Math.max(0, this.indiceResultado)
    const siguiente = (base + direccion + this.resultados.length) % this.resultados.length
    this.seleccionarIndiceResultado(siguiente, previsualizar)
    this.enfocarResultadoActual()
    return true
  }

  moverEnCuadricula(direccion: DireccionCuadricula, previsualizar = true): boolean {
    if (this.resultados.length === 0) return false
    if (this.indiceResultado < 0) {
      this.seleccionarIndiceResultado(0, previsualizar)
      this.enfocarResultadoActual()
      return true
    }

    const columnas = this.columnasResultados
    const indice = this.indiceResultado
    const columna = indice % columnas
    let siguiente = indice
    if (direccion === "izquierda" && columna > 0) siguiente = indice - 1
    if (direccion === "derecha" && columna < columnas - 1 && indice + 1 < this.resultados.length) siguiente = indice + 1
    if (direccion === "arriba" && indice - columnas >= 0) siguiente = indice - columnas
    if (direccion === "abajo" && indice + columnas < this.resultados.length) siguiente = indice + columnas

    if (siguiente !== indice) this.seleccionarIndiceResultado(siguiente, previsualizar)
    this.enfocarResultadoActual()
    return true
  }

  moverVertical(direccion: 1 | -1): boolean {
    if (this.zona === "resultados") return this.moverResultados(direccion)
    if (this.acciones.length === 0) return false

    this.desmarcarAccionActual()
    const base = Math.max(0, this.indiceAccion)
    this.indiceAccion = (base + direccion + this.acciones.length) % this.acciones.length
    this.marcarAccionActual()
    this.enfocarAccionActual()
    return true
  }

  entrarSubmenu(): boolean {
    if (this.indiceResultado < 0 || this.acciones.length === 0) return false
    this.desmarcarResultadoActual()
    this.desmarcarAccionActual()
    this.zona = "submenu"
    this.indiceAccion = 0
    this.marcarAccionActual()
    this.enfocarAccionActual()
    return true
  }

  salirSubmenu(): boolean {
    if (this.zona !== "submenu") return false
    this.desmarcarAccionActual()
    this.zona = "resultados"
    this.marcarResultadoActual()
    this.enfocarResultadoActual()
    return true
  }

  estaEnSubmenu(): boolean {
    return this.zona === "submenu"
  }

  activarResultadoYEntrarSubmenu(): boolean {
    if (this.zona !== "resultados") return false
    const resultado = this.resultados[this.indiceResultado]
    if (!resultado) return false
    resultado.activar()
    return this.entrarSubmenu()
  }

  activarSeleccionado(): boolean {
    const elemento = this.zona === "submenu"
      ? this.acciones[this.indiceAccion]
      : this.resultados[this.indiceResultado]
    if (!elemento) return false
    elemento.activar()
    return true
  }

  private seleccionarIndiceResultado(indice: number, previsualizar: boolean): void {
    const cambio = this.zona !== "resultados" || indice !== this.indiceResultado
    this.desmarcarAccionActual()
    this.desmarcarResultadoActual()
    this.zona = "resultados"
    this.indiceResultado = indice
    const resultado = this.resultados[indice]
    resultado?.marcarSeleccionado(true)
    if (cambio && previsualizar) resultado?.previsualizar?.()
  }

  private marcarResultadoActual(): void {
    this.resultados[this.indiceResultado]?.marcarSeleccionado(true)
  }

  private desmarcarResultadoActual(): void {
    this.resultados[this.indiceResultado]?.marcarSeleccionado(false)
  }

  private marcarAccionActual(): void {
    this.acciones[this.indiceAccion]?.marcarSeleccionado(true)
  }

  private desmarcarAccionActual(): void {
    this.acciones[this.indiceAccion]?.marcarSeleccionado(false)
  }

  private enfocarResultadoActual(): void {
    this.resultados[this.indiceResultado]?.enfocar?.()
  }

  private enfocarAccionActual(): void {
    this.acciones[this.indiceAccion]?.enfocar?.()
  }

  private desmarcarTodos(): void {
    for (const resultado of this.resultados) resultado.marcarSeleccionado(false)
    for (const accion of this.acciones) accion.marcarSeleccionado(false)
  }
}
