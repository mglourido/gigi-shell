// servicios/camara/controles.ts
//
// La mitad de E/S de los controles V4L2: hablar con `v4l2-ctl`. Los tipos, el
// parser y el orden viven en `controlesDatos.ts`, que es puro y está probado.
//
// ── `flags=inactive` NO ES DECORATIVO ───────────────────────────────────────
// La mitad de los controles interesantes están encadenados a un automático:
// `white_balance_temperature` sale `inactive` mientras `white_balance_automatic`
// esté encendido, y `exposure_time_absolute` mientras `auto_exposure` esté en
// automático. Escribir en uno inactivo NO da error: `v4l2-ctl` acepta la orden,
// devuelve 0 y el valor no cambia. De ahí que `Control.inactivo` viaje hasta la
// UI, que debe desactivar el mando (y no dejar que el usuario arrastre algo que
// no hace nada).
import { execAsync } from "ags/process"
import { parsearControles, ordenarControles, type Control } from "./controlesDatos.ts"

export * from "./controlesDatos.ts"

/** Lee los controles de un nodo. Devuelve `[]` ante cualquier fallo (cámara
 *  desenchufada entre la enumeración y esta llamada, `v4l2-ctl` ausente): la UI
 *  ya sabe pintar "sin controles", que es lo cierto en todos esos casos. */
export async function leerControles(nodo: string): Promise<Control[]> {
  try {
    const salida = await execAsync(["v4l2-ctl", "-d", nodo, "--list-ctrls-menus"])
    return ordenarControles(parsearControles(salida))
  } catch (e) {
    console.error("[camara] list-ctrls:", e)
    return []
  }
}

/** Escribe UN control. Resuelve a `true` si `v4l2-ctl` no protestó.
 *
 *  Cuidado con lo que eso significa: `--set-ctrl` sale con 0 aunque el control
 *  esté `inactive` (ver cabecera) y aunque el valor se acote. "Sin error" no es
 *  "se aplicó lo que pediste"; por eso quien llame debe releer si le importa el
 *  valor final, cosa que `aplicarControl` hace por él. */
export async function fijarControl(nodo: string, nombre: string, valor: number): Promise<boolean> {
  try {
    await execAsync(["v4l2-ctl", "-d", nodo, "--set-ctrl", `${nombre}=${valor}`])
    return true
  } catch (e) {
    console.error(`[camara] set-ctrl ${nombre}=${valor}:`, e)
    return false
  }
}

/** Escribe varios de una vez. Una sola invocación de `v4l2-ctl` con varios
 *  `--set-ctrl`: restaurar 12 controles al arrancar con 12 procesos tardaba
 *  lo suyo, y además el orden importa (un automático debe fijarse ANTES que el
 *  manual al que gobierna, o el manual entra `inactive` y se pierde). */
export async function fijarControles(nodo: string, valores: Record<string, number>): Promise<boolean> {
  const pares = Object.entries(valores)
  if (!pares.length) return true
  // Los `*_auto*` primero: si `white_balance_automatic=0` no se ha aplicado
  // todavía, el `white_balance_temperature=5200` que va detrás cae en un control
  // inactivo y se descarta EN SILENCIO. Este orden es la diferencia entre que
  // los ajustes guardados se restauren o no.
  const esAuto = (n: string) => /auto/i.test(n)
  pares.sort((a, b) => Number(esAuto(b[0])) - Number(esAuto(a[0])))
  const args = ["v4l2-ctl", "-d", nodo]
  for (const [nombre, valor] of pares) args.push("--set-ctrl", `${nombre}=${valor}`)
  try {
    await execAsync(args)
    return true
  } catch (e) {
    console.error("[camara] set-ctrl (lote):", e)
    return false
  }
}

/** Devuelve los controles a los valores de fábrica del propio aparato
 *  (`default=` de cada uno), que no es lo mismo que "los que tenía al empezar
 *  la sesión". Es lo que quiere el botón "Restablecer". */
export async function restablecerControles(nodo: string): Promise<Control[]> {
  const actuales = await leerControles(nodo)
  const valores: Record<string, number> = {}
  for (const c of actuales) valores[c.nombre] = c.porDefecto
  await fijarControles(nodo, valores)
  return leerControles(nodo)
}
