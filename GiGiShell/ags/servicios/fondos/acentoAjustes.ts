// servicios/fondos/acentoAjustes.ts
//
// Los ajustes avanzados del acento adaptativo (Ajustes > Personalización >
// Enfatizar > Ajustes avanzados): los umbrales del extractor y los acentos fijados
// a mano. Aquí solo hay reglas —qué es un valor válido, cómo se le pasa al script,
// qué paleta resulta—, sin GTK ni disco, para que Node pueda probarlo.
//
// DOS FICHEROS, UN DUEÑO CADA UNO:
//   - `ags/config/acento-parametros.json` (versionado): los valores de FÁBRICA con
//     su rango y su paso. Lo leen este módulo (deslizadores y "Restablecer") y el
//     propio `acento-fondo.py` (sus valores por defecto), así que un umbral de
//     fábrica se cambia en un solo sitio.
//   - `~/.config/gigishell/acento.json` (del usuario): lo que se ha elegido en
//     Ajustes. Lo escribe solo `acentoPreferencias.ts`.

import fabrica from "../../config/acento-parametros.json" with { type: "json" }
import { ACENTOS, normalizarHexAcento } from "./acentoCss.ts"

export type GrupoParametro = "correccion" | "candidatos" | "paleta"

export type DefinicionParametro = {
  grupo: GrupoParametro
  valor: number
  min: number
  max: number
  paso: number
}

export type Parametros = Record<string, number>
export type Manuales = (string | null)[]

export type AjustesAcento = {
  parametros: Parametros
  /** Un hex por acento fijado a mano, `null` = el que salga del fondo. */
  manuales: Manuales
}

export const VERSION_AJUSTES = 1

export const DEFINICIONES = fabrica.parametros as Record<string, DefinicionParametro>

/** En el orden del JSON de fábrica, que es el orden en que se pintan. */
export const CLAVES = Object.keys(DEFINICIONES)

/** Los que se miden en grados (en el script se pasan a vueltas). */
export const EN_GRADOS = new Set(["separacionTono", "giroAnalogo"])

/**
 * Pares [mínimo, máximo] que tienen que quedar en orden. Desordenados no rompen el
 * script, pero dan resultados absurdos sin ningún error que los explique (un rango
 * de brillo vacío deja TODO fondo sin acento). La regla es "el mínimo nunca pasa al
 * máximo": subir el mínimo se frena en el máximo, y bajar el máximo arrastra al
 * mínimo. Los relajados son el segundo intento, así que nunca más exigentes que el
 * primero.
 */
const PARES_ORDENADOS: readonly (readonly [string, string])[] = [
  ["satMin", "satMax"],
  ["valMinCandidato", "valMaxCandidato"],
  ["cromaMinRelajado", "cromaMin"],
  ["satMinCandidatoRelajado", "satMinCandidato"],
]

/** Los colores de reserva de `estilos/_colores.scss` ($violet, $blue, $turquesa):
 * lo que ocupa un acento NO fijado a mano cuando el fondo no da paleta pero otro sí
 * está fijado. Tienen que coincidir con las reservas de `acento*()` de allí. */
export const ACENTOS_FABRICA: readonly string[] = ["#cba6f7", "#89b4fa", "#87fae9"]

/** Decimales con los que se escribe un valor de ese paso (0.01 → 2, 0.1 → 1, 1 → 0). */
export function decimalesDe(paso: number): number {
  if (paso >= 1) return 0
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(paso) - 1e-9)))
}

function ajustarAlPaso(valor: number, def: DefinicionParametro): number {
  const acotado = Math.min(def.max, Math.max(def.min, valor))
  const pasos = Math.round((acotado - def.min) / def.paso)
  return Number((def.min + pasos * def.paso).toFixed(decimalesDe(def.paso)))
}

/** Los valores de fábrica, una copia nueva cada vez. */
export function parametrosFabrica(): Parametros {
  return Object.fromEntries(CLAVES.map((c) => [c, DEFINICIONES[c].valor]))
}

/**
 * Un juego de parámetros completo y válido a partir de cualquier cosa. Lo que
 * falte o no sea número vale el de fábrica; lo que sobre (una clave de una versión
 * vieja) se descarta; todo se acota al rango y al paso. Un par desordenado se
 * resuelve con mínimo = máximo, que cubre los dos casos de `PARES_ORDENADOS`.
 */
export function normalizarParametros(valor: unknown): Parametros {
  const origen = typeof valor === "object" && valor !== null ? valor as Record<string, unknown> : {}
  const salida = parametrosFabrica()
  for (const clave of CLAVES) {
    const v = origen[clave]
    if (typeof v === "number" && Number.isFinite(v)) salida[clave] = ajustarAlPaso(v, DEFINICIONES[clave])
  }
  for (const [bajo, alto] of PARES_ORDENADOS) {
    if (salida[bajo] > salida[alto]) salida[bajo] = salida[alto]
  }
  return salida
}

export function normalizarManuales(valor: unknown): Manuales {
  const lista = Array.isArray(valor) ? valor : []
  return Array.from({ length: ACENTOS }, (_, i) => normalizarHexAcento(lista[i]))
}

export function ajustesFabrica(): AjustesAcento {
  return {
    parametros: parametrosFabrica(),
    manuales: normalizarManuales((fabrica as { manuales?: unknown }).manuales),
  }
}

/** Lo leído de `acento.json`; cualquier ruido degrada a fábrica, campo a campo. */
export function leerAjustes(datos: unknown): AjustesAcento {
  if (typeof datos !== "object" || datos === null) return ajustesFabrica()
  const { parametros, manuales } = datos as Record<string, unknown>
  return { parametros: normalizarParametros(parametros), manuales: normalizarManuales(manuales) }
}

export function serializarAjustes(ajustes: AjustesAcento): object {
  return { version: VERSION_AJUSTES, parametros: ajustes.parametros, manuales: ajustes.manuales }
}

export function sonFabrica(ajustes: AjustesAcento): boolean {
  const f = ajustesFabrica()
  return CLAVES.every((c) => ajustes.parametros[c] === f.parametros[c])
    && ajustes.manuales.every((m, i) => m === f.manuales[i])
}

/**
 * El argumento para `acento-fondo.py`. Lleva TODOS los parámetros, no solo los que
 * difieren de fábrica, y en orden fijo: la cadena entra en el sello de la caché, así
 * que cambiar un valor de fábrica en el JSON también invalida las paletas viejas.
 */
export function argumentoParametros(parametros: Parametros): string {
  const ordenado = Object.fromEntries(CLAVES.map((c) => [c, parametros[c]]))
  return `--parametros=${JSON.stringify(ordenado)}`
}

/**
 * La paleta que se pinta: cada acento fijado a mano manda sobre el extraído. Sin
 * ninguno fijado es la extraída tal cual (`null` = tema de fábrica). Con alguno
 * fijado y un fondo sin acento, los no fijados toman su color de fábrica: lo que
 * el usuario fijó se respeta siempre.
 */
export function paletaEfectiva(extraida: readonly string[] | null, manuales: Manuales): string[] | null {
  if (manuales.every((m) => m === null)) return extraida === null ? null : [...extraida]
  return Array.from({ length: ACENTOS }, (_, i) => manuales[i] ?? extraida?.[i] ?? ACENTOS_FABRICA[i])
}
