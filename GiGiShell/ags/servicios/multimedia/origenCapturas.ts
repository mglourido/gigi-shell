// servicios/multimedia/origenCapturas.ts
//
// La mitad con subprocesos de `capturasMicrofono.ts`: pregunta a `pactl` de
// dónde saca el audio cada captura y publica el veredicto. Lee ese fichero
// primero — ahí está el porqué, la medida de los tres casos y por qué no se
// puede leer el nodo desde dentro del proceso.
//
// **Solo se pregunta por lo que no se sabe.** `sincronizarOrigenes()` no lanza
// nada si toda captura viva ya está clasificada o es de las que se ignoran
// siempre: cerrar una captura, silenciar el micro o dar a play en Spotify
// (`cava`) no gastan un solo subproceso. En la práctica es UN `pactl` la primera
// vez que una app abre una captura nueva, y nada más.
//
// **La lista que devuelve `pactl` es la de streams vivos**, así que cada
// respuesta reemplaza el mapa entero y los seriales muertos se caen solos: no
// hay caché que envejezca ni que podar.
//
// **Singleton de módulo, no un servicio por widget.** `Microfono` se instancia
// una vez POR MONITOR; sin esto, dos pantallas serían dos `pactl` por evento.
// El rebote de 120 ms funde además la ráfaga de señales que WirePlumber emite
// por una sola app que abre el micro.
//
// **Fail-open hacia "avisa de más".** Sin `pactl`, con un JSON que no parsea o
// con la consulta fallando, el mapa se queda como esté: lo desconocido cuenta y
// el indicador se comporta como antes de todo esto (más la lista manual). El
// modo de fallo nunca puede ser un micrófono abierto sin aviso.

import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import {
  capturasSinClasificar, clasificarCapturas, mismosOrigenes,
  type CapturaAudio, type OrigenCaptura,
} from "./capturasMicrofono"

/** Sin `pactl` no hay clasificación posible y todo queda en la lista manual. */
export const clasificacionDisponible = GLib.find_program_in_path("pactl") !== null

/** `object.serial` del stream → de dónde saca el audio. */
const [origenCapturas, setOrigenCapturas] = createState<Map<number, OrigenCaptura>>(new Map())
export { origenCapturas }

/**
 * ¿Hay un veredicto en camino? Lo consulta el indicador para no encender el
 * icono por una captura que está a punto de clasificarse: sin esta espera, abrir
 * una captura de sistema haría parpadear el aviso de micrófono los ~50 ms que
 * tarda `pactl` en contestar.
 */
const [clasificacionPendiente, setClasificacionPendiente] = createState(false)
export { clasificacionPendiente }

const REBOTE_MS = 120

let reboteId: number | null = null
let enVuelo = false

async function clasificar(): Promise<void> {
  // stderr trae "Invalid ASCII character" con descripciones acentuadas (medido
  // en este equipo) y no impide nada: el JSON sale entero por stdout.
  const json = await execAsync(["pactl", "-f", "json", "list", "source-outputs"])
  const nuevos = clasificarCapturas(json)
  // Publicar un Map nuevo idéntico despertaría a todos los suscriptores para
  // nada — y como despertarles los hace re-sincronizar, sería un bucle.
  if (!mismosOrigenes(nuevos, origenCapturas.get())) setOrigenCapturas(nuevos)
}

function lanzar(): void {
  enVuelo = true
  clasificar()
    .catch((error) => {
      // Fail-open: se conserva lo último bueno y se avisa una vez.
      console.error("[origenCapturas] no se pudo clasificar con pactl:", error)
    })
    .finally(() => {
      enVuelo = false
      setClasificacionPendiente(false)
    })
}

/**
 * Pon al día la clasificación de estas capturas. Idempotente y barata: solo
 * consulta si alguna es desconocida, y una consulta en curso ya cubre a las que
 * lleguen mientras tanto (la respuesta trae la lista viva entera).
 */
export function sincronizarOrigenes(capturas: CapturaAudio[] | null): void {
  if (!clasificacionDisponible) return
  if (capturasSinClasificar(capturas, origenCapturas.get()).length === 0) return
  setClasificacionPendiente(true)
  if (enVuelo || reboteId !== null) return
  reboteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBOTE_MS, () => {
    reboteId = null
    lanzar()
    return GLib.SOURCE_REMOVE
  })
}
