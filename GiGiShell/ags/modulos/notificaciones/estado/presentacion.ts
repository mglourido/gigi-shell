import type { AppSettings } from "./modelos.ts"

const PALETA = ["#89b4fa", "#a6e3a1", "#f9e2af", "#fab387", "#cba6f7", "#94e2d5", "#f38ba8"]

const CATEGORIAS_COLOR: readonly [readonly string[], string][] = [
  [["whatsapp", "telegram", "signal", "discord", "slack", "messages", "chat"], "#a6e3a1"],
  [["mail", "thunderbird", "outlook", "gmail", "email"], "#89b4fa"],
  [["firefox", "chrome", "chromium", "browser"], "#fab387"],
  [["system", "update", "kernel", "pacman", "apt", "dnf"], "#f9e2af"],
  [["error", "fail", "alarm", "critical"], "#f38ba8"],
  [["spotify", "music", "media", "player"], "#94e2d5"],
  [["vscode", "code", "terminal", "git"], "#cba6f7"],
]

const ICONOS_APLICACION: readonly [readonly string[], string][] = [
  [["whatsapp"], "󰖣"],
  [["telegram"], "󰊤"],
  [["discord"], "󰙯"],
  [["slack"], "󰒱"],
  [["signal"], "󱔁"],
  [["firefox"], "󰈹"],
  [["chrome", "chromium"], "󰊯"],
  [["mail", "thunderbird", "email", "gmail"], "󰇮"],
  [["spotify", "music"], "󰓇"],
  [["vscode", "code"], "󰨞"],
  [["terminal", "bash", "zsh"], "󰆍"],
  [["git"], "󰊢"],
  [["system", "update", "pacman", "apt"], "󰇱"],
  [["network", "wifi", "nm-applet"], "󰤨"],
  [["bluetooth"], "󰂯"],
  [["battery"], "󰂄"],
  [["calendar"], "󰃭"],
  [["file", "nautilus", "dolphin"], "󰉋"],
]

function buscarPorNombre(nombre: string, opciones: readonly [readonly string[], string][]): string | undefined {
  return opciones.find(([fragmentos]) => fragmentos.some((fragmento) => nombre.includes(fragmento)))?.[1]
}

export function getAppColor(appName: string): string {
  const nombre = appName.toLowerCase()
  const colorSemantico = buscarPorNombre(nombre, CATEGORIAS_COLOR)
  if (colorSemantico) return colorSemantico

  let hash = 0
  for (let i = 0; i < nombre.length; i++) hash = (hash * 31 + nombre.charCodeAt(i)) & 0xffffffff
  return PALETA[Math.abs(hash) % PALETA.length]
}

export function resolveNotifColor(
  notif: { appName: string; meta?: { color?: string } },
  settings: Record<string, AppSettings>,
): string {
  return notif.meta?.color ?? settings[notif.appName]?.color ?? getAppColor(notif.appName)
}

export function resolveAppColor(appName: string, settings: Record<string, AppSettings>): string {
  return settings[appName]?.color ?? getAppColor(appName)
}

export function getAppIcon(appName: string): string {
  return buscarPorNombre(appName.toLowerCase(), ICONOS_APLICACION) ?? "󰂚"
}

export function getRelativeTime(timestamp: number): string {
  const diferenciaSegundos = (Date.now() - timestamp) / 1000
  if (diferenciaSegundos < 60) return "ahora"
  if (diferenciaSegundos < 3600) return `${Math.floor(diferenciaSegundos / 60)}m`
  if (diferenciaSegundos < 86400) return `${Math.floor(diferenciaSegundos / 3600)}h`
  return `${Math.floor(diferenciaSegundos / 86400)}d`
}
