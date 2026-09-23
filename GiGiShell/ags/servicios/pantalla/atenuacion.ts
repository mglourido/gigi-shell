// servicios/pantalla/atenuacion.ts
// Reparto del brillo en DOS tramos. Lógica pura (sin GTK/gi): probada con node.
//
// El problema que resuelve: el brillo por hardware tiene un SUELO FÍSICO. En el camino
// DDC, `setvcp 10 0` es el mínimo que acepta la electrónica del panel — y en un OLED eso
// sigue siendo claramente luminoso, así que el slider llegaba a 0 y la pantalla no se
// oscurecía más. No era un recorte del código (`applyBrightness` ya dejaba llegar a 0):
// era el hardware diciendo que no baja más.
//
// La cura es atenuar por SOFTWARE por debajo de ese suelo, reduciendo el gamma (la CTM del
// KMS). Ya hay un dueño de esa matriz en el sistema —`hyprsunset`, que la usa para la luz
// nocturna— y admite gamma en caliente (`hyprctl hyprsunset gamma N`), así que el tramo
// software no estrena mecanismo: se cuelga del que ya se reconcilia en `service.ts`.
//
// El reparto es un slider ÚNICO partido en dos zonas:
//
//   100% ┐
//        │  zona HARDWARE: DDC/backlight 100→0. Sin pérdida de niveles.
//   FLOOR┤◄ suelo del monitor (hardware ya al mínimo, gamma todavía intacto)
//        │  zona SOFTWARE: hardware clavado en 0, gamma 100%→GAMMA_MIN.
//     0% ┘  casi negro
//
// Por qué el gamma va SOLO en el tramo bajo y no en todo el rango: reducir gamma recorta
// los niveles útiles y puede producir banding en los degradados. En el tramo alto el
// hardware hace el trabajo sin ese peaje, así que el software solo entra donde el hardware
// ya no puede — donde el banding es el precio de poder ver algo, no un coste gratuito.

/** Punto del slider donde el hardware toca su mínimo. Por encima manda el hardware; por
 *  debajo, el gamma. Es el reparto del recorrido, no una propiedad del monitor: se eligió
 *  para que el tramo útil del hardware (el que se usa a diario) se quede con la mayoría. */
export const DIM_FLOOR = 0.35

/** Gamma mínimo (15%). No baja a 0 a propósito: un gamma 0 deja la pantalla en negro
 *  absoluto, indistinguible de "se ha apagado el monitor" y sin nada visible con lo que
 *  volver a subirlo — el usuario se quedaría a ciegas delante de su propio slider. */
export const GAMMA_MIN = 0.15

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

export interface Reparto {
  /** 0..1 — lo que se le pide al hardware (DDC `setvcp 10` / `brightnessctl`). */
  hardware: number
  /** 0..1 — factor de gamma. 1 = sin atenuación por software. */
  gamma: number
}

/** Parte un brillo compuesto (0..1, lo que ve el usuario) en sus dos canales.
 *  Es continuo en `DIM_FLOOR`: justo ahí el hardware llega a 0 y el gamma sigue en 1, así
 *  que cruzar el suelo arrastrando el slider no da ningún salto visible. */
export function repartirBrillo(ratio: number): Reparto {
  const v = clamp01(ratio)
  if (v >= DIM_FLOOR) {
    return { hardware: (v - DIM_FLOOR) / (1 - DIM_FLOOR), gamma: 1 }
  }
  return { hardware: 0, gamma: GAMMA_MIN + (1 - GAMMA_MIN) * (v / DIM_FLOOR) }
}

/** Inversa parcial: de una lectura del HARDWARE al valor compuesto que enseña el slider.
 *  La usan `detectDdc` (lee el monitor al arrancar) y el watcher de udev (cambios hechos
 *  desde fuera del shell). Solo puede reconstruir la zona hardware — el gamma no se lee
 *  del panel —, así que el tramo software se restaura desde disco en `initDisplayService`. */
export function componerBrillo(hardware: number): number {
  return DIM_FLOOR + clamp01(hardware) * (1 - DIM_FLOOR)
}
