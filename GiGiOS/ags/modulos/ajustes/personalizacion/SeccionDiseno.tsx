// modulos/ajustes/personalizacion/SeccionDiseno.tsx
import { For } from "ags"
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import CapturasMicrofono from "../barra/CapturasMicrofono"
import OpcionDaltonismo from "../accesibilidad/OpcionDaltonismo"
import SelectorFondoShell from "./SelectorFondoShell"
import {
  AjusteInterruptor, FilaAjuste, TarjetaAjustes,
  TextoInformativo, TituloSeccion,
} from "../componentes"
import {
  acentoAdaptativoEnabled, setAcentoAdaptativoEnabled,
  spotifyBarEnabled, setSpotifyBarEnabled,
  batteryBarEnabled, setBatteryBarEnabled,
  networkBarEnabled, setNetworkBarEnabled,
  micIndicatorEnabled, setMicIndicatorEnabled,
  screencastIndicatorEnabled, setScreencastIndicatorEnabled,
  trayBarEnabled, setTrayBarEnabled,
  notificationBarEnabled, setNotificationBarEnabled,
  lagartoBarraEnabled, setLagartoBarraEnabled,
  workspacesBarEnabled, setWorkspacesBarEnabled,
  wsPreviewEnabled, setWsPreviewEnabled,
  titulosAppsWorkspaceActivos, setTitulosAppsWorkspaceActivos,
} from "../preferences"
import {
  knownTrayApps, hiddenTrayApps, trayOverflowAt,
  hideTrayApp, showTrayApp, forgetTrayApp, setTrayOverflowAt,
  type TrayAppInfo,
} from "../trayApps"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import textosAccesibilidad from "../../../textos/ajustes/accesibilidad.json" with { type: "json" }
import textosPersonalizacion from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import textosApps from "../../../textos/ajustes/apps.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

function FilaAppBandeja({ app }: { app: TrayAppInfo }) {
  const visible = hiddenTrayApps((ocultas: string[]) => !ocultas.includes(app.id))
  return (
    <FilaAjuste titulo={app.title}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        {app.iconName
          ? <image iconName={app.iconName} pixelSize={22} />
          : <label cssClasses={["sp-nav-icon"]} label="󰀻" />}
        <button
          cssClasses={["sp-rule-del"]}
          valign={Gtk.Align.CENTER}
          tooltipText={textosApps.app.quitar}
          onClicked={() => forgetTrayApp(app.id)}
        >
          <label label="󰆴" />
        </button>
        <Interruptor activo={visible} alAlternar={() => visible.get() ? hideTrayApp(app.id) : showTrayApp(app.id)} />
      </box>
    </FilaAjuste>
  )
}

/** Apariencia visual del shell: qué se ve y cómo, nunca cómo se comporta.
 *  Ver la sección "Reparto de ajustes en Diseño / Comportamiento" de la spec. */
export default function SeccionDiseno() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.secciones.diseno} />

      <TarjetaAjustes titulo={textosAccesibilidad.grupos.daltonismo} icono="󰦧">
        <box cssClasses={["dev-row"]}>
          <TextoInformativo
            label={textosAccesibilidad.daltonismo.descripcion}
            wrap
            xalign={0}
            maxWidthChars={72}
          />
        </box>
        <OpcionDaltonismo modo="protanopia" {...textosAccesibilidad.modos.protanopia} />
        <OpcionDaltonismo modo="deuteranopia" {...textosAccesibilidad.modos.deuteranopia} />
        <OpcionDaltonismo modo="tritanopia" {...textosAccesibilidad.modos.tritanopia} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.apariencia} icono="󰏘">
        <SelectorFondoShell />
        <AjusteInterruptor titulo={textosPersonalizacion.apariencia.acento.titulo} informacion={textosPersonalizacion.apariencia.acento.descripcion} activo={acentoAdaptativoEnabled} alAlternar={() => setAcentoAdaptativoEnabled(!acentoAdaptativoEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.elementos} icono="󰕰">
        <AjusteInterruptor titulo={textosPersonalizacion.barra.spotify.titulo} informacion={textosPersonalizacion.barra.spotify.descripcion} activo={spotifyBarEnabled} alAlternar={() => setSpotifyBarEnabled(!spotifyBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.bateria.titulo} informacion={textosPersonalizacion.barra.bateria.descripcion} activo={batteryBarEnabled} alAlternar={() => setBatteryBarEnabled(!batteryBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.red.titulo} informacion={textosPersonalizacion.barra.red.descripcion} activo={networkBarEnabled} alAlternar={() => setNetworkBarEnabled(!networkBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.indicadorMicrofono.titulo} informacion={textosPersonalizacion.barra.indicadorMicrofono.descripcion} activo={micIndicatorEnabled} alAlternar={() => setMicIndicatorEnabled(!micIndicatorEnabled.get())} />
        <box visible={micIndicatorEnabled}><CapturasMicrofono /></box>
        <AjusteInterruptor titulo={textosPersonalizacion.barra.compartirPantalla.titulo} informacion={textosPersonalizacion.barra.compartirPantalla.descripcion} activo={screencastIndicatorEnabled} alAlternar={() => setScreencastIndicatorEnabled(!screencastIndicatorEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.bandeja.titulo} informacion={textosPersonalizacion.barra.bandeja.descripcion} activo={trayBarEnabled} alAlternar={() => setTrayBarEnabled(!trayBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.notificaciones.titulo} informacion={textosPersonalizacion.barra.notificaciones.descripcion} activo={notificationBarEnabled} alAlternar={() => setNotificationBarEnabled(!notificationBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.lagarto.titulo} informacion={textosPersonalizacion.barra.lagarto.descripcion} activo={lagartoBarraEnabled} alAlternar={() => setLagartoBarraEnabled(!lagartoBarraEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.espaciosBarra} icono="󰆾">
        <AjusteInterruptor titulo={textosPersonalizacion.barra.workspaces.titulo} informacion={textosPersonalizacion.barra.workspaces.descripcion} activo={workspacesBarEnabled} alAlternar={() => setWorkspacesBarEnabled(!workspacesBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.vistaPrevia.titulo} informacion={textosPersonalizacion.vistaPrevia.descripcion} activo={wsPreviewEnabled} visible={workspacesBarEnabled} alAlternar={() => setWsPreviewEnabled(!wsPreviewEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.workspaces.titulosApps.titulo} informacion={textosPersonalizacion.barra.workspaces.titulosApps.descripcion} activo={titulosAppsWorkspaceActivos} visible={workspacesBarEnabled} alAlternar={() => setTitulosAppsWorkspaceActivos(!titulosAppsWorkspaceActivos.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosApps.seccion.titulo} icono="󰀻" visible={trayBarEnabled}>
        <FilaAjuste titulo={textosApps.agrupacion.titulo} informacion={textosApps.agrupacion.descripcion} visible={trayBarEnabled}>
          <box spacing={6} valign={Gtk.Align.CENTER}>
            <button cssClasses={["sp-step-btn"]} onClicked={() => setTrayOverflowAt(trayOverflowAt.get() - 1)}><label label="−" /></button>
            <label cssClasses={["sp-step-val"]} label={trayOverflowAt((n: number) => formatearTexto(textosApps.agrupacion.cantidad, { cantidad: n }))} />
            <button cssClasses={["sp-step-btn"]} onClicked={() => setTrayOverflowAt(trayOverflowAt.get() + 1)}><label label="+" /></button>
          </box>
        </FilaAjuste>
        <box orientation={Gtk.Orientation.VERTICAL} visible={trayBarEnabled}>
          <box cssClasses={["dev-row"]} visible={knownTrayApps((apps: TrayAppInfo[]) => apps.length === 0)}>
            <TextoInformativo label={textosApps.vacio} halign={Gtk.Align.START} />
          </box>
          <For each={knownTrayApps}>{(app: TrayAppInfo) => <FilaAppBandeja app={app} />}</For>
        </box>
      </TarjetaAjustes>
    </box>
  )
}
