// servicios/energia/planHibernacion.ts
// Lógica pura del reparto de la hibernación — SIN imports GTK/GLib (corre bajo node --test).
// El efecto (leer/escribir ficheros, llamar al helper root) vive en `hibernacion.ts`.

export interface AjusteHibernacion {
  enabled: boolean
  /** Inactividad TOTAL hasta hibernar, en segundos. Es el único número que ve el usuario. */
  totalSeconds: number
}

/**
 * Cómo se cumple el tiempo de hibernación:
 *   "retardo"  → suspender primero y que systemd hiberne desde la suspensión con una alarma RTC.
 *   "listener" → hibernar directo desde un listener de hypridle, sin pasar por la suspensión.
 */
export type ModoHibernacion = "retardo" | "listener"

export interface PlanHibernacion {
  modo: ModoHibernacion
  /** `HibernateDelaySec`: cuánto espera systemd DENTRO de la suspensión. 0 en modo listener. */
  retardo: number
  /** Cómo debe quedar el listener `hibernate` de hypridle.conf. */
  listener: { timeout: number; enabled: boolean }
}

/**
 * Decide el mecanismo a partir del tiempo total pedido y de la suspensión VIGENTE.
 *
 * La regla y su porqué, en una línea: durante un S3 el userspace está congelado, así que un
 * listener de hypridle posterior a la suspensión NO SE DISPARARÍA NUNCA — y sin ningún error.
 * Por eso, siempre que se pueda, quien cuenta es systemd (`suspend-then-hibernate` + alarma RTC),
 * y el listener queda solo para los casos en que hibernar no llega a pasar por la suspensión.
 *
 * El total se respeta en los dos caminos: en modo retardo es suspensión + retardo, por eso el
 * retardo es la RESTA y no el número que puso el usuario. Fijar el total del usuario como
 * `HibernateDelaySec` sería el error fácil aquí: hibernaría a los 70 min en vez de a los 50.
 *
 * El listener conserva su `timeout` incluso apagado, igual que el resto de tiempos de
 * hypridle.conf: el sentinel GIGIOS-OFF existe justo para no perder el número al desactivar.
 */
export function planificar(
  ajuste: AjusteHibernacion,
  suspension: { timeout: number; enabled: boolean },
): PlanHibernacion {
  const espejo = { timeout: ajuste.totalSeconds, enabled: false }
  if (!ajuste.enabled) return { modo: "listener", retardo: 0, listener: espejo }
  if (suspension.enabled && ajuste.totalSeconds > suspension.timeout) {
    return {
      modo: "retardo",
      retardo: ajuste.totalSeconds - suspension.timeout,
      listener: espejo,
    }
  }
  // Sin suspensión, o con la hibernación pedida ANTES que ella (el usuario manda: si quiere
  // hibernar a los 10 min y suspender a los 20, hiberna a los 10 y la suspensión no llega a
  // ocurrir), solo queda contar desde hypridle.
  return { modo: "listener", retardo: 0, listener: { timeout: ajuste.totalSeconds, enabled: true } }
}
