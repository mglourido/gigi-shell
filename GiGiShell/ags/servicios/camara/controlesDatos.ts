// servicios/camara/controlesDatos.ts
//
// Los controles V4L2 de una cámara: qué son, cómo se leen de la salida de
// `v4l2-ctl` y en qué orden se presentan. SIN E/S — de eso va `controles.ts`,
// que es su único consumidor real. Esta mitad es pura para poder probarla con
// `node --test` sin una cámara enchufada (ver `controlesDatos.test.ts`), que es
// justo lo que no se puede hacer con la otra.
//
// ── POR QUÉ LA UI SE GENERA, EN VEZ DE TENER SLIDERS FIJOS ───────────────────
// El juego de controles lo decide el FIRMWARE de cada cámara, no el kernel. Una
// Logitech C920 publica ~15 (incluido zoom y enfoque); la webcam integrada de un
// portátil barato publica dos: brillo y contraste. Y los rangos tampoco son
// comunes: `brightness` va de 0..255 en unas y de -64..64 en otras, con
// `default` en sitios distintos. Pintar un slider fijo 0..100 y mandar el valor
// tal cual es la receta para que en media de las máquinas el slider mueva la
// imagen en el primer 40% y no haga nada en el resto — sin dar ningún error,
// porque `v4l2-ctl --set-ctrl` ACOTA en silencio al rango real.
//
// Así que se pregunta al aparato (`--list-ctrls-menus`) y se pinta lo que diga:
// slider para `int`, interruptor para `bool`, desplegable para `menu`. Si no
// dice nada, la sección enseña "esta cámara no expone controles" en vez de
// mentir con mandos muertos.
//
// ── `flags=inactive` NO ES DECORATIVO ───────────────────────────────────────
// La mitad de los controles interesantes están encadenados a un automático:
// `white_balance_temperature` sale `inactive` mientras `white_balance_automatic`
// esté encendido, y `exposure_time_absolute` mientras `auto_exposure` esté en
// automático. Escribir en uno inactivo NO da error: `v4l2-ctl` acepta la orden,
// devuelve 0 y el valor no cambia. De ahí que `Control.inactivo` viaje hasta la
// UI, que debe desactivar el mando (y no simplemente dejar que el usuario
// arrastre algo que no hace nada).

export type TipoControl = "int" | "bool" | "menu" | "otro"

export interface OpcionMenu {
  valor: number
  etiqueta: string
}

export interface Control {
  /** Nombre para `--set-ctrl`, p.ej. `brightness`, `white_balance_automatic`. */
  nombre: string
  tipo: TipoControl
  min: number
  max: number
  paso: number
  porDefecto: number
  valor: number
  /** Encadenado a un automático que está encendido: la UI lo deshabilita. */
  inactivo: boolean
  /** Solo para `tipo === "menu"`. */
  opciones: OpcionMenu[]
}

/** Nombres bonitos. Los de V4L2 son identificadores en inglés con guion bajo, y
 *  enseñar `backlight_compensation` crudo en una UI en español es feo pero sobre
 *  todo poco claro. Lo que NO esté aquí se presenta con el nombre crudo
 *  legibilizado (guiones bajos a espacios) — nunca se oculta un control por no
 *  tener traducción: es el mando de una cámara que sí existe. */
const ETIQUETAS: Record<string, string> = {
  brightness: "Brillo",
  contrast: "Contraste",
  saturation: "Saturación",
  hue: "Tono",
  gamma: "Gamma",
  gain: "Ganancia",
  sharpness: "Nitidez",
  backlight_compensation: "Compensación de contraluz",
  white_balance_automatic: "Balance de blancos automático",
  white_balance_temperature_auto: "Balance de blancos automático",
  white_balance_temperature: "Temperatura de color",
  power_line_frequency: "Frecuencia de red",
  auto_exposure: "Exposición automática",
  exposure_auto: "Exposición automática",
  exposure_time_absolute: "Tiempo de exposición",
  exposure_absolute: "Tiempo de exposición",
  exposure_dynamic_framerate: "Fotogramas variables por exposición",
  focus_automatic_continuous: "Enfoque automático",
  focus_auto: "Enfoque automático",
  focus_absolute: "Enfoque",
  zoom_absolute: "Zoom",
  pan_absolute: "Giro horizontal",
  tilt_absolute: "Giro vertical",
  horizontal_flip: "Voltear horizontal",
  vertical_flip: "Voltear vertical",
}

export function etiquetaControl(nombre: string): string {
  return ETIQUETAS[nombre] ?? nombre.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
}

/** Los que merecen estar arriba, en ese orden. El resto va detrás por orden
 *  alfabético de su etiqueta: sin esto la lista sale en el orden en que el
 *  firmware los enumera, que empieza por `brightness` pero después es arbitrario
 *  y coloca `gamma` antes que `contrast`. */
const ORDEN = [
  "brightness", "contrast", "saturation", "sharpness", "gamma", "gain",
  "backlight_compensation",
  "white_balance_automatic", "white_balance_temperature_auto", "white_balance_temperature",
  "auto_exposure", "exposure_auto", "exposure_time_absolute", "exposure_absolute",
  "focus_automatic_continuous", "focus_auto", "focus_absolute",
  "zoom_absolute", "pan_absolute", "tilt_absolute",
  "power_line_frequency",
  "horizontal_flip", "vertical_flip",
]

export function ordenarControles(lista: Control[]): Control[] {
  const peso = (c: Control) => {
    const i = ORDEN.indexOf(c.nombre)
    return i === -1 ? ORDEN.length : i
  }
  return [...lista].sort((a, b) => {
    const d = peso(a) - peso(b)
    if (d !== 0) return d
    return etiquetaControl(a.nombre).localeCompare(etiquetaControl(b.nombre), "es")
  })
}

// ── El parser ───────────────────────────────────────────────────────────────
//
// `v4l2-ctl --list-ctrls-menus` escupe algo así:
//
//     User Controls
//
//                          brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128
//             white_balance_automatic 0x0098090c (bool)   : default=1 value=1
//                white_balance_temperature 0x0098091a (int) : min=2800 max=6500 step=1 default=4600 value=4600 flags=inactive
//                power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=2 value=2
//     				0: Disabled
//     				1: 50 Hz
//     				2: 60 Hz
//
//     Camera Controls
//
//                       auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3
//
// Se parsea a mano y no con `--list-ctrls -C`/JSON porque v4l2-ctl NO tiene
// salida JSON (`--list-ctrls` no acepta ningún formato estructurado en 1.28), y
// este formato lleva siendo el mismo desde hace más de una década.
//
// El parser vive aquí, separado de la E/S, precisamente para poder probarlo con
// la salida real de una cámara pegada en el test.
const RE_CONTROL = /^\s*([\w.]+)\s+0x[0-9a-fA-F]+\s+\((\w+)\)\s*:\s*(.*)$/
const RE_OPCION = /^\s+(\d+):\s*(.*)$/

function tipoDe(crudo: string): TipoControl {
  if (crudo === "int" || crudo === "int64") return "int"
  if (crudo === "bool") return "bool"
  if (crudo === "menu" || crudo === "intmenu") return "menu"
  return "otro"
}

export function parsearControles(salida: string): Control[] {
  const controles: Control[] = []
  let actual: Control | null = null

  for (const linea of salida.split("\n")) {
    const opcion = actual?.tipo === "menu" ? RE_OPCION.exec(linea) : null
    // OJO al orden: una línea de opción de menú (`\t\t1: 50 Hz`) NO casa con
    // RE_CONTROL porque le falta el `0x...`, pero probar antes la opción evita
    // depender de esa coincidencia.
    if (opcion) {
      actual!.opciones.push({ valor: Number(opcion[1]), etiqueta: opcion[2].trim() })
      continue
    }

    const m = RE_CONTROL.exec(linea)
    if (!m) continue

    const campos = new Map<string, string>()
    for (const par of m[3].trim().split(/\s+/)) {
      const i = par.indexOf("=")
      if (i > 0) campos.set(par.slice(0, i), par.slice(i + 1))
    }

    const num = (clave: string, porDefecto: number) => {
      const v = Number(campos.get(clave))
      return Number.isFinite(v) ? v : porDefecto
    }

    const tipo = tipoDe(m[2])
    // `button` y `string` no tienen valor que ajustar ni rango que enseñar.
    // Se descartan aquí y no en la UI para que el "esta cámara no expone
    // controles" sea verdad cuando lo único que hay es un botón de reset.
    if (tipo === "otro") continue

    const control: Control = {
      nombre: m[1],
      tipo,
      // Un `bool` no publica min/max: son 0..1 por definición.
      min: num("min", tipo === "bool" ? 0 : 0),
      max: num("max", tipo === "bool" ? 1 : 0),
      paso: Math.max(1, num("step", 1)),
      porDefecto: num("default", 0),
      valor: num("value", num("default", 0)),
      inactivo: (campos.get("flags") ?? "").includes("inactive"),
      opciones: [],
    }
    controles.push(control)
    actual = control
  }

  return controles
}
