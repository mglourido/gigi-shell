// modulos/ajustes/personalizacion/SeccionComportamiento.tsx
import { createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { InlineEditableValue } from "../../../componentes/InlineEditableValue"
import {
  AjusteInterruptor, TarjetaAjustes,
  TextoInformativo, TituloAjuste, TituloSeccion,
} from "../componentes"
import {
  barAutoHideEnabled, setBarAutoHideEnabled,
  barraAvisoBateria, setBarraAvisoBateria,
  barraAvisoBateriaUsaUmbralAhorro, setBarraAvisoBateriaUsaUmbralAhorro,
  barraAvisoBateriaPct, setBarraAvisoBateriaPct,
  BARRA_AVISO_BATERIA_MIN, BARRA_AVISO_BATERIA_MAX,
  workspaceAppLimit, setWorkspaceAppLimit,
  WORKSPACE_APP_LIMIT_MIN, WORKSPACE_APP_LIMIT_MAX,
  workspaceVisibleLimit, setWorkspaceVisibleLimit,
  WORKSPACE_VISIBLE_LIMIT_MIN, WORKSPACE_VISIBLE_LIMIT_MAX,
  segundaVentanaAlLado, setSegundaVentanaAlLado,
  startupVolumeMuted, setStartupVolumeMuted,
  startupMicMuted, setStartupMicMuted,
  startupBluetoothOff, setStartupBluetoothOff,
  volumeOsdEnabled, setVolumeOsdEnabled,
  micOsdEnabled, setMicOsdEnabled,
  brightnessOsdEnabled, setBrightnessOsdEnabled,
  anclarVentanasRofi, setAnclarVentanasRofi,
  escanerAppsInicio, setEscanerAppsInicio,
  absorberSuperSinAtajo, setAbsorberSuperSinAtajo,
} from "../preferences"
import { bateriaPresente } from "../../../servicios/energia/powerState"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import textosPersonalizacion from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

function DeslizadorLimite({ valor, minimo, maximo, alCambiar }: {
  valor: any
  minimo: number
  maximo: number
  alCambiar: (valor: number) => void
}) {
  const ajuste = new Gtk.Adjustment({ lower: minimo, upper: maximo, stepIncrement: 1, pageIncrement: 1 })
  ajuste.value = valor.get()
  const escala = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: ajuste,
    drawValue: false,
    digits: 0,
    hexpand: true,
  })
  escala.cssClasses = ["qs-slider", "brightness"]
  conectarCambioDeslizador(escala, alCambiar)
  // onCleanup, NUNCA connect("destroy"): en GTK4 `destroy` sale de `dispose`, y al
  // desmontar con <With> el widget solo se desparenta —los closures de JS lo siguen
  // referenciando—, así que el handler no llegaba a correr. <With> sí hace
  // scope.dispose(). Mismo patrón que ReproduccionSpotify.tsx.
  onCleanup(valor.subscribe(() => {
    if (ajuste.value !== valor.get()) ajuste.value = valor.get()
  }))
  return escala
}

function LimiteWorkspace({ titulo, descripcion, tooltip, valor, minimo, maximo, alCambiar }: {
  titulo: string
  descripcion: string
  tooltip: string
  valor: any
  minimo: number
  maximo: number
  alCambiar: (valor: number) => void
}) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TituloAjuste label={titulo} hexpand halign={Gtk.Align.START} />
        <InlineEditableValue
          display={valor((limite: number) => `${limite}`)}
          getValue={() => valor.get()}
          onCommit={alCambiar}
          min={minimo}
          max={maximo}
          labelClass="sp-field-value"
          tooltip={tooltip}
          maxLength={1}
        />
      </box>
      {DeslizadorLimite({ valor, minimo, maximo, alCambiar }) as unknown as any}
      <TextoInformativo label={descripcion} halign={Gtk.Align.START} wrap xalign={0} />
    </box>
  )
}

/** Umbral propio del aviso de batería baja: título + valor editable +
 *  deslizador, pero en tanto por ciento y hasta tres cifras — por eso no
 *  reutiliza `LimiteWorkspace`, que fija `maxLength={1}`. */
function UmbralAvisoBateria({ visible }: { visible: any }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]} visible={visible}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TituloAjuste label={textosPersonalizacion.barra.avisoBateria.umbral.titulo} hexpand halign={Gtk.Align.START} />
        <InlineEditableValue
          display={barraAvisoBateriaPct((pct: number) => `${pct} %`)}
          getValue={() => barraAvisoBateriaPct.get()}
          onCommit={setBarraAvisoBateriaPct}
          min={BARRA_AVISO_BATERIA_MIN}
          max={BARRA_AVISO_BATERIA_MAX}
          labelClass="sp-field-value"
          tooltip={textosPersonalizacion.barra.avisoBateria.umbral.tooltip}
          maxLength={3}
        />
      </box>
      {DeslizadorLimite({
        valor: barraAvisoBateriaPct,
        minimo: BARRA_AVISO_BATERIA_MIN,
        maximo: BARRA_AVISO_BATERIA_MAX,
        alCambiar: setBarraAvisoBateriaPct,
      }) as unknown as any}
      <TextoInformativo
        label={formatearTexto(textosPersonalizacion.barra.avisoBateria.umbral.descripcion, {
          minimo: BARRA_AVISO_BATERIA_MIN, maximo: BARRA_AVISO_BATERIA_MAX,
        })}
        halign={Gtk.Align.START} wrap xalign={0}
      />
    </box>
  )
}

/** Comportamiento funcional del shell: qué hace cada cosa, nunca cómo se ve.
 *  Ver la sección "Reparto de ajustes en Diseño / Comportamiento" de la spec. */
export default function SeccionComportamiento() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.secciones.comportamiento} />

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.comportamiento} icono="󰍜">
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.ocultacionAutomatica.titulo}
          informacion={textosPersonalizacion.barra.ocultacionAutomatica.descripcion}
          activo={barAutoHideEnabled}
          alAlternar={() => setBarAutoHideEnabled(!barAutoHideEnabled.get())}
        />
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.avisoBateria.titulo}
          informacion={textosPersonalizacion.barra.avisoBateria.descripcion}
          activo={barraAvisoBateria}
          visible={bateriaPresente}
          sensible={barAutoHideEnabled}
          alAlternar={() => setBarraAvisoBateria(!barraAvisoBateria.get())}
        />
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.avisoBateria.vinculo.titulo}
          informacion={textosPersonalizacion.barra.avisoBateria.vinculo.descripcion}
          activo={barraAvisoBateriaUsaUmbralAhorro}
          visible={createComputed(
            [bateriaPresente, barraAvisoBateria, barAutoHideEnabled],
            (hayBateria, avisoPuesto, autoOcultar) => hayBateria && avisoPuesto && autoOcultar,
          )}
          alAlternar={() => setBarraAvisoBateriaUsaUmbralAhorro(!barraAvisoBateriaUsaUmbralAhorro.get())}
        />
        <UmbralAvisoBateria
          visible={createComputed(
            [bateriaPresente, barraAvisoBateria, barraAvisoBateriaUsaUmbralAhorro, barAutoHideEnabled],
            (hayBateria, avisoPuesto, vinculado, autoOcultar) =>
              hayBateria && avisoPuesto && !vinculado && autoOcultar,
          )}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.espacios} icono="󰆾">
        <box orientation={Gtk.Orientation.VERTICAL}>
          <LimiteWorkspace
            titulo={textosPersonalizacion.barra.workspaces.limiteApps.titulo}
            descripcion={formatearTexto(textosPersonalizacion.barra.workspaces.limiteApps.descripcion, { minimo: WORKSPACE_APP_LIMIT_MIN, maximo: WORKSPACE_APP_LIMIT_MAX })}
            tooltip={textosPersonalizacion.barra.workspaces.limiteApps.tooltip}
            valor={workspaceAppLimit}
            minimo={WORKSPACE_APP_LIMIT_MIN}
            maximo={WORKSPACE_APP_LIMIT_MAX}
            alCambiar={setWorkspaceAppLimit}
          />
          <LimiteWorkspace
            titulo={textosPersonalizacion.barra.workspaces.limiteVisibles.titulo}
            descripcion={textosPersonalizacion.barra.workspaces.limiteVisibles.descripcion}
            tooltip={textosPersonalizacion.barra.workspaces.limiteVisibles.tooltip}
            valor={workspaceVisibleLimit}
            minimo={WORKSPACE_VISIBLE_LIMIT_MIN}
            maximo={WORKSPACE_VISIBLE_LIMIT_MAX}
            alCambiar={setWorkspaceVisibleLimit}
          />
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.colocacion} icono="󰕰">
        <AjusteInterruptor
          titulo={textosPersonalizacion.ventanas.segundaAlLado.titulo}
          informacion={textosPersonalizacion.ventanas.segundaAlLado.descripcion}
          activo={segundaVentanaAlLado}
          alAlternar={() => setSegundaVentanaAlLado(!segundaVentanaAlLado.get())}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.sonidoInicio} icono="󰍃">
        <AjusteInterruptor titulo={textosPersonalizacion.inicioAudio.volumen.titulo} informacion={textosPersonalizacion.inicioAudio.volumen.descripcion} activo={startupVolumeMuted} alAlternar={() => setStartupVolumeMuted(!startupVolumeMuted.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.inicioAudio.microfono.titulo} informacion={textosPersonalizacion.inicioAudio.microfono.descripcion} activo={startupMicMuted} alAlternar={() => setStartupMicMuted(!startupMicMuted.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.inicioConectividad.bluetooth.titulo} informacion={textosPersonalizacion.inicioConectividad.bluetooth.descripcion} activo={startupBluetoothOff} alAlternar={() => setStartupBluetoothOff(!startupBluetoothOff.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.indicadores} icono="󰕾">
        <AjusteInterruptor titulo={textosPersonalizacion.osd.volumen.titulo} informacion={textosPersonalizacion.osd.volumen.descripcion} activo={volumeOsdEnabled} alAlternar={() => setVolumeOsdEnabled(!volumeOsdEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.osd.microfono.titulo} informacion={textosPersonalizacion.osd.microfono.descripcion} activo={micOsdEnabled} alAlternar={() => setMicOsdEnabled(!micOsdEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.osd.brillo.titulo} informacion={textosPersonalizacion.osd.brillo.descripcion} activo={brightnessOsdEnabled} alAlternar={() => setBrightnessOsdEnabled(!brightnessOsdEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.ventanas} icono="󰖯">
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.anclaje.titulo} informacion={textosPersonalizacion.ventanas.anclaje.descripcion} activo={anclarVentanasRofi} alAlternar={() => setAnclarVentanasRofi(!anclarVentanasRofi.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.escanerInicio.titulo} informacion={textosPersonalizacion.ventanas.escanerInicio.descripcion} activo={escanerAppsInicio} alAlternar={() => setEscanerAppsInicio(!escanerAppsInicio.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.superSordo.titulo} informacion={textosPersonalizacion.ventanas.superSordo.descripcion} activo={absorberSuperSinAtajo} alAlternar={() => setAbsorberSuperSinAtajo(!absorberSuperSinAtajo.get())} />
      </TarjetaAjustes>
    </box>
  )
}
