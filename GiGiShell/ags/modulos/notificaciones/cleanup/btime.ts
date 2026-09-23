// modulos/notificaciones/cleanup/btime.ts — pure, no GLib.
export function parseBtime(statContent: string): number | null {
  for (const line of statContent.split("\n")) {
    if (line.startsWith("btime ")) {
      const v = parseInt(line.slice(6).trim(), 10)
      return Number.isFinite(v) ? v : null
    }
  }
  return null
}
