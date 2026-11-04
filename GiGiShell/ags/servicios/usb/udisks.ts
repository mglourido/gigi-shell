// servicios/usb/udisks.ts — los USB de almacenamiento conectados, leídos de UDisks2 por D-Bus.
//
// **Por qué UDisks2 y no `usb-monitor.sh`.** El monitor bash (`udevadm monitor`) solo ve enchufes
// y tirones; no sabe qué hay montado ni dónde. udisksd ya corre como servicio del sistema, lleva
// esa cuenta él solo y la publica por D-Bus con señales, así que escucharle no añade ni un proceso
// ni un temporizador. El monitor sigue siendo quien NOTIFICA (tiene que funcionar con AGS caído);
// esto solo pinta el icono de la barra y su menú. Las acciones reutilizan los mismos
// `usb-*.sh` que los botones de las notificaciones (`acciones.ts`).
//
// **Un solo `DBusObjectManagerClient` para todo el shell.** Es un singleton de módulo: el icono
// se instancia una vez por monitor y todos leen `dispositivosUsb`. Arranca al importarse el
// módulo (o sea, cuando la barra monta el indicador) y vive lo que vive el shell.
//
// **Las señales se agrupan en un `idle`.** Enchufar un pendrive son varios `object-added`
// (unidad, disco, particiones) y un montaje cambia propiedades de varios objetos seguidos; cada
// uno pedía rehacer la lista. El idle la rehace UNA vez cuando el bucle se queda libre, y
// `mismosDispositivos` evita republicar si el resultado no cambia (cambios de propiedades de los
// discos internos, que también llegan por este gestor).
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "ags"

import {
  construirDispositivosUsb,
  mismosDispositivos,
  uuidValido,
  type BloqueUdisks,
  type DispositivoUsb,
  type EspacioVolumen,
  type UnidadUdisks,
} from "./modelo.ts"

const NOMBRE_BUS = "org.freedesktop.UDisks2"
const IFAZ_UNIDAD = "org.freedesktop.UDisks2.Drive"
const IFAZ_BLOQUE = "org.freedesktop.UDisks2.Block"
const IFAZ_PARTICION = "org.freedesktop.UDisks2.Partition"
const IFAZ_FS = "org.freedesktop.UDisks2.Filesystem"
/** Interfaces cuyas propiedades cambian lo que se enseña; el resto (SMART, Ata…) se ignora. */
const INTERFACES_RELEVANTES = new Set([IFAZ_UNIDAD, IFAZ_BLOQUE, IFAZ_FS])

/**
 * Marcas de «volumen sucio sin reparar», una por UUID, que dejan `usb-monitor.sh` y
 * `usb-repair.sh` (`hypr/scripts/lib/usb-sucios.sh`). udisks no publica ese estado: saberlo
 * exige un fsck, y el que lo hace es el monitor al enchufar. Se mira solo al rehacer el menú.
 */
const DIR_SUCIOS = GLib.build_filenamev([GLib.get_user_runtime_dir(), "gigishell-usb-sucios"])

const [dispositivosUsb, fijarDispositivos] = createState<DispositivoUsb[]>([])
export { dispositivosUsb }

let gestor: Gio.DBusObjectManagerClient | null = null
let idlePendiente = 0

const cadena = (p: Gio.DBusProxy, k: string) => {
  const v = p.get_cached_property(k)
  return v ? String(v.unpack()) : ""
}
const booleano = (p: Gio.DBusProxy, k: string) => Boolean(p.get_cached_property(k)?.unpack())
const numero = (p: Gio.DBusProxy, k: string) => Number(p.get_cached_property(k)?.unpack() ?? 0)
// En GJS `get_bytestring()` devuelve un `Uint8Array`, no una cadena (a diferencia de
// `get_bytestring_array()`, que sí da cadenas). Sin decodificar, la ruta del dispositivo llegaba
// como bytes y `GLib.Variant.new_string` lanzaba al construir el menú, que salía vacío.
const decodificador = new TextDecoder()
const bytes = (p: Gio.DBusProxy, k: string) => {
  const crudo = p.get_cached_property(k)?.get_bytestring()
  return crudo ? decodificador.decode(crudo).replace(/\0+$/, "") : ""
}

function leerObjetos(m: Gio.DBusObjectManagerClient) {
  const unidades: UnidadUdisks[] = []
  const bloques: BloqueUdisks[] = []
  for (const objeto of m.get_objects()) {
    const ruta = objeto.get_object_path()
    const unidad = objeto.get_interface(IFAZ_UNIDAD) as Gio.DBusProxy | null
    if (unidad) {
      unidades.push({
        ruta,
        bus: cadena(unidad, "ConnectionBus"),
        medio: booleano(unidad, "MediaAvailable"),
        fabricante: cadena(unidad, "Vendor"),
        modelo: cadena(unidad, "Model"),
      })
      continue
    }
    const bloque = objeto.get_interface(IFAZ_BLOQUE) as Gio.DBusProxy | null
    if (!bloque) continue
    const fs = objeto.get_interface(IFAZ_FS) as Gio.DBusProxy | null
    bloques.push({
      ruta,
      unidad: cadena(bloque, "Drive"),
      dispositivo: bytes(bloque, "PreferredDevice") || bytes(bloque, "Device"),
      uso: cadena(bloque, "IdUsage"),
      tipo: cadena(bloque, "IdType"),
      etiqueta: cadena(bloque, "IdLabel"),
      uuid: cadena(bloque, "IdUUID"),
      tamano: numero(bloque, "Size"),
      ignorar: booleano(bloque, "HintIgnore"),
      particion: objeto.get_interface(IFAZ_PARTICION) !== null,
      montajes: fs ? (fs.get_cached_property("MountPoints")?.get_bytestring_array() ?? []) : null,
    })
  }
  return { unidades, bloques }
}

function recalcular() {
  if (!gestor) return
  try {
    const { unidades, bloques } = leerObjetos(gestor)
    const siguiente = construirDispositivosUsb(unidades, bloques)
    if (!mismosDispositivos(siguiente, dispositivosUsb.get())) fijarDispositivos(siguiente)
  } catch (e) {
    console.error("[usb] no se pudo leer UDisks2:", e)
  }
}

function programar() {
  if (idlePendiente) return
  idlePendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    idlePendiente = 0
    recalcular()
    return GLib.SOURCE_REMOVE
  })
}

function conectar() {
  try {
    Gio.DBusObjectManagerClient.new_for_bus(
      Gio.BusType.SYSTEM,
      Gio.DBusObjectManagerClientFlags.NONE,
      NOMBRE_BUS,
      "/org/freedesktop/UDisks2",
      null,
      null,
      (_o, res) => {
        try {
          gestor = Gio.DBusObjectManagerClient.new_for_bus_finish(res)
        } catch (e) {
          // Sin udisks2 no hay icono, pero el shell sigue: el monitor bash ya avisa de lo suyo.
          console.error("[usb] UDisks2 no disponible:", e)
          return
        }
        for (const senal of ["object-added", "object-removed", "interface-added", "interface-removed"]) {
          gestor.connect(senal, programar)
        }
        gestor.connect("interface-proxy-properties-changed", (_g, _obj, ifaz: Gio.DBusProxy) => {
          if (INTERFACES_RELEVANTES.has(ifaz.get_interface_name())) programar()
        })
        // udisksd reiniciado: los objetos se vacían y vuelven a llegar por `object-added`.
        gestor.connect("notify::name-owner", programar)
        recalcular()
      },
    )
  } catch (e) {
    console.error("[usb] no se pudo conectar con UDisks2:", e)
  }
}

conectar()

/** Espacio libre y total de un montaje (statvfs), sin bloquear el hilo de la interfaz. */
export function consultarEspacio(montaje: string): Promise<EspacioVolumen | null> {
  return new Promise((resolver) => {
    try {
      Gio.File.new_for_path(montaje).query_filesystem_info_async(
        "filesystem::free,filesystem::size",
        GLib.PRIORITY_DEFAULT,
        null,
        (f, res) => {
          try {
            const info = f!.query_filesystem_info_finish(res)
            resolver({
              libre: Number(info.get_attribute_uint64("filesystem::free")),
              total: Number(info.get_attribute_uint64("filesystem::size")),
            })
          } catch {
            resolver(null)
          }
        },
      )
    } catch {
      resolver(null)
    }
  })
}

/** Cierto si el monitor encontró el volumen sucio y nadie lo ha reparado después. */
export function volumenSucio(uuid: string): boolean {
  if (!uuidValido(uuid)) return false
  return GLib.file_test(GLib.build_filenamev([DIR_SUCIOS, uuid]), GLib.FileTest.EXISTS)
}
