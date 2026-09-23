import { With, createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import {
  sfBloquear,
  sfMinutosSuspensionReal,
  setSfBloquear,
  setSfMinutosSuspensionReal,
} from "../../../servicios/energia/powerState"
import {
  plazoSuprimidoPorWakeUp,
  segundosParaSuspensionReal,
} from "../../../servicios/energia/suspensionFalsa"
import { formatearTiempoRestante } from "../../../servicios/energia/tiempoMantenerDespierto"

// Desplegable de «Suspensión falsa»: el plazo hasta la suspensión REAL y el bloqueo.
//
// Va FUERA del <button> de la fila (lo monta FilaFuncion aparte), por lo mismo que
// OpcionesMantenerDespierto: dentro, cualquier clic en el campo de minutos o en el
// interruptor llegaría también al botón de la fila y SALDRÍA de la suspensión falsa —
// justo lo contrario de lo que el usuario acaba de pedir.

function EntradaMinutos() {
  let entrada: Gtk.Entry

  // El ajuste es un número con 0 = desactivado, y en el campo eso se enseña VACÍO (igual
  // que en el Wake up): un "0" a la vista se lee como "suspende ya", que es lo contrario.
  const textoDe = (minutos: number) => (minutos > 0 ? String(minutos) : "")

  const confirmar = () => {
    const limpio = entrada.text.trim()
    // Cualquier basura degrada a 0 = nunca. `setSfMinutosSuspensionReal` ya acota a 1440,
    // así que aquí no se replica el techo: dos validaciones distintas del mismo campo
    // acaban discrepando y la de la UI es la que nadie prueba.
    setSfMinutosSuspensionReal(/^\d+$/.test(limpio) ? Number(limpio) : 0)
    entrada.text = textoDe(sfMinutosSuspensionReal.get())
  }

  return (
    <Gtk.Entry
      cssClasses={["fn-menu-minutes"]}
      maxLength={4}
      widthChars={1}
      maxWidthChars={4}
      widthRequest={38}
      heightRequest={16}
      xalign={1}
      placeholderText="∞"
      inputPurpose={Gtk.InputPurpose.DIGITS}
      tooltipText={"Minutos hasta suspender DE VERDAD.\nVacío o 0 = nunca."}
      $={(self: Gtk.Entry) => { entrada = self; self.text = textoDe(sfMinutosSuspensionReal.get()) }}
      onActivate={confirmar}
    >
      <Gtk.EventControllerFocus onLeave={confirmar} />
    </Gtk.Entry>
  )
}

/** Lo que va a pasar con el plazo, dicho con todas las letras. El chip de la fila es
 *  demasiado corto para explicarlo y un plazo que calladamente no se cumple —el caso del
 *  Wake up vivo— es peor que no ofrecer plazo ninguno. */
const textoPlazo = createComputed(
  [segundosParaSuspensionReal, plazoSuprimidoPorWakeUp, sfMinutosSuspensionReal],
  (restante: number | null, suprimido: boolean, minutos: number) => {
    if (suprimido) return "En pausa: hay un Wake up activo"
    if (minutos <= 0) return "No se suspenderá de verdad"
    if (restante === null) return `Suspensión real tras ${minutos} min`
    return `Suspensión real en ${formatearTiempoRestante(restante)}`
  },
)

export default function OpcionesSuspensionFalsa() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["fn-menu-expand"]} spacing={2}>
      <box cssClasses={["fn-menu-subrow"]} spacing={6} valign={Gtk.Align.CENTER}>
        <label cssClasses={["fn-menu-sublabel"]} label="Suspender tras" xalign={0} hexpand />
        <EntradaMinutos />
      </box>

      <box cssClasses={["fn-menu-subrow"]} spacing={6}>
        <With value={textoPlazo}>
          {(texto: string) => (
            <label cssClasses={["fn-menu-sublabel"]} label={texto} xalign={0} hexpand />
          )}
        </With>
      </box>

      <button
        cssClasses={["fn-menu-subbutton"]}
        focusable={false}
        tooltipText={
          "Pide la contraseña al volver.\n" +
          "Es además la PUERTA DE SALIDA: con la pantalla apagada por nosotros, hypridle no\n" +
          "avisa de nada y es el desbloqueo lo que devuelve el escritorio.\n" +
          "Sin bloqueo, la única salida es el atajo de teclado."
        }
        onClicked={() => setSfBloquear(!sfBloquear.get())}
      >
        <box cssClasses={["fn-menu-subrow"]} spacing={6}>
          <label cssClasses={["fn-menu-sublabel"]} label="Bloquear" xalign={0} hexpand />
          <With value={sfBloquear}>
            {(activa: boolean) => (
              <box cssClasses={activa ? ["fn-menu-state", "on"] : ["fn-menu-state"]}>
                <label label={activa ? "ON" : "OFF"} />
              </box>
            )}
          </With>
        </box>
      </button>
    </box>
  )
}
