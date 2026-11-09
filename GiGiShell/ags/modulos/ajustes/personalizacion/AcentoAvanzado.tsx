// modulos/ajustes/personalizacion/AcentoAvanzado.tsx
//
// "Ajustes avanzados" del acento adaptativo: un desplegable bajo el interruptor de
// Enfatizar, visible solo con el acento encendido. Tres acentos que se pueden fijar
// a mano y un deslizador por cada umbral de `acento-fondo.py`.
//
// Los deslizadores se pintan desde `ags/config/acento-parametros.json` (rango, paso,
// grupo) vía `DEFINICIONES`: un parámetro nuevo en ese JSON sale aquí sin tocar este
// fichero, solo con su texto en `textos/ajustes/personalizacion.json`. Todo se
// aplica en vivo; el recálculo y el guardado llevan su propio retardo (ver
// `servicios/fondos/acento.ts` y `acentoPreferencias.ts`).

import { createState, onCleanup } from "ags"
import Gdk from "gi://Gdk"
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { BotonAjustes, TextoInformativo, TituloAjuste, TituloSubseccion } from "../componentes"
import { acentoAdaptativoEnabled } from "../preferences"
import { acentosExtraidos } from "../../../servicios/fondos/acento"
import {
  ACENTOS_FABRICA, CLAVES, DEFINICIONES, EN_GRADOS, decimalesDe, sonFabrica,
  type GrupoParametro,
} from "../../../servicios/fondos/acentoAjustes"
import {
  ajustesAcento, restablecerAjustesAcento, setAcentoManual, setParametroAcento,
} from "../../../servicios/fondos/acentoPreferencias"
import textosPersonalizacion from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const t = textosPersonalizacion.apariencia.acento.avanzado
const GRUPOS: GrupoParametro[] = ["correccion", "candidatos", "paleta"]

function hexDeRgba(rgba: Gdk.RGBA): string {
  return "#" + [rgba.red, rgba.green, rgba.blue]
    .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
    .join("")
}

function FilaColor({ indice }: { indice: number }) {
  const manual = ajustesAcento((a) => a.manuales[indice])
  const fijado = manual((m) => m !== null)

  const boton = new Gtk.ColorDialogButton({
    dialog: new Gtk.ColorDialog({ withAlpha: false, title: t.colores.elegir }),
    valign: Gtk.Align.CENTER,
  })
  // Del estado al botón, solo si difiere: poner `rgba` emite `notify::rgba`, que
  // vuelve al estado con el mismo valor y ahí se corta (`fijar` ignora lo igual).
  const reflejar = () => {
    const hex = manual.get()
    boton.visible = hex !== null
    if (hex === null || hexDeRgba(boton.rgba) === hex) return
    const rgba = new Gdk.RGBA()
    if (rgba.parse(hex)) boton.rgba = rgba
  }
  reflejar()
  onCleanup(manual.subscribe(reflejar))
  boton.connect("notify::rgba", () => {
    if (manual.get() !== null) setAcentoManual(indice, hexDeRgba(boton.rgba))
  })

  // Al fijarlo, empieza en el color que ya se estaba viendo.
  const alternar = () => setAcentoManual(indice, fijado.get()
    ? null
    : acentosExtraidos.get()?.[indice] ?? ACENTOS_FABRICA[indice])

  return (
    <box spacing={10} valign={Gtk.Align.CENTER}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
        <TituloAjuste label={t.colores.nombres[indice]} />
        <TextoInformativo label={t.colores.papeles[indice]} />
      </box>
      {boton as unknown as any}
      <Interruptor activo={fijado} alAlternar={alternar} />
    </box>
  )
}

function FilaParametro({ clave }: { clave: string }) {
  const def = DEFINICIONES[clave]
  const texto = (t.parametros as Record<string, { titulo: string, descripcion: string }>)[clave]
  const valor = ajustesAcento((a) => a.parametros[clave])
  const decimales = decimalesDe(def.paso)
  const sufijo = EN_GRADOS.has(clave) ? "°" : ""

  const ajuste = new Gtk.Adjustment({
    lower: def.min, upper: def.max, stepIncrement: def.paso, pageIncrement: def.paso * 10,
  })
  ajuste.value = valor.get()
  const escala = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: ajuste,
    drawValue: false,
    digits: decimales,
    hexpand: true,
  })
  escala.cssClasses = ["qs-slider", "brightness"]
  conectarCambioDeslizador(escala, (v) => setParametroAcento(clave, v))
  // El deslizador muestra SIEMPRE el valor normalizado del estado, no el crudo del
  // arrastre: así se ve el salto de paso y el tope de un par (el mínimo no pasa del
  // máximo). Devolver `true` impide que GTK ponga después el valor crudo.
  escala.connect("change-value", () => {
    ajuste.value = valor.get()
    return true
  })
  // onCleanup, nunca connect("destroy"): ver `modulos/ajustes/CLAUDE.md`.
  onCleanup(valor.subscribe(() => {
    if (ajuste.value !== valor.get()) ajuste.value = valor.get()
  }))

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TituloAjuste label={texto?.titulo ?? clave} hexpand halign={Gtk.Align.START} />
        <label cssClasses={["sp-field-value"]}
          label={valor((v) => v.toFixed(decimales).replace(".", ",") + sufijo)} />
      </box>
      {escala as unknown as any}
      {texto ? <TextoInformativo label={texto.descripcion} halign={Gtk.Align.START} /> : <box />}
    </box>
  )
}

export default function AcentoAvanzado() {
  const [abierto, setAbierto] = createState(false)

  const grupos = GRUPOS.flatMap((grupo) => [
    <TituloSubseccion label={t.grupos[grupo]} />,
    ...CLAVES
      .filter((clave) => DEFINICIONES[clave].grupo === grupo)
      .map((clave) => <FilaParametro clave={clave} />),
  ])

  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["dev-row"]} visible={acentoAdaptativoEnabled}>
      <button cssClasses={["flat"]} onClicked={() => setAbierto(!abierto.get())}>
        <box spacing={10}>
          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
            <TituloAjuste label={t.titulo} />
            <TextoInformativo label={t.descripcion} />
          </box>
          <label label={abierto((a) => a ? "󰅀" : "󰅂")} valign={Gtk.Align.CENTER} />
        </box>
      </button>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={12} visible={abierto}>
        <TituloSubseccion label={t.grupos.colores} />
        <TextoInformativo label={t.colores.descripcion} halign={Gtk.Align.START} />
        {[0, 1, 2].map((i) => <FilaColor indice={i} />)}
        {grupos}
        <box spacing={10}>
          <TextoInformativo label={t.restablecerDescripcion} hexpand halign={Gtk.Align.START} />
          <BotonAjustes sensitive={ajustesAcento((a) => !sonFabrica(a))} onClicked={restablecerAjustesAcento}>
            <label label={t.restablecer} />
          </BotonAjustes>
        </box>
      </box>
    </box>
  )
}
