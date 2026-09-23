// modulos/orion/components/sections/rice/EditorFondo.ts
//
// Ficha de un fondo SUELTO: en qué franjas globales puede salir, y el paso para
// convertirlo en un grupo.
//
// "Ninguna franja marcada" y "todas marcadas" significan lo mismo —apto siempre—
// y se guardan igual (sin entrada en la config). No es un descuido: guardar la
// lista completa ataría el fondo a los ids de HOY, así que al crear una franja
// nueva dejaría de ser apto en ella sin que nadie lo hubiera pedido. Ver
// `setFranjasDeFondo`.
//
// Convertirlo en grupo lo saca de la lista de fondos sueltos: un grupo es UNA
// entidad de cara al sorteo, y sus imágenes no pueden competir además por su
// cuenta (si no, agrupar cuatro variantes cuadruplicaría sus posibilidades).

import { Gtk } from "ags/gtk4"
import {
  wallpapersConfig, ahoraFranjas, setFranjasDeFondo, crearGrupo, applyWallpaper,
  reevaluar,
} from "../../../data/wallpaperConfig"
import { esApto, franjaActual } from "../../../data/wallpaperSchedule"
import {
  boton, cabeceraVuelta, chip, columna, etiqueta, fila, miniatura, nombreDe,
} from "./comunes"

export function EditorFondo(
  path: string,
  alVolver: () => void,
  alAbrirGrupo: (gid: string) => void,
  alAbrirFranjas: () => void,
): Gtk.Widget {
  const raiz = columna(0, ["rice-editor"])
  const cuerpo = columna(10)

  const reconstruir = () => {
    let hijo = cuerpo.get_first_child()
    while (hijo) { const sig = hijo.get_next_sibling(); cuerpo.remove(hijo); hijo = sig }

    const cfg = wallpapersConfig.get()
    const ahora = ahoraFranjas.get()
    const declaradas = cfg.fondos[path]?.franjas ?? []
    const apto = esApto(cfg, path, ahora)
    const vigente = franjaActual(cfg, ahora)

    cuerpo.append(miniatura(path, 168, 96))

    // ── Aptitud ───────────────────────────────────────────────────────────────
    const cabeceraAptitud = fila(8)
    cabeceraAptitud.append(etiqueta("¿Cuándo puede salir?", ["rice-subtitle"]))
    cabeceraAptitud.append(etiqueta(
      apto ? "Ahora puede salir." : `Ahora no sale (estamos en ${vigente?.nombre ?? "—"}).`,
      ["rice-estado", apto ? "ok" : "dim"]))
    cuerpo.append(cabeceraAptitud)

    if (cfg.franjas.length === 0) {
      cuerpo.append(etiqueta(
        "Todavía no hay franjas horarias, así que este fondo puede salir a " +
        "cualquier hora.", ["rice-help"]))
      cuerpo.append(boton("Configurar franjas", ["rice-btn"], alAbrirFranjas))
    } else {
      cuerpo.append(etiqueta(
        "Sin marcar ninguna, puede salir siempre.", ["rice-help"]))
      const chips = fila(6, ["rice-chips"])
      for (const f of cfg.franjas) {
        // Con la lista vacía el fondo es apto en todas, así que los chips se
        // pintan encendidos: enseñar "ninguna marcada" cuando el fondo sale a
        // todas horas sería mentir sobre el estado real.
        const marcada = declaradas.length === 0 || declaradas.includes(f.id)
        chips.append(chip(f.nombre, marcada, () => {
          const base = declaradas.length === 0 ? cfg.franjas.map(x => x.id) : declaradas
          const siguiente = base.includes(f.id)
            ? base.filter(x => x !== f.id)
            : [...base, f.id]
          setFranjasDeFondo(path, siguiente)
          reevaluar()
          reconstruir()
        }))
      }
      cuerpo.append(chips)
      if (declaradas.length === 0) {
        cuerpo.append(etiqueta("Puede salir a cualquier hora.", ["rice-help", "dim"]))
      }
    }

    // ── Grupo ─────────────────────────────────────────────────────────────────
    cuerpo.append(etiqueta("Variantes", ["rice-subtitle"]))
    cuerpo.append(etiqueta(
      "Convierte este fondo en un grupo para vincularle otras versiones (día, " +
      "tarde, noche…). El sistema lo tratará como un solo fondo e irá cambiando " +
      "de versión según la hora.", ["rice-help"]))

    const acciones = fila(8, ["rice-acciones"])
    acciones.append(boton("Crear grupo con este fondo", ["rice-btn", "primario"], () => {
      alAbrirGrupo(crearGrupo(path))
    }))
    acciones.append(boton("Aplicar ahora", ["rice-btn"], () => applyWallpaper(path)))
    cuerpo.append(acciones)
  }

  raiz.append(cabeceraVuelta(nombreDe(path), alVolver))
  raiz.append(cuerpo)
  reconstruir()
  return raiz
}
