// modulos/ajustes/predeterminadas/SeccionAppsPredeterminadas.tsx — Ajustes >
// Apps predeterminadas: con qué se abre un enlace, una carpeta, un PDF… y qué
// apps salen en «Abrir con» de Dolphin para cada cosa.
//
// Toda la parte de sistema (qué tipos MIME forman cada categoría, dónde se
// escribe, el terminal) vive en `servicios/aplicaciones/appsPredeterminadas.ts`.
//
// ── Se lee al CONSTRUIR la sección, y se relee tras cada cambio propio ───────
// La sección se monta al abrirla y se desmonta al cerrar Ajustes (el <With>
// único de SettingsPanel.tsx). Un cambio hecho por fuera con Ajustes abierto
// («Abrir con > Predeterminada» en Dolphin) se ve al volver a entrar. Tras un
// cambio hecho aquí se RELEE de GIO en vez de apañar la lista a mano: si GIO no
// lo aplicó, la fila tiene que seguir enseñando lo que de verdad hay.
//
// El selector compartido usa el overlay de la sección para conservar el foco
// en layer-shell. La gestión de «Abrir con» tiene sus propias listas acotadas.
//
// ── Dónde vive el foco ───────────────────────────────────────────────────────
// El buscador de «añadir» está FUERA de las dos listas que se reconstruyen (la
// de «Abrir con» y la de resultados), misma precaución que Apps al inicio:
// reconstruir una lista que contiene el widget con el foco acaba en SIGSEGV.

import { For, createComputed, createState, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import Graphene from "gi://Graphene"
import GLib from "gi://GLib"
import {
  BotonAjustes, EntradaTextoAjustes, ListaAjustes, TarjetaAjustes, TextoInformativo, TituloAjuste,
} from "../componentes"
import {
  catalogoAppsInstaladas, filtrarAppsInstaladas, iconoDesdeCadena,
  type AppInstalada,
} from "../inicio/catalogoApps"
import {
  CATEGORIAS, buscarTiposArchivo, categoriaDeTipo,
  actualCategoria, actualTerminal, anadirACategoria, candidatasCategoria, candidatasTerminal,
  fijarCategoria, fijarTerminal, quitarDeCategoria,
  type AppCandidata, type IdCategoria, type TipoArchivo,
} from "../../../servicios/aplicaciones/appsPredeterminadas"
import textos from "../../../textos/ajustes/predeterminadas.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"
import { DisplaySelect } from "../../../servicios/pantalla/controls"

const MAX_RESULTADOS = 5
/** Filas de «Todos los tipos» a la vez: cada una es una fila completa con su
 *  propio buscador, y una búsqueda corta («a») casaría con cientos. */
const MAX_TIPOS = 15
let cerrarGestionActiva: (() => void) | null = null

const GRUPOS: { titulo: string; icono: string; ids: IdCategoria[] }[] = [
  { titulo: textos.grupos.web, icono: "󰖟", ids: ["navegador", "correo"] },
  { titulo: textos.grupos.archivos, icono: "󰉋", ids: ["archivos", "pdf", "imagenes", "video", "musica", "texto", "comprimidos"] },
  { titulo: textos.grupos.programacion, icono: "󰅩", ids: ["codigo", "markdown"] },
  { titulo: textos.grupos.oficina, icono: "󰈬", ids: ["documentos", "hojas", "presentaciones"] },
]

function edicionDe(categoria: ReturnType<typeof categoriaDeTipo>, catalogo: AppInstalada[]): Edicion {
  return {
    catalogo,
    quitar: (app) => quitarDeCategoria(categoria, app),
    anadir: (app) => anadirACategoria(categoria, app),
  }
}

const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/**
 * «Todos los tipos de archivo»: buscador sobre el índice de shared-mime-info y,
 * por cada resultado, la MISMA fila que las categorías. El campo va fuera del
 * <For> (el foco no puede vivir en una lista que se rehace) y las filas llevan
 * `id` por MIME: afinar la búsqueda no reconstruye las que siguen casando, así
 * que una fila desplegada no se cierra sola mientras se escribe.
 */
function TarjetaTodosLosTipos({ catalogo }: { catalogo: AppInstalada[] }) {
  const [consulta, setConsulta] = createState("")
  const tipos = consulta((q) => buscarTiposArchivo(q, MAX_TIPOS))

  return (
    <TarjetaAjustes titulo={textos.grupos.todos} icono="󰈔">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
        <TextoInformativo label={textos.todos.ayuda} />
        <EntradaTextoAjustes
          placeholderText={textos.todos.marcador}
          hexpand
          onChanged={(self: Gtk.Entry) => setConsulta(self.get_text())}
        />
        <TextoInformativo
          label={textos.todos.sinResultados}
          visible={createComputed([consulta, tipos], (q, l) => !!q.trim() && l.length === 0)}
        />
      </box>
      <ListaAjustes alto={264}>
        <For each={tipos} id={(t: TipoArchivo) => t.mime}>
          {(t: TipoArchivo) => {
            const categoria = categoriaDeTipo(t.mime)
            return (
              <FilaPredeterminada
                titulo={mayuscula(t.descripcion)}
                descripcion={`${t.extensiones.slice(0, 4).map((e) => "." + e).join(" ")}  ·  ${t.mime}`}
                icono={categoria.icono}
                leerCandidatas={() => candidatasCategoria(categoria)}
                leerActual={() => actualCategoria(categoria)}
                fijar={(app) => fijarCategoria(categoria, app)}
                edicion={edicionDe(categoria, catalogo)}
              />
            )
          }}
        </For>
      </ListaAjustes>
      <box cssClasses={["dev-row"]} visible={tipos((l) => l.length >= MAX_TIPOS)}>
        <TextoInformativo label={formatearTexto(textos.todos.limite, { n: MAX_TIPOS })} />
      </box>
    </TarjetaAjustes>
  )
}

function IconoApp({ icono }: { icono: string }) {
  const gicon = iconoDesdeCadena(icono)
  return gicon
    ? <image gicon={gicon} pixelSize={20} valign={Gtk.Align.CENTER} />
    : <label cssClasses={["sp-nav-icon"]} label="󰀻" valign={Gtk.Align.CENTER} />
}

interface Edicion {
  /** Catálogo de apps instaladas, compartido por todas las filas de la visita. */
  catalogo: AppInstalada[]
  quitar: (id: string) => boolean
  anadir: (id: string) => boolean
}

function FilaPredeterminada({ titulo, descripcion, icono, leerCandidatas, leerActual, fijar, edicion }: {
  titulo: string
  descripcion: string
  icono: string
  leerCandidatas: () => AppCandidata[]
  leerActual: () => AppCandidata | null
  fijar: (id: string) => boolean
  /** Ausente = lista fija (el terminal no tiene «Abrir con»). */
  edicion?: Edicion
}) {
  const [actual, setActual] = createState<AppCandidata | null>(leerActual())
  const [candidatas, setCandidatas] = createState<AppCandidata[]>(leerCandidatas())
  const [abierto, setAbierto] = createState(false)
  const [error, setError] = createState(false)
  const [consulta, setConsulta] = createState("")
  const idActual = actual((a) => a?.id ?? "")

  const releer = (ok: boolean) => {
    setError(!ok)
    setActual(leerActual())
    setCandidatas(leerCandidatas())
  }

  const elegir = (id: string) => {
    const ok = id === idActual.get() || fijar(id)
    releer(ok)
    if (ok) cerrar()
  }

  // Los resultados excluyen lo que ya está en la lista, y dependen de las dos
  // fuentes: añadir una app tiene que sacarla de los resultados al momento.
  const resultados = createComputed([consulta, candidatas], (texto, lista) => {
    if (!edicion || !texto.trim()) return []
    const ya = new Set(lista.map((c) => c.id))
    return filtrarAppsInstaladas(edicion.catalogo.filter((a) => !ya.has(a.id)), texto, MAX_RESULTADOS)
  })
  let campo: Gtk.Entry | null = null
  let panel: Gtk.Widget
  let anfitrion: Gtk.Overlay | null = null
  let controladorFuera: Gtk.GestureClick | null = null
  let cierrePendiente = 0
  const ajustesObservados: [Gtk.Adjustment, number][] = []

  const perteneceA = (widget: Gtk.Widget | null, ancestro: Gtk.Widget) => {
    let actual = widget
    while (actual) {
      if (actual === ancestro) return true
      actual = actual.get_parent()
    }
    return false
  }

  const cerrar = () => {
    if (cierrePendiente) GLib.source_remove(cierrePendiente)
    cierrePendiente = 0
    for (const [ajuste, senal] of ajustesObservados) ajuste.disconnect(senal)
    ajustesObservados.length = 0
    if (anfitrion && controladorFuera) anfitrion.remove_controller(controladorFuera)
    controladorFuera = null
    if (anfitrion && panel.get_parent() === anfitrion) anfitrion.remove_overlay(panel)
    anfitrion = null
    setAbierto(false)
    if (cerrarGestionActiva === cerrar) cerrarGestionActiva = null
  }

  const buscarAnfitrion = (widget: Gtk.Widget): Gtk.Overlay | null => {
    let padre = widget.get_parent()
    while (padre) {
      if (padre instanceof Gtk.Overlay && padre.has_css_class("display-select-host")) return padre
      padre = padre.get_parent()
    }
    return null
  }

  const abrir = (boton: Gtk.Button) => {
    cerrarGestionActiva?.()
    anfitrion = buscarAnfitrion(boton)
    if (!anfitrion) return

    const [valido, punto] = boton.compute_point(anfitrion, new Graphene.Point({ x: 0, y: 0 }))
    if (!valido) {
      anfitrion = null
      return
    }

    let limiteSuperior = 0
    let limiteInferior = anfitrion.get_height()
    let ancestro = boton.get_parent()
    while (ancestro) {
      if (ancestro instanceof Gtk.Viewport) {
        const [visible, origen] = ancestro.compute_point(anfitrion, new Graphene.Point({ x: 0, y: 0 }))
        if (visible) {
          limiteSuperior = Math.max(limiteSuperior, origen.y)
          limiteInferior = Math.min(limiteInferior, origen.y + ancestro.get_height())
        }
      }
      if (ancestro instanceof Gtk.ScrolledWindow) {
        const ajuste = ancestro.get_vadjustment()
        ajustesObservados.push([ajuste, ajuste.connect("value-changed", cerrar)])
      }
      ancestro = ancestro.get_parent()
    }

    const ancho = Math.min(420, Math.max(280, anfitrion.get_width() - 16))
    panel.set_size_request(ancho, -1)
    const [, altoNatural] = panel.measure(Gtk.Orientation.VERTICAL, ancho)
    const alto = Math.min(altoNatural, 360)
    const yFila = Math.round(punto.y)
    const huecoAbajo = limiteInferior - yFila - boton.get_height() - 8
    const huecoArriba = yFila - limiteSuperior - 8
    const arriba = alto > huecoAbajo && huecoArriba > huecoAbajo
    const x = Math.max(8, Math.min(anfitrion.get_width() - ancho - 8,
      Math.round(punto.x + boton.get_width() - ancho)))

    panel.set_halign(Gtk.Align.START)
    panel.set_valign(Gtk.Align.START)
    panel.set_margin_start(x)
    panel.set_margin_top(arriba ? Math.max(limiteSuperior + 4, yFila - alto - 8) : yFila + boton.get_height() + 8)
    panel.set_vexpand(false)
    anfitrion.add_overlay(panel)
    anfitrion.set_clip_overlay(panel, false)
    anfitrion.set_measure_overlay(panel, false)

    controladorFuera = new Gtk.GestureClick()
    controladorFuera.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    controladorFuera.connect("pressed", (gesto, _pulsacion, xPulsado, yPulsado) => {
      gesto.set_state(Gtk.EventSequenceState.DENIED)
      if (!anfitrion) return
      const elegido = anfitrion.pick(xPulsado, yPulsado, Gtk.PickFlags.DEFAULT)
      if (perteneceA(elegido, boton) || perteneceA(elegido, panel) || cierrePendiente) return
      cierrePendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        cierrePendiente = 0
        cerrar()
        return GLib.SOURCE_REMOVE
      })
    })
    anfitrion.add_controller(controladorFuera)
    cerrarGestionActiva = cerrar
    setAbierto(true)
  }

  panel = (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["pred-opciones"]}>
      <TextoInformativo
        label={edicion ? textos.fila.ayudaEditable : textos.fila.ayuda}
        cssClasses={["pred-ayuda"]}
      />
      <ListaAjustes alto={144} cantidad={candidatas((lista) => lista.length)} vacia={textos.fila.sinCandidatas}>
        <For each={candidatas} id={(c: AppCandidata) => c.id}>
          {(c: AppCandidata) => (
            <box spacing={6}>
              <button
                hexpand
                cssClasses={idActual((id) => id === c.id ? ["pred-opcion", "active"] : ["pred-opcion"])}
                tooltipText={textos.fila.hacerPredeterminada}
                onClicked={() => elegir(c.id)}
              >
                <box spacing={10}>
                  <IconoApp icono={c.icono} />
                  <label label={c.nombre} hexpand xalign={0} ellipsize={3} />
                  <label cssClasses={["pred-marca"]} label="󰄬" visible={idActual((id) => id === c.id)} />
                </box>
              </button>
              {edicion ? (
                <button
                  cssClasses={["sp-rule-del"]}
                  valign={Gtk.Align.CENTER}
                  sensitive={idActual((id) => id !== c.id)}
                  tooltipText={idActual((id) => id === c.id ? textos.fila.noQuitarActual : textos.fila.quitar)}
                  onClicked={() => releer(edicion.quitar(c.id))}
                >
                  <label label="󰆴" />
                </button>
              ) : <box />}
            </box>
          )}
        </For>
      </ListaAjustes>

      {edicion ? (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["pred-anadir"]}>
          <EntradaTextoAjustes
            placeholderText={textos.fila.anadirMarcador}
            hexpand
            $={(self: Gtk.Entry) => { campo = self }}
            onChanged={(self: Gtk.Entry) => setConsulta(self.get_text())}
          />
          <box orientation={Gtk.Orientation.VERTICAL} visible={consulta((texto) => !!texto.trim())}>
            <ListaAjustes alto={96} cantidad={resultados((lista) => lista.length)}
              vacia={consulta((texto) => texto.trim() ? textos.fila.sinResultados : textos.fila.escribirBusqueda)}>
              <For each={resultados} id={(a: AppInstalada) => a.id}>
                {(a: AppInstalada) => (
                  <button
                    cssClasses={["pred-opcion"]}
                    tooltipText={textos.fila.anadir}
                    onClicked={() => {
                      releer(edicion.anadir(a.id))
                      campo?.set_text("")
                    }}
                  >
                    <box spacing={10}>
                      <IconoApp icono={a.icono} />
                      <label label={a.nombre} hexpand xalign={0} ellipsize={3} />
                      <label cssClasses={["pred-marca"]} label="󰐕" />
                    </box>
                  </button>
                )}
              </For>
            </ListaAjustes>
          </box>
        </box>
      ) : <box />}
    </box>
  ) as unknown as Gtk.Widget
  onCleanup(cerrar)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
      <box spacing={10} valign={Gtk.Align.CENTER}>
        <label cssClasses={["dev-card-icon"]} label={icono} valign={Gtk.Align.START} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <TituloAjuste label={titulo} />
          <TextoInformativo label={descripcion} />
        </box>
        <box cssClasses={["dev-select"]} valign={Gtk.Align.CENTER} hexpand={false}>
          <DisplaySelect compact={false} buscador={textos.fila.buscar} anchoCaracteres={22}
            current={actual((a) => a?.nombre ?? textos.fila.ninguna)}
            options={createComputed(() => candidatas().map((app) => ({
              value: app.id, label: app.nombre, active: app.id === idActual(),
            })))}
            onSelect={elegir} />
        </box>
        {edicion ? (
          <BotonAjustes activo={abierto} cssClasses={["pred-gestionar"]}
            heightRequest={28} valign={Gtk.Align.CENTER} tooltipText={textos.fila.gestionar}
            onClicked={(self: Gtk.Button) => abierto.get() ? cerrar() : abrir(self)}>
            <label label="󰒓" xalign={0.5} yalign={0.5}
              halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} marginEnd={2} />
          </BotonAjustes>
        ) : <box />}
      </box>

      <TextoInformativo label={textos.fila.error} visible={error} cssClasses={["pred-error"]} />
    </box>
  )
}

export default function SeccionAppsPredeterminadas() {
  const porId = new Map(CATEGORIAS.map((c) => [c.id, c]))
  // Una sola lectura del catálogo por visita, compartida por todas las filas.
  const catalogo = catalogoAppsInstaladas()

  return (
    <overlay cssClasses={["display-select-host"]} vexpand>
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand valign={Gtk.Align.START}>

      {GRUPOS.map((grupo) => (
        <TarjetaAjustes titulo={grupo.titulo} icono={grupo.icono}>
          {grupo.ids.map((id) => {
            const categoria = porId.get(id)!
            return (
              <FilaPredeterminada
                titulo={textos.categorias[id].titulo}
                descripcion={textos.categorias[id].descripcion}
                icono={categoria.icono}
                leerCandidatas={() => candidatasCategoria(categoria)}
                leerActual={() => actualCategoria(categoria)}
                fijar={(app) => fijarCategoria(categoria, app)}
                edicion={edicionDe(categoria, catalogo)}
              />
            )
          })}
        </TarjetaAjustes>
      ))}

      <TarjetaTodosLosTipos catalogo={catalogo} />

      <TarjetaAjustes titulo={textos.grupos.sistema} icono="󰆍">
        <FilaPredeterminada
          titulo={textos.categorias.terminal.titulo}
          descripcion={textos.categorias.terminal.descripcion}
          icono="󰆍"
          leerCandidatas={candidatasTerminal}
          leerActual={actualTerminal}
          fijar={fijarTerminal}
        />
      </TarjetaAjustes>

      <box cssClasses={["dev-row"]}>
        <TextoInformativo label={textos.aviso} maxWidthChars={62} />
      </box>
    </box>
    </overlay>
  )
}
