// servicios/camara/formatosDatos.ts
//
// Qué resoluciones da una cámara. Parser puro de `v4l2-ctl --list-formats-ext`;
// la E/S está en `formatos.ts`.
//
// ── ESTO ES INFORMATIVO, Y LA UI NO DEBE FINGIR OTRA COSA ───────────────────
// La resolución y los fps NO los fija el dispositivo: los negocia la APP al
// abrir el stream (`VIDIOC_S_FMT`). No hay ningún ajuste persistente de
// "resolución de la cámara" que imponer desde fuera — la siguiente app que
// abra el nodo pedirá lo suyo y ganará. Por eso esto se presenta como una
// FICHA de lo que el aparato soporta, nunca como un desplegable que el usuario
// pueda "aplicar".
export interface Formato {
  /** FourCC, p.ej. `MJPG`, `YUYV`. */
  codigo: string
  /** Descripción del propio driver, p.ej. "Motion-JPEG". */
  descripcion: string
  /** Resoluciones `AxB`, sin repetir y de mayor a menor. */
  resoluciones: string[]
}

const RE_FORMATO = /^\s*\[\d+\]:\s*'(\w+)'\s*\((.*?)(?:,\s*compressed)?\)\s*$/
const RE_TAMANO = /^\s*Size:\s*\w+\s+(\d+)x(\d+)\s*$/

export function parsearFormatos(salida: string): Formato[] {
  const formatos: Formato[] = []
  let actual: Formato | null = null
  const vistas = new Set<string>()

  for (const linea of salida.split("\n")) {
    const f = RE_FORMATO.exec(linea)
    if (f) {
      actual = { codigo: f[1], descripcion: f[2].trim(), resoluciones: [] }
      formatos.push(actual)
      vistas.clear()
      continue
    }
    const t = actual ? RE_TAMANO.exec(linea) : null
    if (!t) continue
    // Una misma resolución aparece REPETIDA una vez por cada intervalo de
    // fotogramas que la soporta ("Size: Discrete 1920x1080" sale tres veces si
    // admite 30, 24 y 15 fps). Sin deduplicar, la ficha enseña "1920x1080"
    // tres veces seguidas y parece un fallo de pintado.
    const clave = `${t[1]}x${t[2]}`
    if (vistas.has(clave)) continue
    vistas.add(clave)
    actual!.resoluciones.push(clave)
  }

  for (const f of formatos) {
    f.resoluciones.sort((a, b) => {
      const [aw, ah] = a.split("x").map(Number)
      const [bw, bh] = b.split("x").map(Number)
      return bw * bh - aw * ah
    })
  }
  return formatos
}

/** La resolución más alta que soporta el aparato, mirando todos sus formatos.
 *  Es lo único que cabe en una línea de resumen ("hasta 1920x1080"). */
export function resolucionMaxima(formatos: Formato[]): string | null {
  let mejor: string | null = null
  let mejorArea = 0
  for (const f of formatos) {
    for (const r of f.resoluciones) {
      const [w, h] = r.split("x").map(Number)
      if (w * h > mejorArea) { mejorArea = w * h; mejor = r }
    }
  }
  return mejor
}
