// modulos/ajustes/predeterminadas/SeccionAppsPredeterminadas.tsx — Ajustes >
// Apps predeterminadas: con qué se abre un enlace, una carpeta, un PDF…
//
// Toda la parte de sistema (qué tipos MIME forman cada categoría, dónde se
// escribe, el terminal) vive en `servicios/aplicaciones/appsPredeterminadas.ts`.
//
// ── Las candidatas se leen al CONSTRUIR la sección ───────────────────────────
// Igual que el catálogo de Apps al inicio: la sección se monta al abrirla y se
// desmonta al cerrar Ajustes (el <With> único de SettingsPanel.tsx), así que
// «una vez» es una vez por visita. Un cambio hecho por fuera con Ajustes
// abierto («Abrir con > Predeterminada» en Dolphin) se ve al volver a entrar.
//
// ── Lista desplegable en línea, no un Gtk.DropDown ───────────────────────────
// Ningún destino de Ajustes usa popovers: la ventana es una layer-shell OVERLAY
// y el resto de selectores del panel son filas y botones dentro de la tarjeta.
// Aquí la lista de apps se abre bajo su fila; son listas cortas (2-7 apps).

import { createState } from "ags"
import { Gtk } from "ags/gtk4"
import {
  BotonAjustes, TarjetaAjustes, TextoInformativo, TituloAjuste, TituloSeccion,
} from "../componentes"
import { iconoDesdeCadena } from "../inicio/catalogoApps"
import {
  CATEGORIAS,
  actualCategoria, actualTerminal, candidatasCategoria, candidatasTerminal,
  fijarCategoria, fijarTerminal,
  type AppCandidata, type IdCategoria,
} from "../../../servicios/aplicaciones/appsPredeterminadas"
import textos from "../../../textos/ajustes/predeterminadas.json" with { type: "json" }

const GRUPOS: { titulo: string; icono: string; ids: IdCategoria[] }[] = [
  { titulo: textos.grupos.web, icono: "󰖟", ids: ["navegador", "correo"] },
  { titulo: textos.grupos.archivos, icono: "󰉋", ids: ["archivos", "pdf", "imagenes", "video", "musica", "texto", "comprimidos"] },
]

function IconoApp({ icono }: { icono: string }) {
  const gicon = iconoDesdeCadena(icono)
  return gicon
    ? <image gicon={gicon} pixelSize={20} valign={Gtk.Align.CENTER} />
    : <label cssClasses={["sp-nav-icon"]} label="󰀻" valign={Gtk.Align.CENTER} />
}

function FilaPredeterminada({ titulo, descripcion, icono, candidatas, leerActual, fijar }: {
  titulo: string
  descripcion: string
  icono: string
  candidatas: AppCandidata[]
  leerActual: () => AppCandidata | null
  fijar: (id: string) => boolean
}) {
  const [actual, setActual] = createState<AppCandidata | null>(leerActual())
  const [abierto, setAbierto] = createState(false)
  const [error, setError] = createState(false)
  const idActual = actual((a) => a?.id ?? "")

  const elegir = (id: string) => {
    const ok = id === idActual.get() || fijar(id)
    setError(!ok)
    // Se relee en vez de dar por buena la elección: si GIO no la aplicó, la fila
    // tiene que seguir enseñando lo que de verdad abre el archivo.
    setActual(leerActual())
    if (ok) setAbierto(false)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
      <box spacing={10} valign={Gtk.Align.CENTER}>
        <label cssClasses={["dev-card-icon"]} label={icono} valign={Gtk.Align.CENTER} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <TituloAjuste label={titulo} />
          <TextoInformativo label={descripcion} />
        </box>
        <BotonAjustes
          activo={abierto}
          valign={Gtk.Align.CENTER}
          tooltipText={textos.fila.cambiar}
          onClicked={() => setAbierto(!abierto.get())}
        >
          <box spacing={8}>
            {/* El icono cambia con la app: dos ranuras alternadas y no un
                ternario, que quedaría atado al primer valor (ver IndicadorJuegos). */}
            <image
              pixelSize={16}
              gicon={actual((a) => a ? iconoDesdeCadena(a.icono) : null)}
              visible={actual((a) => !!a && !!iconoDesdeCadena(a.icono))}
            />
            <label label={actual((a) => a?.nombre ?? textos.fila.ninguna)} maxWidthChars={22} ellipsize={3} />
            <label label={abierto((v) => v ? "󰅃" : "󰅀")} />
          </box>
        </BotonAjustes>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={abierto} cssClasses={["pred-opciones"]}>
        {candidatas.length === 0
          ? <TextoInformativo label={textos.fila.sinCandidatas} />
          : candidatas.map((c) => (
            <button
              cssClasses={idActual((id) => id === c.id ? ["pred-opcion", "active"] : ["pred-opcion"])}
              onClicked={() => elegir(c.id)}
            >
              <box spacing={10}>
                <IconoApp icono={c.icono} />
                <label label={c.nombre} hexpand xalign={0} ellipsize={3} />
                <label cssClasses={["pred-marca"]} label="󰄬" visible={idActual((id) => id === c.id)} />
              </box>
            </button>
          ))}
        <TextoInformativo label={textos.fila.error} visible={error} cssClasses={["pred-error"]} />
      </box>
    </box>
  )
}

export default function SeccionAppsPredeterminadas() {
  const porId = new Map(CATEGORIAS.map((c) => [c.id, c]))

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.seccion.titulo} />

      {GRUPOS.map((grupo) => (
        <TarjetaAjustes titulo={grupo.titulo} icono={grupo.icono}>
          {grupo.ids.map((id) => {
            const categoria = porId.get(id)!
            return (
              <FilaPredeterminada
                titulo={textos.categorias[id].titulo}
                descripcion={textos.categorias[id].descripcion}
                icono={categoria.icono}
                candidatas={candidatasCategoria(categoria)}
                leerActual={() => actualCategoria(categoria)}
                fijar={(app) => fijarCategoria(categoria, app)}
              />
            )
          })}
        </TarjetaAjustes>
      ))}

      <TarjetaAjustes titulo={textos.grupos.sistema} icono="󰆍">
        <FilaPredeterminada
          titulo={textos.categorias.terminal.titulo}
          descripcion={textos.categorias.terminal.descripcion}
          icono="󰆍"
          candidatas={candidatasTerminal()}
          leerActual={actualTerminal}
          fijar={fijarTerminal}
        />
      </TarjetaAjustes>

      <box cssClasses={["dev-row"]}>
        <TextoInformativo label={textos.aviso} maxWidthChars={62} />
      </box>
    </box>
  )
}
