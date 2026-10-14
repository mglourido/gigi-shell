/** Paleta suave de violeta, azul y turquesa, independiente del fondo y la carátula.
 * Los pasos intermedios cierran el ciclo sin saltos entre colores opuestos.
 * Se comparte entre monitores y evita calcular colores en cada frame. */
export const COLORES_ONDA_RGB: readonly (readonly [number, number, number])[] = [
  [0.72, 0.63, 0.85],
  [0.68, 0.645, 0.845],
  [0.64, 0.66, 0.84],
  [0.60, 0.675, 0.835],
  [0.56, 0.69, 0.83],
  [0.5525, 0.71, 0.805],
  [0.545, 0.73, 0.78],
  [0.5375, 0.75, 0.755],
  [0.53, 0.77, 0.73],
  [0.5775, 0.735, 0.76],
  [0.625, 0.70, 0.79],
  [0.6725, 0.665, 0.82],
]

export type EstadoColorBanda = { color: number, bajando: boolean }

/** Solo avanza al salir de un valle; una meseta conserva el sentido anterior.
 * El llamante compara las alturas visibles y solo actualiza durante reproducción RGB. */
export function actualizarColorBanda(banda: EstadoColorBanda, anterior: number, siguiente: number): void {
  if (siguiente < anterior) banda.bajando = true
  else if (siguiente > anterior) {
    if (banda.bajando) banda.color = (banda.color + 1) % COLORES_ONDA_RGB.length
    banda.bajando = false
  }
}
