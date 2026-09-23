import { Gtk } from "ags/gtk4"
import { With, createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import ProfileAvatar from "../ProfileAvatar"
import { withPrivilegedPrompt } from "../../../estado/shell"
import { importarFotoPerfil, refreshAvatar } from "./avatar"
import { AjusteInterruptor, BotonAjustes, EntradaTextoAjustes, FilaAjuste, TarjetaAjustes, TextoInformativo, TituloSeccion } from "../componentes"
import { RUTA_CONFIG_SDDM, aplicarAutologin, leerAutologin } from "./autologin"
import textos from "../../../textos/ajustes/cuenta.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

type Notice = { kind: "idle" | "working" | "ok" | "error"; text: string }

// Los cambios de cuenta (nombre completo, contraseña de usuario, contraseña de
// administrador, login) van en UNA sola escalada de privilegios. Antes había un campo "Autorización administrativa" en la
// propia sección y cada orden salía por `sudo -S` con esa contraseña por stdin: un
// segundo sitio donde teclear la contraseña de root, cuando polkit ya abre su propio
// diálogo. Ahora es `pkexec`, como el resto de Ajustes (fechaHora.ts, printers.ts,
// disco/limpieza.ts).
//
// Dos detalles que no son opcionales:
//   - Los valores viajan como ARGUMENTOS ("$1", "$2"…), nunca interpolados en el
//     script: un nombre completo con comillas o `$(...)` sería inyección de shell
//     ejecutada como root. pkexec además limpia el entorno, así que por variables
//     tampoco valdría.
//   - Las contraseñas nuevas viajan por STDIN y no por argv, donde cualquiera las
//     vería en `ps`. `chpasswd` lee la suya de la misma línea. Van en el orden en
//     que el guion las lee: primero la del usuario, después la de root. Cada `read`
//     consume UNA línea, así que la entrada solo lleva las líneas de los flags que
//     van a 1 — mandar una de más desalinearía la siguiente lectura.
//
// SON DOS CONTRASEÑAS DISTINTAS, y esta pantalla nunca cambió la de root: "la
// contraseña de la cuenta" es la del usuario que ha iniciado sesión (la de la
// pantalla de bloqueo y la de sudo/polkit). La de administrador es la de `root`,
// la que pide un TTY con `su`. Cada una tiene su propia fila.
//
// NO se exige longitud mínima a propósito: PAM en esta máquina no lleva
// pam_pwquality (`/etc/pam.d/system-auth` es pam_unix a secas) y `PASS_MIN_LEN` de
// login.defs no lo aplica shadow compilado con PAM, así que un PIN de 4 dígitos es
// perfectamente válido para el sistema. La UI antes decía "al menos 8 caracteres" y
// rechazaba en cliente lo que el sistema aceptaba sin rechistar.
const GUION_CUENTA = `
set -e
usuario="$1"; nombre="$2"; nuevo_login="$3"; cambiar_pass="$4"; cambiar_root="$5"; sddm_conf="$6"
if [ -n "$nombre" ]; then usermod -c "$nombre" "$usuario"; fi
if [ "$cambiar_pass" = "1" ]; then
  IFS= read -r pass
  printf '%s:%s\\n' "$usuario" "$pass" | chpasswd
fi
if [ "$cambiar_root" = "1" ]; then
  IFS= read -r pass_root
  printf 'root:%s\\n' "$pass_root" | chpasswd
fi
if [ "$nuevo_login" != "$usuario" ]; then
  usermod -l "$nuevo_login" "$usuario"
  # RENOMBRAR EL USUARIO DEJA EL AUTOLOGIN APUNTANDO A UN USUARIO QUE YA NO EXISTE,
  # y SDDM no da ningún error por eso: enseña el saludador y el autologin deja de
  # funcionar sin más. Se arrastra aquí, dentro de la MISMA escalada de privilegios,
  # y solo si la clave sigue teniendo el nombre viejo (si apunta a otro usuario no
  # es nuestra). Solo llega ruta si el autologin estaba encendido (ver autologin.ts).
  if [ -n "$sddm_conf" ] && [ -f "$sddm_conf" ]; then
    tmp="$(mktemp)"
    if awk -v viejo="$usuario" -v nuevo="$nuevo_login" '
         /^[[:space:]]*\[/ { dentro = ($0 ~ /^[[:space:]]*\[Autologin\][[:space:]]*$/); print; next }
         dentro && /^[[:space:]]*User[[:space:]]*=/ {
           val = $0; sub(/^[^=]*=[[:space:]]*/, "", val)
           if (val == viejo) { print "User=" nuevo; next }
         }
         { print }
       ' "$sddm_conf" > "$tmp" && install -m644 "$tmp" "$sddm_conf"; then :; else
      # No se aborta: las contraseñas y el nombre ya están cambiados y fallar aquí
      # no lo deshace. Se avisa por stdout, que la UI sí mira.
      echo AUTOLOGIN_NO_ACTUALIZADO
    fi
    rm -f "$tmp"
  fi
fi
exit 0
`

function ejecutarComoAdministrador(argumentos: string[], entrada: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      // El "bash" repetido es $0: pkexec lo pasa tal cual y sin él el primer valor
      // real se perdería como nombre del programa en vez de llegar como "$1".
      const proceso = Gio.Subprocess.new(["pkexec", "bash", "-c", GUION_CUENTA, "bash", ...argumentos], flags)
      proceso.communicate_utf8_async(entrada, null, (proc, result) => {
        try {
          const [, stdout, stderr] = proc.communicate_utf8_finish(result)
          if (proc.get_successful()) return resolve((stdout ?? "").trim())
          // 126 = el usuario cerró el diálogo o falló la autenticación;
          // 127 = polkit no le autoriza. Ninguno de los dos deja stderr útil.
          const codigo = proc.get_exit_status()
          if (codigo === 126 || codigo === 127) return reject(new Error(textos.avisos.autorizacionCancelada))
          reject(new Error((stderr ?? "").trim() || textos.avisos.operacionFallida))
        } catch (error) { reject(error) }
      })
    } catch (error) { reject(error) }
  })
}

function limpiarErrorAdministrador(error: unknown): string {
  const mensaje = error instanceof Error ? error.message : String(error)
  return mensaje.replace(/^(usermod|chpasswd|pkexec):\s*/i, "").trim() || textos.avisos.operacionFallida
}

export default function SeccionCuenta() {
  const currentUser = GLib.get_user_name() || textos.seccion.usuarioPredeterminado
  const [loginName, setLoginName] = createState(currentUser)
  const [fullName, setFullName] = createState("")
  const [newPassword, setNewPassword] = createState("")
  const [confirmPassword, setConfirmPassword] = createState("")
  const [avatarInput, setAvatarInput] = createState("")
  const [passwordExpanded, setPasswordExpanded] = createState(false)
  const [newRootPassword, setNewRootPassword] = createState("")
  const [confirmRootPassword, setConfirmRootPassword] = createState("")
  const [rootPasswordExpanded, setRootPasswordExpanded] = createState(false)
  const [notice, setNotice] = createState<Notice>({ kind: "idle", text: "" })
  // El autologin no es una preferencia de GiGiShell: se lee de la configuración de
  // SDDM cada vez que se pinta la sección, porque puede haberla cambiado el
  // instalador o un fichero ajeno desde fuera (ver autologin.ts).
  const [autologin, setAutologin] = createState(leerAutologin())

  const applyAvatar = () => {
    const raw = avatarInput.get().trim()
    if (!raw) return setNotice({ kind: "error", text: textos.avisos.rutaVacia })
    const path = raw === "~" ? GLib.get_home_dir()
      : raw.startsWith("~/") ? `${GLib.get_home_dir()}/${raw.slice(2)}`
      : raw
    try {
      if (!GLib.path_is_absolute(path)) throw new Error(textos.avisos.rutaInvalida)
      if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) throw new Error(textos.avisos.imagenAusente)
      // No es una copia del original: se recorta cuadrado y se reduce (ver avatar.ts).
      importarFotoPerfil(path)
      refreshAvatar()
      setAvatarInput("")
      setNotice({ kind: "ok", text: textos.avisos.fotoActualizada })
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) })
    }
  }

  const applyChanges = async () => {
    const nextLogin = loginName.get().trim()
    const realName = fullName.get().trim()
    const password = newPassword.get()
    const rootPassword = newRootPassword.get()
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(nextLogin)) return setNotice({ kind: "error", text: textos.avisos.usuarioInvalido })
    if (password && password !== confirmPassword.get()) return setNotice({ kind: "error", text: textos.avisos.contrasenasNoCoinciden })
    if (rootPassword && rootPassword !== confirmRootPassword.get()) return setNotice({ kind: "error", text: textos.avisos.contrasenasAdminNoCoinciden })
    if (nextLogin === currentUser && !realName && !password && !rootPassword) return setNotice({ kind: "error", text: textos.avisos.sinCambios })

    setNotice({ kind: "working", text: textos.avisos.aplicando })
    try {
      // withPrivilegedPrompt aparta la ventana de Ajustes mientras polkit pide la
      // contraseña: es una capa OVERLAY y taparía el diálogo, que es un toplevel
      // normal. Mismo envoltorio que fechaHora.ts y printers.ts.
      const estadoAutologin = autologin.get()
      const salida = await withPrivilegedPrompt(() => ejecutarComoAdministrador(
        [
          currentUser, realName, nextLogin, password ? "1" : "0", rootPassword ? "1" : "0",
          estadoAutologin.disponible && estadoAutologin.activo ? RUTA_CONFIG_SDDM : "",
        ],
        // Una línea por contraseña que el guion vaya a leer, en su mismo orden.
        (password ? `${password}\n` : "") + (rootPassword ? `${rootPassword}\n` : ""),
      ))
      setNewPassword("")
      setConfirmPassword("")
      setNewRootPassword("")
      setConfirmRootPassword("")
      setAutologin(leerAutologin())
      if (salida.includes("AUTOLOGIN_NO_ACTUALIZADO")) {
        return setNotice({ kind: "error", text: textos.avisos.autologinDesfasado })
      }
      setNotice({ kind: "ok", text: nextLogin !== currentUser ? textos.avisos.cuentaActualizadaReinicio : textos.avisos.cuentaActualizada })
    } catch (error) {
      setNotice({ kind: "error", text: limpiarErrorAdministrador(error) })
    }
  }

  const alternarAutologin = async () => {
    const estado = autologin.get()
    // Sensitive=false ya lo impide desde la UI; esto cubre la carrera de que el
    // fichero cambie por debajo entre el pintado y el clic.
    if (!estado.disponible) return setNotice({ kind: "error", text: estado.motivo || textos.avisos.operacionFallida })
    const objetivo = !estado.activo
    setNotice({ kind: "working", text: textos.avisos.aplicando })
    try {
      await aplicarAutologin(objetivo)
      setNotice({ kind: "ok", text: objetivo ? textos.avisos.autologinActivado : textos.avisos.autologinDesactivado })
    } catch (error) {
      setNotice({ kind: "error", text: limpiarErrorAdministrador(error) })
    }
    // Se relee SIEMPRE, también tras un fallo: el interruptor tiene que enseñar lo
    // que hay en el fichero, no lo que se pidió. Un pkexec cancelado no cambia nada
    // y dejar el interruptor movido sería enseñar un autologin que no existe.
    setAutologin(leerAutologin())
  }

  const passwordEntry = (placeholder: string, setter: (v: string) => void) => (
    <EntradaTextoAjustes placeholderText={placeholder} visibility={false}
      onChanged={(entry) => setter(entry.get_text())} hexpand />
  )

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={["sp-section", "account-section"]} hexpand>
      <TituloSeccion titulo={textos.seccion.titulo} />

      <TarjetaAjustes titulo={textos.perfil.titulo} icono="󰀄" cssClasses={["account-card"]}>
        <box cssClasses={["dev-row", "account-profile-summary"]} spacing={14} valign={Gtk.Align.CENTER}>
          <ProfileAvatar
            size={46}
            fallbackLabel={currentUser.slice(0, 2).toUpperCase()}
            fallbackCssClasses={["account-avatar", "fallback"]}
            borderWidth={2}
            borderRgba={[203 / 255, 166 / 255, 247 / 255, 0.45]}
          />
          <box orientation={Gtk.Orientation.VERTICAL} spacing={3} hexpand valign={Gtk.Align.CENTER}>
            <label cssClasses={["account-current-user"]} label={currentUser} halign={Gtk.Align.START} />
            <TextoInformativo label={formatearTexto(textos.perfil.equipo, { nombre: GLib.get_host_name() })} halign={Gtk.Align.START} />
          </box>
        </box>
        <FilaAjuste titulo={textos.perfil.foto.titulo} informacion={textos.perfil.foto.descripcion}
          cssClasses={["account-row"]} maxCaracteresInformacion={38}>
          <box cssClasses={["account-controls"]} spacing={8} valign={Gtk.Align.CENTER}>
            <EntradaTextoAjustes placeholderText={textos.perfil.foto.placeholder}
              onChanged={(entry) => setAvatarInput(entry.get_text())}
              onActivate={applyAvatar} hexpand />
            <BotonAjustes label={textos.perfil.foto.boton} onClicked={applyAvatar} />
          </box>
        </FilaAjuste>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.datosPersonales.titulo} icono="󰓝" cssClasses={["account-card"]}>
        <FilaAjuste titulo={textos.datosPersonales.usuario.titulo} informacion={textos.datosPersonales.usuario.descripcion}
          cssClasses={["account-row"]} maxCaracteresInformacion={38}>
          <box cssClasses={["account-controls"]}>
            <EntradaTextoAjustes text={currentUser}
              onChanged={(entry) => setLoginName(entry.get_text())} hexpand />
          </box>
        </FilaAjuste>
        <FilaAjuste titulo={textos.datosPersonales.nombreCompleto.titulo} informacion={textos.datosPersonales.nombreCompleto.descripcion}
          cssClasses={["account-row"]} maxCaracteresInformacion={38}>
          <box cssClasses={["account-controls"]}>
            <EntradaTextoAjustes placeholderText={textos.datosPersonales.nombreCompleto.placeholder}
              onChanged={(entry) => setFullName(entry.get_text())} hexpand />
          </box>
        </FilaAjuste>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.seguridad.titulo} icono="󰌾" cssClasses={["account-card"]}>
        <FilaAjuste titulo={textos.seguridad.contrasena.titulo} informacion={textos.seguridad.contrasena.descripcion}
          cssClasses={["account-row"]} maxCaracteresInformacion={38}>
          <BotonAjustes
            activo={passwordExpanded}
            onClicked={() => {
              const open = !passwordExpanded.get()
              setPasswordExpanded(open)
              if (!open) { setNewPassword(""); setConfirmPassword("") }
            }}
            label={passwordExpanded((open: boolean) => open ? textos.seguridad.contrasena.ocultar : textos.seguridad.contrasena.mostrar)}
          />
        </FilaAjuste>
        <box visible={passwordExpanded} cssClasses={["account-password-fields"]} orientation={Gtk.Orientation.VERTICAL}>
          <FilaAjuste titulo={textos.seguridad.nuevaContrasena.titulo} informacion={textos.seguridad.nuevaContrasena.descripcion}
            cssClasses={["account-row"]} maxCaracteresInformacion={38}>
            <box cssClasses={["account-controls"]}>{passwordEntry(textos.seguridad.nuevaContrasena.placeholder, setNewPassword)}</box>
          </FilaAjuste>
          <FilaAjuste titulo={textos.seguridad.confirmarContrasena.titulo} cssClasses={["account-row"]}>
            <box cssClasses={["account-controls"]}>{passwordEntry(textos.seguridad.confirmarContrasena.placeholder, setConfirmPassword)}</box>
          </FilaAjuste>
        </box>

        <FilaAjuste titulo={textos.seguridad.contrasenaAdmin.titulo} informacion={textos.seguridad.contrasenaAdmin.descripcion}
          cssClasses={["account-row"]} maxCaracteresInformacion={38}>
          <BotonAjustes
            activo={rootPasswordExpanded}
            onClicked={() => {
              const open = !rootPasswordExpanded.get()
              setRootPasswordExpanded(open)
              if (!open) { setNewRootPassword(""); setConfirmRootPassword("") }
            }}
            label={rootPasswordExpanded((open: boolean) => open ? textos.seguridad.contrasenaAdmin.ocultar : textos.seguridad.contrasenaAdmin.mostrar)}
          />
        </FilaAjuste>
        <box visible={rootPasswordExpanded} cssClasses={["account-password-fields"]} orientation={Gtk.Orientation.VERTICAL}>
          <FilaAjuste titulo={textos.seguridad.nuevaContrasenaAdmin.titulo} informacion={textos.seguridad.nuevaContrasenaAdmin.descripcion}
            cssClasses={["account-row"]} maxCaracteresInformacion={38}>
            <box cssClasses={["account-controls"]}>{passwordEntry(textos.seguridad.nuevaContrasenaAdmin.placeholder, setNewRootPassword)}</box>
          </FilaAjuste>
          <FilaAjuste titulo={textos.seguridad.confirmarContrasenaAdmin.titulo} cssClasses={["account-row"]}>
            <box cssClasses={["account-controls"]}>{passwordEntry(textos.seguridad.confirmarContrasenaAdmin.placeholder, setConfirmRootPassword)}</box>
          </FilaAjuste>
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.inicioSesion.titulo} icono="󰍃" cssClasses={["account-card"]}>
        <AjusteInterruptor
          titulo={textos.inicioSesion.autologin.titulo}
          informacion={autologin((estado) => estado.motivo
            || formatearTexto(textos.inicioSesion.autologin.descripcion, { usuario: estado.usuario }))}
          activo={autologin((estado) => estado.activo)}
          sensible={autologin((estado) => estado.disponible)}
          alAlternar={alternarAutologin}
        />
      </TarjetaAjustes>

      <box cssClasses={["account-actions"]} spacing={12} valign={Gtk.Align.CENTER}>
        <With value={notice}>{(state: Notice) => state.text
          ? <label cssClasses={["account-notice", state.kind]} label={formatearTexto(textos.avisos.formato, { mensaje: state.text })} halign={Gtk.Align.START} wrap xalign={0} hexpand />
          : <box hexpand />}</With>
        <BotonAjustes variante="principal" label={textos.acciones.guardar} onClicked={applyChanges} />
      </box>
    </box>
  )
}
