// servicios/energia/brilloAhorroCalculo.ts
//
// El CÁLCULO del brillo objetivo del modo ahorro, aparte de `brilloAhorro.ts` para poder
// probarlo con `node --test`: aquel importa el backend de brillo (gi/GTK) y no se puede
// cargar fuera de la sesión.
//
// Hay dos modos y el segundo existe porque el primero tiene un caso que no cubre:
//
//   • "fijo"      — apunta a un brillo concreto (el de siempre). Su problema es que un
//                   objetivo es un valor absoluto: si al entrar en ahorro la pantalla ya
//                   está MÁS BAJA que el objetivo, aplicarlo la SUBIRÍA — un ajuste que se
//                   pide para gastar menos acabaría gastando más, justo con la batería
//                   baja. Por eso aquí nunca sube: cuando el brillo de partida ya está en
//                   el objetivo o por debajo, se cae al cálculo relativo.
//   • "relativo"  — resta PUNTOS PORCENTUALES al brillo que hubiera (30 % con 10 → 20 %),
//                   así que siempre baja y siempre baja lo mismo se venga de donde se venga.
//                   Es resta de puntos y no un porcentaje del porcentaje (que daría 27 %):
//                   lo que se pide es "diez puntos menos", no "un 10 % menos de brillo".
//
// El objetivo se calcula SIEMPRE desde el brillo de partida —el apunte `brightnessBefore`,
// no el valor vivo— porque si no, en modo relativo cada reconciliación restaría otra vez
// sobre lo ya bajado y la pantalla se iría apagando sola a cada evento.

/** Ver `BrilloAhorroModo` en `powerState.ts`; se duplica aquí para no arrastrar gi al test. */
export type ModoBrilloAhorro = "fijo" | "relativo"

/** Suelo del brillo del ahorro (5 %, el mismo mínimo del deslizador de Ajustes). Bajar de
 *  aquí deja la pantalla prácticamente negra, y entonces no queda nada visible con lo que
 *  volver a subirla. */
export const MINIMO_BRILLO_AHORRO = 0.05

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * El brillo (0..1) al que debe bajar el ahorro partiendo de `base` (0..1).
 *
 * Devuelve `null` cuando NO hay nada que bajar: el resultado subiría el brillo o lo dejaría
 * igual, que es lo que pasa si la pantalla ya está en el suelo. Quien llama no debe escribir
 * nada en ese caso — ni siquiera el mismo valor.
 */
export function objetivoBrilloAhorro(
  base: number,
  modo: ModoBrilloAhorro,
  fijoPct: number,
  reduccionPct: number,
): number | null {
  const partida = clamp01(base)

  let objetivo: number
  if (modo === "relativo") {
    objetivo = partida - clamp01(reduccionPct / 100)
  } else {
    objetivo = clamp01(fijoPct / 100)
    // Fallback del modo fijo: el objetivo no baja nada, así que se reduce relativamente.
    if (objetivo >= partida) objetivo = partida - clamp01(reduccionPct / 100)
  }

  objetivo = Math.max(MINIMO_BRILLO_AHORRO, clamp01(objetivo))
  // Con la pantalla ya en el suelo (o por debajo) no queda margen: mejor no tocar nada que
  // subirla al mínimo, que sería otra vez el fallo que este módulo viene a evitar.
  return objetivo < partida ? objetivo : null
}
