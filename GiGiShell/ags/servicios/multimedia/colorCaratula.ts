// Color de la carátula para los reproductores del shell: la semilla que se saca
// de la imagen y los tonos derivados (fondo, acento de la barra, compañero de las
// ondas). Lo comparten el reproductor de Quick Settings y la tarjeta "Sonando" de
// Orion, para que la misma pista tenga el mismo color en los dos sitios.

import GdkPixbuf from "gi://GdkPixbuf"

export const ACENTO_MEDIA_PREDETERMINADO = "#89b4fa"

export type RGB = [number, number, number]

export function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.replace("#", "")
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

export function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

export function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

// One UI 8 deriva de la semilla una paleta tonal APAGADA (muteada): tanto el
// tinte del fondo como el seekbar tienen saturación baja. Medido sobre la misma
// carátula, Samsung usa fondo≈HSL(_,0.36,0.18) y seekbar≈HSL(_,0.21,0.51). El
// hue se preserva siempre; lo que corregimos aquí es la SATURACIÓN (antes íbamos
// demasiado saturados) y clavamos el tono.

// Tinte del fondo: oscuro y MUTEADO. Se pinta a alpha bajo para que la carátula
// se siga viendo por debajo (como en el teléfono).
export function oneUiBgTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const sat = Math.min(0.42, s * 0.6 + 0.06) // apagado, tope ~Samsung 0.36–0.42
  const lum = 0.18 + Math.min(1, s) * 0.05   // ~0.18–0.23
  return hslToRgb([h, sat, lum])
}

// Seekbar / acento activo: mismo hue, periwinkle MUTEADO y de tono medio,
// legible sobre el fondo oscuro (Samsung ≈ HSL(_,0.21,0.51)).
export function oneUiFgTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const sat = Math.min(0.30, s * 0.4 + 0.08)
  return hslToRgb([h, sat, 0.55])
}

// Tono COMPAÑERO de las ondas: sale de la misma semilla que el resto de la tarjeta,
// pero con reglas propias, para que las dos ondas no sean el mismo color repetido a
// distinto alfa. Tres diferencias respecto a `oneUiFgTone`, y las tres importan:
// gira el hue ~27° (análogo — un giro mayor se pelea con la carátula, del que sale
// el color), sube algo la saturación y sobre todo lo **aclara** (0.68 frente a 0.55).
// La luminosidad es lo que de verdad separa las dos ondas cuando la carátula es
// monocroma y el giro de hue no se aprecia: ahí la diferencia de color no existiría
// y seguirían distinguiéndose por claridad.
export function oneUiOndaTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const hue = (h + 0.075) % 1
  const sat = Math.min(0.46, s * 0.55 + 0.16)
  return hslToRgb([hue, sat, 0.68])
}

export function cssRgbToTuple(rgb: string): [number, number, number] {
  const values = rgb.match(/\d+/g)?.map(Number)
  if (!values || values.length < 3) return hexToRgb(ACENTO_MEDIA_PREDETERMINADO)
  return [values[0], values[1], values[2]]
}

// Los tres tonos derivados de la semilla se calculan MEMORIZADOS por cadena de
// acento. No es una micro-optimización gratuita: `progressArea` los pedía en cada
// frame de las ondas (30 fps), y cada llamada hace un `match` con regex, dos
// conversiones RGB→HSL→RGB y varias asignaciones de array. El acento solo cambia
// cuando cambia la carátula, así que todo eso era trabajo repetido y basura para el
// GC en el único sitio del shell que dibuja continuamente.
export type TonosAcento = { fondo: RGB; acento: RGB; companero: RGB }
let tonosMemo: { clave: string; tonos: TonosAcento } | null = null

export function tonosDeAcento(css: string): TonosAcento {
  if (tonosMemo === null || tonosMemo.clave !== css) {
    const semilla = cssRgbToTuple(css)
    tonosMemo = {
      clave: css,
      tonos: {
        fondo: oneUiBgTone(semilla),
        acento: oneUiFgTone(semilla),
        companero: oneUiOndaTone(semilla),
      },
    }
  }
  return tonosMemo.tonos
}


// Extrae el color "semilla" de la carátula igual que hace la máquina monet de
// One UI 8 (Material Color Utilities → Score): puntúa por CROMA + población, sin
// sesgo de luminancia. El código viejo penalizaba/premiaba por luminancia
// ("darkFit") y calidez ("warmBias"), lo que a veces elegía un color distinto al
// de Samsung → de ahí las inversiones "aquí oscuro / allí claro".
export function dominantPixbufColor(pixbuf: GdkPixbuf.Pixbuf): [number, number, number] {
  const pixels = pixbuf.get_pixels()
  const width = pixbuf.get_width()
  const height = pixbuf.get_height()
  const channels = pixbuf.get_n_channels()
  const rowstride = pixbuf.get_rowstride()
  const step = Math.max(1, Math.floor(Math.min(width, height) / 28))
  const buckets = new Map<string, { r: number; g: number; b: number; chroma: number; count: number }>()
  let total = 0

  for (let y = 0; y < height; y += step) {
    const row = y * rowstride
    for (let x = 0; x < width; x += step) {
      const i = row + x * channels
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const chroma = max - min // 0..255, proxy perceptual de croma (HCT-lite)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

      total += 1
      // Descarta casi-negro, casi-blanco y casi-gris; el resto SÍ compite,
      // incluidos colores oscuros y saturados (Samsung sí los elige de semilla).
      if (lum < 14 || lum > 236 || chroma < 16) continue

      const qr = r >> 5
      const qg = g >> 5
      const qb = b >> 5
      const key = `${qr},${qg},${qb}`
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, chroma: 0, count: 0 }
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.chroma += chroma
      bucket.count += 1
      buckets.set(key, bucket)
    }
  }

  // Score al estilo Material: proporción·0.7 + (croma-48)·peso. El croma manda,
  // pero un color muy poblado y algo menos saturado puede ganar (como en monet).
  const TARGET_CHROMA = 48
  let best: { r: number; g: number; b: number; chroma: number; count: number } | null = null
  let bestScore = -Infinity
  for (const bucket of buckets.values()) {
    const proportion = total > 0 ? bucket.count / total : 0
    const chroma = (bucket.chroma / bucket.count) / 255 * 100 // 0..100
    if (chroma < 5) continue
    const proportionScore = proportion * 100 * 0.7
    const chromaScore = chroma < TARGET_CHROMA
      ? (chroma - TARGET_CHROMA) * 0.1
      : (chroma - TARGET_CHROMA) * 0.3
    const score = proportionScore + chromaScore
    if (!best || score > bestScore) {
      best = bucket
      bestScore = score
    }
  }
  if (!best || best.count <= 0) return hexToRgb(ACENTO_MEDIA_PREDETERMINADO)

  return [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ]
}

// Semilla por RUTA de carátula, memorizada: la tarjeta de Orion se reconstruye en
// cada cambio de estado del reproductor, y decodificar la imagen entera en cada
// una sería trabajo repetido para el mismo resultado. La ruta cambia con la pista.
const semillaPorRuta = new Map<string, string>()
const MAX_SEMILLAS = 32

/** Semilla (`rgb(...)`) de la carátula en `ruta`, o el acento por defecto si no se puede leer. */
export function semillaDeCaratula(ruta: string): string {
  const cacheada = semillaPorRuta.get(ruta)
  if (cacheada) return cacheada
  let semilla = ACENTO_MEDIA_PREDETERMINADO
  try { semilla = rgbToCss(dominantPixbufColor(GdkPixbuf.Pixbuf.new_from_file(ruta))) } catch (_) {}
  if (semillaPorRuta.size >= MAX_SEMILLAS) semillaPorRuta.delete(semillaPorRuta.keys().next().value!)
  semillaPorRuta.set(ruta, semilla)
  return semilla
}
