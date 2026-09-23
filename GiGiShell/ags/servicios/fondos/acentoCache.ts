// servicios/fondos/acentoCache.ts
//
// La caché en disco del acento adaptativo: qué paleta salió de cada fondo, para no
// volver a extraerla nunca de la misma imagen.
//
// POR QUÉ EXISTE. Sacar la paleta cuesta un `python3` con Pillow por cambio de
// fondo: ~150 ms de media y hasta 480 ms con los PNG de 16000 px de la carpeta
// (medido sobre los 64 fondos reales). Ese coste no molesta una vez, pero el fondo
// no cambia una vez: con franjas horarias o con un grupo puesto se cambia varias
// veces al día, SIEMPRE ENTRE LAS MISMAS IMÁGENES, y además se vuelve a pagar en
// cada inicio de sesión por el fondo que ya estaba puesto. Todo eso es recalcular
// un resultado que no puede haber cambiado.
//
// LA CLAVE ES UN SELLO, NO LA RUTA. Una entrada solo vale si la imagen sigue siendo
// la misma (tamaño + mtime, el mismo criterio que la caché de miniaturas de
// `modulos/orion/services/wallpaperThumbs.ts`) Y si el extractor sigue siendo el
// mismo (tamaño + mtime de `acento-fondo.py`). Lo segundo es lo que evita el fallo
// mudo que da miedo aquí: tocar los umbrales del script y seguir viendo los colores
// viejos porque la caché los sirve, sin ningún error y sin nada que lo explique.
// Editar el script invalida la caché entera por construcción.
//
// SE CACHEA TAMBIÉN EL "ESTE FONDO NO TIENE ACENTO" (`acentos: null`), que es una
// respuesta legítima del extractor para un fondo en blanco y negro. Sin eso, justo
// esos fondos serían los únicos que pagarían el proceso en cada cambio. Lo que NO
// se cachea es el resto de fallos (Pillow ausente, imagen a medio copiar): son del
// entorno, no de la imagen, y guardarlos dejaría el tema de fábrica clavado hasta
// que alguien vaciara la caché a mano. El extractor los distingue por stderr.
//
// Aquí no se toca ni GTK ni el disco: solo el formato y las reglas, que es la parte
// con decisiones y la que se puede probar con Node (igual que `acentoCss.ts`).

import { ACENTOS, normalizarHexAcento } from "./acentoCss.ts"

/** Sube al cambiar el FORMATO del fichero (no el algoritmo: de eso ya se encarga
 * el sello del extractor). Una versión distinta se descarta entera. */
export const VERSION_CACHE = 1

/**
 * Cuántos fondos se recuerdan. La carpeta real tiene 64 y cada entrada ocupa ~120
 * bytes, así que el techo no está en el espacio: está en no dejar crecer sin
 * límite un fichero de caché con entradas de fondos que ya se borraron. 48 cubre
 * de sobra el uso real (un puñado de fondos rotando por franjas) y lo que se cae
 * por el borde es lo que hace más tiempo que no se usa.
 */
export const MAXIMO = 48

export type EntradaAcento = {
  ruta: string
  sello: string
  /** La paleta, o `null` si el extractor dijo que ese fondo no tiene acento. */
  acentos: string[] | null
}

/** El sello de una imagen o del propio extractor. Vacío = no se pudo medir. */
export function sello(...partes: (string | number)[]): string {
  return partes.join("|")
}

function entradaValida(valor: unknown): EntradaAcento | null {
  if (typeof valor !== "object" || valor === null) return null
  const { ruta, sello: s, acentos } = valor as Record<string, unknown>
  if (typeof ruta !== "string" || ruta === "") return null
  if (typeof s !== "string" || s === "") return null
  if (acentos === null) return { ruta, sello: s, acentos: null }
  if (!Array.isArray(acentos) || acentos.length !== ACENTOS) return null
  const colores = acentos.map(normalizarHexAcento)
  if (!colores.every((c): c is string => c !== null)) return null
  return { ruta, sello: s, acentos: colores }
}

/**
 * Las entradas de un fichero de caché. Cualquier ruido (JSON roto, versión que no
 * es, entrada con basura) vale lista vacía o entrada descartada: una caché es
 * regenerable por definición, así que nunca hay motivo para propagar un error.
 *
 * Los colores se re-normalizan al leer y no se dan por buenos por venir de "nuestro"
 * fichero: acaban dentro de una hoja de estilo igual que los del extractor, y
 * `~/.cache` es un fichero de texto que cualquiera puede tocar.
 */
export function leerEntradas(texto: string): EntradaAcento[] {
  let datos: any
  try {
    datos = JSON.parse(texto)
  } catch (_) {
    return []
  }
  if (typeof datos !== "object" || datos === null) return []
  if (datos.version !== VERSION_CACHE) return []
  if (!Array.isArray(datos.entradas)) return []
  return datos.entradas
    .map(entradaValida)
    .filter((e: EntradaAcento | null): e is EntradaAcento => e !== null)
    .slice(0, MAXIMO)
}

/** La entrada de esa imagen SI el sello coincide; `null` si no está o caducó. */
export function buscarEntrada(
  entradas: readonly EntradaAcento[],
  ruta: string,
  selloActual: string,
): EntradaAcento | null {
  const e = entradas.find((x) => x.ruta === ruta)
  return e !== undefined && e.sello === selloActual ? e : null
}

/**
 * La lista con esa entrada delante: sin duplicados por ruta (un fondo editado
 * sustituye a su versión vieja, no convive con ella) y podada al máximo por la
 * cola, que es la parte que hace más tiempo que no se usa.
 */
export function conEntrada(
  entradas: readonly EntradaAcento[],
  entrada: EntradaAcento,
): EntradaAcento[] {
  return [entrada, ...entradas.filter((e) => e.ruta !== entrada.ruta)].slice(0, MAXIMO)
}

export function serializarEntradas(entradas: readonly EntradaAcento[]): string {
  return JSON.stringify({ version: VERSION_CACHE, entradas }, null, 2)
}
