// servicios/energia/suspensionFalsa/bluetooth.ts
//
// Apagar el Bluetooth mientras dure la suspensión falsa. Nace APAGADO en los ajustes
// (`sfBluetooth`), como todo lo que se ve o puede molestar: es lo que hace de facto la
// suspensión real, pero un teclado o unos cascos BT que dejan de responder es justo lo que
// alguien puede no querer.
//
// ── SOLO SE ENCIENDE LO QUE APAGAMOS NOSOTROS ─────────────────────────────────────────
// Si el usuario ya lo tenía apagado, al salir NO se enciende. Suena obvio y es la mitad del
// contrato de `efectores.ts`, pero aquí tiene un filo extra: encender el BT tiene efectos
// que apagarlo no tiene (el dongle RTL8761 de esta máquina **se reenumera** al encender, con
// su carga de firmware y sus segundos de ausencia), así que un encendido de más no es una
// operación neutra que nadie note.
//
// ── EL APAGADO SE ESCRIBE EN system_state.json, Y HAY QUE SABERLO ─────────────────────
// La restauración de arranque de `QuickSettings.tsx` **adopta como intención del usuario**
// cualquier cambio de encendido que llegue con su ventana ya cerrada, y lo persiste en
// `~/.config/gigios/system_state.json`. O sea que nuestro apagado se guarda como si lo
// hubiera pedido el usuario, y nuestro encendido lo vuelve a guardar al salir: en un ciclo
// completo la cuenta cuadra y el fichero acaba como estaba. Lo que NO cuadra es un AGS que
// muera a mitad — el disco se queda con `bluetooth: false` y el arranque siguiente arranca
// con el BT apagado. Es un modo de fallo aceptable (visible en el tile, reversible con un
// clic) y se prefiere a la alternativa, que sería pelearse con la restauración de allí desde
// aquí: dos módulos disputándose la misma intención es justo el bug que aquel documenta.
//
// ── LA VUELTA NO SE ESPERA ────────────────────────────────────────────────────────────
// Encender puede tardar segundos (reenumeración + reintentos contra los `Error.Busy` de
// BlueZ). El contrato prohíbe bloquear la salida: hay una persona esperando con la pantalla
// encendida. Así que `restaurar()` lanza la secuencia y vuelve.
import AstalBluetooth from "gi://AstalBluetooth"
import { execAsync } from "ags/process"
import { esperar } from "./espera"
import type { EfectorSuspensionFalsa } from "./efectores"
import { sfApagarBluetooth } from "../powerState"

/** Reintentos del encendido y espera entre ellos. Los números salen de `setBluetoothPower`
 *  en `QuickSettings.tsx`, que ya midió este dongle: al desbloquear, el kernel arranca por su
 *  cuenta una transición `off-enabling` durante la cual BlueZ responde `Error.Busy`, y otros
 *  USB desaparecen unos segundos de BlueZ y vuelven ya encendidos. */
const INTENTOS = 16
const ESPERA_MS = 350

/** ¿Lo apagamos nosotros? En RAM: un crash de AGS deja el BT apagado y el usuario lo ve en
 *  el tile de la barra, que es un residuo visible y reversible con un clic — no hace falta
 *  apunte en disco como en el brillo, que se pierde en silencio. */
let apagadoPorNosotros = false

function adaptador() {
  try {
    const bt = AstalBluetooth.get_default()
    return bt?.adapter ? bt : null
  } catch {
    return null
  }
}

async function encenderConReintentos(): Promise<void> {
  // Un dongle puede no estar sujeto a rfkill; que esto falle no es motivo para abortar,
  // BlueZ todavía puede encender el adaptador.
  await execAsync(["rfkill", "unblock", "bluetooth"]).catch(() => {})
  await esperar(250)
  for (let intento = 0; intento < INTENTOS; intento++) {
    if (adaptador()?.isPowered) return
    try {
      await execAsync(["bluetoothctl", "power", "on"])
      return
    } catch (_) {
      await esperar(ESPERA_MS)
    }
  }
  console.error("[suspension-falsa] no se pudo volver a encender el Bluetooth")
}

export const efectorBluetooth: EfectorSuspensionFalsa = {
  nombre: "bluetooth",

  async aplicar() {
    if (!sfApagarBluetooth.get()) return
    const bt = adaptador()
    // Sin adaptador (dongle desenchufado, o esta máquina no tiene BT) no hay nada que hacer,
    // y sobre todo no se apunta nada: no-op limpio en las dos direcciones.
    if (!bt || !bt.isPowered) return

    apagadoPorNosotros = true
    try {
      await execAsync(["bluetoothctl", "power", "off"])
    } catch (error) {
      // Si el apagado falló, no lo hemos apagado: retirar el apunte es lo que impide que la
      // salida ENCIENDA un adaptador que el usuario podría querer apagado.
      apagadoPorNosotros = false
      console.error("[suspension-falsa] no se pudo apagar el Bluetooth:", error)
    }
  },

  restaurar() {
    if (!apagadoPorNosotros) return
    apagadoPorNosotros = false

    const bt = adaptador()
    // El usuario lo volvió a encender durante la suspensión falsa (o el dongle se reenumeró
    // y BlueZ lo encendió con su `AutoEnable`): ya está donde tiene que estar.
    if (!bt || bt.isPowered) return

    // Sin `await`: ver la cabecera. La salida no puede quedarse esperando a un dongle.
    encenderConReintentos().catch((error) => {
      console.error("[suspension-falsa] restaurar Bluetooth:", error)
    })
  },
}
