// servicios/energia/tlpAuto.ts
//
// Conmuta el perfil de TLP al entrar y salir del modo ahorro. Hasta ahora el selector de
// Ajustes > Energía era SOLO manual: había que acordarse de darle justo cuando la batería
// está baja, que es cuando menos ganas hay de abrir el panel de ajustes.
//
// Merece la pena porque TLP es, después del brillo, el mayor knob de consumo del sistema:
// un solo `tlp start` toca a la vez `energy_perf_policy`, ASPM del PCIe, APM de los discos,
// el power-save del wifi y el autosuspend de USB. Nada de eso lo puede hacer el shell por
// su cuenta.
//
// Vive aparte de `tlp.ts` a propósito: aquel es el servicio (estado + helper root) y no
// sabe nada del ahorro; meterle aquí la dependencia lo ataría a `powerState` para siempre.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// RESPETAR EL CAMBIO MANUAL, SIN NECESIDAD DE UNA BANDERA
// -------------------------------------------------------
// Al entrar se apunta el modo que había y se pide "ahorro". Al salir solo se restaura **si
// el modo activo sigue siendo el que pusimos**: si el usuario le dio a "Normal" a mano
// durante el ahorro, `tlpMode` ya no es "ahorro" y aquí no se toca nada. Sale gratis
// porque `tlp.ts` solo publica el modo cuando el helper root ha salido con éxito, así que
// `tlpMode` es el estado REAL del sistema, no una intención.
//
// La cola de un solo hueco (`pendiente`) existe porque `setTlpMode` se ignora a sí mismo
// mientras `tlpBusy`: sin ella, entrar en ahorro justo mientras el usuario está aplicando
// un perfil a mano se perdería en silencio y el ahorro se quedaría sin su parte de TLP.
import { tlpAvailable, tlpMode, tlpBusy, setTlpMode, type TlpMode } from "./tlp"
import { powerSaveActive, tlpAutoInPowerSave } from "./powerState"

let arrancado = false
/** Modo que había antes de que el ahorro lo cambiara, o `null` si no hay cambio vigente. */
let modoPrevio: TlpMode | null = null
/** Modo que quedó por aplicar porque el helper estaba ocupado. */
let pendiente: TlpMode | null = null

function pedir(modo: TlpMode): void {
  if (tlpBusy.get()) {
    pendiente = modo
    return
  }
  pendiente = null
  setTlpMode(modo)
}

function reconciliar(): void {
  if (!tlpAvailable) return
  const quiere = powerSaveActive.get() && tlpAutoInPowerSave.get()

  if (quiere) {
    if (modoPrevio === null) modoPrevio = tlpMode.get()
    if (modoPrevio === "ahorro") return   // ya estaba en ahorro por su cuenta: nada que hacer
    pedir("ahorro")
    return
  }

  const previo = modoPrevio
  modoPrevio = null
  pendiente = null
  if (previo === null) return
  // El usuario lo movió a mano durante el ahorro: su elección manda sobre la nuestra.
  if (tlpMode.get() !== "ahorro") return
  pedir(previo)
}

/**
 * Arranca el vigilante. Va con el resto de `init*` de fondo del `setTimeout` de 4 s de
 * `app.ts`: siembra del estado (`tlpMode` se lee de `/etc/gigios/tlp/active` al cargar el
 * módulo), no de eventos ocurridos mientras espera.
 *
 * NO hay recuperación de estado huérfano, y a diferencia del brillo aquí no hace falta: si
 * AGS muere con el perfil de ahorro puesto, el sistema se queda con MENOS consumo y el
 * selector de Ajustes lo enseña tal cual, leído de `/etc`. Es visible y reversible con un
 * clic — al revés que un brillo bajo, que además contamina `display.json`.
 */
export function initTlpAuto(): void {
  if (arrancado || !tlpAvailable) return
  arrancado = true

  powerSaveActive.subscribe(reconciliar)
  tlpAutoInPowerSave.subscribe(reconciliar)
  // Desagua la cola en cuanto el helper suelta el testigo.
  tlpBusy.subscribe(() => {
    if (tlpBusy.get() || pendiente === null) return
    const modo = pendiente
    pendiente = null
    setTlpMode(modo)
  })

  reconciliar()
}
