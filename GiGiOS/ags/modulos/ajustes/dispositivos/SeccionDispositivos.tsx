import { Gtk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import { DisplaySelect } from "../../../servicios/pantalla/controls"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import Interruptor from "../../../componentes/Interruptor"
import { EncabezadoAjuste, FilaAjuste, TarjetaAjustes, TituloSeccion } from "../componentes"
import {
  deviceSettings, updateDeviceSettings, resetDeviceSettings,
  type DeviceSettings,
} from "../../../servicios/dispositivos/service"
import {
  printerStatus, printerBusy, refresh as refreshPrinters,
  setCupsEnabled, openCupsWeb,
} from "../../../servicios/dispositivos/printers"
import { temasHyprcursorDisponibles } from "../../../servicios/dispositivos/cursores"
import textos from "../../../textos/ajustes/dispositivos.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

type Key = keyof DeviceSettings

function ToggleRow({ setting, label, hint }: { setting: Key, label: string, hint?: string }) {
  const active = deviceSettings((s) => Boolean(s[setting]))
  return (
    <FilaAjuste titulo={label} informacion={hint} spacing={12} maxCaracteresInformacion={54}>
      <Interruptor
        activo={active}
        alAlternar={() => updateDeviceSettings({ [setting]: !Boolean(deviceSettings.get()[setting]) })}
      />
    </FilaAjuste>
  )
}

function SliderRow({ setting, label, hint, min, max, step, format }: {
  setting: Key, label: string, hint?: string, min: number, max: number, step: number,
  format: (n: number) => string,
}) {
  const adjustment = new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: step, pageIncrement: step * 5 })
  adjustment.value = Number(deviceSettings.get()[setting])
  const scale = new Gtk.Scale({ orientation: Gtk.Orientation.HORIZONTAL, adjustment, drawValue: false, hexpand: true })
  scale.cssClasses = ["qs-slider", "dev-slider"]
  conectarCambioDeslizador(scale, (value) =>
    updateDeviceSettings({ [setting]: Math.round(value / step) * step }))
  // onCleanup, NUNCA connect("destroy"): ver SettingsPanel.tsx (CLAUDE.md raíz).
  // El handler de `destroy` no corría al desmontar con <With>, así que cada visita a
  // Ratón/Touchpad/Teclado/Impresoras añadía un suscriptor permanente a deviceSettings.
  onCleanup(deviceSettings.subscribe(() => { adjustment.value = Number(deviceSettings.get()[setting]) }))
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]}>
      <box spacing={8}>
        <EncabezadoAjuste titulo={label} informacion={hint} />
        <label cssClasses={["sp-field-value", "dev-value"]} label={deviceSettings((s) => format(Number(s[setting])))} />
      </box>
      {scale}
    </box>
  )
}

function SelectRow({ setting, label, hint, choices }: {
  setting: Key, label: string, hint?: string, choices: { value: string | number, label: string }[],
}) {
  const current = deviceSettings((s) => choices.find(c => String(c.value) === String(s[setting]))?.label ?? String(s[setting]))
  const options = deviceSettings((s) => choices.map(c => ({ ...c, value: String(c.value), active: String(c.value) === String(s[setting]) })))
  return (
    <FilaAjuste titulo={label} informacion={hint}>
      <box cssClasses={["dev-select"]}>
        <DisplaySelect current={current} options={options} onSelect={(v) => {
          const choice = choices.find(c => String(c.value) === v)
          if (choice) updateDeviceSettings({ [setting]: choice.value } as Partial<DeviceSettings>)
        }} />
      </box>
    </FilaAjuste>
  )
}

// Tema del puntero. Solo se ofrecen temas con manifest.hl (hyprcursor): elegir
// uno sin él dejaría al compositor cayendo a XCursor sin ningún aviso. La lista
// se calcula UNA vez al construir la fila —instalar un tema es un gesto de
// terminal, no algo que pase mientras miras esta pantalla— y siempre incluye la
// elección guardada aunque ese tema ya no esté: si no, abrir Ajustes en una
// máquina sin él reescribiría el ajuste a "" al primer toque.
function CursorThemeRow() {
  const disponibles = temasHyprcursorDisponibles()
  const guardado = deviceSettings.get().temaCursor
  const nombres = disponibles.map((t) => t.nombre)
  if (guardado && !nombres.includes(guardado)) nombres.unshift(guardado)

  const choices = [
    { value: "", label: textos.puntero.tema.opciones.automatico },
    ...nombres.map((nombre) => ({ value: nombre, label: nombre })),
  ]
  const hint = nombres.length === 0 ? textos.puntero.tema.sinTemas : textos.puntero.tema.descripcion
  return <SelectRow setting="temaCursor" label={textos.puntero.tema.titulo} hint={hint} choices={choices} />
}

// Bloque de impresoras: un interruptor maestro para CUPS, con estado en vivo y
// acceso al panel web. La lógica de sistema vive en servicios/dispositivos/printers.
function PrintersCard() {
  const stateLabel = printerStatus((s) => !s.available
    ? textos.impresoras.estado.noInstalado
    : s.active ? textos.impresoras.estado.activo : textos.impresoras.estado.inactivo)
  const dotClass = printerStatus((s) => !s.available ? ["dev-status-dot"] : s.active ? ["dev-status-dot", "on"] : ["dev-status-dot", "off"])
  const impresionActiva = printerStatus((s) => s.enabled)
  return (
    <TarjetaAjustes titulo={textos.tarjetas.impresoras} icono="󰐪">
      <FilaAjuste
        titulo={textos.impresoras.servicio.titulo}
        informacion={printerStatus((s) => !s.available
              ? textos.impresoras.servicio.descripcionNoInstalado
              : textos.impresoras.servicio.descripcionDisponible)}
        spacing={12}
        maxCaracteresInformacion={54}
      >
        <Interruptor
          activo={impresionActiva}
          sensible={printerStatus((s) => s.available)}
          alAlternar={() => { if (!printerBusy.get()) setCupsEnabled(!printerStatus.get().enabled) }}
        />
      </FilaAjuste>

      <FilaAjuste titulo={textos.impresoras.estado.titulo} spacing={10}>
        <box spacing={7} valign={Gtk.Align.CENTER}>
          <box cssClasses={dotClass} valign={Gtk.Align.CENTER} />
          <label cssClasses={["sp-field-value", "dev-value"]} label={stateLabel} />
        </box>
      </FilaAjuste>

      <FilaAjuste
        visible={printerStatus((s) => s.active)}
        titulo={textos.impresoras.configuracion.titulo}
        informacion={textos.impresoras.configuracion.descripcion}
        spacing={10}
        maxCaracteresInformacion={54}
      >
        <button cssClasses={["dev-reset"]} onClicked={() => openCupsWeb()}>
          <label label={textos.impresoras.configuracion.abrir} />
        </button>
      </FilaAjuste>
    </TarjetaAjustes>
  )
}

type VistaDispositivos = "raton" | "touchpad" | "teclado" | "impresoras"

export default function SeccionDispositivos({ vista }: { vista: VistaDispositivos }) {
  const [confirmReset, setConfirmReset] = createState(false)
  if (vista === "impresoras") refreshPrinters()
  // `vexpand` en el overlay + `valign START` en su hijo: la LISTA del select se dibuja
  // como overlay de ESTE widget, así que su alto útil es el del overlay menos lo que baja
  // el desplegable. En una sección corta (Idioma es un título y una tarjeta) el overlay
  // medía lo que medía el contenido y al desplegable le quedaban ~40 px: cabía una opción
  // y media de las 68 del idioma. Ahora el overlay se estira con el ScrolledWindow del
  // panel y el contenido se queda arriba, así que la lista tiene alto por debajo.
  return (
    <overlay cssClasses={["display-select-host"]} vexpand>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand valign={Gtk.Align.START}>
        <TituloSeccion titulo={textos.vistas[vista]} />

        {vista === "raton" && <TarjetaAjustes titulo={textos.tarjetas.raton} icono="󰍽">
          <SliderRow setting="sensitivity" label={textos.raton.velocidadPuntero.titulo} hint={textos.raton.velocidadPuntero.descripcion} min={-1} max={1} step={0.05} format={v => formatearTexto(textos.formatos.sensibilidad, { signo: v > 0 ? "+" : "", valor: v.toFixed(2) })} />
          <SelectRow setting="accelProfile" label={textos.raton.aceleracion.titulo} hint={textos.raton.aceleracion.descripcion} choices={[{ value: "adaptive", label: textos.raton.aceleracion.opciones.adaptativa }, { value: "flat", label: textos.raton.aceleracion.opciones.plana }]} />
          <SliderRow setting="mouseScrollFactor" label={textos.raton.velocidadDesplazamiento.titulo} hint={textos.raton.velocidadDesplazamiento.descripcion} min={0.1} max={3} step={0.1} format={v => formatearTexto(textos.formatos.multiplicador, { valor: v.toFixed(1) })} />
          <ToggleRow setting="forceNoAccel" label={textos.raton.movimientoSinAceleracion.titulo} hint={textos.raton.movimientoSinAceleracion.descripcion} />
          <ToggleRow setting="leftHanded" label={textos.raton.modoZurdo.titulo} hint={textos.raton.modoZurdo.descripcion} />
          <ToggleRow setting="mouseNaturalScroll" label={textos.raton.desplazamientoNatural.titulo} hint={textos.raton.desplazamientoNatural.descripcion} />
        </TarjetaAjustes>}

        {vista === "touchpad" && <TarjetaAjustes titulo={textos.tarjetas.touchpad} icono="󰟸">
          <SliderRow setting="touchpadScrollFactor" label={textos.touchpad.velocidadDesplazamiento.titulo} hint={textos.touchpad.velocidadDesplazamiento.descripcion} min={0.1} max={3} step={0.1} format={v => formatearTexto(textos.formatos.multiplicador, { valor: v.toFixed(1) })} />
          <ToggleRow setting="touchpadNaturalScroll" label={textos.touchpad.desplazamientoNatural.titulo} hint={textos.touchpad.desplazamientoNatural.descripcion} />
          <ToggleRow setting="tapToClick" label={textos.touchpad.tocarParaClic.titulo} hint={textos.touchpad.tocarParaClic.descripcion} />
          <SelectRow setting="tapButtonMap" label={textos.touchpad.mapaToques.titulo} choices={[{ value: "lrm", label: textos.touchpad.mapaToques.opciones.derechoMedio }, { value: "lmr", label: textos.touchpad.mapaToques.opciones.medioDerecho }]} />
          <ToggleRow setting="disableWhileTyping" label={textos.touchpad.desactivarMientrasEscribe.titulo} hint={textos.touchpad.desactivarMientrasEscribe.descripcion} />
          <ToggleRow setting="clickfinger" label={textos.touchpad.clicPorDedos.titulo} hint={textos.touchpad.clicPorDedos.descripcion} />
          <ToggleRow setting="middleEmulation" label={textos.touchpad.emularBotonCentral.titulo} hint={textos.touchpad.emularBotonCentral.descripcion} />
          <ToggleRow setting="dragLock" label={textos.touchpad.bloqueoArrastre.titulo} hint={textos.touchpad.bloqueoArrastre.descripcion} />
        </TarjetaAjustes>}

        {vista === "teclado" && <TarjetaAjustes titulo={textos.tarjetas.teclado} icono="󰌌">
          <SelectRow setting="kbLayout" label={textos.teclado.distribucion.titulo} hint={textos.teclado.distribucion.descripcion} choices={[{ value: "es", label: textos.teclado.distribucion.opciones.espanol }, { value: "latam", label: textos.teclado.distribucion.opciones.latinoamericano }, { value: "us", label: textos.teclado.distribucion.opciones.inglesEstadosUnidos }, { value: "gb", label: textos.teclado.distribucion.opciones.inglesReinoUnido }, { value: "fr", label: textos.teclado.distribucion.opciones.frances }, { value: "de", label: textos.teclado.distribucion.opciones.aleman }, { value: "pt", label: textos.teclado.distribucion.opciones.portugues }, { value: "it", label: textos.teclado.distribucion.opciones.italiano }]} />
          <SelectRow setting="kbVariant" label={textos.teclado.variante.titulo} choices={[{ value: "", label: textos.teclado.variante.opciones.predeterminada }, { value: "nodeadkeys", label: textos.teclado.variante.opciones.sinTeclasMuertas }, { value: "dvorak", label: textos.teclado.variante.opciones.dvorak }, { value: "colemak", label: textos.teclado.variante.opciones.colemak }]} />
          <SliderRow setting="repeatRate" label={textos.teclado.velocidadRepeticion.titulo} min={1} max={60} step={1} format={v => formatearTexto(textos.formatos.porSegundo, { valor: v })} />
          <SliderRow setting="repeatDelay" label={textos.teclado.esperaRepeticion.titulo} min={100} max={1200} step={50} format={v => formatearTexto(textos.formatos.milisegundos, { valor: v })} />
          <ToggleRow setting="numlock" label={textos.teclado.bloqueoNumerico.titulo} hint={textos.teclado.bloqueoNumerico.descripcion} />
        </TarjetaAjustes>}

        {vista === "raton" && <TarjetaAjustes titulo={textos.tarjetas.puntero} icono="󰆽">
          <CursorThemeRow />
          <SliderRow setting="tamanoCursor" label={textos.puntero.tamano.titulo} min={16} max={64} step={1} format={v => formatearTexto(textos.formatos.pixeles, { valor: v })} />
          <SelectRow setting="followMouse" label={textos.puntero.foco.titulo} hint={textos.puntero.foco.descripcion} choices={[{ value: 0, label: textos.puntero.foco.opciones.soloClic }, { value: 1, label: textos.puntero.foco.opciones.seguirPuntero }, { value: 2, label: textos.puntero.foco.opciones.focoLibre }, { value: 3, label: textos.puntero.foco.opciones.seguirSinTeclado }]} />
        </TarjetaAjustes>}

        {vista === "impresoras" && <PrintersCard />}

        <box cssClasses={["dev-reset-row"]} spacing={10} valign={Gtk.Align.CENTER} visible={vista === "raton"}>
          <EncabezadoAjuste
            titulo={textos.restablecer.titulo}
            informacion={textos.restablecer.descripcion}
          />
          <button cssClasses={confirmReset((v) => v ? ["dev-reset", "confirm"] : ["dev-reset"])} onClicked={() => {
            if (confirmReset.get()) { resetDeviceSettings(); setConfirmReset(false) }
            else setConfirmReset(true)
          }}><label label={confirmReset((v) => v ? textos.restablecer.confirmar : textos.restablecer.boton)} /></button>
        </box>
      </box>
    </overlay>
  )
}
