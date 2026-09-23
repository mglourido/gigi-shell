// modulos/ajustes/inicio/SeccionAppsInicio.tsx — Ajustes > Apps al inicio.
//
// La mitad de escritura de `servicios/aplicaciones/appsInicio.ts`: un buscador
// para añadir apps instaladas, un campo libre para lo que no tenga `.desktop`,
// y la lista de lo que ya se abre al entrar. Quien EJECUTA la lista es
// `inicializador/apps-inicio.sh` desde el autostart de Hyprland; aquí no se
// lanza nada salvo el botón «probar», que es una acción explícita del usuario.
//
// ── El catálogo se lee UNA vez, al construir la sección ───────────────────────
// `catalogoAppsInstaladas()` corre en el cuerpo del componente, no dentro del
// filtro. La sección se construye al abrirla y se desmonta al cerrar Ajustes
// (ver el <With> único de SettingsPanel.tsx), así que ese "una vez" es una vez
// por visita — y rehacerlo en cada pulsación de tecla habría metido un
// `Gio.AppInfo.get_all()` en el camino de escribir.
//
// ── Dónde vive el foco, que aquí no es un detalle de estilo ───────────────────
// Los tres `Gtk.Entry` (el buscador y los dos del comando manual) están FUERA
// de toda lista que se reconstruya. Es la misma precaución que documenta
// `disco/RutasPersonalizadas.tsx`: reconstruir una lista que contiene el widget
// con el foco es lo que en este repositorio acaba en SIGSEGV, no en un warning.
// Los resultados del buscador sí se rehacen a cada tecla, y por eso dentro de
// ellos no hay nada editable — solo una etiqueta y un botón.
//
// ── Las filas guardadas van con `<For id>` y leen por accessor ────────────────
// Con clave, una fila se construye UNA vez y su objeto no vuelve a llegar (ver
// la auditoría del <For> en ags/CLAUDE.md). Así que cada fila deriva su propio
// accessor de `appsInicio` en vez de leer del objeto que recibió: sin eso,
// pulsar el interruptor cambiaría el JSON y la fila seguiría pintando el valor
// viejo, sin un solo error.

import { For, createState, onCleanup, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import {
  BotonAjustes, TarjetaAjustes, TextoInformativo, TituloAjuste, TituloSeccion,
} from "../componentes"
import {
  ESCRITORIO_ACTIVO, ESCRITORIO_MAX,
  alternarAppInicio, alternarSilencioAppInicio, anadirAppInicio, appsInicio,
  fijarEscritorioAppInicio, probarAppInicio, quitarAppInicio,
  type AppInicio,
} from "../../../servicios/aplicaciones/appsInicio"
import {
  catalogoAppsInstaladas, filtrarAppsInstaladas, iconoDesdeCadena,
  type AppInstalada,
} from "./catalogoApps"
import textos from "../../../textos/ajustes/inicio.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

/** Cuántos resultados se pintan a la vez. Es una lista de ayuda, no un lanzador. */
const MAX_RESULTADOS = 8

/** Icono de la app, o un glifo genérico cuando la cadena guardada ya no resuelve. */
function IconoApp({ icono }: { icono: string }) {
  const gicon = iconoDesdeCadena(icono)
  return gicon
    ? <image gicon={gicon} pixelSize={24} valign={Gtk.Align.CENTER} />
    : <label cssClasses={["sp-nav-icon"]} label="󰀻" valign={Gtk.Align.CENTER} />
}

function FilaResultado({ app, yaEsta }: { app: AppInstalada; yaEsta: Accessor<boolean> }) {
  return (
    <box spacing={10} cssClasses={["dev-row"]} valign={Gtk.Align.CENTER}>
      <IconoApp icono={app.icono} />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
        <TituloAjuste label={app.nombre} />
        <TextoInformativo label={app.comando} ellipsize={3} maxWidthChars={48} />
      </box>
      <BotonAjustes
        tooltipText={yaEsta((esta) => esta ? textos.buscador.yaEsta : textos.buscador.anadir)}
        sensitive={yaEsta((esta) => !esta)}
        onClicked={() => anadirAppInicio({ nombre: app.nombre, comando: app.comando, icono: app.icono })}
      >
        <label label="󰐕" />
      </BotonAjustes>
    </box>
  )
}

/**
 * Paso del escritorio de destino: … − [Donde estés | Escritorio N] + …
 *
 * Se baja hasta 0 (= «Donde estés») en vez de parar en 1: quitar el anclaje
 * tiene que ser el mismo gesto que ponerlo, sin un control aparte que decir
 * "ninguno".
 */
function PasoEscritorio({ id, escritorio }: { id: string; escritorio: Accessor<number> }) {
  const etiqueta = escritorio((n) => n === ESCRITORIO_ACTIVO
    ? textos.lista.escritorioActivo
    : formatearTexto(textos.lista.escritorioNumero, { numero: n }))

  return (
    <box spacing={6} valign={Gtk.Align.CENTER}>
      <button
        cssClasses={["sp-step-btn"]}
        sensitive={escritorio((n) => n > ESCRITORIO_ACTIVO)}
        onClicked={() => fijarEscritorioAppInicio(id, escritorio.get() - 1)}
      >
        <label label="−" />
      </button>
      <label cssClasses={["sp-step-val"]} label={etiqueta} />
      <button
        cssClasses={["sp-step-btn"]}
        sensitive={escritorio((n) => n < ESCRITORIO_MAX)}
        onClicked={() => fijarEscritorioAppInicio(id, escritorio.get() + 1)}
      >
        <label label="+" />
      </button>
    </box>
  )
}

function FilaAppInicio({ inicial }: { inicial: AppInicio }) {
  const id = inicial.id
  // La fila no se reconstruye (<For id>), así que todo lo mutable se lee de
  // aquí. El `?? inicial` cubre el parpadeo entre quitar la entrada y que <For>
  // desmonte la fila: sin él, ese instante sería un acceso a undefined.
  const app = appsInicio((lista: AppInicio[]) => lista.find((a) => a.id === id) ?? inicial)
  const activo = app((a) => a.activo)
  const escritorio = app((a) => a.escritorio)
  const anclada = app((a) => a.escritorio !== ESCRITORIO_ACTIVO)
  const silencioso = app((a) => a.silencioso)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
      <box spacing={10} valign={Gtk.Align.CENTER}>
        <IconoApp icono={inicial.icono} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <TituloAjuste label={app((a) => a.nombre)} />
          <TextoInformativo label={app((a) => a.comando)} ellipsize={3} maxWidthChars={48} />
        </box>
        <button
          cssClasses={["account-secondary-btn"]}
          valign={Gtk.Align.CENTER}
          tooltipText={textos.lista.probar}
          onClicked={() => probarAppInicio(id)}
        >
          <label label="󰐊" />
        </button>
        <button
          cssClasses={["sp-rule-del"]}
          valign={Gtk.Align.CENTER}
          tooltipText={textos.lista.quitar}
          onClicked={() => quitarAppInicio(id)}
        >
          <label label="󰆴" />
        </button>
        <Interruptor activo={activo} alAlternar={() => alternarAppInicio(id)} />
      </box>

      {/* Las reglas de ventana solo se leen con la entrada activa; se ocultan
          en vez de deshabilitarse para que una lista con varias apagadas no sea
          una pared de controles grises. */}
      <box spacing={10} valign={Gtk.Align.CENTER} visible={activo}>
        <TextoInformativo label={textos.lista.escritorio} valign={Gtk.Align.CENTER} />
        <PasoEscritorio id={id} escritorio={escritorio} />
        <box hexpand />
        <TextoInformativo
          label={textos.lista.silencioso}
          valign={Gtk.Align.CENTER}
          sensitive={anclada}
        />
        <Interruptor
          activo={silencioso}
          sensible={anclada}
          alAlternar={() => alternarSilencioAppInicio(id)}
        />
      </box>
    </box>
  )
}

export default function SeccionAppsInicio() {
  const catalogo = catalogoAppsInstaladas()
  const [consulta, setConsulta] = createState("")
  const resultados = consulta((texto) => filtrarAppsInstaladas(catalogo, texto, MAX_RESULTADOS))

  let campoNombre: Gtk.Entry | null = null
  let campoComando: Gtk.Entry | null = null
  onCleanup(() => { campoNombre = null; campoComando = null })

  const anadirManual = () => {
    const comando = campoComando?.get_text() ?? ""
    if (!anadirAppInicio({ nombre: campoNombre?.get_text() ?? "", comando })) return
    campoNombre?.set_text("")
    campoComando?.set_text("")
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.seccion.titulo} />

      <TarjetaAjustes titulo={textos.grupos.anadir} icono="󰐕">
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
          <entry
            cssClasses={["account-entry"]}
            placeholderText={textos.buscador.marcador}
            hexpand
            onChanged={(self: Gtk.Entry) => setConsulta(self.get_text())}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL}>
          <box cssClasses={["dev-row"]} visible={resultados((lista: AppInstalada[]) => lista.length === 0)}>
            <TextoInformativo label={textos.buscador.sinResultados} />
          </box>
          <For each={resultados} id={(app: AppInstalada) => app.id}>
            {(app: AppInstalada) => (
              <FilaResultado
                app={app}
                yaEsta={appsInicio((lista: AppInicio[]) => lista.some((x) => x.comando === app.comando))}
              />
            )}
          </For>
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
          <TituloAjuste label={textos.manual.titulo} />
          <TextoInformativo label={textos.manual.descripcion} wrap xalign={0} maxWidthChars={62} />
          <box spacing={6}>
            <entry
              cssClasses={["account-entry"]}
              placeholderText={textos.manual.marcadorNombre}
              widthRequest={150}
              $={(self: Gtk.Entry) => { campoNombre = self }}
              onActivate={anadirManual}
            />
            <entry
              cssClasses={["account-entry"]}
              placeholderText={textos.manual.marcadorComando}
              hexpand
              $={(self: Gtk.Entry) => { campoComando = self }}
              onActivate={anadirManual}
            />
            <BotonAjustes onClicked={anadirManual}>
              <label label={textos.manual.anadir} />
            </BotonAjustes>
          </box>
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.grupos.lista} icono="󰐊">
        <box orientation={Gtk.Orientation.VERTICAL}>
          <box cssClasses={["dev-row"]} visible={appsInicio((lista: AppInicio[]) => lista.length === 0)}>
            <TextoInformativo label={textos.lista.vacio} />
          </box>
          <For each={appsInicio} id={(app: AppInicio) => app.id}>
            {(app: AppInicio) => <FilaAppInicio inicial={app} />}
          </For>
        </box>
        <box cssClasses={["dev-row"]}>
          <TextoInformativo label={textos.lista.aviso} wrap xalign={0} maxWidthChars={62} />
        </box>
      </TarjetaAjustes>
    </box>
  )
}
