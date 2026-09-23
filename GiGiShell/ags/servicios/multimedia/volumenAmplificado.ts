/** La escala 0-200 % de los deslizadores de audio: tope, paso e imán del 100 %.
 *
 * Puro y sin GI: se prueba con `node --test`.
 *
 * ── Por qué 200 % y no el 153 % de pavucontrol ──────────────────────────────
 *
 * El 153 % que enseña el control de volumen de PulseAudio no es un número
 * redondo elegido a ojo: `PA_VOLUME_UI_MAX` está definido como
 * `pa_sw_volume_from_dB(+11.0)`, o sea "hasta +11 dB de ganancia por software",
 * y +11 dB en la escala lineal que pinta la UI cae en ~153 %. AstalWp hace algo
 * parecido pero por lo bruto: `astal_wp_node_set_volume` **recorta a 1.5**. Aquí
 * el tope es un 200 % declarado en un sitio, porque el límite real de PipeWire
 * no está ahí — acepta 1.7 o 2.0 sin rechistar (medido con
 * `wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 1.7` → `Volume: 1.70`).
 *
 * ⚠️ Pasar de 100 % es **amplificación por software**: multiplica también el
 * ruido de fondo y satura si la fuente ya venía alta. Por eso el tope solo
 * existe en Quick Settings, donde se pone a mano; las teclas de volumen de
 * Hyprland siguen llamando a `wpctl set-volume -l 1`, o sea con techo en el
 * 100 % (`hypr/gigios/keybinds.lua`).
 *
 * ── El imán del 100 % ───────────────────────────────────────────────────────
 *
 * Con el recorrido del deslizador repartido entre 0 y 200 %, el 100 % deja de
 * ser el extremo derecho —donde caía solo con arrastrar hasta el tope— y pasa a
 * ser un punto cualquiera en mitad de la barra: en los ~160 px de la tarjeta,
 * un 1 % son 0.8 px, así que "dejarlo en 100" a pulso es cuestión de suerte.
 * `ajustarVolumen` redondea al 1 % (nada de 47.3 %) e **imanta SOLO el entorno
 * del 100 %**: dentro de ±`TOLERANCIA_IMAN` puntos cae exacto en 1.00, y fuera
 * de esa franja el valor pasa tal cual. No es una cuadrícula: 137 % sigue siendo
 * 137 %.
 */

/** Tope de los deslizadores de volumen, en fracción (2 = 200 %). */
export const VOLUMEN_MAX = 2

/** Paso del deslizador: 1 %. También es la rejilla de redondeo. */
export const PASO_VOLUMEN = 0.01

/** Radio del imán alrededor del 100 %, en PUNTOS porcentuales (±3).
 *
 * En puntos y no en fracción a propósito: la comparación se hace sobre el valor
 * ya redondeado a enteros, así que `|97 - 100| <= 3` es exacto. En coma
 * flotante, `Math.abs(0.97 - 1) <= 0.03` sale **falso** (0.030000000000000027),
 * o sea que el borde del imán no imantaba. */
export const TOLERANCIA_IMAN = 3

/** Punto imantado. Uno solo a propósito: el 100 % es el único valor que se
 * quiere clavar sin mirar; imantar además 50 % o 150 % convertiría el
 * deslizador en una rejilla y estorbaría al ajuste fino. */
export const IMAN_VOLUMEN = 1

/** Valor crudo del deslizador → valor que se escribe: acotado, redondeado al
 * 1 % e imantado al 100 % si cae cerca. */
export function ajustarVolumen(valor: number, max: number = VOLUMEN_MAX): number {
  if (!Number.isFinite(valor)) return 0
  const acotado = Math.max(0, Math.min(max, valor))
  const puntos = Math.round(acotado / PASO_VOLUMEN)
  const puntosIman = Math.round(IMAN_VOLUMEN / PASO_VOLUMEN)
  // El imán no existe en un deslizador que ni siquiera llega al 100 %.
  if (puntosIman <= Math.round(max / PASO_VOLUMEN) && Math.abs(puntos - puntosIman) <= TOLERANCIA_IMAN) {
    return IMAN_VOLUMEN
  }
  return puntos * PASO_VOLUMEN
}

/** ¿Este valor está amplificando por software (por encima del 100 %)? */
export function estaAmplificado(valor: number): boolean {
  return Number.isFinite(valor) && valor > 1
}
