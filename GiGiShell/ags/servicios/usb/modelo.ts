// servicios/usb/modelo.ts — qué USB de almacenamiento hay y cómo se nombran. Puro, sin GTK ni
// D-Bus: `udisks.ts` le pasa los objetos de UDisks2 ya leídos como datos planos, y esto decide
// qué se enseña. Vive aparte para poder probarlo (`modelo.test.ts`) sin un udisksd delante.
import { formatearBytes } from "../disco/formato.ts"

/** Lo que interesa de un `org.freedesktop.UDisks2.Drive`. */
export interface UnidadUdisks {
  ruta: string
  /** `ConnectionBus`: "usb" para pendrives y discos externos; vacío en los internos. */
  bus: string
  /** `MediaAvailable`: un lector de tarjetas vacío es una unidad sin medio. */
  medio: boolean
  fabricante: string
  modelo: string
}

/** Lo que interesa de un `org.freedesktop.UDisks2.Block` (+ `Filesystem` si lo tiene). */
export interface BloqueUdisks {
  ruta: string
  /** Ruta del `Drive` del que cuelga; "/" si no cuelga de ninguno (zram, loop). */
  unidad: string
  /** `PreferredDevice`, p. ej. "/dev/sdb1". */
  dispositivo: string
  /** `IdUsage`: solo "filesystem" se puede montar y abrir. */
  uso: string
  tipo: string
  etiqueta: string
  uuid: string
  tamano: number
  /** `HintIgnore`: udisks pide no enseñarlo (ESP, recuperación…). */
  ignorar: boolean
  /** Tiene interfaz `Partition`; el disco entero no la tiene. */
  particion: boolean
  /** `Filesystem.MountPoints`; `null` si el bloque no tiene interfaz `Filesystem`. */
  montajes: string[] | null
}

export interface VolumenUsb {
  dispositivo: string
  etiqueta: string
  tipo: string
  uuid: string
  tamano: number
  /** Primer punto de montaje, o `null` si no está montado. */
  montaje: string | null
}

export interface DispositivoUsb {
  /** Ruta D-Bus de la unidad: identidad estable mientras siga enchufada. */
  id: string
  nombre: string
  /** Nombre del disco entero ("sdb"): lo que reciben `usb-open.sh` y `usb-eject.sh`. */
  disco: string
  volumenes: VolumenUsb[]
}

export interface EspacioVolumen {
  libre: number
  total: number
}

const nombreBase = (ruta: string) => ruta.slice(ruta.lastIndexOf("/") + 1)

/**
 * Las unidades USB con medio y sus volúmenes montables, ordenadas por disco. Una unidad cuyo
 * disco entero no aparece (llega antes el `Drive` que su `Block`) se omite hasta que llegue: sin
 * disco no hay a quién expulsar.
 */
export function construirDispositivosUsb(
  unidades: UnidadUdisks[],
  bloques: BloqueUdisks[],
): DispositivoUsb[] {
  const resultado: DispositivoUsb[] = []
  for (const unidad of unidades) {
    if (unidad.bus !== "usb" || !unidad.medio) continue
    const suyos = bloques.filter((b) => b.unidad === unidad.ruta)
    const disco = suyos.find((b) => !b.particion)
    if (!disco) continue

    const volumenes = suyos
      .filter((b) => b.uso === "filesystem" && !b.ignorar && b.montajes !== null)
      .map((b) => ({
        dispositivo: b.dispositivo,
        etiqueta: b.etiqueta,
        tipo: b.tipo,
        uuid: b.uuid,
        tamano: b.tamano,
        montaje: b.montajes?.[0] ?? null,
      }))
      .sort((a, b) => a.dispositivo.localeCompare(b.dispositivo, undefined, { numeric: true }))

    const nombre = `${unidad.fabricante} ${unidad.modelo}`.trim()
      || volumenes.find((v) => v.etiqueta)?.etiqueta
      || nombreBase(disco.dispositivo)

    resultado.push({ id: unidad.ruta, nombre, disco: nombreBase(disco.dispositivo), volumenes })
  }
  return resultado.sort((a, b) => a.disco.localeCompare(b.disco, undefined, { numeric: true }))
}

/** Igualdad estructural: publicar una lista idéntica despertaría a todas las barras para nada. */
export function mismosDispositivos(a: DispositivoUsb[], b: DispositivoUsb[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Línea informativa de un volumen en el menú: «MIUSB · 12,3 GiB libres de 28,9 GiB». Sin
 * etiqueta y con un solo volumen no hace falta nombrarlo (el encabezado ya dice qué es); con
 * varios, el dispositivo los distingue.
 */
export function textoVolumen(
  volumen: VolumenUsb,
  espacio: EspacioVolumen | null | undefined,
  varios: boolean,
): string {
  const nombre = volumen.etiqueta || (varios ? nombreBase(volumen.dispositivo) : "")
  let detalle: string
  if (!volumen.montaje) detalle = `Sin montar · ${formatearBytes(volumen.tamano)}`
  else if (espacio) detalle = `${formatearBytes(espacio.libre)} libres de ${formatearBytes(espacio.total)}`
  else detalle = formatearBytes(volumen.tamano)
  return nombre ? `${nombre} · ${detalle}` : detalle
}

/** Título de la barra: el nombre si es uno; el número si son varios. */
export function tituloUsb(dispositivos: DispositivoUsb[]): string {
  if (dispositivos.length === 0) return ""
  if (dispositivos.length === 1) return dispositivos[0].nombre
  return `${dispositivos.length} dispositivos USB`
}

/**
 * Solo un UUID con forma de UUID puede ser nombre de fichero en el directorio de marcas:
 * viene del propio pendrive y no puede servir para salir de la carpeta.
 */
export function uuidValido(uuid: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(uuid)
}
