// servicios/camara/dispositivos.ts
//
// Qué cámaras hay, con hotplug. Todo por udev; ni un sondeo.
//
// ── UNA WEBCAM NO ES UN `/dev/videoN`, SON VARIOS ────────────────────────────
// Una UVC corriente registra DOS o TRES nodos: el de vídeo y uno (o dos) de
// METADATOS (`Video Capture Metadata`), que existen desde el kernel 4.16 para
// exponer las cabeceras UVC. Abrir el de metadatos no da imagen — devuelve un
// stream que ninguna app sabe pintar — y `v4l2-ctl --list-ctrls` sobre él
// contesta con la lista VACÍA, sin error. O sea: enumerar `/dev/video*` a pelo
// y quedarse con el primero es una moneda al aire que en la mitad de las
// máquinas deja la sección de ajustes en blanco "sin motivo".
//
// El filtro correcto NO es el nombre (los dos nodos comparten `name` en sysfs)
// sino la propiedad de udev **`ID_V4L_CAPABILITIES`**, que trae `:capture:`
// solo en los nodos que de verdad capturan imagen. La rellena la regla
// `60-persistent-v4l.rules` de systemd llamando a `v4l_id`, así que está en
// cualquier distro con udev y no depende de que tengamos `v4l2-ctl`.
//
// ── POR QUÉ GUdev Y NO Gio.FileMonitor SOBRE /dev ───────────────────────────
// Un monitor de directorio avisaría de que aparece `/dev/video2`, pero llega
// ANTES de que udev haya procesado el dispositivo: en ese instante todavía no
// existen `ID_V4L_CAPABILITIES` ni `ID_V4L_PRODUCT`, así que habría que sondear
// esperando a que aparezcan. La señal `uevent` de GUdev se emite justo DESPUÉS
// de que udev termine, con todas las propiedades ya puestas. Es el mismo
// cliente que ya usa `servicios/pantalla/brightness.ts` para el backlight.
import { createState } from "ags"
import GUdev from "gi://GUdev"

export interface Camara {
  /** Nodo de captura, p.ej. `/dev/video0`. NO es identidad estable: al
   *  reenchufar puede cambiar de número. Sirve para hablar con v4l2-ctl. */
  nodo: string
  /** Identidad ESTABLE entre reinicios y reenchufes. Ver `claveDe()`. */
  clave: string
  /** Nombre presentable ("Integrated Camera", "Logitech C920"). */
  nombre: string
  /** `true` si cuelga del bus USB (o sea, desenchufable). */
  usb: boolean
  /** Ruta sysfs, por si hace falta leer un atributo crudo. */
  sysfs: string
}

// El cliente debe conservar una referencia JS viva: si el GC se lo llevara,
// dejarían de llegar los `uevent` aunque udev siguiera emitiendo. Mismo motivo
// por el que `fuenteArchivoJson.ts` guarda sus monitores en un Set.
let cliente: GUdev.Client | null = null

export const [camaras, setCamaras] = createState<Camara[]>([])
/** Hay al menos una cámara de captura. TODA la UI de cámara cuelga de esto:
 *  el tile de QuickSettings, la sección de Ajustes y el indicador de la barra
 *  se ocultan enteros cuando es falso, que es el caso de cualquier sobremesa
 *  sin webcam enchufada. */
export const [hayCamara, setHayCamara] = createState(false)

/** Identidad estable de una cámara.
 *
 *  NO puede ser `/dev/videoN`: ese número lo reparte el kernel por orden de
 *  aparición, así que reenchufar la webcam o arrancar con un pendrive de vídeo
 *  puesto la renumera, y los ajustes guardados se aplicarían a otro aparato.
 *  Se prefiere el serial cuando el fabricante lo pone (único incluso entre dos
 *  webcams idénticas); si no, vendor:product, que al menos distingue modelos.
 *  Las integradas suelen no tener serial y les basta con eso: hay una. */
function claveDe(d: GUdev.Device): string {
  const serie = d.get_property("ID_SERIAL_SHORT")
  const vendor = d.get_property("ID_VENDOR_ID")
  const producto = d.get_property("ID_MODEL_ID")
  if (serie) return `serial:${serie}`
  if (vendor && producto) return `usb:${vendor}:${producto}`
  // Último recurso: la ruta sysfs sin el número de nodo. Sobrevive a un
  // reinicio en el mismo puerto, que es más de lo que da `/dev/videoN`.
  return `sysfs:${d.get_sysfs_path() ?? d.get_name() ?? "desconocida"}`
}

function nombreDe(d: GUdev.Device): string {
  return (
    d.get_property("ID_V4L_PRODUCT") ||
    d.get_sysfs_attr("name") ||
    d.get_property("ID_MODEL_FROM_DATABASE") ||
    d.get_name() ||
    "Cámara"
  )
}

/** ¿Este nodo captura imagen, o es el de metadatos? Ver la cabecera. */
function esDeCaptura(d: GUdev.Device): boolean {
  const caps = d.get_property("ID_V4L_CAPABILITIES") ?? ""
  // El formato es `:capture:` — con los dos puntos como separador, de modo que
  // buscar la subcadena con ellos evita casar con un hipotético `:nocapture:`.
  if (caps) return caps.includes(":capture:")
  // Sin la propiedad (udev antiguo, o regla desactivada) NO se descarta: se
  // acepta el nodo. Enseñar de más es recuperable desde la UI; enseñar de
  // menos deja al usuario sin cámara y sin explicación.
  return true
}

function enumerar(): Camara[] {
  if (!cliente) return []
  const vistas = new Map<string, Camara>()
  for (const d of cliente.query_by_subsystem("video4linux")) {
    const nodo = d.get_device_file()
    if (!nodo || !esDeCaptura(d)) continue
    const clave = claveDe(d)
    // Una cámara con dos nodos de captura (algunas traen uno MJPEG y otro YUV)
    // se presenta UNA vez: el usuario no distingue dos "Logitech C920" en un
    // desplegable. Gana el de número menor, que es el principal por convenio.
    const previa = vistas.get(clave)
    if (previa && previa.nodo <= nodo) continue
    vistas.set(clave, {
      nodo,
      clave,
      nombre: nombreDe(d),
      usb: (d.get_property("ID_BUS") ?? "") === "usb",
      sysfs: d.get_sysfs_path() ?? "",
    })
  }
  return [...vistas.values()].sort((a, b) => a.nodo.localeCompare(b.nodo))
}

function refrescar() {
  const lista = enumerar()
  setCamaras(lista)
  setHayCamara(lista.length > 0)
}

let iniciado = false

/** Arranca la enumeración y el vigilante de hotplug. Idempotente.
 *  Barato hasta lo ridículo cuando no hay cámara: una consulta a udev al
 *  arrancar y después nada, ni timers ni procesos. */
export function inicializarCamaras() {
  if (iniciado) return
  iniciado = true
  try {
    cliente = new GUdev.Client({ subsystems: ["video4linux"] })
    cliente.connect("uevent", (_c: GUdev.Client, accion: string) => {
      // Solo `add`/`remove` cambian la LISTA. `change` llega además cada vez
      // que se toca un control, y reenumerar ahí publicaría un array nuevo
      // (identidad distinta, contenido idéntico) que haría re-renderizar el
      // desplegable de cámaras a cada arrastre de un slider.
      if (accion !== "add" && accion !== "remove") return
      refrescar()
    })
    refrescar()
  } catch (e) {
    console.error("[camara] udev:", e)
    setCamaras([])
    setHayCamara(false)
  }
}

/** La cámara que corresponde a una clave guardada, o `null` si ya no está. */
export function camaraPorClave(clave: string | null | undefined): Camara | null {
  if (!clave) return null
  return camaras.get().find((c) => c.clave === clave) ?? null
}
