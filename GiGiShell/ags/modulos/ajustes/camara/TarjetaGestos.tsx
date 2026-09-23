// modulos/ajustes/camara/TarjetaGestos.tsx — Ajustes > Cámara > Gestos.
//
// El interruptor del modo, qué gestos están activos y los tres números que lo
// calibran. Vive en la sección de Cámara y no en una propia porque comparte con
// ella el recurso escaso: mientras el modo está encendido, la cámara está
// ocupada y ninguna otra aplicación puede abrirla. Verlo junto al killswitch y
// al detector de uso es lo que hace obvio ese conflicto.
//
// Fichero aparte de `SeccionCamara.tsx` (que ya son 560 líneas) porque no
// comparte nada con ella: ni servicios, ni estado, ni componentes propios.
//
// ── LOS DESLIZADORES SE POSAN ANTES DE GUARDAR, Y AQUÍ IMPORTA MÁS QUE NUNCA ─
// `guardar()` REINICIA el demonio cuando el modo está encendido (ver la cabecera
// de `servicios/gestos/control.ts`: la config se lee una sola vez, al arrancar).
// Escribir en cada píxel del arrastre no sería "un JSON de más" como en los
// controles V4L2 de al lado: sería apagar y encender la cámara sesenta veces por
// segundo. Por eso el valor mostrado se actualiza en vivo pero solo se guarda
// tras `MS_POSAR` de silencio.
import { createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Interruptor from "../../../componentes/Interruptor"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { crearCicloVida } from "../../../utilidades/cicloVida"
import { EncabezadoAjuste, TarjetaAjustes, TextoInformativo } from "../componentes"
import {
  configGestos, gestosDisponibles, gestosOcupado, alternarGestos, guardar,
  type ConfigGestos,
} from "../../../servicios/gestos/control"
import { gestos } from "../../../servicios/gestos/estado"
import { camaraEnUso } from "../../../servicios/camara/uso"
import textos from "../../../textos/ajustes/camara.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

/** Silencio que se considera «ha soltado el deslizador». Más largo que el de
 *  los controles de imagen (400 ms) porque aquí guardar reinicia el modo. */
const MS_POSAR = 700

// ── Un deslizador que solo guarda al soltarse ───────────────────────────────

function Deslizador({
  clave, min, max, paso, formato, titulo, informacion, decimales = 0,
}: {
  clave: keyof ConfigGestos
  min: number
  max: number
  paso: number
  formato: string
  titulo: string
  informacion: string
  decimales?: number
}) {
  const ciclo = crearCicloVida()
  const inicial = Number(configGestos.get()[clave])
  const [mostrado, setMostrado] = createState(inicial)

  const ajuste = new Gtk.Adjustment({
    lower: min, upper: max, stepIncrement: paso, pageIncrement: paso * 5,
  })
  ajuste.value = inicial

  const escala = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL, adjustment: ajuste,
    drawValue: false, hexpand: true,
  })
  escala.cssClasses = ["qs-slider", "dev-slider", "cam-slider"]

  let idPosar = 0
  ciclo.registrar(() => { if (idPosar) GLib.source_remove(idPosar); idPosar = 0 })

  conectarCambioDeslizador(escala, (valor) => {
    const v = Math.min(max, Math.max(min, valor))
    setMostrado(v)
    if (idPosar) GLib.source_remove(idPosar)
    idPosar = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MS_POSAR, () => {
      idPosar = 0
      void guardar({ [clave]: v } as Partial<ConfigGestos>)
      return GLib.SOURCE_REMOVE
    })
  })

  return (
    <box cssClasses={["dev-row"]} spacing={12} valign={Gtk.Align.CENTER}>
      <EncabezadoAjuste titulo={titulo} informacion={informacion} />
      <box spacing={8} hexpand valign={Gtk.Align.CENTER}>
        {escala}
        <label
          cssClasses={["dev-value"]}
          label={mostrado((v) => formatearTexto(formato, { valor: v.toFixed(decimales) }))}
        />
      </box>
    </box>
  )
}

// ── Una fila de gesto: pictograma + qué hace + interruptor ──────────────────

function FilaGesto({
  glifo, titulo, detalle, clave,
}: {
  glifo: string
  titulo: string
  detalle: string
  clave: "swipe" | "pellizco" | "puno" | "espera" | "dobleFlotar"
}) {
  const activo = createComputed([configGestos], (c) => Boolean(c[clave]))
  return (
    <box cssClasses={["dev-row", "gestos-fila"]} spacing={10} valign={Gtk.Align.CENTER}>
      <label cssClasses={["gestos-glifo"]} label={glifo} valign={Gtk.Align.CENTER} />
      <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
        <label
          cssClasses={["gestos-gesto-titulo"]}
          label={titulo}
          halign={Gtk.Align.START}
        />
        <label
          cssClasses={["gestos-gesto-detalle"]}
          label={detalle}
          halign={Gtk.Align.START}
          wrap
          maxWidthChars={52}
          xalign={0}
        />
      </box>
      <Interruptor
        activo={activo}
        alAlternar={() => void guardar({ [clave]: !activo.get() } as Partial<ConfigGestos>)}
      />
    </box>
  )
}

// ── La tarjeta ──────────────────────────────────────────────────────────────

export default function TarjetaGestos() {
  const t = textos.gestos
  const activo = createComputed([gestos], (g) => g.activo)
  // El motivo solo se enseña cuando el modo NO está activo: con el modo en
  // marcha, un motivo viejo ("la cámara la usaba firefox") sería una
  // contradicción a la vista.
  const motivo = createComputed([gestos], (g) => (!g.activo && g.motivo ? g.motivo : ""))
  const hayMotivo = createComputed([gestos], (g) => Boolean(!g.activo && g.motivo))
  // El aviso de "la cámara está ocupada" sobra mientras el modo la ocupa: sería
  // el modo avisando de sí mismo.
  const ocupadaPorOtro = createComputed([camaraEnUso, gestos], (uso, g) => uso && !g.activo)

  return (
    <TarjetaAjustes titulo={t.grupo} icono="󱄂">
      {/* ── El interruptor maestro ──────────────────────────────────────────
          Insensible mientras hay una orden en vuelo: encender tarda ~1 s
          (abrir la cámara y cargar el modelo) y dos pulsaciones seguidas
          dejarían el interruptor y el demonio en desacuerdo. */}
      <box cssClasses={["dev-row"]}>
        <EncabezadoAjuste titulo={t.titulo} informacion={t.descripcion} />
        <Interruptor
          activo={activo}
          alAlternar={alternarGestos}
          sensible={createComputed(
            [gestosOcupado, gestosDisponibles],
            (ocupado, hay) => !ocupado && hay,
          )}
        />
      </box>

      {/* Sin entorno instalado el interruptor está muerto; se dice por qué y
          cómo arreglarlo, en vez de dejar un mando que no reacciona. */}
      <box cssClasses={["dev-row", "cam-aviso"]} visible={gestosDisponibles((h) => !h)}>
        <TextoInformativo label={t.sinEntorno} maxWidthChars={64} />
      </box>

      {/* Por qué el último encendido no cuajó. Lo publica el propio demonio, así
          que también refleja lo que pasó al intentarlo con SUPER+SHIFT+G. */}
      <box cssClasses={["dev-row"]} visible={hayMotivo}>
        <label
          cssClasses={["gestos-motivo"]}
          label={motivo}
          halign={Gtk.Align.START}
          wrap
          maxWidthChars={64}
          xalign={0}
        />
      </box>

      {/* Los cinco gestos. Se listan SIEMPRE, encendido o no: son la
          documentación de qué hace el modo, y esconderlos hasta activarlo
          obligaría a encender la cámara para averiguar para qué sirve. */}
      <FilaGesto glifo="󱄄" titulo={t.swipe.titulo} detalle={t.swipe.detalle} clave="swipe" />
      <FilaGesto glifo="󰹇" titulo={t.pellizco.titulo} detalle={t.pellizco.detalle} clave="pellizco" />
      <FilaGesto glifo="󰞖" titulo={t.dobleFlotar.titulo} detalle={t.dobleFlotar.detalle} clave="dobleFlotar" />
      <FilaGesto glifo="󰹋" titulo={t.puno.titulo} detalle={t.puno.detalle} clave="puno" />
      <FilaGesto glifo="󱄋" titulo={t.espera.titulo} detalle={t.espera.detalle} clave="espera" />

      <Deslizador
        clave="sensibilidad" min={0.08} max={0.45} paso={0.01} decimales={2}
        formato={t.sensibilidad.valor}
        titulo={t.sensibilidad.titulo} informacion={t.sensibilidad.descripcion}
      />
      <Deslizador
        clave="cooldown" min={0.2} max={1} paso={0.05} decimales={2}
        formato={t.cooldown.valor}
        titulo={t.cooldown.titulo} informacion={t.cooldown.descripcion}
      />
      <Deslizador
        clave="paso" min={0.05} max={0.3} paso={0.01} decimales={2}
        formato={t.paso.valor}
        titulo={t.paso.titulo} informacion={t.paso.descripcion}
      />
      {/* Solo sirve para una ventana que YA estuviera flotando: el pellizco no
          saca del mosaico a ninguna. Se pinta igual y no se esconde tras una
          condición, porque «tengo alguna ventana flotante» no es un estado del
          sistema que se pueda consultar de forma estable — y un mando que
          aparece y desaparece según qué ventana tengas delante confunde más
          que uno que dice para qué sirve. El título ya lo acota. */}
      <Deslizador
        clave="ganancia" min={0.5} max={4} paso={0.1} decimales={1}
        formato={t.ganancia.valor}
        titulo={t.ganancia.titulo} informacion={t.ganancia.descripcion}
      />
      <Deslizador
        clave="fps" min={5} max={30} paso={1}
        formato={t.fps.valor}
        titulo={t.fps.titulo} informacion={t.fps.descripcion}
      />

      {/* Lo que el modo cuesta y lo que impide, dicho donde se decide. */}
      <box cssClasses={["dev-row", "cam-aviso"]}>
        <TextoInformativo label={t.avisoCamara} maxWidthChars={64} />
      </box>
      <box cssClasses={["dev-row", "cam-aviso"]} visible={ocupadaPorOtro}>
        <TextoInformativo label={t.camaraOcupada} maxWidthChars={64} />
      </box>
    </TarjetaAjustes>
  )
}
