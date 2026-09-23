// modulos/orion/components/sections/rice/EditorGrupo.ts
//
// Editor de un GRUPO: su nombre y su línea de 24 h.
//
// Un grupo es UNA entidad de cara al sorteo (para el sistema es un fondo, no N),
// y su línea de tiempo es SUYA, independiente de las franjas globales — así un
// grupo puede mudar a las 5:00 aunque "día" empiece a las 7:00. Cada tramo lleva
// una LISTA de imágenes: si hay varias, el motor sortea entre ellas. Un tramo
// VACÍO es la forma de decir "a estas horas este grupo no sale", y entonces el
// grupo queda fuera de la selección hasta el tramo siguiente.
//
// ⚠️ Igual que en `EditorFranjas`: editar una hora o el nombre NO reconstruye la
// lista. Los campos confirman al perder el foco, y reconstruir ahí destruiría el
// `Gtk.Entry` enfocado desde su propio manejador de foco — el SIGSEGV documentado
// en `servicios/pantalla/`. Reconstruyen solo los botones.

import { Gtk } from "ags/gtk4"
import {
  wallpapersConfig, ahoraFranjas, listWallpapers, renombrarGrupo, anadirTramo,
  borrarTramo, moverTramo, alternarEnTramo, borrarGrupo, applyGrupo, reevaluar,
} from "../../../data/wallpaperConfig"
import {
  aMinutos, aHora, rutasAgrupadas, tramoVigente, vigente, MINUTOS_DIA,
  type Grupo,
} from "../../../data/wallpaperSchedule"
import {
  boton, cabeceraVuelta, campoHora, columna, etiqueta, fila, miniatura, nombreDe,
} from "./comunes"

const CHIP_W = 92
const CHIP_H = 52

export function EditorGrupo(gid: string, alVolver: () => void): Gtk.Widget {
  const raiz = columna(0, ["rice-editor"])
  const cuerpo = columna(10)

  const grupoActual = (): Grupo | null =>
    wallpapersConfig.get().grupos.find(g => g.id === gid) ?? null

  // Sub-vista "añadir imagen a este tramo". Se guarda cuál está abierta para que
  // reconstruir no la cierre: se abre y se cierra con botones, no sola.
  let selectorAbiertoEn: string | null = null

  const reconstruir = () => {
    let hijo = cuerpo.get_first_child()
    while (hijo) { const sig = hijo.get_next_sibling(); cuerpo.remove(hijo); hijo = sig }

    const grupo = grupoActual()
    if (!grupo) { alVolver(); return }

    const ahora = ahoraFranjas.get()
    const activo = tramoVigente(grupo, ahora)
    const enVigor = vigente(grupo.tramos, ahora)

    // ── Nombre ────────────────────────────────────────────────────────────────
    const nombre = new Gtk.Entry({
      text: grupo.nombre, cssClasses: ["rice-nombre", "grande"], hexpand: true,
    })
    const confirmarNombre = () => {
      const t = nombre.get_text().trim()
      if (t && t !== grupo.nombre) renombrarGrupo(gid, t)
      else if (!t) nombre.set_text(grupo.nombre)
    }
    nombre.connect("activate", confirmarNombre)
    const foco = new Gtk.EventControllerFocus()
    foco.connect("leave", confirmarNombre)
    nombre.add_controller(foco)
    cuerpo.append(nombre)

    cuerpo.append(etiqueta(
      "Cada tramo empieza a su hora y dura hasta el siguiente. Con varias " +
      "imágenes en un tramo, se elige una al azar. Un tramo vacío deja el grupo " +
      "fuera del sorteo a esas horas.",
      ["rice-help"]))

    cuerpo.append(etiqueta(
      activo.length > 0
        ? `Ahora sale: ${activo.map(nombreDe).join(", ")}`
        : "Ahora mismo este grupo no sale.",
      ["rice-estado", activo.length > 0 ? "ok" : "dim"]))

    // ── Tramos ────────────────────────────────────────────────────────────────
    const ordenados = [...grupo.tramos].sort(
      (a, b) => (aMinutos(a.start) ?? 0) - (aMinutos(b.start) ?? 0))
    const agrupadas = rutasAgrupadas(wallpapersConfig.get())
    const sueltos = listWallpapers().filter(p => !agrupadas.has(p))

    ordenados.forEach((tramo, i) => {
      const sig = ordenados[(i + 1) % ordenados.length]
      const fin = ordenados.length === 1
        ? aHora((aMinutos(tramo.start) ?? 0) + MINUTOS_DIA)
        : aHora(aMinutos(sig.start) ?? 0)
      const esVigente = enVigor?.start === tramo.start

      const tarjeta = columna(6, esVigente ? ["rice-tramo", "activa"] : ["rice-tramo"])

      const cabecera = fila(8)
      cabecera.append(campoHora(tramo.start, nueva => {
        moverTramo(gid, tramo.start, nueva)
        reevaluar()
      }))
      const rango = etiqueta(`hasta ${fin}`, ["rice-rango"])
      rango.set_hexpand(true)
      cabecera.append(rango)
      if (esVigente) cabecera.append(etiqueta("ahora", ["rice-chip-ahora"]))

      // El último tramo que queda no se puede borrar: un grupo sin tramos no
      // tiene forma de volver a tener imágenes desde esta UI.
      if (ordenados.length > 1) {
        const quitar = new Gtk.Button({ cssClasses: ["rice-icon-btn"] })
        quitar.set_child(new Gtk.Image({ iconName: "user-trash-symbolic" }))
        quitar.connect("clicked", () => {
          borrarTramo(gid, tramo.start)
          reevaluar()
          reconstruir()
        })
        cabecera.append(quitar)
      }
      tarjeta.append(cabecera)

      // Imágenes del tramo
      const tira = new Gtk.FlowBox({ cssClasses: ["rice-tira"] })
      tira.selection_mode = Gtk.SelectionMode.NONE
      tira.column_spacing = 6
      tira.row_spacing = 6
      tira.min_children_per_line = 2
      tira.max_children_per_line = 4

      if (tramo.paths.length === 0) {
        tarjeta.append(etiqueta("Sin imágenes: el grupo no sale en este tramo.",
          ["rice-help", "dim"]))
      }
      for (const path of tramo.paths) {
        const b = new Gtk.Button({ cssClasses: ["rice-chip-img-btn"] })
        b.set_child(miniatura(path, CHIP_W, CHIP_H))
        b.set_tooltip_text(`${nombreDe(path)} — quitar de este tramo`)
        b.connect("clicked", () => {
          alternarEnTramo(gid, tramo.start, path)
          reevaluar()
          reconstruir()
        })
        tira.append(b)
      }
      tarjeta.append(tira)

      // Selector de imágenes: candidatas = fondos sueltos + las que ya están en
      // OTROS tramos de este grupo (repetir una imagen en dos tramos es legítimo:
      // "esta vale de día y de noche").
      if (selectorAbiertoEn === tramo.start) {
        const candidatas = [
          ...sueltos,
          ...grupo.tramos.flatMap(t => t.paths).filter(p => !tramo.paths.includes(p)),
        ].filter((p, idx, arr) => arr.indexOf(p) === idx && !tramo.paths.includes(p))

        const picker = new Gtk.FlowBox({ cssClasses: ["rice-tira", "picker"] })
        picker.selection_mode = Gtk.SelectionMode.NONE
        picker.column_spacing = 6
        picker.row_spacing = 6
        picker.min_children_per_line = 2
        picker.max_children_per_line = 4
        if (candidatas.length === 0) {
          tarjeta.append(etiqueta("No queda ningún fondo libre que añadir.",
            ["rice-help", "dim"]))
        }
        for (const path of candidatas) {
          const b = new Gtk.Button({ cssClasses: ["rice-chip-img-btn"] })
          b.set_child(miniatura(path, CHIP_W, CHIP_H))
          b.set_tooltip_text(nombreDe(path))
          b.connect("clicked", () => {
            alternarEnTramo(gid, tramo.start, path)
            selectorAbiertoEn = null
            reevaluar()
            reconstruir()
          })
          picker.append(b)
        }
        tarjeta.append(picker)
        tarjeta.append(boton("Cancelar", ["rice-btn", "sutil"], () => {
          selectorAbiertoEn = null
          reconstruir()
        }))
      } else {
        tarjeta.append(boton("Añadir imagen", ["rice-btn", "sutil"], () => {
          selectorAbiertoEn = tramo.start
          reconstruir()
        }))
      }

      cuerpo.append(tarjeta)
    })

    // ── Acciones del grupo ────────────────────────────────────────────────────
    const acciones = fila(8, ["rice-acciones"])
    acciones.append(boton("Añadir tramo", ["rice-btn"], () => {
      // Se propone una hora libre para no chocar con un tramo existente (dos
      // tramos a la misma hora dejarían uno inalcanzable, sin ningún error).
      const usadas = new Set(grupo.tramos.map(t => aMinutos(t.start)))
      let m = 0
      while (usadas.has(m) && m < MINUTOS_DIA) m += 60
      anadirTramo(gid, aHora(m))
      reconstruir()
    }))
    acciones.append(boton("Aplicar ahora", ["rice-btn"], () => applyGrupo(gid)))

    const deshacer = boton("Deshacer grupo", ["rice-btn", "peligro"], () => {
      // Las imágenes vuelven a ser fondos sueltos; no se borra ningún fichero.
      borrarGrupo(gid)
      reevaluar()
      alVolver()
    })
    deshacer.set_tooltip_text("Sus imágenes vuelven a ser fondos sueltos. No se borra ningún archivo.")
    acciones.append(deshacer)
    cuerpo.append(acciones)
  }

  raiz.append(cabeceraVuelta("Grupo", alVolver))
  raiz.append(cuerpo)
  reconstruir()
  return raiz
}
