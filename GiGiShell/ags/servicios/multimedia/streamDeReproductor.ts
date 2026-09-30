// Qué streams de audio (AstalWp) son los de un reproductor MPRIS. Lo necesita el
// volumen por app de la tarjeta "Sonando" de Orion: MPRIS dice qué suena pero no
// deja tocar el volumen de la app, y PipeWire tiene el volumen pero no sabe nada de
// MPRIS. No hay un identificador común garantizado, así que se casa por dos vías:
//
// 1. **PID**, cuando el bus lo lleva (`org.mpris.MediaPlayer2.chromium.instance12345`):
//    si coincide, es seguro. Si no, no descarta nada (ver abajo).
// 2. **Nombre**: el `entry` (.desktop), el sufijo del bus y la `identity` del
//    reproductor contra los candidatos del stream (`candidatosApp`: id, binario,
//    nombre…). Igualdad, o prefijo con separador (`spotify` ↔ `spotify-client`),
//    nunca subcadena suelta — `includes` haría casar "st" con "steam".
//
// Puro a propósito (sin GTK ni AstalWp): recibe props planas.

import { candidatosApp, type PropsAudio } from "./identidadApps.ts"

export interface IdentidadReproductor {
  entry?: string | null
  busName?: string | null
  identity?: string | null
}

function normalizar(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase().replace(/\.desktop$/i, "")
}

/** Nombres con los que puede anunciarse en PipeWire la app de este reproductor. */
export function clavesReproductor(r: IdentidadReproductor): string[] {
  const bus = normalizar(r.busName).replace(/^org\.mpris\.mediaplayer2\./, "").replace(/\.instance.*$/, "")
  const identidad = normalizar(r.identity)
  const claves = [normalizar(r.entry), bus, identidad, identidad.replace(/\s+/g, "-")]
  return claves.filter((c, i) => c && claves.indexOf(c) === i)
}

/** PID que algunos reproductores meten en el nombre de bus (`…instance12345`), o null. */
export function pidDeBus(busName: string | null | undefined): number | null {
  const m = String(busName ?? "").match(/\.instance(?:_\d+_)?(\d+)$/)
  if (!m) return null
  const pid = Number(m[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function casanNombres(a: string, b: string): boolean {
  if (a === b) return true
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a]
  return corto.length >= 3 && largo.startsWith(corto) && /[-._ ]/.test(largo[corto.length])
}

/** ¿El stream con estas props es de este reproductor? */
export function streamEsDeReproductor(props: PropsAudio, r: IdentidadReproductor): boolean {
  const pid = pidDeBus(r.busName)
  const pidStream = Number((props || {})["application.process.id"])
  // El PID solo AFIRMA: el número del bus no siempre es un PID (Firefox anuncia
  // `instance_1_85`), así que no coincidir no descarta y se sigue por el nombre.
  if (pid !== null && pid === pidStream) return true
  const claves = clavesReproductor(r)
  return candidatosApp(props).some(c => claves.some(k => casanNombres(c, k)))
}
