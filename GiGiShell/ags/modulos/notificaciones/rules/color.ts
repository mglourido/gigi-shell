// modulos/notificaciones/rules/color.ts
// Pure helpers for the notification accent-color feature. No GTK/GLib imports.
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

// Theme palette offered as presets in the color picker (catppuccin-inspired, see CLAUDE.md).
export const COLOR_PRESETS: { hex: string; name: string }[] = [
  { hex: "#cba6f7", name: textos.colores.preajustes.violeta },
  { hex: "#89b4fa", name: textos.colores.preajustes.azul },
  { hex: "#94e2d5", name: textos.colores.preajustes.verdeAzulado },
  { hex: "#a6e3a1", name: textos.colores.preajustes.verde },
  { hex: "#f9e2af", name: textos.colores.preajustes.amarillo },
  { hex: "#fab387", name: textos.colores.preajustes.naranja },
  { hex: "#f38ba8", name: textos.colores.preajustes.rojo },
]

/** True if `s` is a valid #rgb or #rrggbb hex color. */
export function isValidHex(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim())
}

/**
 * Normalize a user-typed color into a canonical lowercase #rrggbb, or undefined if invalid/empty.
 * Accepts an optional leading '#', 3- or 6-digit hex. "" / whitespace → undefined (means "auto").
 */
export function normalizeHex(input: string): string | undefined {
  let s = input.trim().toLowerCase()
  if (!s) return undefined
  if (!s.startsWith("#")) s = "#" + s
  if (!isValidHex(s)) return undefined
  if (s.length === 4) {
    // #rgb → #rrggbb
    s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  }
  return s
}

/** "#rrggbb" → "r,g,b" for use in rgba(). Falls back to white on bad input. */
export function hexToRgb(hex: string): string {
  const h = hex.replace("#", "")
  if (h.length !== 6) return "255,255,255"
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`
}
