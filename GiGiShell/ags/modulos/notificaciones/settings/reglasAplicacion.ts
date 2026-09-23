import type { EffectSpec, NotifRule } from "../rules/types.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export type TipoReglaAplicacion = "bloqueo" | "silencio"

const CONFIGURACION: Record<TipoReglaAplicacion, {
  prefijo: string
  nombre: string
  efectos: EffectSpec
}> = {
  bloqueo: {
    prefijo: "user.mute",
    nombre: textos.apps.nombreBloqueo,
    efectos: { suppress: true },
  },
  silencio: {
    prefijo: "user.muteaudio",
    nombre: textos.apps.nombreSinSonido,
    efectos: { muteAudio: true },
  },
}

export function idReglaAplicacion(tipo: TipoReglaAplicacion, aplicacion: string): string {
  return `${CONFIGURACION[tipo].prefijo}.${aplicacion}`
}

export function crearReglaAplicacion(tipo: TipoReglaAplicacion, aplicacion: string): NotifRule {
  const configuracion = CONFIGURACION[tipo]
  return {
    id: idReglaAplicacion(tipo, aplicacion),
    name: formatearTexto(configuracion.nombre, { app: aplicacion }),
    enabled: true,
    priority: 100,
    source: "user",
    match: { app: { op: "equals", value: aplicacion } },
    effects: { ...configuracion.efectos },
  }
}
