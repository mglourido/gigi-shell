// servicios/camara/uso.ts
//
// "¿Hay una app mirando por la cámara ahora mismo?" — el lado AGS. Aquí no se
// detecta nada: se LEE lo que `hypr/scripts/camara-monitor.sh` deja escrito en
// `~/.config/gigios/camara-uso.json`. La detección vive allí por un motivo que
// conviene no olvidar al tocar esto.
//
// ── POR QUÉ NO SE DETECTA DESDE AQUÍ ────────────────────────────────────────
// El micrófono lo tiene fácil: PipeWire gestiona TODAS las capturas de audio y
// AstalWp emite `recorder-added` al instante, así que el indicador de micro
// (`modulos/barra/indicadores/audio/Microfono.tsx`) no gasta ni un proceso ni un
// temporizador. Con la cámara no hay nada de eso: Firefox, Chrome, Zoom y OBS
// abren `/dev/videoN` DIRECTAMENTE por V4L2, sin pasar por PipeWire, así que no
// existe ninguna señal a la que suscribirse.
//
// La vía obvia —mirar quién tiene el nodo abierto recorriendo `/proc/*/fd`— se
// midió en esta máquina: **28 ms por barrido con 435 procesos**. A 2 s de
// intervalo eso es más de un 1% de una CPU quemado para siempre, y encima
// dentro del proceso que pinta la barra. Descartada.
//
// Lo que sí existe es un evento del kernel: **inotify entrega `IN_OPEN` e
// `IN_CLOSE` sobre nodos de dispositivo**, no solo sobre ficheros normales
// (comprobado con `inotifywait -m -e open -e close /dev/null`). Eso convierte
// la detección en algo puramente reactivo, y es lo que hace el script: bloquea
// en `inotifywait` y solo trabaja cuando alguien abre o cierra la cámara. Coste
// en reposo: cero.
//
// Este fichero, por tanto, cuesta un `Gio.FileMonitor` sobre un directorio que
// ya se está vigilando para otras cosas. Ni sondeo ni procesos.
import { createComputed } from "ags"
import GLib from "gi://GLib"
import { crearFuenteArchivoJson } from "../sistema/fuenteArchivoJson.ts"

export interface CamaraEnUso {
  nodo: string
  nombre: string
  /** Nombres de proceso que la tienen abierta (`firefox`, `zoom`, `obs`). Puede
   *  venir vacío: se resuelve con `fuser`, que no siempre llega a tiempo si la
   *  app abre y cierra en un parpadeo. "Alguien" sigue siendo cierto. */
  apps: string[]
}

export interface UsoCamara {
  enUso: boolean
  /** Epoch en segundos del instante en que se encendió, o `null`. */
  desde: number | null
  camaras: CamaraEnUso[]
}

const VACIO: UsoCamara = { enUso: false, desde: null, camaras: [] }

const RUTA = `${GLib.get_user_config_dir()}/gigios/camara-uso.json`

export const usoCamara = crearFuenteArchivoJson<UsoCamara>({
  ruta: RUTA,
  vacio: VACIO,
  etiqueta: "camara-uso",
  interpretar: (contenido) => {
    const datos = JSON.parse(contenido)
    if (!datos || typeof datos !== "object") return VACIO
    const camaras: CamaraEnUso[] = Array.isArray(datos.camaras)
      ? datos.camaras
          .filter((c: any) => c && typeof c.nodo === "string")
          .map((c: any) => ({
            nodo: c.nodo,
            nombre: typeof c.nombre === "string" && c.nombre ? c.nombre : "Cámara",
            apps: Array.isArray(c.apps) ? c.apps.filter((a: any) => typeof a === "string") : [],
          }))
      : []
    // `enUso` se deriva de la lista y no se cree el booleano a pelo: si el
    // script muriera a mitad de escritura, un `true` con lista vacía dejaría
    // el indicador de privacidad encendido para siempre sin nada que señalar,
    // que es la peor forma de fallar para un aviso de este tipo.
    return {
      enUso: camaras.length > 0,
      desde: Number.isFinite(datos.desde) ? Number(datos.desde) : null,
      camaras,
    }
  },
})

/** Lo único que necesita el indicador de la barra. */
export const camaraEnUso = createComputed([usoCamara], (u) => u.enUso)

/** Texto para el tooltip: quién la está usando. Sin nombres de app resueltos
 *  dice "en uso" a secas — nunca una lista vacía entre paréntesis. */
export function descripcionUso(u: UsoCamara): string {
  if (!u.enUso) return "Cámara libre"
  const apps = [...new Set(u.camaras.flatMap((c) => c.apps))]
  const nombre = u.camaras[0]?.nombre ?? "Cámara"
  if (!apps.length) return `${nombre} en uso`
  return `${nombre} en uso · ${apps.join(", ")}`
}
