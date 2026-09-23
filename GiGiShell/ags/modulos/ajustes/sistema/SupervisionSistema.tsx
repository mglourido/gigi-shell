import { createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, TarjetaAjustes, TextoInformativo, TituloAjuste } from "../componentes"
import {
  batteryMonitorEnabled, setBatteryMonitorEnabled,
  tempMonitorEnabled, setTempMonitorEnabled,
  updatesMonitorEnabled, setUpdatesMonitorEnabled,
  updatesPeriodicEnabled, setUpdatesPeriodicEnabled,
  updatesIntervalHours, setUpdatesIntervalHours,
} from "../preferences"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

function AjustesActualizaciones() {
  let entradaHoras: Gtk.Entry
  const mostrarIntervalo = createComputed(() => updatesMonitorEnabled() && updatesPeriodicEnabled())
  const guardarHoras = () => {
    const horas = parseInt((entradaHoras?.get_text() ?? "").trim(), 10)
    if (Number.isFinite(horas) && horas >= 1) setUpdatesIntervalHours(horas)
    entradaHoras.set_text(String(updatesIntervalHours.get()))
  }
  return (
    <TarjetaAjustes titulo={textos.seccionesNuevas.sistema.actualizaciones} icono="󰏔">
      <AjusteInterruptor titulo={textos.actualizaciones.titulo} informacion={textos.actualizaciones.descripcion} activo={updatesMonitorEnabled} alAlternar={() => setUpdatesMonitorEnabled(!updatesMonitorEnabled.get())} />
      <AjusteInterruptor titulo={textos.actualizaciones.periodicas.titulo} informacion={textos.actualizaciones.periodicas.descripcion} activo={updatesPeriodicEnabled} visible={updatesMonitorEnabled} alAlternar={() => setUpdatesPeriodicEnabled(!updatesPeriodicEnabled.get())} />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={5} cssClasses={["dev-row"]} visible={mostrarIntervalo}>
        <TituloAjuste label={textos.actualizaciones.intervalo.titulo} halign={Gtk.Align.START} />
        <TextoInformativo label={textos.actualizaciones.intervalo.descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <entry
            cssClasses={["sp-num-input"]}
            hexpand
            placeholderText={textos.actualizaciones.intervalo.placeholder}
            $={(self: Gtk.Entry) => { entradaHoras = self; self.set_text(String(updatesIntervalHours.get())) }}
            onActivate={guardarHoras}
          />
          <button cssClasses={["sp-add-rule"]} onClicked={guardarHoras} valign={Gtk.Align.CENTER}>
            <label label={textos.actualizaciones.intervalo.guardar} />
          </button>
        </box>
      </box>
    </TarjetaAjustes>
  )
}

export default function SupervisionSistema() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14}>
      <TarjetaAjustes titulo={textos.seccionesNuevas.sistema.supervision} icono="󰓅">
        <AjusteInterruptor titulo={textos.monitores.bateria.titulo} informacion={textos.monitores.bateria.descripcion} activo={batteryMonitorEnabled} alAlternar={() => setBatteryMonitorEnabled(!batteryMonitorEnabled.get())} />
        <AjusteInterruptor titulo={textos.monitores.temperatura.titulo} informacion={textos.monitores.temperatura.descripcion} activo={tempMonitorEnabled} alAlternar={() => setTempMonitorEnabled(!tempMonitorEnabled.get())} />
      </TarjetaAjustes>
      <AjustesActualizaciones />
    </box>
  )
}
