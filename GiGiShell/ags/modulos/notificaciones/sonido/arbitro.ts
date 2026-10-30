// Evita sonidos solapados. Módulo puro: el temporizador se inyecta.
//
// Lo que llega casi a la vez se reduce al de mayor prioridad, y entre dos sonidos pasan al menos
// 2 s. Un sonido no se pierde por la espera, salvo que llegue otro igual o más importante.

const VENTANA_MS = 250
const SEPARACION_MS = 2000

export interface SonidoPendiente {
  prioridad: number
  reproducir: () => void
}

export class ArbitroSonido {
  private pendiente: SonidoPendiente | null = null
  private ultimo = Number.NEGATIVE_INFINITY

  private readonly programar: (ms: number, ejecutar: () => void) => void
  private readonly reloj: () => number

  constructor(programar: (ms: number, ejecutar: () => void) => void, reloj: () => number = Date.now) {
    this.programar = programar
    this.reloj = reloj
  }

  ofrecer(sonido: SonidoPendiente, ahora: number): void {
    if (this.pendiente) {
      if (sonido.prioridad > this.pendiente.prioridad) this.pendiente = sonido
      return
    }
    this.pendiente = sonido
    this.programar(Math.max(VENTANA_MS, this.ultimo + SEPARACION_MS - ahora), () => {
      const elegido = this.pendiente
      this.pendiente = null
      this.ultimo = this.reloj()
      elegido?.reproducir()
    })
  }
}
