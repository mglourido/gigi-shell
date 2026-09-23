// Conversión del marcado que admite la especificación freedesktop (<b>, <i>, <u>,
// <a>, <img>) al subconjunto que entiende Pango. No basta con pasar el cuerpo tal
// cual a un label con `useMarkup`: si el marcado no está balanceado, si trae una
// etiqueta que Pango no conoce (<img>) o si lleva un `&` suelto, `set_markup` falla
// entero y la notificación se queda **sin texto**, sin más rastro que un warning en
// el log. Por eso se reescribe siempre: se escapa el texto, se dejan pasar solo las
// etiquetas conocidas y se cierran al final las que la app dejó abiertas.

/** Etiquetas de Pango que se dejan pasar; el resto se descarta. */
const ETIQUETAS_PERMITIDAS = new Set(["b", "i", "u", "s", "tt", "big", "small"])

/**
 * Etiquetas que se traducen a otra de Pango. `<a href>` se degrada a subrayado en
 * lugar de mantenerse como enlace: un enlace vivo dentro del popup o de la tarjeta
 * se comería el clic que ya usan el botón y los gestos.
 */
const ETIQUETAS_TRADUCIDAS: Record<string, string> = { a: "u" }

const ENTIDAD_VALIDA = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y

/** Escapa texto plano para usarlo como marcado, respetando las entidades ya válidas. */
export function escaparPango(texto: string): string {
  let salida = ""
  for (let i = 0; i < texto.length; i++) {
    const caracter = texto[i]
    if (caracter === "&") {
      ENTIDAD_VALIDA.lastIndex = i
      if (ENTIDAD_VALIDA.test(texto)) {
        salida += texto.slice(i, ENTIDAD_VALIDA.lastIndex)
        i = ENTIDAD_VALIDA.lastIndex - 1
        continue
      }
      salida += "&amp;"
    } else if (caracter === "<") salida += "&lt;"
    else if (caracter === ">") salida += "&gt;"
    else salida += caracter
  }
  return salida
}

const ETIQUETA = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g

/**
 * Devuelve el cuerpo como marcado de Pango válido y balanceado. Las etiquetas
 * desconocidas (incluida `<img>`, que Pango no sabe pintar) desaparecen sin llevarse
 * por delante el texto que envuelven.
 */
export function aMarcadoPango(texto: string): string {
  let salida = ""
  let posicion = 0
  const abiertas: string[] = []

  for (const coincidencia of texto.matchAll(ETIQUETA)) {
    const indice = coincidencia.index!
    salida += escaparPango(texto.slice(posicion, indice))
    posicion = indice + coincidencia[0].length

    const esCierre = coincidencia[1] === "/"
    const nombre = coincidencia[2].toLowerCase()

    if (nombre === "br") {
      if (!esCierre) salida += "\n"
      continue
    }

    const etiqueta = ETIQUETAS_TRADUCIDAS[nombre] ?? nombre
    if (!ETIQUETAS_PERMITIDAS.has(etiqueta)) continue

    if (!esCierre) {
      abiertas.push(etiqueta)
      salida += `<${etiqueta}>`
      continue
    }

    // Un cierre sin apertura se descarta. Si cierra algo que quedó por debajo de
    // otras aperturas, se cierran también esas: Pango no admite solapamientos.
    const profundidad = abiertas.lastIndexOf(etiqueta)
    if (profundidad < 0) continue
    while (abiertas.length > profundidad) salida += `</${abiertas.pop()}>`
  }

  salida += escaparPango(texto.slice(posicion))
  while (abiertas.length) salida += `</${abiertas.pop()}>`
  return salida
}

/**
 * Texto plano equivalente: quita el marcado y resuelve las entidades. Se usa donde
 * no cabe estilo (tooltips, medida de líneas para decidir si la tarjeta expande).
 */
export function limpiarMarcado(texto: string): string {
  return texto
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
