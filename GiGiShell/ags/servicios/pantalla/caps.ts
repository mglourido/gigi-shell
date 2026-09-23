// Detección de capacidades de pantalla — parsing puro de `modetest -c` y de la
// salida de `edid-decode`, SIN imports GTK/GLib (corre bajo node --test). El
// shell-out y la caché reactiva viven en display/service.ts.
//
// Fuentes (no hay flags de capacidad en `hyprctl monitors -j`):
//   - VRR      → propiedad DRM `vrr_capable` (value 1 = soportado)
//   - 10-bit   → propiedad DRM `max bpc` (máximo del rango >= 10)
//   - HDR/cm   → metadatos HDR en el EDID (edid-decode)

export interface ConnCaps { vrr: boolean; bitdepth10: boolean }

export function parseModetestCaps(text: string): Record<string, ConnCaps> {
  const out: Record<string, ConnCaps> = {}
  let cur: string | null = null
  let prop: "vrr" | "bpc" | null = null
  for (const raw of text.split("\n")) {
    // Cabecera de conector: "508\t507\tconnected\teDP-1\t..."
    const head = raw.match(/^\d+\s+\d+\s+(?:connected|disconnected)\s+(\S+)/)
    if (head) { cur = head[1]; prop = null; if (!out[cur]) out[cur] = { vrr: false, bitdepth10: false }; continue }
    if (!cur) continue
    // Línea de propiedad: "\t515 vrr_capable:" / "\t513 max bpc:"
    const pm = raw.match(/^\s+\d+\s+(vrr_capable|max bpc):/)
    if (pm) { prop = pm[1] === "vrr_capable" ? "vrr" : "bpc"; continue }
    if (prop === "vrr") {
      const v = raw.match(/^\s+value:\s*(\d+)/)
      if (v) { out[cur].vrr = Number(v[1]) === 1; prop = null }
    } else if (prop === "bpc") {
      const vs = raw.match(/^\s+values:\s*(\d+)\s+(\d+)/)
      if (vs) { out[cur].bitdepth10 = Number(vs[2]) >= 10; prop = null }
    }
  }
  return out
}

// Entrada: bloques "###EDID <nombre>" seguidos de las líneas de edid-decode que
// coincidieron con el grep de HDR. Devuelve el set de conectores con HDR.
export function parseEdidHdr(text: string): Set<string> {
  const has = new Set<string>()
  let cur: string | null = null
  for (const line of text.split("\n")) {
    const h = line.match(/^###EDID\s+(\S+)/)
    if (h) { cur = h[1]; continue }
    if (cur && /HDR Static Metadata|SMPTE ST 2084|BT2020|Hybrid Log-Gamma/i.test(line)) has.add(cur)
  }
  return has
}
