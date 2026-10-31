import { execAsync } from "ags/process"

/** La parte de una salida que usan las ventanas, en píxeles físicos, que son los del búfer capturado. */
export interface AreaUtilSalida {
  ancho: number
  alto: number
  /** Píxeles a descartar por cada borde: `izquierda,arriba,derecha,abajo`. */
  recorte: [number, number, number, number]
}

interface MonitorHyprctl {
  name: string
  width: number
  height: number
  scale: number
  transform: number
  reserved: number[]
}

/** `reserved` viene en píxeles lógicos y en orden izquierda, arriba, derecha, abajo. `width` y
 * `height` no incluyen la rotación. */
export function calcularAreaUtil(monitor: MonitorHyprctl): AreaUtilSalida {
  const girado = monitor.transform % 2 === 1
  const anchoTotal = girado ? monitor.height : monitor.width
  const altoTotal = girado ? monitor.width : monitor.height
  const [izquierda, arriba, derecha, abajo] = [0, 1, 2, 3].map((borde) =>
    Math.round((monitor.reserved[borde] ?? 0) * monitor.scale),
  )
  return {
    ancho: anchoTotal - izquierda - derecha,
    alto: altoTotal - arriba - abajo,
    recorte: [izquierda, arriba, derecha, abajo],
  }
}

/** Se pregunta a `hyprctl` y no a AstalHyprland porque este reparte mal `reserved`: con la barra
 * arriba da `reserved-bottom = 38` (medido con la r973). Devuelve null si no se puede saber. */
export async function obtenerAreaUtilSalida(nombreSalida: string): Promise<AreaUtilSalida | null> {
  if (!nombreSalida) return null
  try {
    const monitores: MonitorHyprctl[] = JSON.parse(await execAsync(["hyprctl", "-j", "monitors"]))
    const monitor = monitores.find((candidato) => candidato.name === nombreSalida)
    if (!monitor) return null
    const area = calcularAreaUtil(monitor)
    return area.ancho > 0 && area.alto > 0 ? area : null
  } catch (_) {
    return null
  }
}
