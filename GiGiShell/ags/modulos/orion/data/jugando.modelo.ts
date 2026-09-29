// Lógica pura de la página "Jugando ahora" del carrusel de Inicio (sin GLib,
// para `node --test`). La lectura de /proc vive en `jugando.ts`.

/**
 * Los ticks de /proc/<pid>/stat van en USER_HZ, que el kernel fija en 100 para
 * la interfaz de /proc en todas las arquitecturas habituales — no es el HZ del
 * kernel, así que no hace falta preguntarle a `getconf`.
 */
export const USER_HZ = 100

/**
 * Milisegundos que lleva vivo un proceso a partir de su `starttime` (ticks desde
 * el arranque) y del uptime del sistema en segundos. `null` si algo no cuadra:
 * mejor no enseñar duración que enseñar una absurda.
 */
export function msVivo(inicioTicks: string | null, uptimeSeg: number | null): number | null {
  if (inicioTicks === null || uptimeSeg === null) return null
  const ticks = Number(inicioTicks)
  if (!Number.isFinite(ticks) || !Number.isFinite(uptimeSeg)) return null
  const ms = (uptimeSeg - ticks / USER_HZ) * 1000
  return ms >= 0 ? ms : null
}

/** "ahora", "12 min", "1 h 05 min". */
export function duracionSesion(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "ahora"
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${String(min % 60).padStart(2, "0")} min`
}

/** Las direcciones de Hyprland llegan con y sin `0x` según la fuente. */
export function normalizarDireccion(direccion: string | null | undefined): string {
  return String(direccion ?? "").toLowerCase().replace(/^0x/, "")
}
