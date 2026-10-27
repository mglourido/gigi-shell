// Sección "reactiva": lista de resultados de `search/`, montada cuando una
// búsqueda no es inline para la sección actual (ver `setQuery` en
// `../../state.ts`, que redirige aquí y recuerda de dónde venías).

import { Gtk } from "ags/gtk4"
import {
  searchResults,
  setSection,
  hidePanel,
  showAppContext,
  hideRightPanel,
} from "../../state"
import type { SearchResult } from "../../search"
import { activarDobleClic } from "../shared/dobleClic"
import { registrarAtajo } from "../../data/historial"
import { crearIconoApp } from "../shared/tarjetaApp"
import type {
  ElementoNavegacionBusqueda,
  NavegacionBusqueda,
} from "../shared/NavegacionBusqueda"

function mostrarContextoApp(resultado: SearchResult): void {
  const nombreEjecutable = resultado.meta?.execName ?? ""
  showAppContext({
    id: resultado.id,
    name: resultado.title,
    iconName: resultado.iconName ?? "application-x-executable",
    gicon: resultado.icon ?? null,
    execRaw: resultado.meta?.exec ?? "",
    execName: nombreEjecutable,
    appId: resultado.meta?.appId ?? resultado.id,
    desktopFile: resultado.meta?.desktopFile ?? "",
    rutaEjecutable: resultado.meta?.rutaEjecutable,
    launch: () => resultado.action(),
  })
}

function navegarDesde(resultado: SearchResult, destino: NonNullable<SearchResult["navigateTo"]>): void {
  const binding = resultado.meta?.kbBinding
  if (binding) registrarAtajo(binding, resultado.meta?.kbDescripcion ?? resultado.title)
  setSection(destino)
}

function activarResultado(resultado: SearchResult): void {
  if (resultado.navigateTo) {
    navegarDesde(resultado, resultado.navigateTo)
    return
  }
  resultado.action()
  hidePanel()
}

function crearFila(
  resultado: SearchResult,
  navegacion: NavegacionBusqueda,
): { contenedor: Gtk.Box; navegable: ElementoNavegacionBusqueda } {
  const esApp = !!resultado.meta?.exec

  const contenedor = new Gtk.Box({ cssClasses: ["rx-result-row"] })
  const boton = new Gtk.Button({ cssClasses: ["rx-item"], hexpand: true })
  const fila = new Gtk.Box({ cssClasses: ["rx-row"], spacing: 12 })

  // Icono
  const contenedorIcono = new Gtk.Box({ cssClasses: ["rx-icon-wrap"], valign: Gtk.Align.CENTER })
  contenedorIcono.append(crearIconoApp(resultado.icon, resultado.iconName ?? "application-x-executable", 26))
  fila.append(contenedorIcono)

  // Texto
  const columnaTexto = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
  columnaTexto.append(new Gtk.Label({ label: resultado.title, cssClasses: ["rx-title"], halign: Gtk.Align.START, ellipsize: 3 }))
  if (resultado.subtitle) {
    // Un ejecutable suelto lleva debajo su CARPETA (ya acortada a un techo de
    // caracteres en `carpetaCorta`), en letra más pequeña. La elipsis va en
    // medio y no al final: de una ruta interesan el principio y la carpeta que
    // lo contiene, y `maxWidthChars` impide que una ruta larga ensanche Orion.
    const esRuta = !!resultado.meta?.rutaEjecutable
    columnaTexto.append(new Gtk.Label({
      label: resultado.subtitle,
      cssClasses: esRuta ? ["rx-subtitle", "rx-ruta"] : ["rx-subtitle"],
      halign: Gtk.Align.START,
      ellipsize: esRuta ? 2 : 3,
      maxWidthChars: esRuta ? 44 : -1,
      tooltipText: esRuta ? resultado.meta!.rutaEjecutable : null,
    }))
  }
  fila.append(columnaTexto)
  boton.set_child(fila)

  const navegable: ElementoNavegacionBusqueda = {
    marcarSeleccionado: (seleccionado) => {
      if (seleccionado) boton.add_css_class("seleccionado")
      else boton.remove_css_class("seleccionado")
    },
    previsualizar: () => {
      if (esApp) mostrarContextoApp(resultado)
      else hideRightPanel()
    },
    enfocar: () => boton.grab_focus(),
    activar: () => activarResultado(resultado),
  }

  // Ratón y accesibilidad también entran por el modelo único; el foco de
  // GTK nunca pinta una selección paralela por su cuenta.
  boton.connect("notify::has-focus", () => {
    if (boton.has_focus) navegacion.seleccionarResultado(navegable, false)
  })

  const estaSuprimido = esApp
    ? activarDobleClic(boton, () => {
      navegacion.seleccionarResultado(navegable, false)
      resultado.action()
      hidePanel()
    })
    : null

  boton.connect("clicked", () => {
    navegacion.seleccionarResultado(navegable)
    if (estaSuprimido?.()) return
    if (resultado.navigateTo) {
      navegarDesde(resultado, resultado.navigateTo)
    } else if (!esApp) {
      resultado.action()
      hidePanel()
    } else {
      mostrarContextoApp(resultado)
    }
  })

  contenedor.append(boton)
  return { contenedor, navegable }
}

export function ReactiveSection(
  navegacion: NavegacionBusqueda,
) {
  const contenido = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["rx-content"] })

  const etiquetaVacia = new Gtk.Label({ label: "Sin resultados", cssClasses: ["rx-empty"] })
  etiquetaVacia.visible = false
  contenido.append(etiquetaVacia)

  // Filas VIVAS por `resultado.id`, reutilizadas entre resoluciones en vez de
  // destruirse y recrearse en cada tecla (mismo criterio que el `<For>` con
  // `id` del resto del shell — ver la nota de identidad de objeto en el
  // ags/modulos/barra/CLAUDE.md). El id de un resultado (app o atajo) es estable de una
  // query a otra para la misma entidad, así que la fila —widgets, gestos,
  // handlers de foco ya conectados— sobrevive; solo se reordena.
  const filas = new Map<string, { contenedor: Gtk.Box; navegable: ElementoNavegacionBusqueda }>()

  function reconstruir(resultados: SearchResult[]) {
    if (resultados.length === 0) {
      for (const fila of filas.values()) contenido.remove(fila.contenedor)
      filas.clear()
      navegacion.establecerResultados([])
      etiquetaVacia.visible = true
      return
    }
    etiquetaVacia.visible = false

    const idsNuevos = new Set(resultados.map(r => r.id))
    for (const [id, fila] of filas) {
      if (!idsNuevos.has(id)) {
        contenido.remove(fila.contenedor)
        filas.delete(id)
      }
    }

    const navegables: ElementoNavegacionBusqueda[] = []
    let anterior: Gtk.Widget = etiquetaVacia
    for (const resultado of resultados) {
      let fila = filas.get(resultado.id)
      if (!fila) {
        fila = crearFila(resultado, navegacion)
        filas.set(resultado.id, fila)
        contenido.append(fila.contenedor)
      }
      contenido.reorder_child_after(fila.contenedor, anterior)
      anterior = fila.contenedor
      navegables.push(fila.navegable)
    }
    navegacion.establecerResultados(navegables)
  }

  searchResults.subscribe(() => reconstruir(searchResults.get()))
  reconstruir(searchResults.get())

  return contenido
}
