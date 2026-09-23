// servicios/fondos/acentoCss.ts
//
// La parte del acento adaptativo que no toca ni GTK ni el disco: validar la paleta
// que devuelve `ags/scripts/acento-fondo.py` y convertirla en la hoja de estilo que
// redefine las variables de acento. Vive aparte de `acento.ts` para que Node pueda
// probarla, que es exactamente la parte con reglas (la otra mitad es un CssProvider
// y una suscripción, y esas no tienen nada que decidir).

/** El selector es `:root` porque las variables CSS SE HEREDAN: definidas en la
 * raíz, las ven todas las ventanas del shell sin tener que enumerar ninguna. */
const SELECTOR = ":root"

/** Cuántos acentos trae la paleta. Es el contrato con el extractor. */
export const ACENTOS = 3

/**
 * Qué variable CSS recibe cada acento de la paleta, por índice.
 *
 * Los tres terciarios (`--acento-3*`) reciben TODOS el mismo color: son el mismo
 * papel del tema —los cianes de los iconos y de los controles activos— en tres
 * tonos distintos, y tienen variable propia solo para conservar cada uno su
 * reserva exacta en `_colores.scss`, o sea para que apagar el ajuste devuelva el
 * aspecto de antes clavado. Ver el bloque "Acentos" de `estilos/_colores.scss`.
 */
const VARIABLES: readonly (readonly string[])[] = [
  ["--acento"],
  ["--acento-2"],
  ["--acento-3", "--acento-3b", "--acento-3c"],
]

/**
 * Normaliza un color del extractor a `#rrggbb` en minúsculas, o `null`.
 *
 * Es una FRONTERA DE CONFIANZA, no una comodidad: lo que devuelva acaba
 * concatenado dentro de una hoja de estilo, así que un valor con `;` o `}` podría
 * inyectar reglas arbitrarias. Por eso se acepta solo la forma exacta de un hex
 * de seis dígitos y se rechaza todo lo demás, incluidos los `#rgb` de tres y los
 * nombres de color, que serían válidos en CSS pero no son lo que el script emite.
 */
export function normalizarHexAcento(valor: unknown): string | null {
  if (typeof valor !== "string") return null
  const limpio = valor.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(limpio) ? limpio : null
}

/**
 * La hoja que define la paleta, o la hoja VACÍA si no hay paleta que aplicar.
 *
 * Que "apagado" sea una cadena vacía y no la ausencia de hoja es lo que hace que
 * quitar el acento sea gratis y sin parpadeo: el provider siempre está puesto y
 * solo se le cambia el contenido, así que al vaciarlo cada `var(--acento…, …)` de
 * `out.css` cae en su valor de reserva —los colores de siempre— sin que nadie
 * tenga que saber cuáles son ni recargar nada.
 *
 * Es TODO O NADA: una paleta incompleta o con un color inválido no se aplica a
 * medias, porque media paleta es justo el desparejado (dos acentos del fondo y uno
 * del tema viejo) que tener tres acentos viene a evitar.
 */
export function hojaDePaleta(paleta: readonly string[] | null): string {
  if (paleta === null || paleta.length !== ACENTOS) return ""
  const colores = paleta.map(normalizarHexAcento)
  if (colores.some((c) => c === null)) return ""

  const declaraciones = VARIABLES
    .flatMap((nombres, i) => nombres.map((nombre) => `${nombre}: ${colores[i]};`))
    .join(" ")
  return `${SELECTOR} { ${declaraciones} }\n`
}

/**
 * Lee la línea JSON del extractor y saca la paleta. Cualquier ruido (línea vacía,
 * JSON roto, campo ausente o con basura) vale `null`: el fondo del escritorio no
 * puede dejar al shell sin colores, así que el fallo es "no hay paleta" y el tema
 * se queda con la suya.
 */
export function paletaDeSalida(salida: string): string[] | null {
  let acentos: unknown
  try {
    acentos = JSON.parse(salida.trim())?.acentos
  } catch (_) {
    return null
  }
  if (!Array.isArray(acentos) || acentos.length !== ACENTOS) return null
  const colores = acentos.map(normalizarHexAcento)
  return colores.every((c): c is string => c !== null) ? colores : null
}
