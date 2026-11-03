// modulos/notificaciones/rules/efectos/tipos.ts
// Qué hay que declarar de un EFECTO de regla. Puro (sin GTK): lo importan el motor, la
// validación, el saneado, el resumen y el test; solo el editor lo traduce a widgets.
//
// UN EFECTO = UN FICHERO en esta carpeta + una línea en `index.ts` (que fija el orden) + sus
// textos en `textos/ajustes/notificaciones.json`. Lo único que queda fuera es el código que lo
// APLICA (el popup que lee `meta.popupMs`, el sonido que lee `soundFile`…), que vive donde se usa.
// Ver la guía completa en `rules/efectos/README.md`.
import type { EffectSpec } from "../types.ts"

export type ClaveEfecto = keyof EffectSpec

/** Forma del valor guardado. Gobierna el saneado al cargar de disco: un valor de otro tipo se
 *  descarta (ver `estado/saneado.ts`). `cualquiera` = la comprobación entera la hace `sanear`. */
export type TipoValor = "booleano" | "numero" | "texto" | "lista-texto" | "objeto" | "cualquiera"

/** Cómo se combinan los valores de varias reglas que casan a la vez. Las reglas llegan ordenadas
 *  de mayor a menor prioridad.
 *  - `prioridad`: gana el valor de la regla más prioritaria que lo fije (el caso normal).
 *  - `union`: se juntan los de todas (las condiciones).
 *  - `por-campo`: objeto cuyos campos se resuelven por separado con `prioridad` (la reescritura:
 *    una regla puede cambiar el título y otra el cuerpo). */
export type Combinacion = "prioridad" | "union" | "por-campo"

/** Adónde llega el valor tras evaluar.
 *  - `meta`: se hornea en la `NotifMeta` y se GUARDA con la notificación (lo leen el popup, el
 *    panel o la limpieza más tarde).
 *  - `resultado`: va al `EvalResult` y lo consume la ingesta UNA vez (no se persiste).
 *  - `motor`: lo usa el propio motor para calcular otra cosa (`lifetime` → `expiresAt`…). */
export type Destino = "meta" | "resultado" | "motor"

/** Opción de un selector. `valor: undefined` es «la regla no opina» (se borra la clave). */
export interface OpcionEditor {
  valor: unknown
  etiqueta: string
}

/** El control del editor, por TIPO. Añadir un efecto de un tipo existente no toca el editor;
 *  un tipo nuevo se implementa una vez en `settings/controlesEfecto.tsx`. */
export type ControlEditor =
  | {
      tipo: "interruptor"
      etiqueta: string
      /** Interruptores consecutivos con la misma `fila` se pintan juntos en una fila. */
      fila: string
      /** Ayuda bajo la fila entera; basta con ponerla en uno de sus interruptores. */
      ayudaFila?: string
    }
  | { tipo: "duracion"; titulo: string; marcador: string; ayuda?: string }
  | {
      tipo: "opciones"
      titulo: string
      opciones: OpcionEditor[]
      ayuda?: string
      /** Qué opción se marca según el valor guardado. Por defecto, la de `valor` igual. */
      seleccion?: (valor: unknown) => unknown
    }
  | { tipo: "color"; titulo: string }
  | {
      tipo: "ruta-audio"
      titulo: string
      ayuda?: string
      marcador: string
      etiquetaProbar: string
      ayudaProbar: string
      avisoNoExiste: string
    }
  | { tipo: "condiciones"; titulo: string; ayuda?: string }
  | { tipo: "reescritura" }

export interface UbicacionEditor {
  /** Encabezado de sección que se pinta JUSTO ANTES de este control. */
  seccion?: string
  /** Va dentro del bloque plegable «Avanzado». */
  avanzado?: boolean
  /** Solo se enseña si se cumple (p. ej. «Expira tras» solo con ciclo temporal). */
  visibleSi?: (efectos: EffectSpec) => boolean
}

export interface DefinicionEfecto {
  clave: ClaveEfecto
  valor: TipoValor
  /** Por defecto `prioridad`. */
  combinar?: Combinacion
  destino: Destino
  /** Valor en la meta o en el resultado cuando ninguna regla lo fija. Sin él, la clave no se pone. */
  porDefecto?: unknown
  /** Saneado de DOMINIO al cargar de disco, después de comprobar el `valor`: devuelve el valor
   *  limpio, o `undefined` para descartarlo (un enum desconocido, una duración ≤ 0, un color que
   *  no es hex…). Lo aplica `sanearEfectos()` en todas las puertas de entrada (reglas de usuario,
   *  overrides, `notif-sistema.json`, catálogo de avisos). Sin él, basta con el tipo.
   *
   *  Descarta en vez de corregir: un valor inventado podría hacer algo que nadie escribió. Y no
   *  sustituye a `validar`, que es la que explica el error al guardar desde el editor. */
  sanear?: (valor: unknown) => unknown
  /** Errores legibles (vacío = válido). Recibe todos los efectos para las reglas cruzadas. */
  validar?: (valor: unknown, efectos: EffectSpec) => string[]
  /** Frase(s) del resumen de la lista de reglas. `null` = no se enseña. */
  resumen?: (valor: unknown, efectos: EffectSpec) => string | string[] | null
  editor: ControlEditor & UbicacionEditor
}

/** Azúcar para que cada fichero quede tipado sin repetir la interfaz. */
export const definirEfecto = (d: DefinicionEfecto): DefinicionEfecto => d
