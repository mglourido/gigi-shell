const FRAGMENTOS_APPS_MENSAJERIA = [
  "whatsapp",
  "telegram",
  "signal",
  "discord",
  "slack",
  "messages",
  "chat",
  "sms",
  "matrix",
]

/** Detecta las apps para las que se ofrece la respuesta inline. */
export function esAppMensajeria(nombreApp: string): boolean {
  const nombreNormalizado = nombreApp.toLowerCase()
  return FRAGMENTOS_APPS_MENSAJERIA.some((fragmento) =>
    nombreNormalizado.includes(fragmento))
}

/** Aproximación conservadora al límite visual de dos líneas del cuerpo. */
export function necesitaExpansionCuerpo(texto: string): boolean {
  return texto.length > 90 || texto.split("\n").length > 2
}

export function fondoOpacoDesdeHex(hex: string, opacidad: number): string {
  const valorHex = hex.replace("#", "")
  const colorValido = valorHex.length === 6 && /^[0-9a-f]+$/i.test(valorHex)
  const rojo = colorValido ? parseInt(valorHex.substring(0, 2), 16) : 255
  const verde = colorValido ? parseInt(valorHex.substring(2, 4), 16) : 255
  const azul = colorValido ? parseInt(valorHex.substring(4, 6), 16) : 255
  const alfa = Math.max(0, Math.min(1, opacidad))

  // El panel sólido anterior era rgb(8, 8, 12). Precomponer aquí el tinte
  // conserva el color visual de las no leídas sin dejar pasar el blur.
  const salidaRojo = 8 + (rojo - 8) * alfa
  const salidaVerde = 8 + (verde - 8) * alfa
  const salidaAzul = 12 + (azul - 12) * alfa
  return `rgb(${salidaRojo}, ${salidaVerde}, ${salidaAzul})`
}
