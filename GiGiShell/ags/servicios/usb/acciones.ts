// servicios/usb/acciones.ts — Abrir, Expulsar y Reparar desde el menú USB de la barra.
//
// No reimplementa nada: llama a los mismos scripts que los botones de las notificaciones de
// `usb-monitor.sh`, así que montar, volcar la caché, apagar el puerto, reparar y avisar del
// resultado (o del fallo: «en uso por…») siguen viviendo en un solo sitio. Los scripts notifican
// ellos mismos, por eso aquí un fallo solo se registra.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

const DIR_SCRIPTS = GLib.build_filenamev([GLib.get_user_config_dir(), "hypr", "scripts"])

function lanzar(script: string, ...argumentos: string[]) {
  execAsync([GLib.build_filenamev([DIR_SCRIPTS, script]), ...argumentos]).catch((e) => {
    console.error(`[usb] ${script} ${argumentos.join(" ")}:`, e)
  })
}

/** Monta si hace falta y abre en el gestor de archivos. Acepta disco ("sdb") o partición. */
export const abrirVolumen = (dispositivo: string) => lanzar("usb-open.sh", dispositivo)
/** Solo monta, sin abrir nada (pulsar la fila del volumen). Avisa el script si falla. */
export const montarVolumen = (dispositivo: string) => lanzar("usb-open.sh", "--montar", dispositivo)
/** Desmonta todas sus particiones y apaga el disco ("sdb"). */
export const expulsarDisco = (disco: string) => lanzar("usb-eject.sh", disco)
/** `Filesystem.Repair` de udisks sobre "/dev/sdb1". */
export const repararVolumen = (dispositivo: string) => lanzar("usb-repair.sh", dispositivo)
