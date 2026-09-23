// modulos/ajustes/barra/CapturasMicrofono.tsx — Ajustes > Barra y escritorios.
//
// La escotilla de `servicios/multimedia/capturasMicrofono.ts`: qué capturas de
// audio cuentan como "una app está usando el micrófono" para el indicador de la
// barra. Lee ese fichero antes de tocar esto.
//
// **Aquí NO se apunta a mano el caso normal.** Una captura del monitor de un
// altavoz o de la salida de otra app se detecta sola (`origenCapturas.ts`
// pregunta a `pactl`) y aparece ya apartada, con su motivo y el interruptor
// insensible: no hay nada que decidir cuando el sistema sabe la respuesta, y
// dejar reactivarla solo serviría para volver a encender un aviso falso. Los
// interruptores vivos son los de las capturas clasificadas COMO micrófono, para
// el caso que la detección no cace.
//
// ── Qué filas se ven ─────────────────────────────────────────────────────────
// La unión de lo que está capturando AHORA y lo que el usuario ya apartó. Lo
// segundo es obligatorio: sin ello, apartar una app sería un viaje de ida —
// desaparecería de la lista al cerrarse y solo se podría recuperar editando
// `preferences.json` a mano (misma lección que el cajón "Ocultos" del menú de
// audio de Quick Settings). Lo que se ignora SIEMPRE (`cava`, que es del propio
// shell) no se pinta: sería un interruptor sin efecto.
//
// La clave es el `node.name` del stream, no la app: Discord abre dos —
// "WEBRTC VoiceEngine" (el micro) y "discord_capture" (la salida de un juego o
// de Spotify)— y apartar la app entera dejaría el micro de Discord sin aviso.

import { For, createBinding, createComputed, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp"
import Interruptor from "../../../componentes/Interruptor"
import { FilaAjuste, TextoInformativo } from "../componentes"
import {
  CAPTURAS_IGNORADAS_SIEMPRE, claveCaptura, detalleCaptura,
  type CapturaAudio, type OrigenCaptura,
} from "../../../servicios/multimedia/capturasMicrofono"
import { origenCapturas, sincronizarOrigenes } from "../../../servicios/multimedia/origenCapturas"
import { microfonoAppsIgnoradas, alternarAppMicrofonoIgnorada } from "../preferences"
import textos from "../../../textos/ajustes/microfono.json" with { type: "json" }

const audioWp = (() => {
  try { return AstalWp.get_default()?.audio ?? null } catch { return null }
})()

type FilaCaptura = {
  clave: string
  detalle: string
  activa: boolean
  ignorada: boolean
  origen: OrigenCaptura | null
}

/** Qué se lee a la derecha del nombre: primero el motivo, luego el estado. */
function estadoFila(fila: FilaCaptura): string {
  if (!fila.activa) return textos.fila.inactiva
  if (fila.origen === "sistema") return textos.fila.sistema
  return fila.detalle || textos.fila.capturando
}

// La fila se construye UNA vez (`<For id>`: con clave, su objeto no vuelve a
// llegar — ver la auditoría del <For> en ags/CLAUDE.md), así que TODO lo mutable
// se deriva aquí de `filas`. Leyendo del objeto recibido, pulsar el interruptor
// cambiaría el JSON y la fila seguiría pintando el valor viejo, sin dar error.
function FilaCapturaMicrofono({ inicial, filas }: {
  inicial: FilaCaptura
  filas: Accessor<FilaCaptura[]>
}) {
  const clave = inicial.clave
  const fila = filas((lista) => lista.find((f) => f.clave === clave) ?? inicial)
  return (
    <FilaAjuste titulo={clave}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TextoInformativo label={fila(estadoFila)} />
        <Interruptor
          activo={fila((f) => !f.ignorada && f.origen !== "sistema")}
          sensible={fila((f) => f.origen !== "sistema")}
          alAlternar={() => alternarAppMicrofonoIgnorada(clave)}
        />
      </box>
    </FilaAjuste>
  )
}

export default function CapturasMicrofono() {
  // Sin WirePlumber no hay nada que listar y el indicador tampoco se enciende.
  if (!audioWp) return <box visible={false} />

  // Abrir Ajustes no genera ningún evento de WirePlumber, así que sin esto la
  // lista heredaría la clasificación de la última captura que hubo — o ninguna.
  // Si la barra ya las conoce todas, esto no lanza nada.
  sincronizarOrigenes(audioWp.recorders as unknown as CapturaAudio[])

  const filas = createComputed(
    [createBinding(audioWp, "recorders"), microfonoAppsIgnoradas, origenCapturas],
    (
      vivos: AstalWp.Endpoint[],
      ignoradas: string[],
      origenes: Map<number, OrigenCaptura>,
    ): FilaCaptura[] => {
      const activas = new Map<string, { detalle: string; origen: OrigenCaptura | null }>()
      for (const captura of vivos ?? []) {
        const clave = claveCaptura(captura)
        if (clave === "" || CAPTURAS_IGNORADAS_SIEMPRE.includes(clave)) continue
        // Con dos streams del mismo nombre manda el que sí sea micrófono: la
        // clave es una sola fila y apartarla los apartaría a los dos.
        const previo = activas.get(clave)
        const origen = origenes.get(captura.serial) ?? null
        if (previo && previo.origen !== "sistema") continue
        activas.set(clave, { detalle: detalleCaptura(captura), origen })
      }
      const claves = [...new Set([...activas.keys(), ...ignoradas])]
        .filter((clave) => !CAPTURAS_IGNORADAS_SIEMPRE.includes(clave))
        .sort((a, b) => a.localeCompare(b))
      return claves.map((clave) => ({
        clave,
        detalle: activas.get(clave)?.detalle ?? "",
        activa: activas.has(clave),
        ignorada: ignoradas.includes(clave),
        origen: activas.get(clave)?.origen ?? null,
      }))
    },
  )

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <TextoInformativo label={textos.descripcion} halign={Gtk.Align.START} wrap />
      <box cssClasses={["dev-row"]} visible={filas((lista: FilaCaptura[]) => lista.length === 0)}>
        <TextoInformativo label={textos.vacio} halign={Gtk.Align.START} />
      </box>
      <For each={filas} id={(fila: FilaCaptura) => fila.clave}>
        {(fila: FilaCaptura) => <FilaCapturaMicrofono inicial={fila} filas={filas} />}
      </For>
    </box>
  )
}
