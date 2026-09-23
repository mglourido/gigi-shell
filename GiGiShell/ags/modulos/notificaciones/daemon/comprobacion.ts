// Vigila que seamos NOSOTROS quienes servimos las notificaciones de la sesión.
//
// `ingest()` solo corre desde la señal "notified" de AstalNotifd, y esa señal solo llega si
// AstalNotifd es el dueño del nombre D-Bus `org.freedesktop.Notifications`. Solo un proceso
// puede tenerlo: si otro daemon (dunst, mako…) se adelanta, el shell se queda sin recibir una
// sola notificación —ni popups, ni lista activa, ni historial— y el síntoma
// (`notif-history.json` siempre vacío) parece un bug de persistencia.
//
// Astal **sí** se queja al no conseguir el nombre ("proxy.vala: cannot get proxy: dunst is
// already running"), pero por el **stdout de `ags`**: arrancando desde `gigishell/autostart.lua` esa
// línea no acaba ni en `hyprland.log` ni en el journal, o sea que solo la ve quien lanza el
// shell a mano en una terminal. Y aunque la vea, dice *qué* pasa pero no *qué rompe* ni *cómo
// se arregla*. Este módulo no descubre nada nuevo: comprueba el invariante de verdad ("¿es
// nuestro el nombre?") y lo convierte en algo que se ve — estado reactivo para el banner
// (`BannerConflicto.tsx`), una notificación de escritorio y un log accionable.
//
// Lo que hace traicionero el fallo: basta con tener dunst *instalado* aunque no lo lances —
// D-Bus lo autoactiva con la primera notificación de la sesión, antes de que AGS esté listo.
// Se arregla enmascarándolo, no desinstalándolo (`docs/SETUP.md` §2).
import { createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

const NOTIF_NAME = "org.freedesktop.Notifications"

export interface DaemonConflict {
  /** PID del proceso que nos ha robado el nombre. */
  pid: number
  /** Nombre del ejecutable ("dunst", "mako"…), o "" si no se pudo leer. */
  comm: string
}

/** null = todo bien (el nombre es nuestro, o aún no lo tiene nadie y lo acabaremos cogiendo). */
export const [notifDaemonConflict, setNotifDaemonConflict] = createState<DaemonConflict | null>(null)

function callDBus(bus: Gio.DBusConnection, method: string, args: GLib.Variant): GLib.Variant | null {
  try {
    return bus.call_sync(
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      method, args, null, Gio.DBusCallFlags.NONE, 1000, null,
    )
  } catch (_) {
    // GetNameOwner lanza NameHasNoOwner cuando el nombre está libre: no es un fallo.
    return null
  }
}

function commOf(pid: number): string {
  try {
    const [ok, content] = GLib.file_get_contents(`/proc/${pid}/comm`)
    if (ok) return new TextDecoder().decode(content).trim()
  } catch (_) {}
  return ""
}

/** ¿Quién tiene el nombre ahora mismo? Compara contra nuestro propio nombre único del bus. */
function evaluate(bus: Gio.DBusConnection): DaemonConflict | null {
  const owner = callDBus(bus, "GetNameOwner", new GLib.Variant("(s)", [NOTIF_NAME]))
  if (!owner) return null                       // libre: AstalNotifd lo cogerá
  const [uniqueName] = owner.deep_unpack() as [string]
  if (uniqueName === bus.get_unique_name()) return null   // es nuestro

  const res = callDBus(bus, "GetConnectionUnixProcessID", new GLib.Variant("(s)", [uniqueName]))
  const pid = res ? (res.deep_unpack() as [number])[0] : 0
  return { pid, comm: commOf(pid) }
}

/** Aviso por notificación de escritorio: lo pintará el propio daemon intruso, que es el que
 *  funciona. Es el único canal que el usuario ve de verdad (el log de AGS va al hyprland.log). */
function warnOnce(c: DaemonConflict): void {
  const who = c.comm || formatearTexto(textos.conflicto.pid, { pid: c.pid })
  const daemon = c.comm || textos.conflicto.daemonDesconocido
  console.error(formatearTexto(textos.conflicto.registro, {
    proceso: who, pid: c.pid, nombre: NOTIF_NAME, daemon,
  }))
  execAsync([
    "notify-send", "-u", "critical", "-a", "GiGiShell",
    formatearTexto(textos.conflicto.notificacionTitulo, { proceso: who }),
    formatearTexto(textos.conflicto.notificacionCuerpo, { proceso: who, daemon }),
  ]).catch(() => {})
}

let started = false

/** Se llama una vez desde app.ts (después de NotificationPopup, que crea el AstalNotifd). */
export function initNotifDaemonCheck(): void {
  if (started) return
  started = true

  let bus: Gio.DBusConnection
  try {
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, null)
  } catch (e) {
    console.error("[notif] daemonCheck: no se pudo abrir el bus de sesión:", e)
    return
  }

  // Reevaluar en vivo: NameOwnerChanged nos avisa tanto de que un intruso coge el nombre como de
  // que lo suelta. Al soltarlo, AstalNotifd —que quedó **en cola** por él— lo toma sin reiniciar
  // AGS, así que el aviso se apaga solo en cuanto enmascaras al daemon rival. Sin esto haría
  // falta relanzar el shell solo para que el banner desapareciera.
  bus.signal_subscribe(
    "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus",
    NOTIF_NAME, Gio.DBusSignalFlags.NONE,
    () => refresh(bus),
  )

  refresh(bus)
}

let lastWarnedPid = 0

function refresh(bus: Gio.DBusConnection): void {
  const conflict = evaluate(bus)
  setNotifDaemonConflict(conflict)
  if (conflict && conflict.pid !== lastWarnedPid) {
    lastWarnedPid = conflict.pid
    warnOnce(conflict)
  }
  if (!conflict) lastWarnedPid = 0
}
