// Lógica pura de la programación horaria de pantalla (SIN GTK/GLib).

export function parseHM(hm: string): number {
  const m = hm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2])
}

// Una regla es un DISPARO, no un estado que se sostenga: a su hora escribe el estado que
// debe tener la pantalla —como si el usuario pulsara el interruptor o moviera el slider—
// y a partir de ahí manda el usuario hasta el siguiente disparo. Programa DOS canales
// independientes (luz nocturna y brillo) y se escribe de dos formas:
//
//   • EN ADELANTE (`end: null`): un solo disparo, a `start`. Lo que pone se queda hasta que
//     otro disparo del mismo canal lo cambie (o el usuario). Una regla «22:00 → 3500 K»
//     sola enciende la luz a las 22:00 y nada la apaga salvo otra regla o la mano.
//   • FRANJA (`end` con hora): dos disparos. A `start` aplica sus valores; a `end` devuelve
//     cada canal al estado de justo antes de empezar, PERO solo si el usuario no lo tocó
//     durante la franja — si lo tocó, el fin no cambia nada (lo decide el servicio, que es
//     quien conoce el estado; ver `service.ts`).
//
//   temp:       null = no toca la luz nocturna · 0 = la APAGA · >0 = la enciende a esos K
//   brightness: null = no toca el brillo       · 1..100 = % al dispararse
//
// Cada disparo actúa UNA vez por día —a su hora— y al iniciar sesión se reaplica el estado
// que el horario establece para esa hora (el último disparo de cada canal).
export type Channel = "temp" | "brightness"
export interface NightRule {
  start: string
  end: string | null          // null = "en adelante": solo hay disparo de inicio
  temp: number | null
  brightness?: number | null
}

/** Identidad estable de una regla (clave de sus apuntes en `service.ts`). */
export function ruleKey(r: NightRule): string {
  return `${r.start}-${r.end ?? "∞"}`
}

/** Disparo de una regla: el de su inicio, o el de su fin si es una franja. */
export interface Disparo {
  regla: NightRule
  tipo: "inicio" | "fin"
  hace: number               // minutos transcurridos desde que tocó (0..1439)
}

// Último disparo de un canal antes de `now` (incluido el de este mismo minuto), dando la
// vuelta a medianoche. Solo cuentan las reglas que hablan del canal, y una franja vacía
// (inicio = fin) no dispara nunca. Desempates en el mismo minuto: un INICIO gana a un fin
// —«de 07 a 22» + «de 22 a 07» encadenadas no deben restaurar nada a las 22:00, sino
// aplicar la siguiente— y entre iguales gana la última de la lista.
export function ultimoDisparo(now: { h: number; m: number }, rules: NightRule[], channel: Channel): Disparo | null {
  const cur = now.h * 60 + now.m
  let mejor: Disparo | null = null
  const considerar = (regla: NightRule, tipo: Disparo["tipo"], hm: string) => {
    const hace = (cur - parseHM(hm) + 1440) % 1440
    if (!mejor || hace < mejor.hace || (hace === mejor.hace && (tipo === "inicio" || mejor.tipo === "fin"))) {
      mejor = { regla, tipo, hace }
    }
  }
  for (const r of rules) {
    if (r[channel] == null) continue
    if (r.end != null && parseHM(r.end) === parseHM(r.start)) continue
    if (r.end != null) considerar(r, "fin", r.end)
    considerar(r, "inicio", r.start)
  }
  return mejor
}

// Regla cuyo valor ha fijado el horario por última vez en ese canal: la del último disparo
// si fue un inicio. Tras el fin de una franja no hay ninguna (el canal volvió a lo de antes).
// Es lo que la UI enseña como «vigente».
export function activeRuleFor(now: { h: number; m: number }, rules: NightRule[], channel: Channel): NightRule | null {
  const d = ultimoDisparo(now, rules, channel)
  return d && d.tipo === "inicio" ? d.regla : null
}

// Valor que el horario fijó por última vez en un canal, o null si ninguno.
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
