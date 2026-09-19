import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, TarjetaAjustes, TituloSeccion } from "../componentes"
import LimpiezaPortapapeles from "./LimpiezaPortapapeles"
import {
  orionEnabled, setOrionEnabled,
  orionAppsDefault, setOrionAppsDefault,
  orionRecordarUltimaSeccion, setOrionRecordarUltimaSeccion,
  clipboardHistoryEnabled, setClipboardHistoryEnabled,
  limpiezaPortapapelesAlIniciar, setLimpiezaPortapapelesAlIniciar,
} from "../preferences"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

type VistaFunciones = "orion" | "portapapeles"

export default function SeccionFuncionesShell({ vista }: { vista: VistaFunciones }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.vistasFunciones[vista]} />

      {vista === "orion" && <TarjetaAjustes titulo={textos.seccionesNuevas.funcionesShell.orion} icono="󰆍">
        <AjusteInterruptor titulo={textos.orion.menu.titulo} informacion={textos.orion.menu.descripcion} activo={orionEnabled} alAlternar={() => setOrionEnabled(!orionEnabled.get())} />
        <AjusteInterruptor titulo={textos.orion.paginaInicial.titulo} informacion={textos.orion.paginaInicial.descripcion} activo={orionAppsDefault} visible={orionEnabled} alAlternar={() => setOrionAppsDefault(!orionAppsDefault.get())} />
        <AjusteInterruptor titulo={textos.orion.ultimaSeccion.titulo} informacion={textos.orion.ultimaSeccion.descripcion} activo={orionRecordarUltimaSeccion} visible={orionEnabled} alAlternar={() => setOrionRecordarUltimaSeccion(!orionRecordarUltimaSeccion.get())} />
      </TarjetaAjustes>}

      {vista === "portapapeles" && <TarjetaAjustes titulo={textos.seccionesNuevas.funcionesShell.portapapeles} icono="󰅇">
        <AjusteInterruptor titulo={textos.portapapeles.titulo} informacion={textos.portapapeles.descripcion} activo={clipboardHistoryEnabled} alAlternar={() => setClipboardHistoryEnabled(!clipboardHistoryEnabled.get())} />
        <LimpiezaPortapapeles />
        <AjusteInterruptor
          titulo={textos.portapapeles.limpiezaAutomatica.titulo}
          informacion={textos.portapapeles.limpiezaAutomatica.descripcion}
          activo={limpiezaPortapapelesAlIniciar}
          alAlternar={() => setLimpiezaPortapapelesAlIniciar(!limpiezaPortapapelesAlIniciar.get())}
        />
      </TarjetaAjustes>}
    </box>
  )
}
