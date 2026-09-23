// Lógica pura de edición de hypridle.conf — SIN imports GTK/GLib (corre bajo
// node --test). El efecto (leer/escribir/reiniciar) vive en
// modulos/ajustes/pantalla/Inactividad.tsx.

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
   * `~/.config/gigios/hibernacion.json`; esto es su espejo. Ver `servicios/energia/hibernacion.ts`.
   */
  hibernate: ListenerState
  /** ¿Bloquea la pantalla al suspender? (before_sleep_cmd del bloque general) */
  bloqueoAlSuspender: boolean
}

// on-timeout → tipo de listener.
//
// Conviven DOS formatos a propósito:
//   1. La puerta `idle-action.sh <acción>`, por donde van hoy los listeners para
//      que la función "Wake up" pueda vetarlos (ver hypr/scripts/idle-action.sh).
//   2. El comando directo (`hyprctl dispatch dpms off` / `hyprlock` /
//      `systemctl suspend`), que es lo que documenta hypridle y lo que traería un
//      hypridle.conf de otra máquina o una copia de seguridad anterior al Wake up.
//
// La puerta va PRIMERO: su ruta contiene ".../hypr/scripts/...", y un `hyprlock`
// dentro de la ruta engañaría al patrón directo. Comprobar el argumento es además
// lo único que distingue las tres invocaciones entre sí — todas nombran el mismo
// script.
const GATE_ACTIONS: Record<string, ListenerKind> = {
  "dpms-off": "dpms",
  "lock": "lock",
  "suspend": "suspend",
  "hibernate": "hibernate",
}

function kindOf(onTimeout: string): ListenerKind | null {
  const gated = onTimeout.match(/idle-action\.sh\s+(\S+)/)
  if (gated) return GATE_ACTIONS[gated[1]] ?? null
  if (/dpms\s+off/.test(onTimeout)) return "dpms"
  if (/hyprlock/.test(onTimeout)) return "lock"
  // `hibernate` ANTES que `suspend`: `systemctl suspend-then-hibernate` casa con los dos patrones
  // y es, de las dos, la que hiberna. Al revés se leería como un listener de suspensión y la UI
  // enseñaría el tiempo en la fila equivocada.
  if (/systemctl\s+(hibernate|suspend-then-hibernate)/.test(onTimeout)) return "hibernate"
  if (/systemctl\s+suspend/.test(onTimeout)) return "suspend"
  return null
}

const DEFAULT: ListenerState = { timeout: 0, enabled: false }

// ── Bloqueo al suspender (before_sleep_cmd) ─────────────────────────────────
// El listener "lock" y este ajuste son cosas DISTINTAS: el listener bloquea tras N
// minutos de inactividad; before_sleep_cmd bloquea al entrar en suspensión, venga
// de donde venga (el listener de suspensión, el menú de energía, el botón físico,
// cerrar la tapa, `systemctl suspend` a mano) — logind avisa a hypridle en todos
// los casos. Por eso apagar el listener de bloqueo NO evitaba encontrarse el
// bloqueo al despertar: era este comando, que no tenía interruptor.
//
// Se desactiva comentando la línea con el mismo sentinel GIGIOS-OFF que los
// listeners, para no perder el comando escrito (con su envoltura, sea `loginctl
// lock-session` o cualquier otro) y poder reactivarlo tal cual.
const RE_BEFORE_SLEEP = /^([ \t]*)(#[ \t]*)?before_sleep_cmd[ \t]*=[ \t]*(.*)$/m
const SENTINEL = /[ \t]*#[ \t]*GIGIOS-OFF[ \t]*$/

function parseBloqueoAlSuspender(text: string): boolean {
  const m = text.match(RE_BEFORE_SLEEP)
  // Sin línea no hay bloqueo al suspender: ausente y comentada son el mismo
  // comportamiento, así que el interruptor debe enseñarse apagado en ambos casos.
  if (!m) return false
  return !m[2]
}

/**
 * Activa o desactiva `before_sleep_cmd`. Si la línea no existe (config traída de
 * otra máquina, o borrada a mano) y se pide activarla, se inserta en el bloque
 * `general` con el comando por defecto — de lo contrario el interruptor quedaría
 * encendido en la UI sin efecto ninguno.
 */
export function writeBloqueoAlSuspender(text: string, enabled: boolean): string {
  if (RE_BEFORE_SLEEP.test(text)) {
    return text.replace(RE_BEFORE_SLEEP, (_todo, sangria: string, _comentada: string | undefined, resto: string) => {
      const cmd = resto.replace(SENTINEL, "").trim()
      return enabled
        ? `${sangria}before_sleep_cmd = ${cmd}`
        : `${sangria}# before_sleep_cmd = ${cmd}   # GIGIOS-OFF`
    })
  }
  if (!enabled) return text
  return text.replace(/^([ \t]*)general[ \t]*\{[ \t]*$/m, `$1general {\n$1    before_sleep_cmd = loginctl lock-session`)
}

export function parseHypridle(text: string): HypridleConfig {
  const cfg: HypridleConfig = {
    dpms: { ...DEFAULT }, lock: { ...DEFAULT }, suspend: { ...DEFAULT }, hibernate: { ...DEFAULT },
    bloqueoAlSuspender: parseBloqueoAlSuspender(text),
  }
  // Partir en bloques listener { ... }
  const blocks = text.match(/listener\s*\{[^}]*\}/g) || []
  for (const block of blocks) {
    const on = block.match(/on-timeout\s*=\s*(.+)/)
    if (!on) continue
    const kind = kindOf(on[1])
    if (!kind) continue
    // timeout, incluso si está comentado con el sentinel
    const active = block.match(/^\s*timeout\s*=\s*(\d+)/m)
    const disabled = block.match(/^\s*#\s*timeout\s*=\s*(\d+)\s*#\s*GIGIOS-OFF/m)
    if (active) cfg[kind] = { timeout: Number(active[1]), enabled: true }
    else if (disabled) cfg[kind] = { timeout: Number(disabled[1]), enabled: false }
  }
  return cfg
}

export function writeHypridle(text: string, values: Partial<Record<ListenerKind, ListenerState>>): string {
  return text.replace(/listener\s*\{[^}]*\}/g, (block) => {
    const on = block.match(/on-timeout\s*=\s*(.+)/)
    if (!on) return block
    const kind = on[1] ? kindOf(on[1]) : null
    if (!kind || !values[kind]) return block
    const v = values[kind]!
    const line = v.enabled
      ? `timeout = ${v.timeout}`
      : `# timeout = ${v.timeout}   # GIGIOS-OFF`
    // Reemplaza la línea timeout activa o la comentada, preservando indentación.
    return block.replace(/^(\s*)(#\s*)?timeout\s*=\s*\d+(\s*#\s*GIGIOS-OFF)?/m, `$1${line}`)
  })
}
