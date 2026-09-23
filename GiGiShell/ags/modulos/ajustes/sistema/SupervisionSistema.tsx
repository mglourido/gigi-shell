import { createComputed, For } from "ags"
import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, TarjetaAjustes, TextoInformativo, TituloAjuste } from "../componentes"
import {
  batteryMonitorEnabled, setBatteryMonitorEnabled,
  tempMonitorEnabled, setTempMonitorEnabled,
  updatesMonitorEnabled, setUpdatesMonitorEnabled,
  updatesPeriodicEnabled, setUpdatesPeriodicEnabled,
  updatesIntervalHours, setUpdatesIntervalHours,
  updatesWatchList, addUpdatesWatch, removeUpdatesWatch,
} from "../preferences"
import TituloSubseccion from "../componentes/TituloSubseccion"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

// Paquetes vigilados: nombres exactos; el monitor avisa del primero que encuentre.
function PaquetesVigilados() {
  const t = textos.actualizaciones.vigilados
  let entrada: Gtk.Entry
  const anadir = () => {
    const valor = entrada?.get_text().trim() ?? ""
    if (!valor) return
    addUpdatesWatch(valor)
    entrada.set_text("")
  }
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} visible={updatesMonitorEnabled}>
      <TituloSubseccion label={t.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={t.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
        <For each={updatesWatchList}>
          {(nombre: string) => (
            <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
              <label cssClasses={["sp-clase-nombre"]} label={nombre} halign={Gtk.Align.START} ellipsize={3} />
              <box hexpand />
              <button cssClasses={["sp-rule-del"]} onClicked={() => removeUpdatesWatch(nombre)} valign={Gtk.Align.CENTER} tooltipText={t.quitar}>
                <label label="󰅖" />
              </button>
            </box>
          )}
        </For>
      </box>
      <TextoInformativo label={t.vacia} halign={Gtk.Align.START} visible={updatesWatchList((l) => l.length === 0)} />
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <entry
          cssClasses={["sp-num-input", "sp-clase-entrada"]}
          hexpand
          xalign={0}
          placeholderText={t.placeholder}
          $={(self: Gtk.Entry) => { entrada = self }}
          onActivate={anadir}
        />
        <button cssClasses={["sp-add-rule"]} onClicked={anadir} valign={Gtk.Align.CENTER}>
          <label label={t.anadir} />
        </button>
      </box>
    </box>
  )
}

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
      <PaquetesVigilados />
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
