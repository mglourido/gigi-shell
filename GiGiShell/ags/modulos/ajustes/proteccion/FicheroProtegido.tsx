// modulos/ajustes/proteccion/FicheroProtegido.tsx — la fila desplegable de un
// archivo protegido: accesos habituales, permisos por programa, historial y
// «Dejar de proteger».
//
// La fila va con `<For id={f.id}>` en SeccionProteccion: se construye UNA vez y
// su objeto no vuelve a llegar, así que todo lo mutable se lee por accessor
// derivado de `ficheros` (ver la auditoría del <For> en ags/CLAUDE.md). La RUTA
// también es mutable —si el archivo se mueve, el daemon la actualiza— y por eso
// cada orden la lee en el momento del clic, no al construir.
//
// El campo de «Dar permiso a un programa…» está FUERA de toda lista que se
// reconstruya: reconstruir una lista que contiene el widget con el foco es lo
// que en este repositorio acaba en SIGSEGV (ver SeccionAppsInicio.tsx).

import { For, createComputed, createState, onCleanup, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { BotonAjustes, ListaAjustes, TextoInformativo, TituloAjuste } from "../componentes"
import {
  conceder, desproteger, esInterprete, ficheros, fijarCategoria, fijarPermiso, pedirHistorial,
  type EntradaHistorial, type Fichero, type Permiso,
} from "../../../servicios/seguridad/guardian"
import { getAppInfos } from "../../orion/data/appsInfo"
import { catalogoAppsInstaladas, filtrarAppsInstaladas, type AppInstalada } from "../inicio/catalogoApps"
import SelectorCategorias from "./SelectorModo"
import { carpetaCorta, nombreArchivo, nombrePrograma } from "../../guardian/rutas"
import textos from "../../../textos/ajustes/proteccion.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

const t = textos.seccion
const LIMITE_HISTORIAL = 50
const MAX_RESULTADOS = 6
const CONFIRMAR_MS = 4000
const DENEGADOS: EntradaHistorial["resultado"][] = ["denegado", "tiempo_agotado", "sin_ags"]

/** Nombre legible: el de su `.desktop` si alguno lanza ese binario; si no, el binario. */
function nombreLegible(exe: string): string {
  const binario = nombrePrograma(exe)
  for (const app of getAppInfos()) {
    const ejecutable = app.get_executable()
    if (ejecutable && nombrePrograma(ejecutable) === binario) return app.get_name() ?? binario
  }
  return binario
}

/** Ruta real del ejecutable de una app (o de lo que se haya tecleado): el daemon
 *  identifica a los programas por `/proc/PID/exe`, que ya viene resuelta. */
async function resolverEjecutable(comandoORuta: string): Promise<string | null> {
  const primero = comandoORuta.trim().split(/\s+/)[0] ?? ""
  const ruta = primero.startsWith("/") ? primero : GLib.find_program_in_path(primero)
  if (!ruta) return null
  try {
    return (await execAsync(["realpath", "-e", ruta])).trim() || null
  } catch {
    return null
  }
}

function FilaPermiso({ ruta, inicial, permisos }: {
  ruta: () => string
  inicial: Permiso
  permisos: Accessor<Permiso[]>
}) {
  const programa = inicial.programa
  const permiso = permisos((lista) => lista.find((p) => p.programa === programa) ?? inicial)
  const nombre = nombreLegible(programa)

  // Cada casilla manda las tres: el daemon fija el permiso EXACTO (no un OR).
  const cambiar = (campo: "leer" | "modificar" | "borrar", valor: boolean) => {
    const p = permiso.get()
    if (p[campo] === valor) return // eco de la propia actualización de la lista
    const nuevo = { ...p, [campo]: valor }
    fijarPermiso(ruta(), programa, nuevo.leer, nuevo.modificar, nuevo.borrar)
  }

  const casilla = (campo: "leer" | "modificar" | "borrar", texto: string) => (
    <Gtk.CheckButton
      cssClasses={["guardian-casilla"]}
      label={texto}
      active={permiso((p) => p[campo])}
      onToggled={(self: Gtk.CheckButton) => cambiar(campo, self.get_active())}
    />
  )

  return (
    <box spacing={10} cssClasses={["dev-row"]} valign={Gtk.Align.CENTER}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
        <TituloAjuste label={nombre} />
        <TextoInformativo label={programa} ellipsize={3} maxWidthChars={40} />
      </box>
      {casilla("leer", t.fichero.leer)}
      {casilla("modificar", t.fichero.modificar)}
      {casilla("borrar", t.fichero.borrar)}
      <button
        cssClasses={["sp-rule-del"]}
        valign={Gtk.Align.CENTER}
        tooltipText={t.fichero.quitar}
        onClicked={() => fijarPermiso(ruta(), programa, false, false, false)}
      >
        <label label="󰅖" />
      </button>
    </box>
  )
}

interface FilaHistorialDatos {
  clave: string
  entrada: EntradaHistorial
}

function FilaHistorial({ ruta, datos, permisos }: {
  ruta: () => string
  datos: FilaHistorialDatos
  permisos: Accessor<Permiso[]>
}) {
  const e = datos.entrada
  const fecha = GLib.DateTime.new_from_unix_local(e.fecha)?.format("%d/%m %H:%M") ?? ""
  const denegada = DENEGADOS.includes(e.resultado)
  const puedeConceder = denegada && e.programa !== "?" && e.programa !== "" && !esInterprete(e.programa)
  const puedeRevocar = e.resultado === "automatico"
    && permisos((lista) => lista.some((p) => p.programa === e.programa))
  const resultado = (t.resultados as Record<string, string>)[e.resultado] ?? e.resultado

  return (
    <box spacing={10} cssClasses={["dev-row"]} valign={Gtk.Align.CENTER}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
        <TituloAjuste label={`${fecha} · ${e.programa ? nombrePrograma(e.programa) : "—"} · ${e.operacion}`} />
        <TextoInformativo
          label={resultado}
          cssClasses={denegada ? ["guardian-historial-denegado"] : []}
        />
      </box>
      <BotonAjustes
        visible={puedeConceder}
        onClicked={() => conceder(ruta(), e.programa, e.operacion)}
      >
        <label label={t.fichero.permitirSiempre} />
      </BotonAjustes>
      <BotonAjustes
        visible={puedeRevocar}
        onClicked={() => fijarPermiso(ruta(), e.programa, false, false, false)}
      >
        <label label={t.fichero.revocar} />
      </BotonAjustes>
    </box>
  )
}

function DarPermiso({ ruta }: { ruta: () => string }) {
  const catalogo = catalogoAppsInstaladas()
  const [consulta, setConsulta] = createState("")
  const [abierto, setAbierto] = createState(false)
  // Un intérprete pide un segundo clic con el aviso delante.
  const [interpretePendiente, setInterpretePendiente] = createState<string | null>(null)
  const resultados = consulta((q) => q.trim() === "" ? [] : filtrarAppsInstaladas(catalogo, q, MAX_RESULTADOS))

  const anadir = async (comandoORuta: string) => {
    const exe = await resolverEjecutable(comandoORuta)
    if (!exe) return
    if (esInterprete(exe) && interpretePendiente.get() !== exe) {
      setInterpretePendiente(exe)
      return
    }
    setInterpretePendiente(null)
    fijarPermiso(ruta(), exe, true, false, false)
    setConsulta("")
    campo?.set_text("")
  }

  let campo: Gtk.Entry | null = null
  onCleanup(() => { campo = null })

  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <box cssClasses={["dev-row"]}>
        <BotonAjustes activo={abierto} onClicked={() => setAbierto(!abierto.get())}>
          <label label={t.fichero.darPermiso} />
        </BotonAjustes>
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} visible={abierto}>
        <box spacing={6} cssClasses={["dev-row"]}>
          <entry
            cssClasses={["account-entry"]}
            placeholderText={t.fichero.buscarPrograma}
            hexpand
            $={(self: Gtk.Entry) => { campo = self }}
            onChanged={(self: Gtk.Entry) => { setConsulta(self.get_text()); setInterpretePendiente(null) }}
            onActivate={(self: Gtk.Entry) => { anadir(self.get_text()) }}
          />
          <BotonAjustes onClicked={() => { anadir(campo?.get_text() ?? "") }}>
            <label label={t.fichero.anadir} />
          </BotonAjustes>
        </box>
        <box cssClasses={["dev-row"]} visible={interpretePendiente((p) => p !== null)}>
          <TextoInformativo
            cssClasses={["guardian-historial-denegado"]}
            label={interpretePendiente((p) => formatearTexto(t.fichero.avisoInterprete, { programa: p ?? "" }))}
          />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL}>
          <For each={resultados} id={(app: AppInstalada) => app.id}>
            {(app: AppInstalada) => (
              <box spacing={10} cssClasses={["dev-row"]} valign={Gtk.Align.CENTER}>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                  <TituloAjuste label={app.nombre} />
                  <TextoInformativo label={app.comando} ellipsize={3} maxWidthChars={44} />
                </box>
                <BotonAjustes onClicked={() => { anadir(app.comando) }}>
                  <label label="󰐕" />
                </BotonAjustes>
              </box>
            )}
          </For>
        </box>
      </box>
    </box>
  )
}

export default function FicheroProtegido({ inicial }: { inicial: Fichero }) {
  const id = inicial.id
  const fichero = ficheros((lista) => lista.find((f) => f.id === id) ?? inicial)
  const ruta = () => fichero.get().ruta
  const permisos = fichero((f) => f.permisos)
  const [desplegado, setDesplegado] = createState(false)
  const [confirmando, setConfirmando] = createState(false)
  const [historial, setHistorial] = createState<EntradaHistorial[]>([])
  const [soloDenegados, setSoloDenegados] = createState(false)

  const pedir = () => pedirHistorial(ruta(), LIMITE_HISTORIAL, setHistorial)
  // Mientras está desplegado, cada cambio del archivo (un permiso concedido, una
  // ruta nueva) vuelve a pedir el historial, que es donde se ve el efecto.
  const soltar = fichero.subscribe(() => { if (desplegado.get()) pedir() })
  let temporizadorConfirmar: ReturnType<typeof setTimeout> | null = null
  onCleanup(() => {
    soltar()
    if (temporizadorConfirmar !== null) clearTimeout(temporizadorConfirmar)
  })

  const filasHistorial = createComputed(() => historial()
    .filter((e) => !soloDenegados() || DENEGADOS.includes(e.resultado))
    .map((entrada, i) => ({ clave: `${entrada.fecha}-${entrada.pid}-${entrada.resultado}-${i}`, entrada })))

  const dejarDeProteger = () => {
    if (!confirmando.get()) {
      setConfirmando(true)
      temporizadorConfirmar = setTimeout(() => { temporizadorConfirmar = null; setConfirmando(false) }, CONFIRMAR_MS)
      return
    }
    desproteger(ruta())
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["dev-row"]}>
      <button
        cssClasses={["flat"]}
        onClicked={() => {
          const abrir = !desplegado.get()
          setDesplegado(abrir)
          if (abrir) pedir()
        }}
      >
        <box spacing={10}>
          <label cssClasses={["dev-card-icon"]} label="󰈙" valign={Gtk.Align.CENTER} />
          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
            <TituloAjuste label={fichero((f) => nombreArchivo(f.ruta))} />
            <TextoInformativo label={fichero((f) => carpetaCorta(f.ruta))} wrap={false}
              ellipsize={1} maxWidthChars={48} tooltipText={ruta} />
          </box>
          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} valign={Gtk.Align.CENTER}>
            <label
              halign={Gtk.Align.END}
              cssClasses={fichero((f) => ["guardian-estado-dot", f.estado])}
              label={fichero((f) => f.estado === "activo" ? t.fichero.activo : t.fichero.noDisponible)}
            />
            <TextoInformativo
              halign={Gtk.Align.END}
              label={permisos((p) => formatearTexto(t.fichero.programas, { n: p.length }))}
            />
          </box>
          <label label={desplegado((d) => d ? "󰅀" : "󰅂")} valign={Gtk.Align.CENTER} />
        </box>
      </button>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} visible={desplegado}>
        <TituloAjuste label={t.fichero.habituales} />
        <SelectorCategorias
          modos={fichero((f) => f.categorias)}
          sensible={fichero((f) => f.estado === "activo")}
          alElegir={(cat, modo) => fijarCategoria(ruta(), cat, modo)}
        />

        <TituloAjuste label={t.fichero.permisos} />
        <ListaAjustes cantidad={permisos((lista) => lista.length)} vacia={t.fichero.sinPermisos}>
          <For each={permisos} id={(p: Permiso) => p.programa}>
            {(p: Permiso) => <FilaPermiso ruta={ruta} inicial={p} permisos={permisos} />}
          </For>
        </ListaAjustes>
        <DarPermiso ruta={ruta} />

        <box spacing={10}>
          <TituloAjuste label={t.fichero.historial} hexpand />
          <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER}>
            <button
              cssClasses={soloDenegados((s) => s ? ["dl-seg-btn"] : ["dl-seg-btn", "active"])}
              onClicked={() => setSoloDenegados(false)}
            >
              <label label={t.fichero.todos} />
            </button>
            <button
              cssClasses={soloDenegados((s) => s ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
              onClicked={() => setSoloDenegados(true)}
            >
              <label label={t.fichero.soloDenegados} />
            </button>
          </box>
        </box>
        <ListaAjustes cantidad={filasHistorial((lista) => lista.length)} vacia={t.fichero.sinHistorial}>
          <For each={filasHistorial} id={(d: FilaHistorialDatos) => d.clave}>
            {(d: FilaHistorialDatos) => <FilaHistorial ruta={ruta} datos={d} permisos={permisos} />}
          </For>
        </ListaAjustes>

        <box cssClasses={["dev-row"]} halign={Gtk.Align.END}>
          <BotonAjustes onClicked={dejarDeProteger}>
            <label label={confirmando((c) => c ? t.fichero.confirmar : t.fichero.dejarDeProteger)} />
          </BotonAjustes>
        </box>
      </box>
    </box>
  )
}
