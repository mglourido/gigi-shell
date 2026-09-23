// servicios/energia/brilloAhorro.ts
//
// Baja el brillo de la pantalla al entrar en modo ahorro y lo devuelve al salir —
// SALVO que el usuario lo haya tocado mientras tanto, en cuyo caso lo suyo manda y aquí
// no se restaura nada.
//
// Es la medida de ahorro con más recorrido de todo el panel: el panel es el mayor
// consumidor único de un portátil, muy por encima de todo el sondeo de fondo que congela
// `freezeBackground`. Por eso nace APAGADA de fábrica: bajar el brillo se ve, y una medida
// que se ve tiene que pedirse.
//
// Cuánto se baja lo decide `brilloAhorroCalculo.ts` (dos modos: apuntar a un brillo fijo o
// restar puntos al que haya). Aquí solo interesa que el objetivo se calcula desde el brillo
// APUNTADO, nunca desde el vivo, y que puede salir `null` = no hay nada que bajar, en cuyo
// caso no se escribe: el modo fijo no sube el brillo jamás.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// CÓMO SE DISTINGUE "LO BAJÉ YO" DE "LO SUBIÓ EL USUARIO"
// -------------------------------------------------------
// No hay señal que lo diga: `brightness` es un único estado y todos escriben en él (el
// slider, las teclas XF86MonBrightness*, las franjas horarias de Ajustes > Pantalla, el
// watcher de udev y nosotros). Se compara con `ultimoAplicado`, el valor que escribimos:
// si el estado se aparta de él más que TOLERANCIA, el cambio es de otro y se TIRA el
// apunte del brillo previo — a partir de ahí ni restauramos al salir ni volvemos a
// imponer el objetivo. Ceder es lo correcto: el usuario acaba de decir explícitamente
// qué brillo quiere con la batería baja.
//
// La tolerancia no es un margen de seguridad arbitrario, cubre un ida y vuelta real:
// `applyBrightness` redondea el canal hardware a un entero por ciento y el watcher de
// udev nos devuelve esa lectura recompuesta con `componerBrillo`. El error máximo de ese
// viaje es 0,65 × 0,005 ≈ 0,003; TOLERANCIA le deja un orden de magnitud de margen para
// la cuantización del backlight, que tiene su propio `max_brightness`.
// (Por debajo de DIM_FLOOR no hay eco de udev en absoluto: ahí el hardware está clavado
// en 0 y `adoptarLecturaHardware` devuelve `null` a propósito.)
//
// ⚠️ EL APUNTE DEL BRILLO PREVIO VIVE EN DISCO, NO EN RAM, y no es opcional. El brillo es
// lo único de este módulo con residuo FÍSICO: por DDC se graba en la firmware del monitor
// y sobrevive al proceso. Si AGS muere con el ahorro puesto, la pantalla se queda baja
// para siempre y además `brightness.subscribe(saveDisplayConfig)` adopta ese valor
// impuesto como si lo hubiera elegido el usuario, borrando el real de `display.json`. Es
// exactamente el fallo que documenta `applyScheduledBrightness` para las franjas horarias.
// Con el apunte en `power-save/config.json`, la restauración pendiente se cobra en el
// arranque siguiente (ver la rama de recuperación de `reconciliar`).
import { brightness, brightnessSupported, applyBrightness } from "../pantalla/brightness"
import {
  powerSaveActive,
  reduceBrightnessInPowerSave,
  powerSaveBrightnessMode,
  powerSaveBrightnessPct,
  powerSaveBrightnessDropPct,
  leerBrilloAntesDelAhorro,
  guardarBrilloAntesDelAhorro,
} from "./powerState"
import { objetivoBrilloAhorro } from "./brilloAhorroCalculo"

/** Ver el bloque de arriba: cubre el redondeo del ida y vuelta hardware→udev→compuesto. */
const TOLERANCIA = 0.03

let arrancado = false
/** ¿Hay una reducción NUESTRA vigente ahora mismo? */
let reducido = false
/** Último valor que escribimos, para reconocer nuestro propio eco. */
let ultimoAplicado: number | null = null

// ─────────────────────────────────────────────────────────────────────────────────────
// LA SUSPENSIÓN FALSA NO TOCA EL BRILLO. NO LO VUELVAS A AÑADIR.
// -------------------------------------------------------------
// Lo tuvo, y estaba mal por dos razones independientes:
//
//  1. **No ahorraba nada.** El paso 2 de la secuencia de entrada es `dpms off`: el panel ya
//     está APAGADO cuando le tocaría el turno al brillo. Bajar el brillo de una pantalla
//     apagada no ahorra un solo vatio; solo escribe.
//  2. **Se veía, y se veía mal.** La salida de la suspensión falsa la dispara el DESBLOQUEO
//     de hyprlock, pero la pantalla la enciende antes cualquier tecla. En esa ventana —de la
//     primera tecla hasta que se teclea la contraseña— el usuario se encontraba el panel al
//     mínimo, y solo volvía a su brillo al desbloquear. Reportado en vivo.
//
// Y en este equipo el brillo va por DDC, así que además dejaba residuo FÍSICO en la firmware
// del monitor (ver la cabecera). Si algún día alguien quiere volver a intentarlo: haría falta
// restaurar el brillo al ENCENDERSE la pantalla, no al desbloquear, y no hay ninguna señal
// fiable de eso — hypridle no emite `on-resume` de un DPMS que apagamos nosotros, que es el
// mismo agujero que documenta «Cómo se sale» en docs/suspension-falsa.md.

/** El objetivo, calculado SIEMPRE desde `base` —el brillo de antes de que bajáramos nada—
 *  y no desde el valor vivo: en modo relativo, partir de lo ya bajado restaría otra vez en
 *  cada reconciliación y la pantalla se apagaría sola a base de eventos. `null` = no hay
 *  nada que bajar (ver `objetivoBrilloAhorro`). */
function objetivoActual(base: number): number | null {
  return objetivoBrilloAhorro(
    base,
    powerSaveBrightnessMode.get(),
    powerSaveBrightnessPct.get(),
    powerSaveBrightnessDropPct.get(),
  )
}

function aplicar(valor: number): void {
  // El orden importa: `applyBrightness` llama a `setBrightness` de forma SÍNCRONA, así que
  // el vigilante de abajo corre dentro de esta misma llamada. Si `ultimoAplicado` no
  // estuviera ya puesto, nuestro propio cambio se leería como un cambio del usuario y
  // tiraría el apunte en el acto.
  ultimoAplicado = valor
  applyBrightness(valor)
}

function reconciliar(): void {
  const quiere = powerSaveActive.get() && reduceBrightnessInPowerSave.get()

  // Sin backend no hay nada que bajar ni que restaurar, y forzarlo escribiría en el vacío
  // (o, en el camino `backlight` ausente, en el LED de scroll-lock: ver brightness.ts).
  // No es un caso raro al arrancar: el sondeo DDC tarda ~1 s y esto puede correr antes.
  if (!brightnessSupported.get()) return

  if (quiere) {
    if (!reducido) {
      reducido = true
      // Apunte SÍNCRONO en disco antes de tocar nada (ver la cabecera). Solo si no hay
      // uno ya: un apunte vivo al ENTRAR es el que dejó un AGS que murió reduciendo, y
      // el brillo de ahora es el que él bajó — pisarlo con eso perdería el valor real
      // para siempre, que es justo lo que el apunte existe para evitar.
      if (leerBrilloAntesDelAhorro() === null) guardarBrilloAntesDelAhorro(brightness.get())
    }
    // Con el apunte ya tirado (el usuario tomó el mando durante el ahorro) no se vuelve a
    // imponer nada: la reducción sigue "vigente" solo para no re-armarse sola.
    const base = leerBrilloAntesDelAhorro()
    if (base === null) return
    const objetivo = objetivoActual(base)
    // Sin margen para bajar (ya se está en el suelo, o el objetivo fijo subiría y la
    // reducción relativa tampoco llega): no se escribe nada. El apunte se queda puesto y
    // la salida del ahorro repone el mismo valor, que es inofensivo.
    if (objetivo === null) return
    if (ultimoAplicado !== null && Math.abs(ultimoAplicado - objetivo) < 0.001) return
    aplicar(objetivo)
    return
  }

  // Salida del ahorro — o recuperación de un apunte huérfano que dejó un AGS muerto: son
  // el mismo camino a propósito, y por eso la condición mira el DISCO y no `reducido`.
  const previo = leerBrilloAntesDelAhorro()
  reducido = false
  ultimoAplicado = null
  if (previo === null) return
  guardarBrilloAntesDelAhorro(null)
  applyBrightness(previo)
}

/**
 * Arranca el vigilante. Va con el resto de `init*` de fondo del `setTimeout` de 4 s de
 * `app.ts`: siembra del ESTADO (`powerSaveActive` ya está resuelto y el apunte está en
 * disco), no de eventos ocurridos mientras espera.
 */
export function initBrilloAhorro(): void {
  if (arrancado) return
  arrancado = true

  // Cualquier escritura ajena durante nuestra reducción cede el mando definitivamente.
  brightness.subscribe(() => {
    if (!reducido || ultimoAplicado === null) return
    if (leerBrilloAntesDelAhorro() === null) return
    if (Math.abs(brightness.get() - ultimoAplicado) <= TOLERANCIA) return
    guardarBrilloAntesDelAhorro(null)
  })

  powerSaveActive.subscribe(reconciliar)
  reduceBrightnessInPowerSave.subscribe(reconciliar)
  powerSaveBrightnessMode.subscribe(reconciliar)
  powerSaveBrightnessPct.subscribe(reconciliar)
  powerSaveBrightnessDropPct.subscribe(reconciliar)
  // El backend puede confirmarse DESPUÉS de esto (DDC tarda ~1 s): sin esta suscripción,
  // arrancar ya dentro del ahorro no bajaría el brillo nunca, y un apunte huérfano de un
  // AGS muerto no se recuperaría hasta el siguiente cambio de estado.
  brightnessSupported.subscribe(reconciliar)

  reconciliar()
}
