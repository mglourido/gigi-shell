// modulos/ajustes-rapidos/camaraQsDatos.ts
//
// La lógica sin GTK del tile y del submenú de cámara de Quick Settings. Vive
// aparte para poder probarla con `node --test` **en esta máquina, que no tiene
// webcam**: es justo la parte que no se puede comprobar a ojo abriendo el panel.
//
// Aquí no hay E/S ni estado reactivo: entra lo que publican los servicios y sale
// lo que hay que pintar.
import type { Control } from "../../servicios/camara/controlesDatos.ts"
import type { Camara } from "../../servicios/camara/dispositivos.ts"
import type { UsoCamara } from "../../servicios/camara/uso.ts"

/** Glifo de la pastilla en reposo y con alguien mirando. Nerd Font. */
export const GLIFO_CAMARA = "󰄀"
export const GLIFO_CAMARA_EN_USO = "󰄉"

// ── Qué cámara se enseña ────────────────────────────────────────────────────

/** La cámara que debe verse en el submenú, en este orden: la que el usuario
 *  tiene seleccionada AHORA, la preferida guardada, la primera que haya.
 *
 *  Las dos primeras pueden apuntar a una cámara que ya no está: los ajustes se
 *  guardan por `clave` (serial/vendor:product) y sobreviven a desenchufarla, así
 *  que tras un hotplug hay que caer a algo real. Devolver una `Camara` fantasma
 *  dejaría los sliders escribiendo en un `/dev/videoN` inexistente — y
 *  `v4l2-ctl` sobre un nodo que no existe falla en un `execAsync` que nadie
 *  mira, o sea sin ningún síntoma más que "no hace nada". */
export function resolverCamaraVisible(
  lista: Camara[],
  claveSeleccionada: string | null | undefined,
  clavePreferida: string | null | undefined,
): Camara | null {
  if (!lista.length) return null
  return (
    lista.find((c) => c.clave === claveSeleccionada) ??
    lista.find((c) => c.clave === clavePreferida) ??
    lista[0]
  )
}

// ── Las filas de controles ──────────────────────────────────────────────────

export interface FilaControlCamara {
  /** Clave del `<For>`. Lleva la cámara DELANTE del nombre del control a
   *  propósito: `brightness` existe en las dos cámaras del usuario con rangos
   *  distintos (0..255 en una, -64..64 en otra), y como la geometría del slider
   *  se congela al construir la fila, reutilizarla al cambiar de cámara dejaría
   *  un mando con la escala equivocada — sin error, solo moviendo la imagen en
   *  el primer tercio del recorrido. */
  clave: string
  control: Control
}

export function componerFilas(claveCamara: string, controles: Control[]): FilaControlCamara[] {
  return controles.map((control) => ({ clave: `${claveCamara}:${control.nombre}`, control }))
}

/** ¿Las dos listas son la misma ESTRUCTURA, o sea las mismas filas en el mismo
 *  orden? Solo mira las claves: los valores viven aparte a propósito.
 *
 *  El `<For>` de gnim **desparenta y vuelve a parentar TODOS sus hijos en cada
 *  emisión**, casen o no las claves: `callback` (`jsx/For.ts`) recorre su mapa
 *  entero haciendo `fragment.remove` y solo después reordena. La clave sí evita
 *  lo caro —medido con una traza en el constructor de la fila: reconstruye
 *  **cero** filas—, pero el vaivén de la jerarquía se paga igual, y en GTK4
 *  desparentar es desmapear y desrealizar. Sin esta igualdad eran los ~15 mandos
 *  de la sección pasando por ahí en CADA lectura: al restablecer, al soltar un
 *  deslizador y al tocar cualquier automático.
 *
 *  Honestidad sobre el alcance: grabando el panel a 144 Hz no se llegó a
 *  fotografiar ningún fotograma intermedio con el layout movido, así que esto
 *  quita trabajo y una fuente conocida de saltos, pero no está demostrado que
 *  fuera la causa del parpadeo que se reportó. El fallo VISIBLE que sí se midió
 *  en esa misma pantalla —y se arregló— era otro: el deslizador se quedaba un
 *  cambio por detrás (ver la suscripción de la escala en `QuickSettings.tsx`). */
export function mismasFilas(a: FilaControlCamara[], b: FilaControlCamara[]): boolean {
  return a.length === b.length && a.every((fila, i) => fila.clave === b[i].clave)
}

// ── La geometría de un slider de control ────────────────────────────────────

export interface GeometriaControl {
  /** Posiciones del deslizador: 0..pasos. NO es el rango del control. */
  pasos: number
  /** Posición del deslizador para un valor del aparato. */
  aPosicion(valor: number): number
  /** Valor del aparato para una posición, ya imantado al `step` y acotado. */
  aValor(posicion: number): number
}

/** El deslizador se mueve en PASOS, no en el valor crudo del control.
 *
 *  V4L2 publica `step` y no todos valen 1: `exposure_time_absolute` suele ir de
 *  3 a 2047 con `step=1`, pero hay controles con `step=16` o `step=64`. Escribir
 *  un valor que no cae en la rejilla no da error — `v4l2-ctl` lo acota o lo
 *  redondea en silencio — y el efecto es un slider que "se pega" a sitios
 *  raros. Trabajando en pasos enteros el imán del deslizador y la rejilla del
 *  aparato son la misma cosa. */
export function geometriaControl(control: Control): GeometriaControl {
  const paso = Math.max(1, Math.floor(control.paso) || 1)
  // `Math.max(1, …)` cubre el control degenerado (min === max): un ajuste con
  // upper 0 es un deslizador que no se puede mover y que GTK pinta lleno.
  const pasos = Math.max(1, Math.floor((control.max - control.min) / paso))
  return {
    pasos,
    aPosicion: (valor) => {
      const acotado = Math.min(control.max, Math.max(control.min, valor))
      return Math.min(pasos, Math.max(0, Math.round((acotado - control.min) / paso)))
    },
    aValor: (posicion) => {
      const entero = Math.min(pasos, Math.max(0, Math.round(posicion)))
      return Math.min(control.max, control.min + entero * paso)
    },
  }
}

// ── El tile de la rejilla ───────────────────────────────────────────────────

export interface ResumenTileCamara {
  icono: string
  /** Nombre de la cámara, o "En uso" cuando alguien la tiene abierta: en el
   *  tile cabe una sola línea y saber que está encendida importa más que saber
   *  el modelo, que se lee entrando al submenú. */
  subtitulo: string
  /** Enciende el resaltado del tile, con el mismo significado que en los demás:
   *  "está disponible", o sea que NO está bloqueada — y el clic derecho la
   *  bloquea y la desbloquea, igual que el de Wi-Fi enciende y apaga la radio.
   *
   *  La excepción es que alguien la tenga ABIERTA, que enciende el resaltado
   *  aunque esté bloqueada: bloquear impide abrirla, no corta una captura en
   *  marcha (`servicios/camara/bloqueo.ts`), así que apagar ahí el aviso de
   *  privacidad —que es el rojo de `claseActiva`, pintado sobre este mismo
   *  resaltado— lo escondería justo cuando más importa. */
  activo: boolean
  /** Alguien tiene la cámara abierta. Viaja aparte de `activo` porque es lo que
   *  decide el COLOR del resaltado (rojo de privacidad en vez del cian normal),
   *  y los dos hechos pueden discrepar. */
  enUso: boolean
}

export function resumenTileCamara(
  lista: Camara[],
  clavePreferida: string | null | undefined,
  uso: UsoCamara,
  bloqueada: boolean,
): ResumenTileCamara {
  if (uso.enUso) {
    return { icono: GLIFO_CAMARA_EN_USO, subtitulo: "En uso", activo: true, enUso: true }
  }
  const camara = resolverCamaraVisible(lista, null, clavePreferida)
  return {
    icono: GLIFO_CAMARA,
    subtitulo: camara?.nombre ?? "Sin cámara",
    activo: !bloqueada,
    enUso: false,
  }
}
