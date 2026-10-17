import { Gdk, Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
  obtenerEntradaEscritorio,
  observarCambiosAplicaciones,
} from "../../../servicios/aplicaciones/entradasEscritorio"
import { crearCacheIconos } from "./cache.ts"

// Solo referencias: no retiene texturas ni añade copias de imágenes en disco.
const cache = crearCacheIconos<Gio.Icon | null>()
const observadores = new Set<() => void>()
let tema: Gtk.IconTheme | null = null
let iniciado = false
let avisoPendiente: number | null = null

function invalidar(): void {
  cache.invalidar()
  if (!observadores.size || avisoPendiente !== null) return
  // Una instalación puede emitir varias señales seguidas; se refresca una vez.
  avisoPendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    avisoPendiente = null
    for (const actualizar of observadores) {
      try { actualizar() } catch (error) {
        console.error("[notif] No se pudo actualizar un icono:", error)
      }
    }
    return GLib.SOURCE_REMOVE
  })
}

function iniciar(): void {
  if (!iniciado) {
    iniciado = true
    observarCambiosAplicaciones(invalidar)
  }
  if (tema) return
  const pantalla = Gdk.Display.get_default()
  if (!pantalla) return
  tema = Gtk.IconTheme.get_for_display(pantalla)
  tema.connect("changed", invalidar)
}

export function observarCambiosIconos(actualizar: () => void): () => void {
  iniciar()
  observadores.add(actualizar)
  return () => {
    observadores.delete(actualizar)
    if (!observadores.size && avisoPendiente !== null) {
      GLib.source_remove(avisoPendiente)
      avisoPendiente = null
    }
  }
}

function archivoUtilizable(icono: Gio.Icon | null): Gio.Icon | null {
  if (!(icono instanceof Gio.FileIcon)) return icono
  const ruta = icono.get_file().get_path()
  return ruta && GLib.file_test(ruta, GLib.FileTest.IS_REGULAR) ? icono : null
}

function resolverReferencia(referencia: string): Gio.Icon | null {
  if (!referencia) return null
  if (referencia.startsWith("/") || referencia.startsWith("file://")) {
    const archivo = referencia.startsWith("file://")
      ? Gio.File.new_for_uri(referencia)
      : Gio.File.new_for_path(referencia)
    // Los avatares y las rutas temporales no entran en la caché. Se comprueban
    // al reutilizarlos, incluidos los que no existían en la consulta anterior.
    return archivoUtilizable(Gio.FileIcon.new(archivo))
  }
  if (!tema) return null
  return cache.obtener(`tema:${referencia}`, () => {
    const minusculas = referencia.toLowerCase()
    const candidatos = [referencia, minusculas, minusculas.replace(/[_\s]/g, "-")]
    const nombre = candidatos.find((candidato) => tema!.has_icon(candidato))
    return nombre ? Gio.ThemedIcon.new(nombre) : null
  })
}

export function resolverIconoNotificacion(iconoApp: string, nombreApp: string): Gio.Icon | null {
  try {
    iniciar()
    const recibido = resolverReferencia(iconoApp)
    if (recibido) return recibido
    const nombrado = resolverReferencia(nombreApp)
    if (nombrado) return nombrado
    if (!nombreApp) return null
    const escritorio = cache.obtener(`app:${nombreApp}`, () => {
      const icono = obtenerEntradaEscritorio({ class: nombreApp })?.icono ?? null
      if (icono instanceof Gio.ThemedIcon) {
        return icono.get_names().some((nombre) => tema?.has_icon(nombre)) ? icono : null
      }
      return icono
    })
    return archivoUtilizable(escritorio)
  } catch (_) {
    return null
  }
}
