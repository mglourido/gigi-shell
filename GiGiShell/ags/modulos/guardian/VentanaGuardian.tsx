// modulos/guardian/VentanaGuardian.tsx — la ventana que pregunta cuando un
// programa quiere abrir un archivo protegido, y que avisa cuando el guardia ya
// ha denegado algo (borrar, mover, cambiar atributos).
//
// ── Por qué no son notificaciones ─────────────────────────────────────────────
// «No molestar» las silenciaría, y detrás de cada pregunta hay un proceso
// colgado en su open() hasta 30 s. Es una ventana propia en la capa OVERLAY,
// arriba al centro, visible también sobre pantalla completa, y solo en el
// monitor principal (una pregunta en cada pantalla sería contestable dos veces).
//
// ── Sin foco y sin botón por defecto ─────────────────────────────────────────
// keymode NONE: la ventana no roba el teclado a lo que estés escribiendo, y un
// Intro o un espacio pulsados justo cuando aparece no pueden contestar por ti.
// Por lo mismo los botones nacen insensibles y se activan a los 0,6 s: un clic
// que ya iba de camino a otra cosa no concede un permiso.
//
// Las tarjetas van con `<For id>` (id de la pregunta / clave local del aviso):
// sin clave, cada pregunta nueva reconstruiría las demás y reiniciaría sus
// cuentas atrás. Cada tarjeta es dueña de su temporizador y lo para en
// onCleanup (nunca connect("destroy"); ver ags/CLAUDE.md).

import { For, createComputed, createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { barTopMargin } from "../ajustes/preferences"
import {
  conceder, denegados, descartarDenegado, descartarResumen, preguntas, responder, resumen,
  type Denegado, type Pregunta,
} from "../../servicios/seguridad/guardian"
import { carpetaCorta, nombreArchivo, nombrePrograma } from "./rutas"
import textos from "../../textos/ajustes/proteccion.json" with { type: "json" }
import { formatearTexto } from "../../textos/formatear"

const t = textos.ventana
const MAX_TARJETAS = 3
const RETARDO_BOTONES_MS = 600

function operacionVisible(op: string): string {
  return (t.operaciones as Record<string, string>)[op] ?? op.toUpperCase()
}

/** Botones insensibles durante los primeros 0,6 s de vida de la tarjeta. */
function crearRetardoBotones() {
  const [listos, setListos] = createState(false)
  const retardo = setTimeout(() => setListos(true), RETARDO_BOTONES_MS)
  onCleanup(() => clearTimeout(retardo))
  return listos
}

function TarjetaPregunta({ p }: { p: Pregunta }) {
  const listos = crearRetardoBotones()
  const restantes = () => Math.max(0, Math.ceil((p.caduca - Date.now()) / 1000))
  const [segundos, setSegundos] = createState(restantes())
  const cuenta = setInterval(() => setSegundos(restantes()), 1000)
  onCleanup(() => clearInterval(cuenta))

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["guardian-tarjeta"]}>
      <box spacing={8}>
        <label cssClasses={["guardian-icono"]} label="󰒃" />
        <label
          cssClasses={["guardian-titulo"]}
          hexpand
          xalign={0}
          label={`${nombrePrograma(p.programa)} ${t.quiere} ${operacionVisible(p.operacion)}`}
        />
        <label
          cssClasses={["guardian-cuenta"]}
          label={segundos((n) => formatearTexto(t.segundos, { n }))}
        />
      </box>
      <label
        cssClasses={["guardian-archivo"]}
        xalign={0}
        label={`${nombreArchivo(p.ruta)} — ${carpetaCorta(p.ruta)}`}
      />
      <label
        cssClasses={["guardian-detalle"]}
        xalign={0}
        ellipsize={3}
        label={formatearTexto(t.exePid, { exe: p.programa, pid: p.pid })}
      />
      <label
        cssClasses={["guardian-detalle", "guardian-script"]}
        xalign={0}
        ellipsize={3}
        visible={!!p.script}
        label={formatearTexto(t.script, { script: p.script ?? "" })}
      />
      <label
        cssClasses={["guardian-aviso"]}
        xalign={0}
        wrap
        visible={p.cambiado}
        label={t.cambiado}
      />
      <box spacing={8} cssClasses={["guardian-botones"]} homogeneous>
        <button sensitive={listos} onClicked={() => responder(p.id, "denegar")}>
          <label label={t.denegar} />
        </button>
        <button sensitive={listos} onClicked={() => responder(p.id, "proceso")}>
          <label label={t.proceso} />
        </button>
        <button sensitive={listos} visible={!p.interprete} onClicked={() => responder(p.id, "siempre")}>
          <label label={t.siempre} />
        </button>
      </box>
    </box>
  )
}

function TarjetaDenegado({ d }: { d: Denegado }) {
  const listos = crearRetardoBotones()
  const programa = nombrePrograma(d.programa)
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["guardian-tarjeta", "denegado"]}>
      <box spacing={8}>
        <label cssClasses={["guardian-icono"]} label="󰒃" />
        <label
          cssClasses={["guardian-titulo"]}
          hexpand
          xalign={0}
          wrap
          label={formatearTexto(t.denegadoTitulo, {
            programa,
            operacion: operacionVisible(d.operacion),
            archivo: nombreArchivo(d.ruta),
          })}
        />
      </box>
      <label cssClasses={["guardian-detalle"]} xalign={0} ellipsize={3} label={d.programa} />
      <box spacing={8} cssClasses={["guardian-botones"]} homogeneous>
        <button sensitive={listos} onClicked={() => descartarDenegado(d.clave)}>
          <label label={t.vale} />
        </button>
        <button
          sensitive={listos}
          visible={!d.interprete && d.programa !== "?"}
          onClicked={() => {
            conceder(d.ruta, d.programa, d.operacion)
            descartarDenegado(d.clave)
          }}
        >
          <label label={formatearTexto(t.permitirSiempre, { programa })} />
        </button>
      </box>
    </box>
  )
}

function TarjetaResumen() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["guardian-tarjeta"]}>
      <box spacing={8}>
        <label cssClasses={["guardian-icono"]} label="󰒃" />
        <label
          cssClasses={["guardian-titulo"]}
          hexpand
          xalign={0}
          wrap
          label={resumen((n) => formatearTexto(t.resumen, { n }))}
        />
      </box>
      <box cssClasses={["guardian-botones"]} halign={Gtk.Align.END}>
        <button onClicked={descartarResumen}>
          <label label={t.vale} />
        </button>
      </box>
    </box>
  )
}

export default function VentanaGuardian(gdkmonitor: Gdk.Monitor) {
  // Tres tarjetas como mucho: primero las preguntas (hay un proceso esperando),
  // luego los avisos. El resto espera en la cola del servicio.
  const preguntasVisibles = preguntas((ps) => ps.slice(0, MAX_TARJETAS))
  const denegadosVisibles = createComputed(() =>
    denegados().slice(0, Math.max(0, MAX_TARJETAS - Math.min(preguntas().length, MAX_TARJETAS))))
  const hayResumen = createComputed(() =>
    resumen() > 0 && preguntas().length + denegados().length < MAX_TARJETAS)
  const visible = createComputed(() =>
    preguntas().length > 0 || denegados().length > 0 || resumen() > 0)

  return (
    <window
      name="guardian"
      namespace="guardian"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      anchor={Astal.WindowAnchor.TOP}
      keymode={Astal.Keymode.NONE}
      marginTop={barTopMargin(46, 8)}
      application={app}
      visible={visible}
      cssClasses={["guardian-ventana"]}
    >
      {/* Cada <For> en su propia caja: al cambiar su lista vuelve a añadir sus
          hijos AL FINAL del contenedor, y compartiéndolo, las preguntas nuevas
          acabarían debajo de los avisos. */}
      <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <For each={preguntasVisibles} id={(p: Pregunta) => p.id}>
            {(p: Pregunta) => <TarjetaPregunta p={p} />}
          </For>
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <For each={denegadosVisibles} id={(d: Denegado) => d.clave}>
            {(d: Denegado) => <TarjetaDenegado d={d} />}
          </For>
        </box>
        <box visible={hayResumen}>
          <TarjetaResumen />
        </box>
      </box>
    </window>
  )
}
