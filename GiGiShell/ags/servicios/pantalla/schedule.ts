// Lógica pura de la programación horaria de pantalla (SIN GTK/GLib).

export interface NightSchedule {
  enabled: boolean
  start: string  // "HH:MM"
  end: string    // "HH:MM"
}

export function parseHM(hm: string): number {
  const m = hm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2])
}

// ¿La hora `now` cae dentro de la ventana [start, end)? Soporta ventanas que cruzan
// medianoche (start > end). Fin exclusivo. start === end ⇒ ventana vacía (nunca).
export function isWithinWindow(now: { h: number; m: number }, start: string, end: string): boolean {
  const cur = now.h * 60 + now.m
  const s = parseHM(start)
  const e = parseHM(end)
  if (s === e) return false
  if (s < e) return cur >= s && cur < e
  return cur >= s || cur < e   // cruza medianoche
}

export function isWithinSchedule(now: { h: number; m: number }, s: NightSchedule): boolean {
  return s.enabled && isWithinWindow(now, s.start, s.end)
}

// Una regla programa DOS canales independientes y puede escribirse de dos formas:
//
//   • FRANJA  (`end` con hora): rige en [start, end) y fuera de ella no existe — no
//     arrastra su valor. Es lo indicado para "de 10 a 11" o "de 22:00 a 07:00".
//   • DESDE   (`end: null`): rige DESDE su hora hasta que otra regla del mismo canal la
//     releve (la más recientemente empezada gana, ver `activeRuleFor`). Es el "pon una
//     hora y listo": una sola regla «desde las 22:00 a 3500 K» rige a partir de las 22:00
//     y sigue rigiendo mientras nadie más hable de ese canal — también al día siguiente,
//     porque no tiene final. Para acotarla se añade otra regla («desde las 07:00, apagar»,
//     o «desde las 07:00, no cambiar»… que NO releva: «no cambiar» significa que la regla
//     no habla del canal, así que para cortar hace falta «Apagar» o una franja).
//
//   temp:       null = no toca la luz nocturna · 0 = la APAGA · >0 = K mientras rija
//   brightness: null = no toca el brillo       · 1..100 = % al empezar a regir
//
// Mientras ninguna regla rija, cada canal vuelve a su dueño natural: la luz nocturna, al
// interruptor manual; el brillo, al valor que tenía antes (lo restaura el servicio, ver
// `service.ts`).
//
// `temp: 0` (apagar) NO es lo mismo que `temp: null` (no cambiar): null deja mandar al
// interruptor manual, 0 lo pisa mientras la regla rija. Sin él no había forma de decir
// "de 9 a 18 la quiero apagada aunque la deje encendida a mano" — solo de no tocarla.
export type Channel = "temp" | "brightness"
export interface NightRule {
  start: string
  end: string | null          // null = sin final: rige hasta que otra regla releve al canal
  temp: number | null
  brightness?: number | null
}

// ¿La regla rige AHORA? Una franja, solo dentro de su ventana; una regla sin final, siempre
// (empezó a su hora y nadie la ha terminado: quién manda de las que rigen lo decide el
// desempate por antigüedad de `activeRuleFor`).
export function isRuleActive(now: { h: number; m: number }, r: NightRule): boolean {
  return r.end == null ? true : isWithinWindow(now, r.start, r.end)
}

/** Identidad estable de una regla, para detectar el cambio de una a otra. */
export function ruleKey(r: NightRule): string {
  return `${r.start}-${r.end ?? "∞"}`
}

// Regla que rige un canal AHORA: de las que rigen (dentro de su franja, o sin final) y
// hablan de ese canal, la que arrancó más recientemente (contando la vuelta de medianoche);
// a igualdad, la última de la lista. Así, si dos se solapan gana la que acaba de empezar —
// que es también lo que encadena las reglas sin final: a las 23:00, «desde 22:00» (1 h) le
// gana a «desde 07:00» (16 h), y al llegar las 07:00 se cambian los papeles.
export function activeRuleFor(now: { h: number; m: number }, rules: NightRule[], channel: Channel): NightRule | null {
  const cur = now.h * 60 + now.m
  let best: NightRule | null = null
  let bestAge = Infinity
  rules.forEach((r) => {
    if (r[channel] == null) return
    if (!isRuleActive(now, r)) return
    const age = (cur - parseHM(r.start) + 1440) % 1440   // minutos desde que empezó
    if (age <= bestAge) { best = r; bestAge = age }      // <= : a igualdad gana la última
  })
  return best
}

// Valor vigente de un canal, o null si ninguna regla lo programa ahora mismo.
export function activeSetpoint(now: { h: number; m: number }, rules: NightRule[], channel: Channel): number | null {
  const r = activeRuleFor(now, rules, channel)
  return r ? (r[channel] as number) : null
}

// Saneado de lo que venga del JSON: un valor basura (string, NaN, fuera de rango) llegaría
// hasta el hardware. Migra además el formato viejo de puntos de cambio (`{time, temp}`,
// encadenados hasta la siguiente regla) a franjas: cada regla se extiende hasta la hora de
// la siguiente (envolviendo al día siguiente), y las que solo servían de terminador
// ("apagar desde esa hora", temp 0 y sin brillo) desaparecen: en el modelo de franjas, no
// programar nada YA significa que manda el manual.
export function normalizeRules(raw: unknown): NightRule[] {
  if (!Array.isArray(raw)) return []
  const hm = (v: unknown): string | null => {
    const s = String(v ?? "")
    return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : null
  }
  const num = (v: unknown, lo: number, hi: number): number | null => {
    const n = typeof v === "number" ? v : Number(v)
    if (v == null || v === "" || !Number.isFinite(n)) return null
    const c = Math.max(lo, Math.min(hi, Math.round(n)))
    return c
  }
  // 0 se conserva: es "apagar la luz nocturna en esta franja", distinto de null ("no
  // cambiar"). Cualquier otro valor se acota al rango de hyprsunset.
  const temp = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = typeof v === "number" ? v : Number(v)
    if (!Number.isFinite(n)) return null
    return n <= 0 ? 0 : num(v, 1000, 6500)
  }
  // En el formato VIEJO un 0 no era "apagar durante la franja" sino un terminador de la
  // cadena de puntos de cambio, y ahí sigue significando "no programes nada aquí" (la
  // migración de abajo los descarta). Mantener la equivalencia habría convertido cada
  // terminador en una franja que apaga a la fuerza — justo lo que la migración evita.
  const tempLegacy = (v: unknown): number | null => (temp(v) || null)
  const bright = (v: unknown): number | null => num(v, 1, 100)

  const items = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")

  // ¿Formato viejo? (sin `end`, con `time`). Se migra la lista entera de golpe.
  const legacy = items.filter(r => r.end == null && r.time != null)
  if (legacy.length === items.length && items.length > 0) {
    const sorted = legacy
      .map(r => ({ at: hm(r.time), temp: tempLegacy(r.temp), brightness: bright(r.brightness) }))
      .filter((r): r is { at: string; temp: number | null; brightness: number | null } => r.at !== null)
      .sort((a, b) => parseHM(a.at) - parseHM(b.at))
    const out: NightRule[] = []
    sorted.forEach((r, i) => {
      if (r.temp == null && r.brightness == null) return   // era solo un terminador
      const next = sorted[(i + 1) % sorted.length]
      const end = sorted.length > 1 ? next.at : r.at       // regla única: no hay dónde acabar
      if (end === r.at) return                             // franja vacía: se descarta
      out.push({ start: r.at, end, temp: r.temp, brightness: r.brightness })
    })
    return out
  }

  const out: NightRule[] = []
  for (const r of items) {
    const start = hm(r.start)
    if (!start) continue
    // Sin `end` (o con uno ilegible) la regla es del tipo "desde": no se descarta, que es
    // justo la forma de escribirla. Solo se llega aquí con `start` válido, así que un
    // objeto sin horas sigue cayéndose.
    out.push({ start, end: hm(r.end), temp: temp(r.temp), brightness: bright(r.brightness) })
  }
  return out
}
