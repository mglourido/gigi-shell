// servicios/energia/suspensionFalsa/leds.ts
//
// Retroiluminación de teclado y LEDs a 0 mientras dure la suspensión falsa. Es el delator
// visual: un equipo suspendido de verdad no tiene el teclado iluminado.
//
// ⚠️ EL SELECTOR DE DISPOSITIVO VA SIEMPRE EXPLÍCITO. Es la otra cara de una trampa ya
// pagada en `servicios/pantalla/brightness.ts`: allí el brillo del panel se escribe con
// `brightnessctl -c backlight …` porque SIN esa clase brightnessctl **no falla** — cae al
// primer dispositivo de la clase `leds` y acaba encendiendo el LED de scroll-lock del
// teclado en cada login, sin un solo error. Aquí la clase que se quiere es justamente
// `leds`, así que el peligro es el simétrico: un `brightnessctl -c leds s 0` a secas
// escribiría en el primero que enumere el kernel, que en esta máquina es `input9::kana`.
// Por eso todo pasa por `-c leds -d <dispositivo>`, uno a uno, con el nombre exacto que se
// ha enumerado — nunca implícito, en ninguna de las dos direcciones.
//
// QUÉ se apaga y qué no lo decide `ledsFiltro.ts` (puro, con test), que es donde está el
// razonamiento largo: se excluyen los LEDs de estado del teclado (los escribe el kernel) y
// los de red/almacenamiento (son información de hardware, y apagar el de la tarjeta de red
// mientras la red sigue viva es apagar el indicador de lo único que esta función promete
// mantener). En una máquina donde no quede ningún LED aplicable —este sobremesa, sin
// `kbd_backlight` ni ningún `/sys/class/backlight`— el efector es un NO-OP limpio: no lanza
// procesos, no avisa y no falla.
//
// La lectura del valor previo va por sysfs y la escritura por brightnessctl, y no es
// incoherencia: `/sys/class/leds/*/brightness` es world-readable pero solo escribible por
// root, y quien resuelve eso (regla udev / logind) es brightnessctl. De paso sysfs da el
// `trigger`, que brightnessctl no publica y que es la mitad del filtro.
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import type { EfectorSuspensionFalsa } from "./efectores"
import { esLedApagable, triggerActivo } from "./ledsFiltro"
import { sfApagarLeds } from "../powerState"

const RAIZ = "/sys/class/leds"

/** Lo que bajamos NOSOTROS: nombre → valor crudo previo. Vacío = no hay nada que restaurar,
 *  que es el contrato de `efectores.ts`. En RAM y solo en RAM: un LED no sobrevive al
 *  proceso como el brillo por DDC (el kernel lo pierde al apagar, y de todas formas el
 *  usuario lo ve encendido o apagado de un vistazo), así que no merece apunte en disco. */
const bajados = new Map<string, number>()

function leerEntero(ruta: string): number | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(ruta)
    if (!ok) return null
    const v = Number(new TextDecoder().decode(bytes).trim())
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function leerTexto(ruta: string): string {
  try {
    const [ok, bytes] = GLib.file_get_contents(ruta)
    return ok ? new TextDecoder().decode(bytes) : ""
  } catch {
    return ""
  }
}

/** Los LEDs vivos AHORA. Se enumera en cada `aplicar()` y no una vez al importar: un teclado
 *  USB con retroiluminación se enchufa a mitad de sesión y sus LEDs aparecen y desaparecen
 *  con él. */
function enumerarLeds(): string[] {
  const nombres: string[] = []
  try {
    const iter = Gio.File.new_for_path(RAIZ)
      .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    for (let info = iter.next_file(null); info !== null; info = iter.next_file(null)) {
      nombres.push(info.get_name())
    }
    iter.close(null)
  } catch {
    // Sin `/sys/class/leds` (o sin permiso para listarlo) no hay nada que hacer: no-op.
  }
  return nombres
}

/** `brightnessctl -c leds -d <dispositivo> s <valor>`. Se lanza y se vuelve: son escrituras
 *  en sysfs de microsegundos y nadie espera su resultado (el contrato prohíbe bloquear la
 *  secuencia). `-n0` no se usa aquí a propósito: el mínimo de brightnessctl es para el
 *  backlight de un panel, y en un LED queremos el 0 de verdad. */
function escribir(dispositivo: string, valor: number): void {
  execAsync(["brightnessctl", "-c", "leds", "-d", dispositivo, "-q", "s", `${valor}`])
    .catch((error) => console.error(`[suspension-falsa] led ${dispositivo}:`, error))
}

export const efectorLeds: EfectorSuspensionFalsa = {
  nombre: "leds",

  aplicar() {
    // El ajuste manda. Sin él no se enumera siquiera: el efector tiene que ser gratis
    // cuando está apagado.
    if (!sfApagarLeds.get()) return

    for (const nombre of enumerarLeds()) {
      const base = `${RAIZ}/${nombre}`
      if (!esLedApagable(nombre, triggerActivo(leerTexto(`${base}/trigger`)))) continue

      const actual = leerEntero(`${base}/brightness`)
      // Ya apagado (o ilegible) → no lo tocamos y, sobre todo, NO lo apuntamos: restaurar
      // solo deshace lo que este efector impuso de verdad. Apuntar un 0 haría que la salida
      // escribiera un 0 en un LED que a lo mejor el usuario ha encendido mientras tanto.
      if (actual === null || actual <= 0) continue

      bajados.set(nombre, actual)
      escribir(nombre, 0)
    }
  },

  restaurar() {
    // Sin nada apuntado, no-op: es también el camino del arranque (`initSuspensionFalsa`
    // llama a todos los efectores por si un AGS muerto dejó algo puesto, y aquí nunca lo
    // deja — los LEDs no sobreviven al proceso).
    for (const [nombre, previo] of bajados) {
      const actual = leerEntero(`${RAIZ}/${nombre}/brightness`)
      // El LED desapareció (teclado desenchufado) → nada que reponer.
      if (actual === null) continue
      // Alguien lo encendió durante la suspensión falsa: manda lo suyo, misma disciplina
      // que el brillo y el DND. Solo reponemos lo que sigue en el 0 que pusimos nosotros.
      if (actual !== 0) continue
      escribir(nombre, previo)
    }
    bajados.clear()
  },
}

