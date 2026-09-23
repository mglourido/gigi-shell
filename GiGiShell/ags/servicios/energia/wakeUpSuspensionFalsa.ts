// servicios/energia/wakeUpSuspensionFalsa.ts
//
// El PUENTE entre el Wake up y la suspensión falsa: «al vencer la inactividad, entrar en
// suspensión falsa» (regla 2 de «Wake up y suspensión falsa» en docs/suspension-falsa.md).
//
// ── POR QUÉ ESTE FICHERO EXISTE Y NO ES UNA LÍNEA EN mantenerDespierto.ts ──────────────
// `suspensionFalsa.ts` YA importa `mantenerDespiertoActivo` (lo necesita para suprimir y
// rearmar el plazo de suspensión real). Si `mantenerDespierto.ts` importara de vuelta
// `entrarSuspensionFalsa`, se cerraría un CICLO de importación: con módulos ES eso no da
// error de compilación, simplemente uno de los dos ve al otro a medio inicializar y un
// `createState` puede quedarse en `undefined` — fallo en tiempo de ejecución, intermitente
// según el orden de carga y sin nada útil en el log. Este módulo importa de los dos lados
// y NADIE importa de él, así que el grafo sigue siendo acíclico.
//
// ── DE DÓNDE SALE LA SEÑAL «HYPRIDLE HA QUERIDO SUSPENDER» ────────────────────────────
// De un fichero que escribe `hypr/scripts/idle-action.sh` cuando VETA un `suspend`, y de
// nada más. Las alternativas se descartaron por lo siguiente:
//
//   · El script NO aprende reglas nuevas. Sigue vetando el `systemctl suspend` igual que
//     hoy; quien conoce la opción y decide entrar es AGS. Escribir un epoch al vetar no es
//     una regla, es un aviso, y no toca la REGLA DE ORO de fail-open del script.
//   · AGS no tiene forma propia de saber que la inactividad ha vencido: no hay listener de
//     ext-idle-notify en el shell, hypridle no publica nada en D-Bus, y el `IdleHint` de
//     logind no es fiable en una sesión Wayland. Armar un temporizador propio con el
//     timeout leído de `hypridle.conf` no vale: haría falta una señal de ACTIVIDAD para
//     reiniciarlo, y esa es justo la que no existe.
//   · Fichero + `Gio.FileMonitor` es el patrón que ya usa el repo para hablar de bash a AGS
//     (`camara-monitor.sh` → `camara-uso.json` → `servicios/camara/uso.ts`), y a diferencia
//     de un `ags request` no obliga a tocar `app.ts`.
//
// Contrato, deliberadamente mínimo — el fichero contiene el epoch en segundos del veto:
//
//     ~/.config/gigios/idle-suspend-vetado        →  "1756480000"
//
// Mientras el lado bash no lo escriba, este módulo es INERTE: monitoriza un fichero que no
// aparece nunca y no pasa nada. Ese es el modo de fallo que se quiere (la opción no hace
// nada, visible y arreglable) y no el contrario.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import {
  mantenerDespiertoActivo,
  suspensionFalsaAlVencer,
} from "./mantenerDespierto"
import { entrarSuspensionFalsa, suspensionFalsaActiva } from "./suspensionFalsa"
import { sfSustituirReal } from "./powerState"

const RUTA_SENAL = `${GLib.get_user_config_dir()}/gigios/idle-suspend-vetado`

/** Ventana de validez del aviso. Un veto de hace media hora —el fichero que dejó la sesión
 *  anterior— no puede meter al usuario en una suspensión falsa nada más arrancar el shell:
 *  el monitor emite un evento al crearse el vigilante en algunos backends, y el contenido
 *  de un fichero heredado es indistinguible de uno recién escrito si no se mira el reloj. */
const VALIDEZ_SEGUNDOS = 30

let arrancado = false
let monitor: Gio.FileMonitor | null = null
/** Último epoch ya atendido. hypridle no repite un `on-timeout` ya disparado, así que en la
 *  práctica llega un aviso por ciclo; esto cubre el caso de un backend de monitor que emita
 *  CHANGED y CHANGES_DONE_HINT por la misma escritura, que si no entraría dos veces. */
let ultimoAtendido = 0

const instanteActual = () => Math.floor(Date.now() / 1000)

function leerEpochSenal(): number | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA_SENAL)
    if (!ok) return null
    const epoch = Number(new TextDecoder().decode(contenido).trim())
    return Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : null
  } catch (_) {
    return null
  }
}

/**
 * Atiende un aviso de «hypridle quiso suspender y se le vetó».
 *
 * Hay DOS razones distintas para convertir ese veto en una suspensión falsa, y este módulo
 * las atiende las dos porque el aviso que llega es el mismo:
 *
 *  1. **El sustituto** (`sfSustituirReal`): en este equipo la suspensión real no se usa, así
 *     que toda inactividad que fuera a suspender entra en suspensión falsa. No mira el Wake
 *     up ni su opción — es más general que los dos.
 *  2. **El Wake up con su opción encendida**: el caso original, para cuando la suspensión
 *     real sí se usa pero ahora mismo hay algo que proteger.
 *
 * Y una guarda común: **no estamos ya en suspensión falsa**. `entrarSuspensionFalsa()` ya
 * sale sola en ese caso, pero comprobarlo aquí ahorra el viaje y deja la intención escrita
 * (el veto también lo pudo poner la propia suspensión falsa ya puesta).
 */
function atenderSenal() {
  const epoch = leerEpochSenal()
  if (epoch === null) return
  if (epoch <= ultimoAtendido) return
  if (instanteActual() - epoch > VALIDEZ_SEGUNDOS) return
  ultimoAtendido = epoch

  if (suspensionFalsaActiva.get()) return
  const porSustituto = sfSustituirReal.get()
  const porWakeUp = mantenerDespiertoActivo.get() && suspensionFalsaAlVencer.get()
  if (!porSustituto && !porWakeUp) return

  entrarSuspensionFalsa().catch((error) => {
    console.error("[wake-up→suspensión-falsa] no se pudo entrar:", error)
  })
}

/**
 * Arranca el vigilante. Lo cablea `app.ts`; va con los `init*` apartados a los 4 s y no a
 * t=0 porque no limpia nada peligroso: solo se suscribe a un fichero, y los avisos que
 * pudieran caer en esos cuatro segundos son de la sesión anterior y se descartan igual por
 * la ventana de validez.
 */
export function initPuenteWakeUp(): void {
  if (arrancado) return
  arrancado = true

  try {
    const archivo = Gio.File.new_for_path(RUTA_SENAL)
    // El monitor se pone sobre el fichero AUNQUE NO EXISTA todavía: Gio avisa igualmente de
    // su creación. Vigilar el directorio entero traería el ruido de todo `~/.config/gigios`,
    // que es donde escriben media docena de módulos.
    monitor = archivo.monitor_file(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_m, _f, _o, evento: Gio.FileMonitorEvent) => {
      if (
        evento === Gio.FileMonitorEvent.CREATED ||
        evento === Gio.FileMonitorEvent.CHANGED ||
        evento === Gio.FileMonitorEvent.CHANGES_DONE_HINT
      ) {
        atenderSenal()
      }
    })
  } catch (error) {
    console.error("[wake-up→suspensión-falsa] no se pudo vigilar la señal:", error)
  }

  // Un aviso heredado no se atiende, pero su epoch sí se adopta como «ya visto»: así el
  // primer veto REAL de esta sesión (que traerá un epoch mayor) se distingue del residuo.
  const heredado = leerEpochSenal()
  if (heredado !== null) ultimoAtendido = heredado
}
