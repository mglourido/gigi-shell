/** Precisión del transporte ASCII: conserva bandas pequeñas incluso al 1 % de volumen. */
export const ESCALA_ESPECTRO = 2_000_000_000

const SUELO = 0.00001
const TECHO = 0.9
const CAIDA_REFERENCIA = 2.5

/** Normaliza 13 bandas, nunca muestras PCM ni la FFT, fuera del reloj de dibujo. */
export class NormalizadorEspectro {
  private referencia = 0
  private ultimoTiempo = 0

  reiniciar(): void {
    this.referencia = 0
    this.ultimoTiempo = 0
  }

  normalizar(bandas: number[], ganancia: number, tiempo: number): number[] {
    let pico = 0
    for (let i = 0; i < bandas.length; i++) {
      const valor = ganancia > 0 && Number.isFinite(ganancia) ? bandas[i] / ganancia : 0
      bandas[i] = Number.isFinite(valor) ? Math.max(0, valor) : 0
      if (bandas[i] > pico) pico = bandas[i]
    }
    const delta = this.ultimoTiempo ? Math.max(0, tiempo - this.ultimoTiempo) : 0
    this.ultimoTiempo = tiempo
    // El pico sube inmediatamente y cae despacio: conserva los golpes y pausas de la
    // canción. La referencia recibe señal sin el volumen del usuario, por lo que mover
    // ese control no obliga a recuperar la sensibilidad durante varios segundos.
    this.referencia = Math.max(SUELO, pico, this.referencia * Math.exp(-delta / CAIDA_REFERENCIA))
    const factor = pico >= SUELO ? TECHO / this.referencia : 0
    for (let i = 0; i < bandas.length; i++) bandas[i] = Math.min(TECHO, bandas[i] * factor)
    return bandas
  }
}
