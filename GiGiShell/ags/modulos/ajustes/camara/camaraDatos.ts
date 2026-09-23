// modulos/ajustes/camara/camaraDatos.ts
//
// Lo PURO de Ajustes > Cámara: componer la lista que se pinta y las cadenas de
// resumen. Sin GTK ni E/S, para poder probarlo con `node --test` — que en esta
// máquina es lo ÚNICO comprobable de toda la sección, porque es un sobremesa
// sin webcam (`/dev/video*` no existe). Ver `camaraDatos.test.ts`.
//
// ── POR QUÉ LA LISTA MEZCLA PRESENTES Y RECORDADAS ──────────────────────────
// La sección no lista `camaras` a secas. Una webcam USB desenchufada cuyos
// ajustes siguen en `camara.json` tiene que poder verse y OLVIDARSE desde aquí:
// si solo se listara lo presente, esos ajustes quedarían huérfanos en el disco
// —y se volverían a imponer en cuanto se reenchufara— sin ninguna forma de
// borrarlos que no fuera editar el JSON a mano. Lo que sí desaparece del todo
// es la sección entera cuando no hay NI presentes NI recordadas (ver
// `haySeccionCamara`): en un equipo que nunca ha visto una cámara no hay nada
// que enseñar, y un destino vacío en la nav es peor que ningún destino.
import type { Camara } from "../../../servicios/camara/dispositivos.ts"
import type { EstadoCamara } from "../../../servicios/camara/persistencia.ts"
import type { Control } from "../../../servicios/camara/controlesDatos.ts"
import type { Formato } from "../../../servicios/camara/formatosDatos.ts"

export interface CamaraConocida {
  clave: string
  nombre: string
  /** Está enchufada AHORA. Con `false` solo se puede olvidar lo guardado: sin
   *  nodo no hay nada a lo que hablarle por `v4l2-ctl`. */
  presente: boolean
  /** `/dev/videoN` mientras esté presente; `null` si solo es un recuerdo. */
  nodo: string | null
  usb: boolean
  /** Cuántos controles hay guardados para ella. 0 = nada que olvidar. */
  guardados: number
  preferida: boolean
}

/** ¿Se pinta el destino «Cámara» en la navegación de Ajustes? Ver la cabecera. */
export function haySeccionCamara(presentes: Camara[], estado: EstadoCamara): boolean {
  return presentes.length > 0 || Object.keys(estado.dispositivos).length > 0
}

/**
 * Une lo que hay enchufado con lo que hay guardado, sin duplicar: la clave de
 * `Camara` y la del JSON son la MISMA (serial o vendor:product, nunca el nodo),
 * así que una cámara presente y recordada sale una sola vez y con `presente`.
 *
 * Las presentes van primero; dentro de cada mitad, por nombre. Sin ese orden la
 * lista dependería del orden de inserción del objeto JSON, o sea del historial
 * del usuario: dos webcams idénticas cambiarían de sitio entre sesiones.
 */
export function camarasConocidas(presentes: Camara[], estado: EstadoCamara): CamaraConocida[] {
  const lista: CamaraConocida[] = presentes.map((c) => ({
    clave: c.clave,
    nombre: c.nombre,
    presente: true,
    nodo: c.nodo,
    usb: c.usb,
    guardados: Object.keys(estado.dispositivos[c.clave]?.controles ?? {}).length,
    preferida: estado.preferida === c.clave,
  }))
  const vistas = new Set(lista.map((c) => c.clave))

  for (const [clave, ajustes] of Object.entries(estado.dispositivos)) {
    if (vistas.has(clave)) continue
    lista.push({
      clave,
      // Se guardó el nombre justo para esto: enseñar «Logitech C920
      // (desconectada)» sin tener el aparato delante. Si falta (un JSON escrito
      // por una versión anterior), la clave cruda es mejor que "Cámara" a secas,
      // que sería indistinguible entre dos entradas.
      nombre: ajustes.nombre || clave,
      presente: false,
      nodo: null,
      // Solo se desenchufa lo que es USB; una integrada que no está es una
      // integrada de OTRA máquina cuyo JSON se ha copiado, y también es USB
      // por dentro en casi todos los portátiles. No se afirma nada: la UI de
      // una ausente no enseña el tipo, solo «desconectada».
      usb: true,
      guardados: Object.keys(ajustes.controles ?? {}).length,
      preferida: estado.preferida === clave,
    })
  }

  return lista.sort((a, b) => {
    if (a.presente !== b.presente) return a.presente ? -1 : 1
    return a.nombre.localeCompare(b.nombre, "es")
  })
}

/**
 * La ficha de formatos en UNA línea: `"MJPG hasta 1920x1080 · YUYV hasta 1280x720"`.
 *
 * Es INFORMATIVA y la UI no debe fingir otra cosa (ver la cabecera de
 * `servicios/camara/formatosDatos.ts`): la resolución la negocia la app al abrir
 * el stream, no se puede imponer desde fuera. Por eso se resume en vez de
 * pintar las 30 resoluciones que publica una webcam corriente — una lista
 * exhaustiva invita a creer que se puede elegir una.
 *
 * Se cortan a `maximo` formatos porque hay cámaras que publican seis o siete
 * variantes del mismo YUV y la línea se vuelve ilegible.
 */
export function resumenFormatos(formatos: Formato[], maximo = 3): string {
  const utiles = formatos.filter((f) => f.resoluciones.length > 0)
  if (!utiles.length) return ""
  const partes = utiles.slice(0, maximo).map((f) => `${f.codigo} hasta ${f.resoluciones[0]}`)
  if (utiles.length > maximo) partes.push("…")
  return partes.join(" · ")
}

/**
 * Acota y "cuantiza" un valor al rango real del control.
 *
 * Hace falta porque `Gtk.Scale` emite valores continuos y `v4l2-ctl --set-ctrl`
 * ACOTA en silencio (sale con 0 y aplica otra cosa). Sin esto, un control con
 * `step=5` recibiría 37 y el aparato guardaría 35: se persistiría un 37 que la
 * siguiente relectura contradice, y el slider daría un tirón hacia atrás sin
 * que nada explique por qué.
 */
export function ajustarAlPaso(valor: number, control: Pick<Control, "min" | "max" | "paso">): number {
  const paso = control.paso > 0 ? control.paso : 1
  const acotado = Math.min(control.max, Math.max(control.min, valor))
  const pasos = Math.round((acotado - control.min) / paso)
  return Math.min(control.max, control.min + pasos * paso)
}
