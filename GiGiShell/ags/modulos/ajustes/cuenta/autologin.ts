// modulos/ajustes/cuenta/autologin.ts
//
// Entrar solo a Hyprland sin pasar por el saludador. El dato NO es de GiGiShell: vive
// en la configuración de SDDM, en `[Autologin] User=` de
// /etc/sddm.conf.d/zz-gigishell.conf — el mismo fichero que materializa `install.sh`
// (paso `sddm`) desde system/sddm/zz-gigishell.conf.in, y con las mismas reglas.
// Aquí solo se conmuta esa clave: usuario actual para entrar solo, VACÍO para pedir
// contraseña (para SDDM vacío es «no hay autologin», no «autologin del usuario ''»).
//
// Todo lo que sigue existe porque en este ajuste el fallo típico es MUDO: se escribe
// la clave correcta, no da ningún error, y al arrancar el equipo hace lo contrario.
//
//   · SIN `Session=` NO HAY AUTOLOGIN. SDDM necesita saber qué sesión abrir; con el
//     campo vacío ignora el autologin y enseña el saludador, sin avisar. Si el
//     fichero no la trae, se busca hyprland.desktop en los tres wayland-sessions
//     (mismo orden que el instalador) y se escribe junto al usuario. Si no aparece
//     en ninguno, la fila sale apagada: prometer autologin sin sesión es mentir.
//   · /etc/sddm.conf GANA SOBRE TODO /etc/sddm.conf.d/ pese al nombre
//     (`man 5 sddm.conf`), y dentro del directorio gana EL ÚLTIMO por orden
//     alfabético. Si alguno de los dos fija `User`, escribir en nuestro drop-in no
//     se nota. Se comprueba antes y la fila sale apagada nombrando al culpable, en
//     vez de dejar un interruptor que se mueve y no hace nada.
//   · No se crea el fichero si falta: sin él SDDM está con su configuración de
//     fábrica y lo que toca es `install.sh --solo sddm`, que además pone el tema y
//     el resto de claves. Un fichero suelto con dos líneas escritas desde aquí
//     dejaría el saludador a medias.
//
// El cambio es para el PRÓXIMO arranque: SDDM lee su configuración al empezar.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { withPrivilegedPrompt } from "../../../estado/shell"
import textos from "../../../textos/ajustes/cuenta.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

const DIRECTORIO_SDDM = "/etc/sddm.conf.d"
/** El drop-in de GiGiShell. Lo exporta para que SeccionCuenta pueda arrastrar el
 *  autologin al usuario nuevo cuando se renombra la cuenta, en su misma escalada. */
export const RUTA_CONFIG_SDDM = `${DIRECTORIO_SDDM}/zz-gigishell.conf`
const NUESTRO = RUTA_CONFIG_SDDM
const SUELTO = "/etc/sddm.conf"
const DIRECTORIOS_SESION = [
  "/usr/local/share/wayland-sessions",
  "/usr/share/wayland-sessions",
  "/usr/share/xsessions",
]

export type EstadoAutologin = {
  /** false = el interruptor va apagado y no se puede tocar; `motivo` dice por qué. */
  disponible: boolean
  activo: boolean
  /** Usuario que quedaría al encenderlo (el de la sesión actual). */
  usuario: string
  /** Vacío si no está disponible. */
  motivo: string
}

function leerFichero(ruta: string): string | null {
  try {
    const [ok, datos] = GLib.file_get_contents(ruta)
    if (!ok || !datos) return null
    return new TextDecoder().decode(datos)
  } catch {
    return null
  }
}

/**
 * Último valor de una clave dentro de una sección de un .conf de SDDM. "Último"
 * porque es lo que hace SDDM: una clave repetida se queda con la de más abajo.
 * Devuelve null si la clave no aparece, que no es lo mismo que aparecer vacía.
 */
function valorIni(contenido: string, seccion: string, clave: string): string | null {
  let dentro = false
  let valor: string | null = null
  for (const linea of contenido.split("\n")) {
    const limpia = linea.trim()
    if (limpia.startsWith("#") || limpia.startsWith(";")) continue
    if (limpia.startsWith("[")) { dentro = limpia.replace(/\s+/g, "") === `[${seccion}]`; continue }
    if (!dentro) continue
    const igual = limpia.indexOf("=")
    if (igual < 0) continue
    if (limpia.slice(0, igual).trim() !== clave) continue
    valor = limpia.slice(igual + 1).trim()
  }
  return valor
}

/** Ficheros de conf.d que se leen DESPUÉS del nuestro y por tanto lo pisarían. */
function dropInsPosteriores(): string[] {
  const posteriores: string[] = []
  try {
    const dir = GLib.Dir.open(DIRECTORIO_SDDM, 0)
    let nombre: string | null
    while ((nombre = dir.read_name()) !== null) {
      if (nombre > "zz-gigishell.conf") posteriores.push(`${DIRECTORIO_SDDM}/${nombre}`)
    }
    dir.close()
  } catch {
    // El directorio no existe o no se puede leer: se trata como «no hay nadie
    // detrás», que es lo que se ve desde aquí.
  }
  return posteriores.sort()
}

/** Primer .desktop de sesión que encuentre, en el mismo orden que el instalador. */
function buscarSesion(): string {
  for (const dir of DIRECTORIOS_SESION) {
    if (GLib.file_test(`${dir}/hyprland.desktop`, GLib.FileTest.IS_REGULAR)) return "hyprland.desktop"
  }
  return ""
}

export function leerAutologin(): EstadoAutologin {
  const usuario = GLib.get_user_name() || ""
  const base: EstadoAutologin = { disponible: false, activo: false, usuario, motivo: "" }

  const contenido = leerFichero(NUESTRO)
  if (contenido === null) return { ...base, motivo: textos.inicioSesion.autologin.sinConfiguracion }

  const nuestroUsuario = valorIni(contenido, "Autologin", "User") ?? ""
  const activo = nuestroUsuario !== ""

  // Quien nos pise, en orden de precedencia: primero el fichero suelto, que gana
  // sobre el directorio entero; después los drop-ins que se leen detrás.
  const sueltoContenido = leerFichero(SUELTO)
  if (sueltoContenido !== null && valorIni(sueltoContenido, "Autologin", "User") !== null) {
    return { ...base, activo, motivo: formatearTexto(textos.inicioSesion.autologin.pisado, { fichero: SUELTO }) }
  }
  for (const ruta of dropInsPosteriores()) {
    const otro = leerFichero(ruta)
    if (otro !== null && valorIni(otro, "Autologin", "User") !== null) {
      return { ...base, activo, motivo: formatearTexto(textos.inicioSesion.autologin.pisado, { fichero: ruta }) }
    }
  }

  // Sin sesión no hay autologin posible; apagarlo, en cambio, siempre se puede.
  const sesion = valorIni(contenido, "Autologin", "Session") || buscarSesion()
  if (!sesion && !activo) return { ...base, motivo: textos.inicioSesion.autologin.sinSesion }

  return { disponible: true, activo, usuario, motivo: "" }
}

// El fichero es de root y esta clave se escribe con `awk` porque hay que respetar
// la SECCIÓN: un `sed s/^User=/` a secas también tocaría un `User=` de otro grupo.
// Los valores viajan como argumentos (-v de awk) y nunca interpolados en el guion.
const GUION_AUTOLOGIN = `
set -e
destino="$1"; usuario="$2"; sesion="$3"
[ -f "$destino" ] || { echo "no existe $destino" >&2; exit 1; }
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
awk -v u="$usuario" -v s="$sesion" '
  function faltantes() {
    if (!vistoU) print "User=" u
    if (!vistoS) print "Session=" s
    vistoU = 1; vistoS = 1
  }
  /^[[:space:]]*\\[/ {
    if (dentro) faltantes()
    dentro = ($0 ~ /^[[:space:]]*\\[Autologin\\][[:space:]]*$/)
    if (dentro) { habia = 1; vistoU = 0; vistoS = 0 }
    print; next
  }
  dentro && /^[[:space:]]*User[[:space:]]*=/  { print "User=" u; vistoU = 1; next }
  dentro && /^[[:space:]]*Session[[:space:]]*=/ { print "Session=" s; vistoS = 1; next }
  { print }
  END {
    if (dentro) faltantes()
    else if (!habia) { print ""; print "[Autologin]"; print "User=" u; print "Session=" s }
  }
' "$destino" > "$tmp"
grep -q '^\\[Autologin\\]' "$tmp"
install -m644 "$tmp" "$destino"
exit 0
`

function ejecutarComoAdministrador(argumentos: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      // El "bash" repetido es $0: sin él el primer valor real se perdería como
      // nombre del programa en vez de llegar como "$1".
      const proceso = Gio.Subprocess.new(["pkexec", "bash", "-c", GUION_AUTOLOGIN, "bash", ...argumentos], flags)
      proceso.communicate_utf8_async(null, null, (proc, result) => {
        try {
          const [, , stderr] = proc.communicate_utf8_finish(result)
          if (proc.get_successful()) return resolve()
          const codigo = proc.get_exit_status()
          if (codigo === 126 || codigo === 127) return reject(new Error(textos.avisos.autorizacionCancelada))
          reject(new Error((stderr ?? "").trim() || textos.avisos.operacionFallida))
        } catch (error) { reject(error) }
      })
    } catch (error) { reject(error) }
  })
}

/** Enciende o apaga el autologin del usuario actual. Surte efecto al reiniciar. */
export async function aplicarAutologin(activar: boolean): Promise<void> {
  const contenido = leerFichero(NUESTRO)
  if (contenido === null) throw new Error(textos.inicioSesion.autologin.sinConfiguracion)

  const sesion = valorIni(contenido, "Autologin", "Session") || buscarSesion()
  if (activar && !sesion) throw new Error(textos.inicioSesion.autologin.sinSesion)

  const usuario = activar ? (GLib.get_user_name() || "") : ""
  if (activar && !usuario) throw new Error(textos.avisos.operacionFallida)

  // withPrivilegedPrompt aparta la ventana de Ajustes mientras polkit pide la
  // contraseña: es una capa OVERLAY y taparía el diálogo (ver SeccionCuenta.tsx).
  await withPrivilegedPrompt(() => ejecutarComoAdministrador([NUESTRO, usuario, sesion]))
}
