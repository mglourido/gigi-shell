// modulos/ajustes/pantalla/SeccionPantalla.tsx
// Sección "Pantalla" del panel de Ajustes: TODOS los ajustes de pantalla
// (copiados de QuickSettings + avanzados) sobre el service compartido
// (servicios/pantalla/service.ts). Patrón visual sp-section/sp-field como
// las demás secciones de Ajustes.
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { createState, createComputed, For, onCleanup } from "ags"
import { DisplaySelect } from "../../../servicios/pantalla/controls"
import Interruptor from "../../../componentes/Interruptor"
import { TextoInformativo, TituloAjuste, TituloSeccion, TituloSubseccion } from "../componentes"
import {
  monitors, monitorPrefs, monitorCaps, applyPatch, acquirePoll, releasePoll,
  globalVrrMode, applyGlobalVrr,
  nightRules, setNightRulesAndSave, nightRulesEnabled, setNightRulesEnabled,
  luzPausadaPorJuego,
} from "../../../servicios/pantalla/service"
import type { NightRule } from "../../../servicios/pantalla/schedule"
import { activeSetpoint } from "../../../servicios/pantalla/schedule"
import {
  resolutionOptions, refreshOptions, bestRefreshFor, matchScalePreset, SCALE_PRESETS,
  TRANSFORMS, CM_MODES, computeRelativePosition,
} from "../../../servicios/pantalla/modes"
import { settingsPanelVisible } from "../../../estado/shell"
import textos from "../../../textos/ajustes/pantalla.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"
import FilaReglaHorario, {
  adquirirRelojHorario,
  claveReglaHorario,
  horaHorario,
  liberarRelojHorario,
  TEMPERATURA_REGLA_PREDETERMINADA,
} from "./HorarioPantalla.tsx"
import ControlesLuz from "./ControlesLuz.tsx"

// Las entradas y filas del horario viven en HorarioPantalla.tsx.
const ETIQUETAS_TRANSFORMACION = [
  textos.monitor.rotacion.opciones.normal,
  textos.monitor.rotacion.opciones.grados90,
  textos.monitor.rotacion.opciones.grados180,
  textos.monitor.rotacion.opciones.grados270,
  textos.monitor.rotacion.opciones.volteado,
  textos.monitor.rotacion.opciones.volteado90,
  textos.monitor.rotacion.opciones.volteado180,
  textos.monitor.rotacion.opciones.volteado270,
]
const etiquetaTransformacion = (valor: number) =>
  ETIQUETAS_TRANSFORMACION[valor] ?? ETIQUETAS_TRANSFORMACION[0]

const ETIQUETAS_COLOR: Record<string, string> = {
  auto: textos.monitor.gestionColor.opciones.automatico,
  srgb: textos.monitor.gestionColor.opciones.srgb,
  wide: textos.monitor.gestionColor.opciones.gamaAmplia,
  hdr: textos.monitor.gestionColor.opciones.hdr,
}
const etiquetaColor = (valor: string) =>
  ETIQUETAS_COLOR[valor] ?? textos.monitor.gestionColor.opciones.automatico

const POSICIONES_RELATIVAS = [
  ["right", textos.monitor.posicion.opciones.derecha],
  ["left", textos.monitor.posicion.opciones.izquierda],
  ["down", textos.monitor.posicion.opciones.debajo],
  ["up", textos.monitor.posicion.opciones.encima],
] as const

// La identidad estable y el editor de reglas viven en HorarioPantalla.tsx.
export default function SeccionPantalla() {
  const [selectedName, setSelectedName] = createState<string>("")

  // Poller (hyprctl cada 2 s) Y reloj (30 s) ref-contados: ambos se adquieren solo
  // mientras el panel de Ajustes está VISIBLE, no mientras la sección está montada.
  // El reloj colgaba del montaje, así que dejar Ajustes en Pantalla y cerrar el panel
  // lo dejaba tickeando el resto de la sesión, recomputando el resumen y actualizando
  // etiquetas de una ventana oculta. Se gatean juntos porque los dos existen solo para
  // pintar algo que nadie está mirando cuando el panel está cerrado.
  let holding = false
  const evalPoll = () => {
    const want = settingsPanelVisible.get()
    if (want && !holding) { acquirePoll(); adquirirRelojHorario(); holding = true }
    else if (!want && holding) { releasePoll(); liberarRelojHorario(); holding = false }
  }
  const unsub = settingsPanelVisible.subscribe(evalPoll)
  evalPoll()

  // Qué está aplicando el horario AHORA. Es la respuesta visible a "¿por qué se ha
  // encendido?": si una regla rige, se ve aquí y su tarjeta sale marcada.
  const scheduleSummary = createComputed(() => {
    const t = horaHorario()
    const hh = `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`
    if (!nightRulesEnabled() || nightRules().length === 0) {
      return formatearTexto(textos.reglas.horario.sinFranjas, { hora: hh })
    }
    const temp = activeSetpoint(t, nightRules(), "temp")
    const bright = activeSetpoint(t, nightRules(), "brightness")
    // "—" es "ninguna regla lo programa"; una regla que APAGA (temp 0) sí programa algo
    // y se dice, o el resumen no distinguiría "manda el manual" de "la fuerzo apagada".
    const luz = temp == null ? "—" : temp > 0 ? `${temp} K` : textos.reglas.horario.luzApagada
    const bri = bright != null ? `${bright} %` : "—"
    return formatearTexto(textos.reglas.horario.resumen, { hora: hh, luz: luz, brillo: bri })
  })

  const fixSelection = () => {
    const list = monitors.get()
    if (list.length && !list.some((m: any) => m.name === selectedName.get())) {
      const f = list.find((m: any) => m.focused) || list[0]
      setSelectedName(f ? f.name : "")
    }
  }
  const unsubMon = monitors.subscribe(fixSelection)
  fixSelection()

  const cleanup = () => {
    if (holding) { releasePoll(); liberarRelojHorario(); holding = false }
    if (typeof unsub === "function") unsub()
    if (typeof unsubMon === "function") unsubMon()
  }
  onCleanup(cleanup)

  const selected = createComputed(() => monitors().find((m: any) => m.name === selectedName()) || null)

  // Bit depth / gestión de color: reflejan la PREFERENCIA guardada (monitorPrefs),
  // no solo el formato reportado — así la elección "se queda" aunque el panel no
  // cambie el formato de salida (p.ej. eDP sin 10-bit real).
  const curBitdepth = (s: any): number => {
    const pref = s ? monitorPrefs[s.description] : null
    if (pref?.bitdepth != null) return pref.bitdepth
    return s && s.currentFormat && /2101010/.test(String(s.currentFormat)) ? 10 : 8
  }
  const curCm = (s: any): string => {
    const pref = s ? monitorPrefs[s.description] : null
    return pref?.cm ?? "auto"
  }

  // Capacidad del monitor seleccionado (para ocultar lo no soportado). Mientras no
  // se hayan detectado (arranque), los ajustes inciertos quedan ocultos.
  const capOf = (key: "vrr" | "bitdepth10" | "hdr") =>
    createComputed(() => { const s = selected(); return !!s && !!(monitorCaps()[s.name]?.[key]) })
  const admiteVrr = capOf("vrr")
  const admiteDiezBits = capOf("bitdepth10")
  const admiteHdr = capOf("hdr")
  const admiteColor = createComputed(() => admiteDiezBits() || admiteHdr())
  const anyVrr = createComputed(() => Object.values(monitorCaps()).some((c) => c.vrr))

  // `vexpand` en el overlay + `valign START` en su hijo: la LISTA del select se dibuja
  // como overlay de ESTE widget, así que su alto útil es el del overlay menos lo que baja
  // el desplegable. En una sección corta (Idioma es un título y una tarjeta) el overlay
  // medía lo que medía el contenido y al desplegable le quedaban ~40 px: cabía una opción
  // y media de las 68 del idioma. Ahora el overlay se estira con el ScrolledWindow del
  // panel y el contenido se queda arriba, así que la lista tiene alto por debajo.
  return (
    <overlay cssClasses={["display-select-host"]} vexpand>
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={["sp-section"]} hexpand valign={Gtk.Align.START}>
      <TituloSeccion titulo={textos.seccion.titulo} />

      {/* Selector de monitor */}
      <TextoInformativo cssClasses={["sp-display-detected-title"]} label={textos.seccion.pantallasDetectadas} halign={Gtk.Align.START} />
      <box cssClasses={["qs-display-monitor-tabs"]} spacing={6}>
        <For each={monitors}>
          {(m: any) => (
            <button
              cssClasses={selectedName((n) => n === m.name ? ["qs-display-monitor-pill", "active"] : ["qs-display-monitor-pill"])}
              onClicked={() => setSelectedName(m.name)}
            >
              <box spacing={5} valign={Gtk.Align.CENTER}>
                <label cssClasses={["qs-display-monitor-dot"]} label="●" visible={m.focused} />
                <label label={m.name} ellipsize={3} maxWidthChars={14} />
              </box>
            </button>
          )}
        </For>
      </box>

      {/* ── Por monitor ── */}
      <box orientation={Gtk.Orientation.VERTICAL} spacing={5} cssClasses={["sp-field", "sp-display-monitor-fields"]}
        visible={createComputed(() => { const s = selected(); return !!s && !s.disabled })}>
        <TituloSubseccion label={textos.grupos.disposicion} halign={Gtk.Align.START} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
          <TituloAjuste label={textos.monitor.resolucion.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => { const s = selected(); return s ? `${s.width}×${s.height}` : "—" })}
            options={createComputed(() => {
              const s = selected(); if (!s) return []
              return resolutionOptions(s.availableModes).map(o => ({
                label: o.native
                  ? formatearTexto(textos.monitor.resolucion.opcionNativa, { resolucion: `${o.w}×${o.h}` })
                  : `${o.w}×${o.h}`,
                value: o.key,
                active: s.width === o.w && s.height === o.h,
              }))
            })}
            onSelect={(value) => {
              const s = selected(); if (!s) return
              const [w, h] = value.split("x").map(Number)
              // Los Hz actuales pueden no existir en la nueva resolución.
              const hz = bestRefreshFor(s.availableModes, { w, h }, s.refreshRate) ?? s.refreshRate.toFixed(2)
              applyPatch(s, { mode: `${value}@${hz}Hz` })
            }}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
          <TituloAjuste label={textos.monitor.frecuencia.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => { const s = selected(); return s ? `${Math.round(s.refreshRate)} Hz` : "—" })}
            options={createComputed(() => {
              const s = selected(); if (!s) return []
              return refreshOptions(s.availableModes, { w: s.width, h: s.height }).map(o => ({ label: `${o.hz} Hz`, value: o.raw, active: Math.round(s.refreshRate) === o.hz }))
            })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { mode: `${s.width}x${s.height}@${value}Hz` }) }}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
          <TituloAjuste label={textos.monitor.escala.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => { const s = selected(); return s ? matchScalePreset(s.scale).toFixed(2) : "—" })}
            options={createComputed(() => {
              const s = selected(); if (!s) return []
              const cur = matchScalePreset(s.scale)
              return SCALE_PRESETS.map(sc => ({ label: sc.toFixed(2), value: String(sc), active: sc === cur }))
            })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { scale: Number(value) }) }}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
          <TituloAjuste label={textos.monitor.rotacion.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => { const s = selected(); const t = s ? (s.transform ?? 0) : 0; return etiquetaTransformacion(t) })}
            options={createComputed(() => {
              const s = selected(); const cur = s ? (s.transform ?? 0) : 0
              return TRANSFORMS.map(t => ({ label: etiquetaTransformacion(t.value), value: String(t.value), active: t.value === cur }))
            })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { transform: Number(value) }) }}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}
          visible={createComputed(() => monitors().length > 1)}>
          <TituloAjuste label={textos.monitor.posicion.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={textos.monitor.posicion.seleccionar}
            options={createComputed(() => {
              const s = selected(); if (!s) return []
              const opts: any[] = []
              for (const m of monitors()) {
                if (m.name === s.name) continue
                for (const [side, plantilla] of POSICIONES_RELATIVAS) {
                  opts.push({ label: formatearTexto(plantilla, { monitor: m.name }), value: `${side}|${m.name}`, active: false })
                }
              }
              return opts
            })}
            onSelect={(value) => {
              const s = selected(); if (!s) return
              const [side, refName] = value.split("|")
              const ref = monitors().find((m: any) => m.name === refName)
              if (!ref) return
              const pos = computeRelativePosition(
                { x: ref.x, y: ref.y, width: ref.width, height: ref.height, scale: ref.scale },
                { width: s.width, height: s.height, scale: s.scale },
                side as any,
              )
              applyPatch(s, { position: pos })
            }}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}
          visible={createComputed(() => monitors().length > 1)}>
          <TituloAjuste label={textos.monitor.duplicar.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => { const s = selected(); return s && s.mirrorOf && s.mirrorOf !== "none" ? s.mirrorOf : textos.monitor.duplicar.ninguno })}
            options={createComputed(() => {
              const s = selected(); if (!s) return []
              const noMirror = !s.mirrorOf || s.mirrorOf === "none"
              const opts = [{ label: textos.monitor.duplicar.ninguno, value: "none", active: noMirror }]
              for (const m of monitors()) { if (m.name !== s.name) opts.push({ label: m.name, value: m.name, active: s.mirrorOf === m.name }) }
              return opts
            })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { mirrorOf: value }) }}
          />
          <TextoInformativo
            label={textos.monitor.duplicar.descripcion}
            halign={Gtk.Align.START} wrap xalign={0}
          />
        </box>

        <TituloSubseccion label={textos.grupos.colorMonitor} halign={Gtk.Align.START} visible={admiteColor} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} visible={admiteDiezBits}>
          <TituloAjuste label={textos.monitor.profundidadColor.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => `${curBitdepth(selected())}-bit`)}
            options={createComputed(() => { const bd = curBitdepth(selected()); return [
              { label: "8-bit", value: "8", active: bd === 8 },
              { label: "10-bit", value: "10", active: bd === 10 },
            ] })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { bitdepth: Number(value) }) }}
          />
          <TextoInformativo
            label={textos.monitor.profundidadColor.descripcion}
            halign={Gtk.Align.START} wrap xalign={0}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} visible={admiteHdr}>
          <TituloAjuste label={textos.monitor.gestionColor.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={createComputed(() => etiquetaColor(curCm(selected())))}
            options={createComputed(() => { const cm = curCm(selected()); return CM_MODES.map(c => ({ label: etiquetaColor(c.value), value: c.value, active: c.value === cm })) })}
            onSelect={(value) => { const s = selected(); if (s) applyPatch(s, { cm: value }) }}
          />
        </box>

      </box>

      <ControlesLuz />

      {/* ── Reglas horarias: luz nocturna y/o brillo (independiente del manual) ── */}
      <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["sp-field"]}>
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <TituloAjuste label={textos.programacion.titulo} hexpand halign={Gtk.Align.START} />
          <Interruptor
            activo={nightRulesEnabled}
            alAlternar={() => setNightRulesEnabled(!nightRulesEnabled.get())}
          />
        </box>
        <TextoInformativo
          label={textos.programacion.descripcion}
          halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0}
        />
        <label
          cssClasses={["sp-schedule-now"]}
          label={scheduleSummary}
          visible={nightRulesEnabled}
          halign={Gtk.Align.START} xalign={0}
          wrap wrapMode={Pango.WrapMode.WORD_CHAR}
        />
        {/* La otra mitad de la respuesta a "¿por qué NO se ha encendido?": con un juego
            abierto y la pausa activa, el resumen de arriba sigue diciendo la verdad sobre
            qué regla rige, pero nada de eso llega a la pantalla. Sin este renglón la
            función sería invisible justo cuando actúa. Va fuera del `visible` del horario:
            la pausa también retiene la luz encendida a mano, sin ninguna regla de por medio. */}
        <label
          cssClasses={["sp-schedule-now"]}
          label={textos.reglas.horario.pausadaPorJuego}
          visible={luzPausadaPorJuego}
          halign={Gtk.Align.START} xalign={0}
          wrap wrapMode={Pango.WrapMode.WORD_CHAR}
        />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} visible={nightRulesEnabled}>
          {/* La regla que se añade nace SIN final ("en adelante"): añadir una es decir "a esta
              hora quiero esto", y obligar a inventarse un final era justo la fricción que se
              quitó; la franja sigue a un clic, en el selector de la propia fila. El horario por
              defecto al ENCENDER la programación sí es una franja 22:00–07:00 completa (ver
              `setNightRulesEnabled`). */}
          <button
            cssClasses={["sp-add-rule"]}
            halign={Gtk.Align.START}
            onClicked={() => setNightRulesAndSave([...nightRules.get(), {
              start: "22:00",
              end: null,
              temp: TEMPERATURA_REGLA_PREDETERMINADA,
              brightness: null,
            }])}
          >
            <box spacing={6} valign={Gtk.Align.CENTER}>
              <label label="󰐕" />
              <label label={textos.reglas.acciones.anadir} />
            </box>
          </button>
          {/* El `<For>` va en su PROPIA caja, no suelto entre los hermanos de este contenedor.
              `For` no inserta por índice: en cada cambio de la lista quita todos sus hijos y los
              vuelve a añadir, y añadir en un `Gtk.Box` es siempre AL FINAL — con el botón como
              hermano directo, tocar una franja reordenaba tarjetas y botón entre sí. */}
          <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
            <For each={nightRules} id={claveReglaHorario}>
              {(rule: NightRule, index: any) => <FilaReglaHorario regla={rule} indice={index} />}
            </For>
          </box>
        </box>
      </box>

      {/* ── Globales ── */}
      {/* Todo lo que hay dentro es VRR, y ambos bloques ya se ocultan sin monitor compatible;
          el título no, así que en un equipo sin VRR quedaba «Fluidez y juegos» encabezando un
          grupo vacío. La condición va en el grupo entero, no repetida en el título: `admiteVrr`
          (el monitor seleccionado) implica `anyVrr` (alguno lo admite). */}
      <box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={["sp-field"]}
        visible={anyVrr}>
        <TituloSubseccion label={textos.globales.titulo} halign={Gtk.Align.START} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={admiteVrr}>
          <box spacing={8} valign={Gtk.Align.CENTER}>
            <TituloAjuste label={textos.monitor.vrr.titulo} hexpand halign={Gtk.Align.START} />
            <Interruptor
              activo={createComputed(() => Boolean(selected()?.vrr))}
              alAlternar={() => { const s = selected(); if (s) applyPatch(s, { vrr: !s.vrr }) }}
            />
          </box>
          <TextoInformativo
            label={textos.monitor.vrr.descripcion}
            halign={Gtk.Align.START} wrap xalign={0}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={anyVrr}>
          <TextoInformativo label={textos.globales.vrr.titulo} halign={Gtk.Align.START} />
          <DisplaySelect
            current={globalVrrMode((v: number) => v === 0
              ? textos.globales.vrr.opciones.desactivado
              : v === 1
                ? textos.globales.vrr.opciones.activado
                : textos.globales.vrr.opciones.soloPantallaCompleta)}
            options={globalVrrMode((v: number) => [
              { label: textos.globales.vrr.opciones.desactivado, value: "0", active: v === 0 },
              { label: textos.globales.vrr.opciones.activado, value: "1", active: v === 1 },
              { label: textos.globales.vrr.opciones.soloPantallaCompleta, value: "2", active: v === 2 },
            ])}
            onSelect={(value) => applyGlobalVrr(Number(value))}
          />
          <TextoInformativo
            label={textos.globales.vrr.descripcion}
            halign={Gtk.Align.START} wrap xalign={0}
          />
        </box>

      </box>

    </box>
    </overlay>
  )
}
