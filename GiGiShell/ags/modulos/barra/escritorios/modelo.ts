import type Gio from "gi://Gio"

import { esEscritorioEspecial } from "../../../servicios/escritorios/especiales.ts"

/** Forma estructural de AstalHyprland.Client usada por los escritorios. Los nombres de
 * propiedades ingleses pertenecen a la API externa y se conservan como contrato. */
export interface ClienteEscritorio {
  address: string
  class?: string | null
  initialClass?: string | null
  initial_class?: string | null
  title?: string | null
  initialTitle?: string | null
  initial_title?: string | null
  floating?: boolean | null
  xwayland?: boolean | null
  pid?: number | null
  x?: number | null
  y?: number | null
  workspace?: { id: number } | null
  get_workspace?: () => { id: number } | null
}

export interface IconoClienteEscritorio {
  icono: string
  iconoGio: Gio.Icon | null
  direccion: string
  claseAplicacion: string
  esGlifo: boolean
  /** Tooltip de la ventana, construido bajo demanda (ver `iconos.ts`). */
  descripcion: () => string
}

export interface EscritorioVisible {
  id: number
  /** Nombre de Hyprland. Para los normales es el id en texto; los especiales son
   *  `special:<algo>`, y ahí es el único sitio de donde sacar ese `<algo>`. */
  nombre: string
  enfocar: () => void
  clientes: IconoClienteEscritorio[]
}

/** Lo que se pinta en la pastilla. Un especial se enseña como **0**: su id real
 *  (-98) es un detalle interno de Hyprland que no significa nada para quien mira
 *  la barra, y ocupaba tres caracteres donde el resto ocupa uno. El 0 encaja
 *  además a la izquierda del 1, que es donde el orden por id ya lo coloca. */
export function etiquetaEscritorio(id: number): string {
  return esEscritorioEspecial(id) ? "0" : String(id)
}

export function claseAplicacionCssSegura(claseAplicacion: string): string {
  return claseAplicacion.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app"
}

// Separadores de control: no pueden aparecer en una clase, una dirección ni un
// título de ventana, así que dos listas distintas no pueden firmar igual por
// concatenación (ej. dos escritorios de un cliente frente a uno de dos).
const SEPARADOR_CAMPO = "\u0001"
const SEPARADOR_CLIENTE = "\u0002"
const SEPARADOR_ESCRITORIO = "\u0003"

const firmasMemorizadas = new WeakMap<readonly EscritorioVisible[], string>()

/** Firma estable de lo que se ve de una lista de escritorios.
 *
 * `actualizar()` en `Escritorios.tsx` reconstruye la lista entera ante cualquier
 * señal de AstalHyprland, incluida `notify::focused-client` — que con
 * `input:follow_mouse = 1` salta **cada vez que el puntero cruza de una ventana a
 * otra**, no solo al alternar con el teclado. Como cada pasada devolvía objetos
 * nuevos y `<For>` indexa por identidad, ese cruce del ratón destruía y
 * reconstruía todos los botones de escritorio de todas las barras. Comparar
 * contenido es lo que hace que un cambio de foco, que no toca la lista, ni
 * siquiera llegue a los widgets.
 *
 * Incluye todo lo que `BotonEscritorio` pinta y nada más: orden, id y nombre de
 * cada escritorio y, por cliente, dirección e icono. La **descripción queda fuera**:
 * se calcula al abrir el tooltip, no se pinta, y derivarla del título metía en la
 * firma un dato que cambia con cada pestaña del navegador o cada `cd` en la terminal
 * — reconstruyendo todos los botones de todas las barras por un texto que nadie
 * estaba mirando (y también con los títulos desactivados en Ajustes). `enfocar` queda
 * fuera a propósito — es una clausura nueva en cada pasada, pero solo depende del
 * id y del nombre, que sí están en la firma (el nombre entró con los especiales:
 * abrirlos va por `toggle_special <nombre>`, no por el id). */
export function firmarEscritorios(
  escritorios: readonly EscritorioVisible[] | null | undefined,
): string {
  if (!escritorios) return ""
  const memorizada = firmasMemorizadas.get(escritorios)
  if (memorizada !== undefined) return memorizada

  const firma = [...escritorios].map((escritorio) => [
    String(escritorio.id),
    escritorio.nombre,
    ...(escritorio.clientes ?? []).map((cliente) => [
      cliente.direccion,
      cliente.claseAplicacion,
      cliente.icono,
      cliente.esGlifo ? "glifo" : "imagen",
      cliente.iconoGio ? "gio" : "-",
    ].join(SEPARADOR_CAMPO)),
  ].join(SEPARADOR_CLIENTE)).join(SEPARADOR_ESCRITORIO)

  // Las listas se reconstruyen enteras, nunca se mutan en su sitio, así que la
  // identidad del array es una clave válida para memorizar su firma.
  firmasMemorizadas.set(escritorios, firma)
  return firma
}

/** Igualdad por contenido para el `equals` de `createState`: publicar una lista
 *  equivalente conserva el array anterior y no notifica a nadie. */
export function sonEscritoriosEquivalentes(
  anterior: readonly EscritorioVisible[],
  siguiente: readonly EscritorioVisible[],
): boolean {
  return anterior === siguiente || firmarEscritorios(anterior) === firmarEscritorios(siguiente)
}
