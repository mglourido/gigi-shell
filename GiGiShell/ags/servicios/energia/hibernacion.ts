// servicios/energia/hibernacion.ts
//
// UN solo número en Ajustes ("hibernar tras N minutos de inactividad") y DOS mecanismos
// distintos por debajo. Este fichero es el que elige cuál, y conviene saber por qué existe la
// elección antes de tocar nada:
//
//   • Durante una suspensión (S3) el userspace está CONGELADO. hypridle no cuenta, AGS no
//     cuenta, ningún script cuenta. Un `listener { timeout = 3000 }` de hibernación con la
//     suspensión puesta a los 20 min NO SE DISPARA JAMÁS — y sin un solo error: el equipo se
//     duerme a los 20 y ahí se queda. Es exactamente el fallo mudo que este repo evita.
//   • Lo único que sí puede contar con el equipo dormido es el RELOJ DE LA PLACA. Eso es
//     `systemctl suspend-then-hibernate`: antes de dormirse arma una alarma RTC a
//     `HibernateDelaySec`, el equipo despierta solo al vencer y se hiberna.
//
// De ahí las dos rutas, que se eligen solas a partir del número que puso el usuario:
//
//   modo "retardo"   (el normal): hay suspensión y el total es MAYOR que ella.
//                    → HibernateDelaySec = total − suspensión, y idle-action.sh suspende con
//                      `suspend-then-hibernate`. El listener de hibernación queda APAGADO.
//                      Regalo de este camino: también cubre las suspensiones que no vienen de
//                      la inactividad (tapa, botón, menú de energía).
//   modo "listener"  (minoritario): no hay suspensión, o el total es MENOR o igual que ella.
//                    → listener de hypridle a `total`, hibernando directo sin pasar por el S3.
//
// Quién guarda qué:
//   ~/.config/gigios/hibernacion.json   ← LA AUTORIDAD (enabled + totalSeconds + modo).
//                                          Lo lee idle-action.sh para saber si suspende con
//                                          alarma o sin ella.
//   hypridle.conf, listener `hibernate` ← espejo del total; solo está ENCENDIDO en modo listener.
//   /etc/systemd/sleep.conf.d/99-gigios-hibernacion.conf ← HibernateDelaySec (lo escribe el
//                                          helper root, ver system/hibernacion/).
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { createState } from "ags"
import { abrirEnTerminal } from "../../utilidades/abrirTerminal"
import { planificar, type AjusteHibernacion, type ModoHibernacion } from "./planHibernacion"
import { RAIZ_REPO } from "../../utilidades/rutas"

const ARCHIVO = `${GLib.get_user_config_dir()}/gigios/hibernacion.json`

// El reparto en sí es lógica pura y vive aparte para poder probarlo bajo `node --test`; aquí
// solo está el efecto. Se reexporta para que los llamantes tengan un único sitio al que mirar.
export { planificar } from "./planHibernacion"
export type { AjusteHibernacion, ModoHibernacion, PlanHibernacion } from "./planHibernacion"

/** Valor de partida: apagado, y 50 min si algún día se enciende. */
const POR_DEFECTO: AjusteHibernacion = { enabled: false, totalSeconds: 3000 }

// ── Disponibilidad ───────────────────────────────────────────────────────────
//
// No se asume: se pregunta. `gigios-hibernacion estado` consulta a logind, que es quien sabe si
// hay swap persistente suficiente Y `resume=` en la línea de comandos del kernel. En una máquina
// recién instalada sin el paso `hibernacion` del instalador, o antes del primer reinicio tras
// ejecutarlo, la respuesta es "no" — y entonces la fila de Ajustes sale apagada CON SU MOTIVO,
// en vez de ser un interruptor que promete algo que fallaría de madrugada sin testigos.
// Se declara el par entero y se exporta solo el lector: nadie de fuera debe poder afirmar que
// la máquina puede hibernar; eso lo dice logind y lo escribe `comprobarHibernacion()`.
const [disponible, setDisponible] = createState(false)
const [motivo, setMotivo] = createState("")
export { disponible as hibernacionActivable, motivo as hibernacionMotivo }

function traducirMotivo(clave: string): string {
  switch (clave) {
    case "sin-swap-o-sin-resume":
      return "Este equipo no puede hibernar todavía: falta swap persistente o el parámetro resume= del kernel. Ejecuta: bash ~/GiGiShell/install.sh --solo hibernacion (y reinicia)."
    case "prohibido-por-politica":
      return "La política del sistema no permite hibernar en esta sesión."
    case "logind-no-responde":
      return "No pude preguntarle a logind si el equipo puede hibernar."
    default:
      return "La hibernación no está disponible en este equipo."
  }
}

/** Refresca `hibernacionActivable`/`hibernacionMotivo`. Silencioso: nunca lanza. */
export function comprobarHibernacion(): void {
  execAsync(["/usr/local/bin/gigios-hibernacion", "estado"])
    .then((salida) => {
      const campos = new Map<string, string>()
      for (const linea of String(salida).split("\n")) {
        const i = linea.indexOf("=")
        if (i > 0) campos.set(linea.slice(0, i).trim(), linea.slice(i + 1).trim())
      }
      const ok = campos.get("disponible") === "si"
      setDisponible(ok)
      setMotivo(ok ? "" : traducirMotivo(campos.get("motivo") ?? ""))
    })
    .catch(() => {
      // El helper no está instalado (falta el paso `hibernacion` del instalador). Es el mismo
      // resultado práctico que "no se puede": fila apagada y motivo a la vista.
      setDisponible(false)
      setMotivo("Falta el ayudante de hibernación. Ejecuta: bash ~/GiGiShell/install.sh --solo hibernacion")
    })
}

// ── Ajuste del usuario ───────────────────────────────────────────────────────

export function leerHibernacion(): AjusteHibernacion {
  try {
    const [ok, contenido] = GLib.file_get_contents(ARCHIVO)
    if (!ok) return { ...POR_DEFECTO }
    const datos = JSON.parse(new TextDecoder().decode(contenido))
    return {
      enabled: datos?.enabled === true,
      totalSeconds: typeof datos?.totalSeconds === "number" && datos.totalSeconds > 0
        ? datos.totalSeconds
        : POR_DEFECTO.totalSeconds,
    }
  } catch (_) {
    // JSON roto o ilegible degrada a "apagado", no a un tiempo inventado: encender la
    // hibernación sola porque un fichero no se pudo leer sería una sorpresa muy cara.
    return { ...POR_DEFECTO }
  }
}

function escribirEstado(ajuste: AjusteHibernacion, modo: ModoHibernacion): void {
  try {
    const dir = GLib.path_get_dirname(ARCHIVO)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(ARCHIVO, JSON.stringify({ ...ajuste, modo }))
  } catch (e) {
    console.error("[hibernacion] no se pudo guardar el ajuste:", e)
  }
}

/**
 * Aplica el plan: escribe el estado que lee idle-action.sh y empuja el retardo a systemd.
 * Devuelve la línea del listener para que el llamador la meta en hypridle.conf en la MISMA
 * escritura que los demás tiempos (una sola pasada, un solo reinicio de hypridle).
 *
 * El retardo se manda SIEMPRE, incluso 0 (que borra el drop-in). Dejar un HibernateDelaySec
 * viejo al apagar la hibernación haría que cualquier `suspend-then-hibernate` de fuera de aquí
 * siguiera hibernando con el tiempo antiguo.
 */
export function aplicarHibernacion(
  ajuste: AjusteHibernacion,
  suspension: { timeout: number; enabled: boolean },
): { timeout: number; enabled: boolean } {
  const plan = planificar(ajuste, suspension)
  escribirEstado(ajuste, plan.modo)
  // `sudo -n`: si la regla sudoers no está instalada esto falla en el acto en vez de quedarse
  // esperando una contraseña que nadie va a teclear (el mismo motivo que en install.sh).
  execAsync(["sudo", "-n", "/usr/local/bin/gigios-hibernacion", "retardo", String(plan.retardo)])
    .catch((e) => console.error("[hibernacion] no se pudo fijar HibernateDelaySec:", e))
  return plan.listener
}

// ── Preparar / quitar el sistema entero ──────────────────────────────────────
//
// Esto NO es el ajuste del tiempo (arriba): es la instalación de disco y arranque que lo
// hace posible en absoluto — swapfile persistente, resume= del kernel, conservación de
// VRAM de NVIDIA. Se lanza en una TERMINAL con `sudo` interactivo (`abrirEnTerminal`) y no
// por un helper NOPASSWD: crear/borrar un fichero de varios GiB y reescribir la línea de
// comandos del kernel no es algo que un clic silencioso deba poder hacer. El mismo patrón
// que ya usaba "Actualizaciones" de la barra para `sudo pacman -Syu`.
//
// Las dos reconsultan `comprobarHibernacion()` al cerrarse la terminal (el usuario ya vio
// la salida y pulsó Enter/cerró la ventana), para que la fila de Ajustes refleje el nuevo
// estado sin tener que reabrir el panel. Quitar SÍ se nota en el acto (el script hace
// `swapoff` antes que nada); preparar sigue sin notarse hasta reiniciar (resume= es cosa
// del arranque), y eso ya lo explica `hibernarPrepararInfo`.
export function prepararHibernacion(): void {
  abrirEnTerminal(`bash ${GLib.shell_quote(`${RAIZ_REPO}/install.sh`)} --solo hibernacion`, "hibernacion")
    .then(comprobarHibernacion)
    .catch(() => {})
}

export function quitarHibernacion(): void {
  abrirEnTerminal(`sudo bash ${GLib.shell_quote(`${RAIZ_REPO}/system/hibernacion/gigios-hibernacion-quitar.sh`)}`, "hibernacion")
    .then(comprobarHibernacion)
    .catch(() => {})
}
