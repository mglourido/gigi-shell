// servicios/energia/refrescoAhorro.ts
//
// Baja la tasa de refresco (Hz) de los monitores al entrar en modo ahorro y devuelve la de
// siempre al salir. Los Hz que se ponen los elige el usuario en Ajustes > Energía.
//
// SOLO EN VIVO, Y NO SE PERSISTE NADA. El cambio va por `aplicarModoTemporal` (que no toca
// `monitorPrefs` ni display.json) y el modo que había se guarda en `modoAntesDelAhorro`,
// en RAM. Es la decisión que distingue esto del brillo: el brillo por DDC se graba en la
// firmware del monitor y necesita un apunte en disco; un modo de vídeo no deja residuo, y
// display.json —de donde lo lee `hypr/gigishell/pantalla.lua— sigue diciendo los Hz
// normales. Si AGS muere con el ahorro puesto, el siguiente `hyprctl reload` o inicio de
// sesión los repone solo. La contrapartida: un `hyprctl reload` DURANTE el ahorro también
// los repone y aquí no hay señal de recarga que lo vea; se queda a los Hz normales hasta la
// siguiente transición.
//
// SOLO BAJA. Si el monitor ya va a los Hz elegidos o a menos, no se toca: un «ahorro» que
// subiera de 60 a 144 Hz gastaría más, y el ajuste existe para lo contrario.
//
// Si el usuario cambia el modo de un monitor a mano durante el ahorro, `applyPatch` retira
// la entrada de `modoAntesDelAhorro` y aquí ya no hay nada que devolver en ese monitor.
//
// Lee los monitores con `hyprctl monitors all -j` en cada pasada en vez de suscribirse a
// `monitors` de service.ts: ese estado solo se sondea con Ajustes abierto.
import { execAsync } from "ags/process"
import { modoMasCercanoAHz } from "../pantalla/modes"
import { aplicarModoTemporal, modoAntesDelAhorro } from "../pantalla/service"
import {
  powerSaveActive,
  reduceRefreshInPowerSave,
  powerSaveRefreshHz,
} from "./powerState"

let arrancado = false
/** Las pasadas no se solapan: un `hyprctl monitors` viejo pisaría a uno más reciente. */
let enCurso = false
let repetir = false

/** El modo del monitor tal como lo escribe `availableModes`, para poder devolverlo exacto. */
function modoActual(mon: any): string {
  const vivo = Math.round(mon.refreshRate * 100) / 100
  return modoMasCercanoAHz(mon.availableModes ?? [], mon.width, mon.height, vivo)
    ?? `${mon.width}x${mon.height}@${mon.refreshRate.toFixed(2)}Hz`
}

async function pasada(): Promise<void> {
  const quiere = powerSaveActive.get() && reduceRefreshInPowerSave.get()
  let lista: any[]
  try { lista = JSON.parse(await execAsync(["hyprctl", "monitors", "all", "-j"])) } catch { return }

  for (const mon of lista) {
    if (mon.disabled) continue
    const previo = modoAntesDelAhorro.get(mon.name)

    if (quiere) {
      // Se decide contra el modo NORMAL (`previo`, o el vivo si aún no hay ahorro puesto):
      // con el ahorro ya aplicado el modo vivo es el nuestro, y compararlo con él impediría
      // tanto subir a otro valor elegido como volver al normal si el elegido ya no baja.
      const normal = previo ?? modoActual(mon)
      const objetivo = modoMasCercanoAHz(mon.availableModes ?? [], mon.width, mon.height, powerSaveRefreshHz.get())
      const baja = objetivo !== null && parseFloat(objetivo.split("@")[1]) < parseFloat(normal.split("@")[1])
      const deseado = baja ? objetivo! : normal
      if (!baja) modoAntesDelAhorro.delete(mon.name)
      else if (!previo) modoAntesDelAhorro.set(mon.name, normal)
      if (modoActual(mon) !== deseado) await aplicarModoTemporal(mon, deseado)
      continue
    }

    // Salida del ahorro (o el ajuste se apagó): devolver lo que quitamos.
    if (!previo) continue
    modoAntesDelAhorro.delete(mon.name)
    if (modoActual(mon) !== previo) await aplicarModoTemporal(mon, previo)
  }

  // Monitores que desaparecieron durante el ahorro: su entrada ya no significa nada.
  if (!quiere) modoAntesDelAhorro.clear()
}

function reconciliar(): void {
  if (enCurso) { repetir = true; return }
  enCurso = true
  pasada()
    .catch(e => console.error("[refresco-ahorro]", e))
    .finally(() => {
      enCurso = false
      if (repetir) { repetir = false; reconciliar() }
    })
}

/**
 * Arranca el vigilante. Va con el resto de `init*` de fondo del `setTimeout` de 4 s de
 * `app.ts`: siembra del ESTADO (`powerSaveActive` ya está resuelto), no de eventos. No hay
 * nada que recuperar de un AGS anterior porque no se deja nada en disco.
 */
export function initRefrescoAhorro(): void {
  if (arrancado) return
  arrancado = true
  powerSaveActive.subscribe(reconciliar)
  reduceRefreshInPowerSave.subscribe(reconciliar)
  powerSaveRefreshHz.subscribe(reconciliar)
  reconciliar()
}
