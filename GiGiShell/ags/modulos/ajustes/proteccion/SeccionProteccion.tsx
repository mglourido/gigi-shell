// modulos/ajustes/proteccion/SeccionProteccion.tsx — Ajustes > Protección de
// archivos. La mitad visible de `servicios/seguridad/guardian.ts`: interruptor
// del servicio, valores por defecto de las categorías y la lista de archivos.
//
// Nada de aquí escribe la política: todo son órdenes al daemon por el socket,
// que contesta con un `cambio` y el servicio vuelve a pedir la lista. Sin
// conexión (servicio apagado) la lista sale en gris.
//
// ── «Proteger archivo…» abre un Gtk.FileDialog, y eso aquí no es gratis ─────
// Ajustes es una layer-shell en la capa OVERLAY y el diálogo es una ventana
// normal: el compositor lo dibujaría DEBAJO, invisible (ver ags/CLAUDE.md,
// CampoRutaAudio). Se abre dentro de `withPrivilegedPrompt`, que baja Ajustes a
// la capa BOTTOM mientras dura la promesa — el mismo apaño que el diálogo de
// polkit, que es exactamente el mismo problema.

import { For, createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { withPrivilegedPrompt } from "../../../estado/shell"
import {
  AjusteInterruptor, BotonAjustes, TarjetaAjustes, TextoInformativo, TituloSeccion,
} from "../componentes"
import {
  activar, categoriasPorDefecto, conectado, denegadosSemana, desactivar, estadoServicio,
  ficheros, fijarCategoria, proteger, refrescarEstado, reiniciar, ultimoError,
  type Fichero,
} from "../../../servicios/seguridad/guardian"
import SelectorCategorias from "./SelectorModo"
import FicheroProtegido from "./FicheroProtegido"
import textos from "../../../textos/ajustes/proteccion.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

const t = textos.seccion

/** Rutas elegidas en el diálogo (vacío si se cancela). */
function elegirArchivos(): Promise<string[]> {
  return new Promise((resolve) => {
    const dialogo = new Gtk.FileDialog({ title: t.archivos.dialogo, modal: true })
    dialogo.open_multiple(null, null, (_d, res) => {
      try {
        const lista = dialogo.open_multiple_finish(res)
        const rutas: string[] = []
        for (let i = 0; i < (lista?.get_n_items() ?? 0); i++) {
          const ruta = (lista!.get_item(i) as Gio.File | null)?.get_path()
          if (ruta) rutas.push(ruta)
        }
        resolve(rutas)
      } catch {
        resolve([]) // cancelado
      }
    })
  })
}

async function protegerArchivos() {
  const rutas = await withPrivilegedPrompt(elegirArchivos)
  for (const ruta of rutas) proteger(ruta)
}

export default function SeccionProteccion() {
  // Sin sondeo: el estado se lee al abrir la sección.
  refrescarEstado()

  const activo = estadoServicio((e) => e === "activo")
  const conmutable = estadoServicio((e) => e === "activo" || e === "apagado")
  const motivo = estadoServicio((e) =>
    e === "no-instalado" ? t.estado.noInstalado
      : e === "sin-bpf" ? t.estado.sinBpf
        : e === "caido" ? t.estado.caido
          : "")
  const resumen = createComputed(() => formatearTexto(t.estado.resumen, {
    ficheros: ficheros().length,
    denegados: denegadosSemana(),
  }))
  const conectando = createComputed(() => estadoServicio() === "activo" && !conectado())

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={t.titulo} />

      <TarjetaAjustes titulo={t.estado.tarjeta} icono="󰌾">
        <AjusteInterruptor
          titulo={t.estado.interruptor}
          informacion={t.estado.descripcion}
          activo={activo}
          sensible={conmutable}
          alAlternar={() => (activo.get() ? desactivar() : activar())}
        />
        <box cssClasses={["dev-row"]} spacing={10} visible={motivo((m) => m !== "")}>
          <TextoInformativo label={motivo} hexpand />
          <BotonAjustes visible={estadoServicio((e) => e === "caido")} onClicked={() => reiniciar()}>
            <label label={t.estado.reiniciar} />
          </BotonAjustes>
        </box>
        <box cssClasses={["dev-row"]} visible={conectado}>
          <TextoInformativo label={resumen} />
        </box>
        <box cssClasses={["dev-row"]} visible={conectando}>
          <TextoInformativo label={t.estado.conectando} />
        </box>
        <box cssClasses={["dev-row"]} visible={ultimoError((e) => e !== null)}>
          <TextoInformativo label={ultimoError((e) => e ?? "")} cssClasses={["guardian-historial-denegado"]} />
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={t.defecto.tarjeta} icono="󰒓">
        <box cssClasses={["dev-row"]}>
          <TextoInformativo label={t.defecto.descripcion} />
        </box>
        <SelectorCategorias
          modos={categoriasPorDefecto}
          sensible={conectado}
          alElegir={(cat, modo) => fijarCategoria(null, cat, modo)}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={t.archivos.tarjeta} icono="󰈙">
        <box cssClasses={["dev-row"]} visible={conectado((c) => !c)}>
          <TextoInformativo label={t.archivos.sinConexion} />
        </box>
        <box cssClasses={["dev-row"]} sensitive={conectado}>
          <BotonAjustes variante="principal" onClicked={() => { protegerArchivos() }}>
            <label label={t.archivos.proteger} />
          </BotonAjustes>
        </box>
        <box
          cssClasses={["dev-row"]}
          visible={createComputed(() => conectado() && ficheros().length === 0)}
        >
          <TextoInformativo label={t.archivos.vacio} />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} sensitive={conectado}>
          <For each={ficheros} id={(f: Fichero) => f.id}>
            {(f: Fichero) => <FicheroProtegido inicial={f} />}
          </For>
        </box>
      </TarjetaAjustes>
    </box>
  )
}
