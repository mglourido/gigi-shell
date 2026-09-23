// modulos/ajustes/energia/InactividadAhorro.tsx
// Tiempos de inactividad propios del modo ahorro. Misma fila que la tarjeta general
// (`modulos/ajustes/pantalla/FilaInactividad.tsx`), pero guardando en
// `power-save/config.json` en vez de en hypridle.conf: quien traduce estos minutos al
// fichero de hypridle —y quien devuelve los de siempre al salir del ahorro— es
// `servicios/pantalla/inactividadAhorro.ts`.
import { createState } from "ags"
import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, TarjetaAjustes, TextoInformativo } from "../componentes"
import FilaInactividad from "../pantalla/FilaInactividad"
import textosPantalla from "../../../textos/ajustes/pantalla.json" with { type: "json" }
import textos from "../../../textos/ajustes/energia.json" with { type: "json" }
import {
  idleOverrideInPowerSave, setIdleOverrideInPowerSave,
  idleDpmsAhorro, setIdleDpmsAhorro,
  idleLockAhorro, setIdleLockAhorro,
  idleSuspendAhorro, setIdleSuspendAhorro,
} from "../../../servicios/energia/powerState.ts"

export default function InactividadAhorro() {
  const [minutosDpms, fijarMinutosDpms] = createState(idleDpmsAhorro.get().min)
  const [dpmsActivo, fijarDpmsActivo] = createState(idleDpmsAhorro.get().on)
  const [minutosBloqueo, fijarMinutosBloqueo] = createState(idleLockAhorro.get().min)
  const [bloqueoActivo, fijarBloqueoActivo] = createState(idleLockAhorro.get().on)
  const [minutosSuspension, fijarMinutosSuspension] = createState(idleSuspendAhorro.get().min)
  const [suspensionActiva, fijarSuspensionActiva] = createState(idleSuspendAhorro.get().on)

  const guardar = () => {
    setIdleDpmsAhorro({ min: minutosDpms.get(), on: dpmsActivo.get() })
    setIdleLockAhorro({ min: minutosBloqueo.get(), on: bloqueoActivo.get() })
    setIdleSuspendAhorro({ min: minutosSuspension.get(), on: suspensionActiva.get() })
  }

  return (
    <TarjetaAjustes titulo={textos.grupos.inactividadAhorro} icono="󰾪">
      <AjusteInterruptor
        titulo={textos.inactividadAhorro.titulo}
        informacion={textos.inactividadAhorro.descripcion}
        activo={idleOverrideInPowerSave}
        alAlternar={() => setIdleOverrideInPowerSave(!idleOverrideInPowerSave.get())}
      />
      {/* Las tres filas solo se pintan con el interruptor maestro encendido: apagado, los
          tiempos no se aplican y enseñarlos editables sugeriría que sí. */}
      <box orientation={Gtk.Orientation.VERTICAL} visible={idleOverrideInPowerSave}>
        <FilaInactividad etiqueta={textosPantalla.suspension.apagarPantalla} minutos={minutosDpms} fijarMinutos={fijarMinutosDpms} activo={dpmsActivo} fijarActivo={fijarDpmsActivo} guardar={guardar} />
        <FilaInactividad etiqueta={textosPantalla.suspension.bloquear} minutos={minutosBloqueo} fijarMinutos={fijarMinutosBloqueo} activo={bloqueoActivo} fijarActivo={fijarBloqueoActivo} guardar={guardar} />
        <FilaInactividad etiqueta={textosPantalla.suspension.suspender} minutos={minutosSuspension} fijarMinutos={fijarMinutosSuspension} activo={suspensionActiva} fijarActivo={fijarSuspensionActiva} guardar={guardar} />
        <box cssClasses={["dev-row"]}>
          <TextoInformativo label={textos.inactividadAhorro.aviso} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        </box>
      </box>
    </TarjetaAjustes>
  )
}
