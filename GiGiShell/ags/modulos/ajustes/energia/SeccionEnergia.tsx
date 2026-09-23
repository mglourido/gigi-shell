// modulos/ajustes/energia/SeccionEnergia.tsx
// Sección de energía: umbral y funciones que se suspenden durante el ahorro.
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { createComputed, onCleanup } from "ags"
import { InlineEditableValue } from "../../../componentes/InlineEditableValue"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { AjusteInterruptor, TarjetaAjustes, TextoInformativo, TituloAjuste, TituloSeccion } from "../componentes"
import Inactividad from "../pantalla/Inactividad"
import textos from "../../../textos/ajustes/energia.json" with { type: "json" }
import {
  powerSaveThreshold, setPowerSaveThreshold,
  forcePowerSave, setForcePowerSave,
  suspendNotifFilters, setSuspendNotifFilters,
  pauseWsPreviewInPowerSave, setPauseWsPreviewInPowerSave,
  hideSpotifyBarInPowerSave, setHideSpotifyBarInPowerSave,
  fallbackWaveInPowerSave, setFallbackWaveInPowerSave,
  freezeBackgroundInPowerSave, setFreezeBackgroundInPowerSave,
  hideMascotaInPowerSave, setHideMascotaInPowerSave,
  opaquePanelsInPowerSave, setOpaquePanelsInPowerSave,
  opaqueWindowsInPowerSave, setOpaqueWindowsInPowerSave,
  reduceBrightnessInPowerSave, setReduceBrightnessInPowerSave,
  powerSaveBrightnessMode, setPowerSaveBrightnessMode,
  powerSaveBrightnessPct, setPowerSaveBrightnessPct,
  powerSaveBrightnessDropPct, setPowerSaveBrightnessDropPct,
  tlpAutoInPowerSave, setTlpAutoInPowerSave,
  powerSaveActive, batteryStatusText,
} from "../../../servicios/energia/powerState.ts"
import { brightnessSupported } from "../../../servicios/pantalla/brightness.ts"
import InactividadAhorro from "./InactividadAhorro"
import Segmentado from "./Segmentado"
import SuspensionFalsa from "./SuspensionFalsa"
import { tlpAvailable, tlpMode, tlpBusy, setTlpMode } from "../../../servicios/energia/tlp.ts"
import {
  accionesEnergiaOcultas, botonApagado, setAccionEnergiaOculta, setBotonApagado,
  accionTapa, setAccionTapa,
  tapaIgnorarConPantallaExterna, setTapaIgnorarConPantallaExterna,
} from "../preferences.ts"
import { ACCIONES_ENERGIA, accionesVisibles } from "../../menu-energia/acciones"
import {
  ACCIONES_BOTON_ENCENDIDO,
  comprobarBotonEncendido,
  teclaCedidaAHyprland,
  type AccionBotonEncendido,
} from "../../../servicios/energia/botonEncendido.ts"
import {
  ACCIONES_TAPA,
  comprobarTapa,
  hayTapa,
  tapaCedidaAHyprland,
  type AccionTapa,
} from "../../../servicios/energia/tapaPortatil.ts"
import { DisplaySelect } from "../../../servicios/pantalla/controls"

/** Deslizador 0..100 atado a un estado de `powerState`. Lo comparten el umbral de batería
 *  y el brillo del ahorro: los dos son un porcentaje entero con la misma presentación.
 *  `minimo` existe porque el brillo no puede llegar a 0 (dejaría la pantalla apagada sin
 *  nada visible con lo que volver a subirla), mientras que en el umbral el 0 significa
 *  "desactivado" y sí es un valor legítimo. */
function DeslizadorPorcentaje(
  valor: typeof powerSaveThreshold,
  fijar: (v: number) => void,
  minimo = 0,
): Gtk.Scale {
  const adj = new Gtk.Adjustment({ lower: minimo, upper: 100, stepIncrement: 1, pageIncrement: 5 })
  adj.value = valor.get()
  onCleanup(valor.subscribe(() => {
    if (adj.value !== valor.get()) adj.value = valor.get()
  }))
  const scale = new Gtk.Scale({ orientation: Gtk.Orientation.HORIZONTAL, adjustment: adj, drawValue: false, hexpand: true })
  scale.cssClasses = ["qs-slider", "brightness"]
  conectarCambioDeslizador(scale, fijar)
  return scale
}

const etiquetaAccion = (accion: AccionBotonEncendido) =>
  (textos.botonEncendido.opciones as Record<string, string>)[accion] ?? accion

/**
 * Qué hace el botón de encendido físico. El shell solo guarda la elección: quien la
 * ejecuta es `GiGiShell.boton_apagado()` (`hypr/gigios/boton-apagado.lua`) desde un bind
 * `{locked = true}` de Hyprland, así que
 * el botón sigue respondiendo con AGS caído o la sesión bloqueada.
 *
 * El aviso no sobra: systemd-logind maneja esa tecla por su cuenta y de fábrica
 * apaga el equipo, tapando la acción elegida SIN dar ningún error. Solo se enseña
 * cuando la elección de verdad no puede cumplirse — con "Apagar el equipo" el
 * resultado es el mismo venga de quien venga, así que ahí callar es lo correcto.
 */
function TarjetaBotonEncendido() {
  comprobarBotonEncendido()
  const avisoVisible = createComputed(() =>
    teclaCedidaAHyprland() === false && botonApagado() !== "apagar"
  )

  return (
    <TarjetaAjustes titulo={textos.grupos.botonEncendido} icono="󰐥">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <TituloAjuste label={textos.botonEncendido.titulo} halign={Gtk.Align.START} />
        <box cssClasses={["sp-field"]} widthRequest={320} hexpand={false} halign={Gtk.Align.START}>
          <DisplaySelect
            current={botonApagado((accion) => etiquetaAccion(accion))}
            options={botonApagado((actual) => ACCIONES_BOTON_ENCENDIDO.map((accion) => ({
              label: etiquetaAccion(accion), value: accion, active: accion === actual,
            })))}
            onSelect={(valor) => setBotonApagado(valor as AccionBotonEncendido)}
          />
        </box>
        <TextoInformativo label={textos.botonEncendido.descripcion} halign={Gtk.Align.START} wrap />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={avisoVisible}>
          <TextoInformativo
            label={textos.botonEncendido.aviso}
            cssClasses={["sp-field-hint-warn"]}
            halign={Gtk.Align.START} wrap
          />
          <TextoInformativo
            label={textos.botonEncendido.avisoComando}
            cssClasses={["sp-field-hint-command"]}
            halign={Gtk.Align.START} wrap selectable
          />
        </box>
      </box>
    </TarjetaAjustes>
  )
}

const etiquetaAccionTapa = (accion: AccionTapa) =>
  (textos.tapa.opciones as Record<string, string>)[accion] ?? accion

/**
 * Qué hace el portátil al cerrar la tapa. Misma división de trabajo que el botón de
 * encendido: aquí solo se guarda la elección y quien la ejecuta es
 * `GiGiShell.tapa_cerrada()` (`hypr/gigios/tapa.lua`) desde un bind `{locked = true}`
 * sobre `switch:on:Lid Switch`, releyéndola en cada cierre.
 *
 * El aviso avisa de otra cosa que el del botón: la tapa no se le quita a logind
 * desde /etc sino con un inhibidor que solo dura lo que dure la sesión (ver
 * `servicios/energia/tapaPortatil.ts`), así que lo que puede fallar es que el
 * inhibidor no esté puesto — y entonces logind suspende ignorando la elección, sin
 * dar ningún error. Con "Suspender" el resultado es el mismo venga de quien venga,
 * así que ahí se calla.
 */
function TarjetaTapa() {
  comprobarTapa()
  const avisoVisible = createComputed(() =>
    tapaCedidaAHyprland() === false && accionTapa() !== "suspender"
  )

  return (
    <TarjetaAjustes titulo={textos.grupos.tapa} icono="󰌢">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <TituloAjuste label={textos.tapa.titulo} halign={Gtk.Align.START} />
        <box cssClasses={["sp-field"]} widthRequest={320} hexpand={false} halign={Gtk.Align.START}>
          <DisplaySelect
            current={accionTapa((accion) => etiquetaAccionTapa(accion))}
            options={accionTapa((actual) => ACCIONES_TAPA.map((accion) => ({
              label: etiquetaAccionTapa(accion), value: accion, active: accion === actual,
            })))}
            onSelect={(valor) => setAccionTapa(valor as AccionTapa)}
          />
        </box>
        <TextoInformativo label={textos.tapa.descripcion} halign={Gtk.Align.START} wrap />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={avisoVisible}>
          <TextoInformativo
            label={textos.tapa.aviso}
            cssClasses={["sp-field-hint-warn"]}
            halign={Gtk.Align.START} wrap
          />
          <TextoInformativo
            label={textos.tapa.avisoComando}
            cssClasses={["sp-field-hint-command"]}
            halign={Gtk.Align.START} wrap selectable
          />
        </box>
      </box>
      <AjusteInterruptor
        titulo={textos.tapa.externa.titulo}
        informacion={textos.tapa.externa.descripcion}
        activo={tapaIgnorarConPantallaExterna}
        sensible={accionTapa((a) => a !== "nada")}
        alAlternar={() => setTapaIgnorarConPantallaExterna(!tapaIgnorarConPantallaExterna.get())}
      />
    </TarjetaAjustes>
  )
}

/**
 * Qué botones se pintan en el menú de energía. Se guarda la lista de OCULTAS, así que
 * una acción nueva aparece sola sin tener que tocar nada.
 *
 * El interruptor de la última acción visible se deja insensible en vez de dejar que el
 * setter rechace el cambio en silencio: un interruptor que vuelve solo a su sitio se lee
 * como un fallo del shell, y aquí el motivo es una regla — un menú de energía vacío no
 * tendría desde dónde volver a llenarse salvo editando preferences.json a mano.
 */
function TarjetaMenuEnergia() {
  const ultimaVisible = accionesEnergiaOcultas((ocultas) => {
    const visibles = accionesVisibles(ocultas)
    return visibles.length === 1 ? visibles[0].claseCss : null
  })

  return (
    <TarjetaAjustes titulo={textos.grupos.menuEnergia} icono="󰤄">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <TituloAjuste label={textos.menuEnergia.titulo} halign={Gtk.Align.START} />
        <TextoInformativo label={textos.menuEnergia.descripcion} halign={Gtk.Align.START} wrap />
      </box>
      {/* La etiqueta sale de la propia acción, no de textos/: así el nombre del ajuste y
          el del botón del menú no pueden acabar diciendo cosas distintas.

          El `.map` va DENTRO de una caja, igual que en `disco/SeccionAlmacenamiento.tsx`.
          `TarjetaAjustes` es un componente de función que vuelca su `children` como UN
          hijo de su caja, y el JSX de gnim solo aplana UN nivel: con el array suelto
          junto a otros hermanos llegaba anidado a dos niveles y reventaba con «Object …
          is not a subclass of GObject_Object, it's a Array», que tumba la construcción de
          la sección entera — Ajustes > Energía salía en blanco. Con el array como hijo
          ÚNICO (que es el caso de Vigilancia o del catálogo de limpiezas) no pasa, y por
          eso el fallo parece caprichoso.

          El renglón de «la última no se puede quitar» entra en la MISMA caja a propósito:
          `.dev-row:last-child` quita el borde inferior al último hermano, así que dejarlo
          fuera habría movido ese borde de sitio. */}
      <box orientation={Gtk.Orientation.VERTICAL}>
        {ACCIONES_ENERGIA.map((accion) => (
          <AjusteInterruptor
            titulo={accion.etiqueta}
            activo={accionesEnergiaOcultas((ocultas) => !ocultas.includes(accion.claseCss))}
            sensible={ultimaVisible((ultima) => ultima !== accion.claseCss)}
            alAlternar={() => setAccionEnergiaOculta(
              accion.claseCss,
              !accionesEnergiaOcultas.get().includes(accion.claseCss),
            )}
          />
        ))}
        <box cssClasses={["dev-row"]}>
          <TextoInformativo label={textos.menuEnergia.ultima} halign={Gtk.Align.START} wrap />
        </box>
      </box>
    </TarjetaAjustes>
  )
}

export default function SeccionEnergia() {
  const summaryClass = powerSaveActive((active) =>
    active ? ["sp-energy-summary", "active"] : ["sp-energy-summary"]
  )
  const modeClass = powerSaveActive((active) =>
    active ? ["sp-energy-mode", "active"] : ["sp-energy-mode"]
  )

  // El overlay es el ancla que DisplaySelect busca para desplegar su lista sin
  // crear otra superficie (ver servicios/pantalla/controls.tsx).
  // `vexpand` en el overlay + `valign START` en su hijo: la LISTA del select se dibuja
  // como overlay de ESTE widget, así que su alto útil es el del overlay menos lo que baja
  // el desplegable. En una sección corta (Idioma es un título y una tarjeta) el overlay
  // medía lo que medía el contenido y al desplegable le quedaban ~40 px: cabía una opción
  // y media de las 68 del idioma. Ahora el overlay se estira con el ScrolledWindow del
  // panel y el contenido se queda arriba, así que la lista tiene alto por debajo.
  return (
    <overlay cssClasses={["display-select-host"]} vexpand>
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section"]} hexpand valign={Gtk.Align.START}>
      <TituloSeccion titulo={textos.seccion.titulo} />

      {/* estado actual */}
      <box spacing={6} halign={Gtk.Align.START}>
        <label cssClasses={summaryClass} label={batteryStatusText} wrap wrapMode={Pango.WrapMode.WORD_CHAR} xalign={0} />
        <label cssClasses={["sp-energy-separator"]} label="·" />
        <label
          cssClasses={modeClass}
          label={powerSaveActive((active) => active ? textos.estado.ahorroActivo : textos.estado.ahorroDesactivado)}
          wrap wrapMode={Pango.WrapMode.WORD_CHAR} xalign={0}
        />
      </box>

      <TarjetaAjustes titulo={textos.grupos.bateria} icono="󰁹">
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
          <box spacing={8} valign={Gtk.Align.CENTER}>
            <TituloAjuste label={textos.umbral.titulo} hexpand halign={Gtk.Align.START} />
            <InlineEditableValue
              display={powerSaveThreshold((v) => `${Math.round(v)} %`)}
              getValue={() => powerSaveThreshold.get()}
              onCommit={setPowerSaveThreshold}
              min={0} max={100}
              labelClass="sp-field-value"
              tooltip={textos.umbral.tooltip}
            />
          </box>
          {DeslizadorPorcentaje(powerSaveThreshold, setPowerSaveThreshold) as unknown as any}
          <TextoInformativo label={textos.umbral.descripcion} halign={Gtk.Align.START} wrap />
        </box>
        <AjusteInterruptor titulo={textos.forzar.titulo} informacion={textos.forzar.descripcion} activo={forcePowerSave} alAlternar={() => setForcePowerSave(!forcePowerSave.get())} />
      </TarjetaAjustes>

      {/* Ternario con `<></>` y no `&&`: ver la nota larga en `SuspensionFalsa.tsx`. Con la
          rama falsa, `&&` deja el booleano `false` como hijo del árbol y el runtime de gnim
          revienta al llamar a `getType(false)`. Aquí llevaba tiempo sin dar la cara porque
          este hijo cuelga del Fragment de nivel superior, que lo tolera; en cuanto uno igual
          apareció dentro de una tarjeta, se llevó la sección entera. */}
      {tlpAvailable ? (
        <TarjetaAjustes titulo={textos.grupos.tlp} icono="󰂎">
          <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
            <box spacing={8} valign={Gtk.Align.CENTER}>
              <TituloAjuste label={textos.tlp.titulo} hexpand halign={Gtk.Align.START} />
              <Segmentado
                current={tlpMode}
                disabled={tlpBusy}
                onSelect={(v) => setTlpMode(v as any)}
                options={[
                  { value: "normal", label: textos.tlp.normal },
                  { value: "ahorro", label: textos.tlp.ahorro },
                ]}
              />
            </box>
            <TextoInformativo
              label={tlpBusy((b) => b ? textos.tlp.aplicando : textos.tlp.descripcion)}
              halign={Gtk.Align.START} wrap
            />
          </box>
          <AjusteInterruptor
            titulo={textos.tlp.automatico.titulo}
            informacion={textos.tlp.automatico.descripcion}
            activo={tlpAutoInPowerSave}
            alAlternar={() => setTlpAutoInPowerSave(!tlpAutoInPowerSave.get())}
          />
        </TarjetaAjustes>
      ) : <></>}

      {/* Brillo. La tarjeta se pinta SIEMPRE, también sin backend de brillo: ocultarla
          dejaría el ajuste indescubrible y sin nada que explicara la ausencia — el mismo
          criterio que la tarjeta de firmas de ClamAV. Lo que se oculta es el deslizador,
          que sin backend escribiría en el vacío, y en su sitio queda el porqué. */}
      <TarjetaAjustes titulo={textos.grupos.brilloAhorro} icono="󰃞">
        <AjusteInterruptor
          titulo={textos.brillo.titulo}
          informacion={textos.brillo.descripcion}
          activo={reduceBrightnessInPowerSave}
          alAlternar={() => setReduceBrightnessInPowerSave(!reduceBrightnessInPowerSave.get())}
        />
        {/* El deslizador de la REDUCCIÓN se pinta en los dos modos a propósito: en
            "relativo" es el ajuste, y en "fijo" es el fallback que entra cuando el brillo
            ya está por debajo del nivel elegido (ver `brilloAhorroCalculo.ts`), así que
            esconderlo dejaría un valor que sí se aplica sin nada donde editarlo. */}
        <box
          orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand
          visible={createComputed(() => reduceBrightnessInPowerSave() && brightnessSupported())}
        >
          <box spacing={8} valign={Gtk.Align.CENTER}>
            <TituloAjuste label={textos.brillo.modo} hexpand halign={Gtk.Align.START} />
            <Segmentado
              current={powerSaveBrightnessMode}
              onSelect={(v) => setPowerSaveBrightnessMode(v as any)}
              options={[
                { value: "fijo", label: textos.brillo.modoFijo },
                { value: "relativo", label: textos.brillo.modoRelativo },
              ]}
            />
          </box>
          <TextoInformativo
            label={powerSaveBrightnessMode((m) => m === "relativo"
              ? textos.brillo.modoDescripcionRelativa
              : textos.brillo.modoDescripcionFija)}
            halign={Gtk.Align.START} wrap
          />
          <box
            orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand
            visible={powerSaveBrightnessMode((m) => m === "fijo")}
          >
            <box spacing={8} valign={Gtk.Align.CENTER}>
              <TituloAjuste label={textos.brillo.nivel} hexpand halign={Gtk.Align.START} />
              <InlineEditableValue
                display={powerSaveBrightnessPct((v) => `${Math.round(v)} %`)}
                getValue={() => powerSaveBrightnessPct.get()}
                onCommit={setPowerSaveBrightnessPct}
                min={5} max={100}
                labelClass="sp-field-value"
                tooltip={textos.brillo.tooltip}
              />
            </box>
            {DeslizadorPorcentaje(powerSaveBrightnessPct, setPowerSaveBrightnessPct, 5) as unknown as any}
          </box>
          <box spacing={8} valign={Gtk.Align.CENTER}>
            <TituloAjuste label={textos.brillo.reduccion} hexpand halign={Gtk.Align.START} />
            <InlineEditableValue
              display={powerSaveBrightnessDropPct((v) => `${Math.round(v)} %`)}
              getValue={() => powerSaveBrightnessDropPct.get()}
              onCommit={setPowerSaveBrightnessDropPct}
              min={1} max={100}
              labelClass="sp-field-value"
              tooltip={textos.brillo.tooltipReduccion}
            />
          </box>
          {DeslizadorPorcentaje(powerSaveBrightnessDropPct, setPowerSaveBrightnessDropPct, 1) as unknown as any}
          <TextoInformativo label={textos.brillo.suelo} halign={Gtk.Align.START} wrap />
        </box>
        <box cssClasses={["dev-row"]} visible={brightnessSupported((s) => !s)}>
          <TextoInformativo
            label={textos.brillo.sinSoporte}
            cssClasses={["sp-field-hint-warn"]}
            halign={Gtk.Align.START} wrap
          />
        </box>
      </TarjetaAjustes>

      <TarjetaBotonEncendido />

      {/* Ternario con `<></>` y no `&&` (ver la nota de TLP, arriba). Esta tarjeta es
          la excepción al "una tarjeta se pinta siempre": sin tapa que cerrar la
          pregunta no existe, así que en un sobremesa no hay nada que explicar. */}
      {hayTapa ? <TarjetaTapa /> : <></>}

      <TarjetaMenuEnergia />

      <Inactividad />

      <InactividadAhorro />

      <TarjetaAjustes titulo={textos.grupos.modoAhorro} icono="󰌪">
        <AjusteInterruptor titulo={textos.notificaciones.titulo} informacion={textos.notificaciones.descripcion} activo={suspendNotifFilters} alAlternar={() => setSuspendNotifFilters(!suspendNotifFilters.get())} />
        <AjusteInterruptor titulo={textos.vistasPrevias.titulo} informacion={textos.vistasPrevias.descripcion} activo={pauseWsPreviewInPowerSave} alAlternar={() => setPauseWsPreviewInPowerSave(!pauseWsPreviewInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.procesosFondo.titulo} informacion={textos.procesosFondo.descripcion} activo={freezeBackgroundInPowerSave} alAlternar={() => setFreezeBackgroundInPowerSave(!freezeBackgroundInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.spotify.titulo} informacion={textos.spotify.descripcion} activo={hideSpotifyBarInPowerSave} alAlternar={() => setHideSpotifyBarInPowerSave(!hideSpotifyBarInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.ondaSpotify.titulo} informacion={textos.ondaSpotify.descripcion} activo={fallbackWaveInPowerSave} alAlternar={() => setFallbackWaveInPowerSave(!fallbackWaveInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.mascota.titulo} informacion={textos.mascota.descripcion} activo={hideMascotaInPowerSave} alAlternar={() => setHideMascotaInPowerSave(!hideMascotaInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.transparencia.titulo} informacion={textos.transparencia.descripcion} activo={opaquePanelsInPowerSave} alAlternar={() => setOpaquePanelsInPowerSave(!opaquePanelsInPowerSave.get())} />
        <AjusteInterruptor titulo={textos.transparenciaVentanas.titulo} informacion={textos.transparenciaVentanas.descripcion} activo={opaqueWindowsInPowerSave} alAlternar={() => setOpaqueWindowsInPowerSave(!opaqueWindowsInPowerSave.get())} />
      </TarjetaAjustes>

      {/* La suspensión falsa va al FINAL y con tarjetas propias: comparte casi toda la
          maquinaria con el modo ahorro, pero no es «un ahorro más agresivo» — el ahorro
          reacciona a la batería con el usuario delante y esta la pide él porque se va.
          Mezclar sus interruptores con los de arriba habría hecho creer que se aplican
          también con la batería baja. Son dos tarjetas (`SuspensionFalsa` devuelve un
          fragmento) porque el allowlist de apps a congelar es lo único que puede perder
          datos y merece su propio encabezado y su propio aviso. */}
      <SuspensionFalsa />

    </box>
    </overlay>
  )
}
