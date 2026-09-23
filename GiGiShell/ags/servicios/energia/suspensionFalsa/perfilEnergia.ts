// servicios/energia/suspensionFalsa/perfilEnergia.ts
//
// El perfil de energía del SISTEMA (`power-profiles-daemon`) mientras dure la suspensión
// falsa. Es el hermano de `tlp.ts` para las máquinas donde TLP no está, y en la práctica
// es el efector que más vatios mueve de toda la función.
//
// ── POR QUÉ EXISTE, SI YA ESTABA EL EFECTOR DE TLP ────────────────────────────────────
// Porque `tlpAvailable` es falso en cualquier sobremesa (necesita `tlp`, el helper root y
// una BATERÍA REAL), así que allí la tarjeta de TLP ni se pinta y la suspensión falsa se
// quedaba SIN NINGÚN control de energía de CPU: apagaba la pantalla, el DND y los LEDs y
// dejaba el paquete corriendo al perfil de siempre. Medido con RAPL
// (`/sys/class/powercap/intel-rapl:0/energy_uj`) en este sobremesa Intel, escritorio en
// reposo, ventanas de 12 s:
//
//     performance   22,10 W  /  17,40 W
//     power-saver    9,97 W  /   9,91 W
//
// O sea entre 7 y 12 W, que es más que todo lo demás de esta lista junto. En un portátil
// los dos efectores conviven sin pisarse: TLP gobierna los periféricos y el disco, PPD el
// EPP/gobernador de la CPU, y cada uno tiene su propio selector.
//
// ── NO HACE FALTA ROOT, Y ESA ES LA DIFERENCIA CON TLP ────────────────────────────────
// `powerprofilesctl` habla por D-Bus con un demonio de sistema que ya autoriza al usuario
// de la sesión activa. No hay helper en `/usr/local/bin`, no hay regla en `sudoers.d`, no
// hay nada que instalar: si el demonio está, esto funciona. Por eso este efector no aparece
// en `system/` ni en `install.sh`.
//
// ── LA DISCIPLINA ES LA DE SIEMPRE: SOLO SE DESHACE LO QUE IMPUSIMOS ──────────────────
// Se apunta el perfil PREVIO y el que pusimos, y al salir se restaura **solo si el perfil
// vivo sigue siendo el nuestro**. Cubre de un golpe los tres casos que importan y sin una
// segunda bandera que pudiera mentir:
//   · el usuario lo cambió a mano mientras dormíamos      → manda lo suyo;
//   · `powerprofilesctl set` falló al entrar               → nunca fue nuestro, no se toca;
//   · algo tomó un HOLD (`powerprofilesctl launch`, que es como un juego o un instalador
//     fuerzan `performance` temporalmente) → `get` devuelve el perfil retenido, la
//     comparación falla y no se lo arrancamos de las manos.
//
// ── EL RESIDUO, Y POR QUÉ SE ACEPTA ───────────────────────────────────────────────────
// Un AGS que muera aquí deja el equipo en `power-saver`. Es residuo BENIGNO y de la misma
// familia que el mute de `audio.ts`: no se pierde nada, no hay dato del usuario en juego, y
// el propio demonio vuelve a su perfil configurado en cuanto se reinicia (o al reiniciar el
// equipo). Nada de apunte en disco: eso está reservado a lo que se pierde EN SILENCIO y
// para siempre, que es el caso del brillo por DDC — aquí lo peor que pasa es que la máquina
// vaya lenta hasta el siguiente arranque, y eso se nota.
//
// ── "NO-TOCAR" NO ES "BALANCED" ───────────────────────────────────────────────────────
// El selector nace en "no-tocar", igual que `sfTlp`: lo que no se impone tampoco se
// restaura, así que un usuario que tenga su propio perfil puesto (o un juego con un hold)
// no se lo encuentra cambiado por haber estrenado la suspensión falsa.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import type { EfectorSuspensionFalsa } from "./efectores"
import { sfPerfilEnergia } from "../powerState"

const CTL = "powerprofilesctl"

/**
 * ¿Se puede ofrecer el selector? Basta con que el binario esté: `powerprofilesctl` viene
 * con el propio demonio, así que su presencia y la del servicio van juntas. Se resuelve una
 * vez al importar, como `tlpAvailable`, porque instalar un demonio de sistema a mitad de
 * sesión no es un caso que haya que cubrir en caliente.
 *
 * Lo consume la UI de Ajustes para ocultar la tarjeta entera donde no aplica, con el mismo
 * criterio que el brillo sin backend DDC: una tarjeta que no puede hacer nada es peor que
 * ninguna tarjeta, porque el usuario la mueve y no pasa nada.
 */
export const ppdDisponible = GLib.find_program_in_path(CTL) !== null

/** El perfil que IMPUSIMOS nosotros y al que hay que volver. Los dos a la vez o ninguno:
 *  `null` = no se impuso nada (ajuste en "no-tocar", sin demonio, o ya estaba puesto). */
let impuesto: string | null = null
let previo: string | null = null

/** El perfil activo AHORA, o `null` si no se puede saber. Nunca lanza: quien llama trata el
 *  `null` como «no tocar nada», que es la degradación correcta en las dos direcciones. */
async function perfilActual(): Promise<string | null> {
  try {
    const salida = await execAsync([CTL, "get"])
    const v = salida.trim()
    return v.length > 0 ? v : null
  } catch (error) {
    console.error("[suspension-falsa] no se pudo leer el perfil de energía:", error)
    return null
  }
}

/** `powerprofilesctl set <perfil>`. Devuelve si de verdad quedó puesto. El `set` falla —y
 *  debe fallar— cuando el perfil no lo ofrece este equipo: hay drivers de CPU que no
 *  publican `power-saver`, y ahí lo correcto es no apuntar nada y salir sin ruido. */
async function fijarPerfil(perfil: string): Promise<boolean> {
  try {
    await execAsync([CTL, "set", perfil])
    return true
  } catch (error) {
    console.error(`[suspension-falsa] no se pudo poner el perfil "${perfil}":`, error)
    return false
  }
}

export const efectorPerfilEnergia: EfectorSuspensionFalsa = {
  nombre: "perfil-energia",

  async aplicar() {
    if (!ppdDisponible) return

    const objetivo = sfPerfilEnergia.get()
    if (objetivo !== "power-saver" && objetivo !== "balanced") return   // "no-tocar"

    const actual = await perfilActual()
    // Ilegible (demonio caído a mitad de sesión) o ya puesto: no se impone NADA, y por eso
    // tampoco se apunta. Apuntarlo haría que la salida fijara un perfil que nunca pusimos.
    if (actual === null || actual === objetivo) return

    // Se apunta ANTES de llamar y se retira si el `set` falla, no al revés: entre las dos
    // líneas hay un `await` que cede el bucle, y una salida que se colara por ahí con el
    // apunte a medias restauraría un perfil que todavía no habíamos cambiado.
    previo = actual
    impuesto = objetivo
    if (!(await fijarPerfil(objetivo))) {
      previo = null
      impuesto = null
    }
  },

  async restaurar() {
    // Sin nada apuntado, no-op y SIN LANZAR NADA. Es también el camino del arranque:
    // `initSuspensionFalsa()` llama a todos los efectores por si un AGS muerto dejó algo
    // puesto, y aquí no puede haberlo (el apunte vive en RAM), así que no se paga ni un
    // proceso por arrancar el shell.
    if (impuesto === null || previo === null) return

    const volverA = previo
    const nuestro = impuesto
    // Se limpia ANTES de esperar a nada: `restaurar()` tiene que ser idempotente y los
    // `await` de abajo ceden el bucle, así que una segunda llamada (el atajo pulsado dos
    // veces, la salida solapada con el plazo) no puede encontrarse el apunte todavía puesto.
    impuesto = null
    previo = null

    const actual = await perfilActual()
    // El usuario lo cambió a mano, algo tomó un hold, o el demonio ya no responde: en los
    // tres casos manda lo que hay. Ver la cabecera.
    if (actual !== nuestro) return
    await fijarPerfil(volverA)
  },
}
