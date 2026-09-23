import { Gtk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import GLib from "gi://GLib"
import Interruptor from "../../../componentes/Interruptor"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { brightness, nightLightActive, nightLightTemp } from "../../../estado/shell"
import {
  saveDisplayConfig,
  setManualTemp,
  setNightLightManual,
} from "../../../servicios/pantalla/service"
import { applyBrightness, brightnessSupported } from "../../../servicios/pantalla/brightness"
import { TextoInformativo, TituloAjuste, TituloSubseccion } from "../componentes"
import textos from "../../../textos/ajustes/pantalla.json" with { type: "json" }

const acotar = (valor: number, minimo = 0, maximo = 1) =>
  Math.max(minimo, Math.min(maximo, valor))

function crearDeslizador(
  clases: string[],
  obtenerValor: () => number,
  establecerValor: (valor: number) => void,
  suscribir?: (callback: () => void) => (() => void) | void,
): Gtk.Scale {
  const ajuste = new Gtk.Adjustment({ lower: 0, upper: 1, stepIncrement: 0.01 })
  ajuste.value = acotar(obtenerValor())
  if (suscribir) {
    const desconectar = suscribir(() => { ajuste.value = acotar(obtenerValor()) })
    if (typeof desconectar === "function") onCleanup(desconectar)
  }
  const deslizador = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: ajuste,
    drawValue: false,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  })
  deslizador.cssClasses = clases
  conectarCambioDeslizador(deslizador, (valor) => establecerValor(acotar(valor)))
  return deslizador
}

export default function ControlesLuz() {
  const [editandoBrillo, establecerEditandoBrillo] = createState(false)
  const [editandoTemperatura, establecerEditandoTemperatura] = createState(false)
  let entradaBrillo: Gtk.Entry
  let entradaTemperatura: Gtk.Entry

  const confirmarBrillo = () => {
    const numeroLeido = Number.parseInt(entradaBrillo?.text.trim() ?? "", 10)
    const valor = Number.isFinite(numeroLeido)
      ? Math.max(0, Math.min(100, numeroLeido))
      : Math.round(brightness.get() * 100)
    applyBrightness(valor / 100)
    saveDisplayConfig()
    if (entradaBrillo) entradaBrillo.text = String(valor)
    establecerEditandoBrillo(false)
  }
  const editarBrillo = () => {
    entradaBrillo.text = String(Math.round(brightness.get() * 100))
    establecerEditandoBrillo(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      entradaBrillo.grab_focus()
      entradaBrillo.select_region(0, -1)
      return GLib.SOURCE_REMOVE
    })
  }
  const confirmarTemperatura = () => {
    const numeroLeido = Number.parseInt(entradaTemperatura?.text.trim() ?? "", 10)
    const valor = Number.isFinite(numeroLeido)
      ? Math.max(1500, Math.min(6000, numeroLeido))
      : nightLightTemp.get()
    setManualTemp(valor)
    if (entradaTemperatura) entradaTemperatura.text = String(valor)
    establecerEditandoTemperatura(false)
  }
  const editarTemperatura = () => {
    entradaTemperatura.text = String(nightLightTemp.get())
    establecerEditandoTemperatura(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      entradaTemperatura.grab_focus()
      entradaTemperatura.select_region(0, -1)
      return GLib.SOURCE_REMOVE
    })
  }

  const deslizadorBrillo = crearDeslizador(
    ["qs-slider", "brightness"],
    () => brightness.get(),
    (valor) => { applyBrightness(valor); saveDisplayConfig() },
    (callback) => brightness.subscribe(callback),
  )
  const deslizadorTemperatura = crearDeslizador(
    ["qs-slider", "temperature"],
    () => (nightLightTemp.get() - 1500) / 4500,
    (valor) => setManualTemp(Math.round(valor * 4500 + 1500)),
    (callback) => nightLightTemp.subscribe(callback),
  )

  return (
    <>
      <TituloSubseccion label={textos.grupos.brilloLuz} halign={Gtk.Align.START} />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["sp-field"]} visible={brightnessSupported}>
        <box spacing={6}>
          <TituloAjuste label={textos.brillo.titulo} hexpand halign={Gtk.Align.START} />
          <button cssClasses={["qs-inline-value-btn"]} visible={editandoBrillo((activo) => !activo)} onClicked={editarBrillo}>
            <TextoInformativo label={brightness((valor: number) => `${Math.round(valor * 100)} %`)} />
          </button>
          <Gtk.Entry
            cssClasses={["qs-inline-number-input"]}
            visible={editandoBrillo}
            maxLength={3}
            widthChars={3}
            widthRequest={28}
            heightRequest={16}
            xalign={1}
            inputPurpose={Gtk.InputPurpose.DIGITS}
            $={(self: Gtk.Entry) => {
              entradaBrillo = self
              self.text = String(Math.round(brightness.get() * 100))
            }}
            onActivate={confirmarBrillo}
          >
            <Gtk.EventControllerFocus onLeave={confirmarBrillo} />
          </Gtk.Entry>
        </box>
        {deslizadorBrillo}
        <TextoInformativo label={textos.brillo.descripcion} halign={Gtk.Align.START} wrap xalign={0} />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["sp-field"]}>
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <TituloAjuste label={textos.luzNocturna.titulo} hexpand halign={Gtk.Align.START} />
          <button cssClasses={["qs-inline-value-btn"]} visible={editandoTemperatura((activo) => !activo)} onClicked={editarTemperatura}>
            <TextoInformativo label={nightLightTemp((valor: number) => `${valor}K`)} />
          </button>
          <Gtk.Entry
            cssClasses={["qs-inline-number-input"]}
            visible={editandoTemperatura}
            maxLength={4}
            widthChars={4}
            widthRequest={34}
            heightRequest={16}
            xalign={1}
            inputPurpose={Gtk.InputPurpose.DIGITS}
            $={(self: Gtk.Entry) => {
              entradaTemperatura = self
              self.text = String(nightLightTemp.get())
            }}
            onActivate={confirmarTemperatura}
          >
            <Gtk.EventControllerFocus onLeave={confirmarTemperatura} />
          </Gtk.Entry>
          <Interruptor
            activo={nightLightActive}
            alAlternar={() => setNightLightManual(!nightLightActive.get())}
          />
        </box>
        {deslizadorTemperatura}
        <TextoInformativo label={textos.luzNocturna.descripcion} halign={Gtk.Align.START} wrap xalign={0} />
      </box>
    </>
  )
}
