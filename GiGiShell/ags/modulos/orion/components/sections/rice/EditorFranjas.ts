// modulos/orion/components/sections/rice/EditorFranjas.ts
//
// Editor de las FRANJAS GLOBALES (día / tarde / noche, y las que quieras).
//
// Son las que gobiernan los fondos SUELTOS: cada fondo declara en cuáles es apto,
// y de ahí sale "que no salga nada claro de noche", que es lo que motivó todo
// esto. NO gobiernan las variantes de un grupo — esas van por la línea de 24 h
// propia del grupo (`EditorGrupo`), a propósito, para que un grupo pueda mudar a
// las 5:00 aunque la franja "día" empiece a las 7:00.
//
// Cada franja se define SOLO por su hora de inicio y llega hasta el comienzo de
// la siguiente, envolviendo la medianoche: con tres franjas se ponen tres horas,
// no seis. El rango que se enseña a la derecha es derivado, no un dato que el
// usuario tenga que mantener cuadrado.
//
// ⚠️ EDITAR UNA HORA NO RECONSTRUYE LA LISTA. Los campos confirman al perder el
// foco, y reconstruir ahí destruiría el `Gtk.Entry` que tiene el foco desde
// dentro de su propio manejador de foco: es literalmente el SIGSEGV documentado
// en `servicios/pantalla/` (el método de entrada de Wayland se queda apuntando a
// un widget ya liberado). Así que al confirmar solo se persiste y se refrescan
// las etiquetas de rango en su sitio; el reordenado por hora se ve al volver a
// entrar. Reconstruir sí se hace desde los botones (añadir/borrar), que no salen
// de un evento de foco.

import { Gtk } from "ags/gtk4"
import {
  wallpapersConfig, ahoraFranjas, anadirFranja, editarFranja, borrarFranja,
  crearFranjasPorDefecto, reevaluar,
} from "../../../data/wallpaperConfig"
import { aMinutos, aHora, franjaActual, MINUTOS_DIA } from "../../../data/wallpaperSchedule"
import { boton, cabeceraVuelta, campoHora, columna, etiqueta, fila } from "./comunes"

export function EditorFranjas(alVolver: () => void): Gtk.Widget {
  const raiz = columna(0, ["rice-editor"])
  raiz.append(cabeceraVuelta("Franjas horarias", alVolver))

  const cuerpo = columna(8)
  raiz.append(cuerpo)

  // Las etiquetas de rango son derivadas de las horas, así que se refrescan sin
  // tocar los widgets — ver el aviso de la cabecera sobre reconstruir.
  const rangos: { id: string; label: Gtk.Label }[] = []
  const refrescarRangos = () => {
    const ordenadas = [...wallpapersConfig.get().franjas].sort(
      (a, b) => (aMinutos(a.start) ?? 0) - (aMinutos(b.start) ?? 0))
    for (const { id, label } of rangos) {
      const i = ordenadas.findIndex(f => f.id === id)
      if (i < 0) continue
      const sig = ordenadas[(i + 1) % ordenadas.length]
      const fin = ordenadas.length === 1
        ? aHora((aMinutos(ordenadas[0].start) ?? 0) + MINUTOS_DIA)
        : aHora(aMinutos(sig.start) ?? 0)
      label.set_label(`hasta ${fin}`)
    }
  }

  const reconstruir = () => {
    rangos.length = 0
    let hijo = cuerpo.get_first_child()
    while (hijo) { const sig = hijo.get_next_sibling(); cuerpo.remove(hijo); hijo = sig }

    const cfg = wallpapersConfig.get()
    const ahora = ahoraFranjas.get()

    cuerpo.append(etiqueta(
      "Cada franja empieza a su hora y dura hasta que empieza la siguiente. " +
      "Marca en cuáles puede salir cada fondo desde su ficha.",
      ["rice-help"]))

    if (cfg.franjas.length === 0) {
      cuerpo.append(etiqueta(
        "Sin franjas, todos los fondos pueden salir a cualquier hora.",
        ["rice-help", "dim"]))
      cuerpo.append(boton("Crear día, tarde y noche", ["rice-btn", "primario"], () => {
        crearFranjasPorDefecto()
        reconstruir()
      }))
      return
    }

    const vigente = franjaActual(cfg, ahora)

    // Orden por hora solo para PINTAR: los rangos se leen encadenados y una lista
    // desordenada haría que "hasta las X" pareciera un error del programa.
    const ordenadas = [...cfg.franjas].sort(
      (a, b) => (aMinutos(a.start) ?? 0) - (aMinutos(b.start) ?? 0))

    ordenadas.forEach((f, i) => {
      const inicio = aMinutos(f.start) ?? 0
      const siguiente = ordenadas[(i + 1) % ordenadas.length]
      const finMin = aMinutos(siguiente.start) ?? 0
      // Con una sola franja el rango es el día entero, no "07:00 → 07:00".
      const fin = ordenadas.length === 1 ? aHora(inicio + MINUTOS_DIA) : aHora(finMin)

      const esVigente = vigente?.id === f.id
      const caja = fila(8, esVigente ? ["rice-row", "activa"] : ["rice-row"])

      const nombre = new Gtk.Entry({
        text: f.nombre, cssClasses: ["rice-nombre"], hexpand: true,
      })
      const confirmarNombre = () => {
        const t = nombre.get_text().trim()
        if (t && t !== f.nombre) editarFranja(f.id, { nombre: t })
        else if (!t) nombre.set_text(f.nombre)
      }
      nombre.connect("activate", confirmarNombre)
      const foco = new Gtk.EventControllerFocus()
      foco.connect("leave", confirmarNombre)
      nombre.add_controller(foco)
      caja.append(nombre)

      const rango = etiqueta(`hasta ${fin}`, ["rice-rango"])
      caja.append(campoHora(f.start, nueva => {
        editarFranja(f.id, { start: nueva })
        refrescarRangos()
        reevaluar()
      }))
      caja.append(rango)
      rangos.push({ id: f.id, label: rango })

      if (esVigente) caja.append(etiqueta("ahora", ["rice-chip-ahora"]))

      // Con una sola franja, borrarla equivale a apagar la función; se permite,
      // porque "sin franjas" es un estado válido y explicado.
      const quitar = new Gtk.Button({ cssClasses: ["rice-icon-btn"] })
      quitar.set_child(new Gtk.Image({ iconName: "user-trash-symbolic" }))
      quitar.connect("clicked", () => {
        borrarFranja(f.id)
        reevaluar()
        reconstruir()
      })
      caja.append(quitar)

      cuerpo.append(caja)
    })

    cuerpo.append(boton("Añadir franja", ["rice-btn"], () => {
      anadirFranja()
      reconstruir()
    }))
  }

  reconstruir()
  return raiz
}
