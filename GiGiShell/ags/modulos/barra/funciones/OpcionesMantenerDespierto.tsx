import { With } from "ags"
import { Gtk } from "ags/gtk4"
import {
  fijarMantenerPantallaActiva,
  fijarMinutosMantenerDespierto,
  fijarSuspensionFalsaAlVencer,
  mantenerPantallaActiva,
  minutosMantenerDespierto,
  suspensionFalsaAlVencer,
} from "../../../servicios/energia/mantenerDespierto"
import { sfSustituirReal } from "../../../servicios/energia/powerState"

function EntradaMinutos() {
  let entrada: Gtk.Entry

  const confirmar = () => {
    fijarMinutosMantenerDespierto(entrada.text)
    entrada.text = minutosMantenerDespierto.get()
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
      tooltipText={"Minutos que el PC seguirá despierto.\nVacío = sin límite."}
      $={(self: Gtk.Entry) => { entrada = self; self.text = minutosMantenerDespierto.get() }}
      onActivate={confirmar}
    >
      <Gtk.EventControllerFocus onLeave={confirmar} />
    </Gtk.Entry>
  )
}

export default function OpcionesMantenerDespierto() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["fn-menu-expand"]} spacing={2}>
      <box cssClasses={["fn-menu-subrow"]} spacing={6} valign={Gtk.Align.CENTER}>
        <label cssClasses={["fn-menu-sublabel"]} label="Minutos" xalign={0} hexpand />
        <EntradaMinutos />
      </box>

      <button
        cssClasses={["fn-menu-subbutton"]}
        focusable={false}
        tooltipText={"También impide que la pantalla se apague y bloquee.\nSin esto, solo se evita la suspensión."}
        onClicked={() => fijarMantenerPantallaActiva(!mantenerPantallaActiva.get())}
      >
        <box cssClasses={["fn-menu-subrow"]} spacing={6}>
          <label cssClasses={["fn-menu-sublabel"]} label="Pantalla" xalign={0} hexpand />
          <With value={mantenerPantallaActiva}>
            {(activa: boolean) => (
              <box cssClasses={activa ? ["fn-menu-state", "on"] : ["fn-menu-state"]}>
                <label label={activa ? "ON" : "OFF"} />
              </box>
            )}
          </With>
        </box>
      </button>

      {/*
        «Al vencer la inactividad, entrar en suspensión falsa».

        Sin esto, el Wake up solo VETA: a los 20 min hypridle pide suspender, idle-action.sh
        se traga la acción y el equipo se queda encendido y a la vista, gastando. Con la
        opción puesta ese mismo momento entra en suspensión falsa — pantalla apagada, sesión
        bloqueada, escritorio quieto— y el Wake up sigue cumpliendo su promesa, porque nada
        se detiene: la descarga, la compilación y el SSH siguen vivos.

        Es un AJUSTE y se persiste (fichero propio; ver mantenerDespierto.ts): el Wake up se
        apaga en cada arranque a propósito, pero cómo debe comportarse cuando se encienda no
        hay por qué recordárselo cada vez.
      */}
      {/* Con «usar la suspensión falsa en lugar de la real» puesto (Ajustes > Energía) esto
          YA PASA SIEMPRE, con Wake up o sin él: aquel ajuste es más general. La fila se
          deshabilita y el tooltip lo dice, en vez de dejar un interruptor que se puede
          apagar y no cambia nada — que es la clase de mentira silenciosa que más cuesta
          depurar después. El valor guardado no se toca: al apagar el sustituto vuelve a
          mandar lo que el usuario tuviera aquí. */}
      <button
        cssClasses={["fn-menu-subbutton"]}
        focusable={false}
        sensitive={sfSustituirReal((sustituye: boolean) => !sustituye)}
        tooltipText={sfSustituirReal((sustituye: boolean) => sustituye
          ? "Ya está pasando siempre: en Ajustes > Energía está puesto «usar la\n" +
            "suspensión falsa en lugar de la real», que se aplica a toda la\n" +
            "inactividad, haya Wake up o no."
          : "Al vencer la inactividad, en vez de no hacer nada, entra en suspensión falsa:\n" +
            "el equipo parece apagado pero NO se suspende — descargas, compilaciones y\n" +
            "sesiones SSH siguen vivas. Se sale desbloqueando o con el atajo.")}
        onClicked={() => fijarSuspensionFalsaAlVencer(!suspensionFalsaAlVencer.get())}
      >
        <box cssClasses={["fn-menu-subrow"]} spacing={6}>
          <label cssClasses={["fn-menu-sublabel"]} label="Susp. falsa al vencer" xalign={0} hexpand />
          <With value={suspensionFalsaAlVencer}>
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
