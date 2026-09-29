// Modelo de los tiempos de hypridle — SIN imports GTK/GLib (corre bajo node --test). El efecto
// (leer/escribir el JSON, reiniciar hypridle) vive en servicios/pantalla/inactividadAhorro.ts.
//
// La autoridad es `~/.config/gigishell/inactividad.json`, NO hypr/hypridle.conf: ese fichero está
// versionado y es estático (usa variables `$IDLE_*`). `hypr/scripts/hypridle.sh` traduce el JSON a
// esas variables cada vez que arranca hypridle. Antes se reescribían los `timeout =` del .conf con
// regex, y cada ajuste acababa en `gigishell status` como un cambio sin commitear.

export type ListenerKind = "dpms" | "lock" | "suspend" | "hibernate"

export interface ListenerState { timeout: number; enabled: boolean }
export interface HypridleConfig {
  dpms: ListenerState
  lock: ListenerState
  suspend: ListenerState
  /**
   * Listener de HIBERNACIÓN. Ojo: su `enabled` NO significa "¿hiberna el equipo?" sino "¿hiberna
   * contándolo hypridle?" — que es solo uno de los dos caminos posibles. El otro (el normal) es
   * suspender primero y que systemd hiberne desde la suspensión con una alarma RTC, y entonces
   * este listener está APAGADO aunque la hibernación esté encendida. Quién manda de verdad es
   * `~/.config/gigishell/hibernacion.json`; esto es su espejo. Ver `servicios/energia/hibernacion.ts`.
   */
  hibernate: ListenerState
  /**
   * ¿Bloquea la pantalla al suspender? (`before_sleep_cmd` del bloque general). Es un ajuste APARTE
   * del listener "lock": aquel cuenta inactividad, este se dispara en CUALQUIER suspensión (menú de
   * energía, botón, tapa, `systemctl suspend`), porque quien avisa a hypridle es logind.
   */
  bloqueoAlSuspender: boolean
}

/** Deben coincidir con los `$IDLE_*` por defecto de hypr/hypridle.conf. */
export const INACTIVIDAD_POR_DEFECTO: HypridleConfig = {
  dpms: { timeout: 600, enabled: true },
  lock: { timeout: 660, enabled: true },
  suspend: { timeout: 2400, enabled: true },
  hibernate: { timeout: 3000, enabled: false },
  bloqueoAlSuspender: false,
}

const LISTENERS: ListenerKind[] = ["dpms", "lock", "suspend", "hibernate"]

function listener(v: unknown, porDefecto: ListenerState): ListenerState {
  const l = v as Partial<ListenerState> | null
  if (!l || typeof l.timeout !== "number" || !(l.timeout >= 1) || typeof l.enabled !== "boolean") {
    return { ...porDefecto }
  }
  return { timeout: Math.floor(l.timeout), enabled: l.enabled }
}

/**
 * Lo que haya en el JSON (o nada) → configuración completa. Cada clave ausente o mal formada cae
 * a su valor por defecto por separado, con el mismo criterio que aplica `hypridle.sh` al
 * traducirlo: la UI nunca debe enseñar algo distinto de lo que hypridle está usando.
 */
export function normalizarInactividad(datos: unknown): HypridleConfig {
  const d = (datos && typeof datos === "object" ? datos : {}) as Record<string, unknown>
  const cfg = { ...INACTIVIDAD_POR_DEFECTO } as HypridleConfig
  for (const clave of LISTENERS) cfg[clave] = listener(d[clave], INACTIVIDAD_POR_DEFECTO[clave])
  cfg.bloqueoAlSuspender = typeof d.bloqueoAlSuspender === "boolean"
    ? d.bloqueoAlSuspender
    : INACTIVIDAD_POR_DEFECTO.bloqueoAlSuspender
  return cfg
}
