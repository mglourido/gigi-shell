// servicios/disco/preferencias.ts — configuración de la autolimpieza.
//
// Se persiste en su PROPIO fichero, `~/.config/gigios/almacenamiento.json`, y no en
// `preferences.json`, por la misma razón que `security.json`: **lo lee un script bash**
// (`hypr/scripts/limpieza-arranque.sh` y `limpiar-almacenamiento.sh`, con `jq`). Un fichero
// compartido con las preferencias del shell obligaría a esos scripts a conocer claves que no les
// incumben, y a este módulo a no pisar las que escribe otro.
//
// A DIFERENCIA de `security.json` —que `oom-monitor.sh` lee UNA vez al arrancar—, aquí no hay nada
// cacheado en ningún proceso: `limpieza-arranque.sh` no es un daemon, así que cada ejecución suya
// parte de leer este fichero. Guardar es toda la sincronización que existe; no hay ningún vigilante
// al que avisar ni que relanzar.
import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { ACCIONES_AUTOMATIZABLES, type IdAccion } from "./catalogo"

const RUTA = `${GLib.get_user_config_dir()}/gigios/almacenamiento.json`
const ARRANQUE = `${GLib.get_user_config_dir()}/hypr/scripts/limpieza-arranque.sh`
const VERSION = 1

/** Retención del journal por defecto. Cabe en cualquier disco y conserva varios días de arranques. */
const RETENCION_DEFECTO = "200M"

export const [autoLimpieza, _setAutoLimpieza] = createState(false)
export const [intervaloHoras, _setIntervaloHoras] = createState(24)
export const [umbralUso, _setUmbralUso] = createState(0)
export const [retenerJournal, _setRetenerJournal] = createState(RETENCION_DEFECTO)
export const [diasPapelera, _setDiasPapelera] = createState(0)
export const [diasDescargas, _setDiasDescargas] = createState(0)
export const [notificarLimpieza, _setNotificarLimpieza] = createState(true)

/**
 * Si «Limpiar descargas antiguas» manda los ficheros a la papelera en vez de borrarlos.
 *
 * **Apagado por defecto, y ese default es el arreglo de un fallo.** Antes la acción usaba
 * `gio trash` siempre, y eso hacía que la cifra mintiera: la papelera vive en el MISMO sistema de
 * ficheros, así que mover 5 GB ahí no libera un solo byte de disco —solo cambia de carpeta— y la
 * sección informaba de «5 GB liberados». Un botón bajo el rótulo «Liberar espacio» que no libera
 * espacio hasta que además vacías la papelera.
 *
 * Con el interruptor encendido el comportamiento vuelve, pero la contabilidad es honesta: la acción
 * informa de 0 liberado y dice cuánto ha movido, y el analizador da `liberable: 0` para esta
 * categoría — el espacio lo liberará «Vaciar papelera», que tiene su propia fila y su propia cifra.
 * Contarlo en las dos sería prometer el mismo hueco dos veces.
 */
export const [descargasAPapelera, _setDescargasAPapelera] = createState(false)

/**
 * Carpetas que el usuario quiere vaciar, tal y como las escribió.
 *
 * **Aquí NO se validan, y es deliberado.** La validación de verdad —resolver symlinks, rechazar
 * `/`, `$HOME`, `~/.config` y el árbol del sistema— vive en `ruta_personalizada_valida`
 * (`hypr/scripts/lib/limpieza-rutas.sh`), porque quien borra es quien tiene que validar: este JSON
 * se puede editar a mano, restaurar de un backup viejo o venir de otro equipo donde esa ruta
 * significaba otra cosa. La UI llama a esa misma función antes de añadir para dar el error al
 * momento, pero eso es cortesía, no la barrera.
 */
export const [rutasPersonalizadas, _setRutasPersonalizadas] = createState<string[]>([])

/**
 * Carpetas y archivos que NINGUNA limpieza puede tocar. La otra mitad de `rutasPersonalizadas`:
 * allí se escribe qué borrar, aquí qué no.
 *
 * Existe porque la lista de exclusiones fija (`CACHE_PRESERVADO`, en `lib/limpieza-rutas.sh`) la
 * decide el repositorio y cada equipo tiene su propia carpeta que técnicamente es caché pero cuesta
 * cara de perder — el perfil de un navegador que guarda la sesión bajo `~/.cache`, la caché de
 * compilación del proyecto de esta semana. Sin esto, salvarla obligaba a desmarcar la acción entera
 * y no limpiar nada.
 *
 * Igual que arriba, aquí NO se validan: el filtro de verdad vive en el script que borra
 * (`ruta_protegida_valida`), porque este JSON se puede editar a mano o venir de otro equipo. Lo
 * único que hace la UI es canonicalizar con `--validar-protegida` antes de guardar, y eso sí es
 * imprescindible: lo que decide si algo se salva es una comparación TEXTUAL de rutas, y `~/x/../x`
 * no casaría con nada.
 */
export const [rutasProtegidas, _setRutasProtegidas] = createState<string[]>([])

/**
 * Contador que sube cada vez que cambia una preferencia que altera CUÁNTO se liberaría.
 *
 * `retenerJournal`, `diasPapelera` y `diasDescargas` no deciden solo cómo se limpia: deciden la
 * cifra. Con la retención en 200M el journal de 100 MiB libera 0, y subiéndola a 50M pasa a
 * liberar 50 MiB; con «Descargas» a 0 días la acción no borra nada y a 30 días borra lo del mes
 * pasado. Esas cifras las calcula `analizar-almacenamiento.sh` leyendo este mismo JSON, así que
 * tocar el campo deja el análisis en caché desfasado — y la estimación se quedaba enseñando el
 * número anterior sin nada que la volviera a disparar, porque la caché sigue siendo "reciente".
 *
 * La sección se suscribe a esto y reanaliza. Es un contador y no un booleano para que dos cambios
 * seguidos emitan dos veces; el consumidor agrupa.
 */
export const [revisionLimpieza, _setRevisionLimpieza] = createState(0)

function invalidarEstimacion(): void {
  _setRevisionLimpieza(revisionLimpieza.get() + 1)
}

// Una sola fuente para las casillas: cada acción automatizable tiene su estado. Todas nacen
// APAGADAS. Es lo contrario del criterio de `security.json` (todo ON) y es deliberado: allí los
// defaults solo deciden si algo se vigila, aquí deciden si algo se borra sin preguntar.
const acciones = {} as Record<IdAccion, ReturnType<typeof createState<boolean>>>
for (const id of ACCIONES_AUTOMATIZABLES) acciones[id] = createState(false)

export function accionAutomatica(id: IdAccion) {
  return acciones[id][0]
}

/** Las acciones marcadas ahora mismo. Es lo que usa la estimación de espacio liberable. */
export function accionesActivas(): IdAccion[] {
  return ACCIONES_AUTOMATIZABLES.filter(id => acciones[id][0].get())
}

function cargar(): void {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA)
    if (!ok) return
    const guardado = JSON.parse(new TextDecoder().decode(contenido))
    if (typeof guardado.auto === "boolean") _setAutoLimpieza(guardado.auto)
    if (Number.isFinite(guardado.intervaloHoras) && guardado.intervaloHoras > 0) _setIntervaloHoras(guardado.intervaloHoras)
    if (Number.isFinite(guardado.umbralUso) && guardado.umbralUso >= 0 && guardado.umbralUso <= 100) _setUmbralUso(guardado.umbralUso)
    if (typeof guardado.retenerJournal === "string" && /^\d+[KMG]$/.test(guardado.retenerJournal)) _setRetenerJournal(guardado.retenerJournal)
    if (Number.isFinite(guardado.diasPapelera) && guardado.diasPapelera >= 0) _setDiasPapelera(guardado.diasPapelera)
    if (Number.isFinite(guardado.diasDescargas) && guardado.diasDescargas >= 0) _setDiasDescargas(guardado.diasDescargas)
    if (typeof guardado.notificar === "boolean") _setNotificarLimpieza(guardado.notificar)
    if (typeof guardado.descargasAPapelera === "boolean") _setDescargasAPapelera(guardado.descargasAPapelera)
    if (Array.isArray(guardado.rutasPersonalizadas)) {
      _setRutasPersonalizadas(guardado.rutasPersonalizadas.filter((r: unknown): r is string =>
        typeof r === "string" && r.length > 0))
    }
    if (Array.isArray(guardado.rutasProtegidas)) {
      _setRutasProtegidas(guardado.rutasProtegidas.filter((r: unknown): r is string =>
        typeof r === "string" && r.length > 0))
    }
    const marcadas = guardado.acciones
    if (marcadas && typeof marcadas === "object") {
      for (const id of ACCIONES_AUTOMATIZABLES) {
        if (typeof marcadas[id] === "boolean") acciones[id][1](marcadas[id])
      }
    }
  } catch (_) {
    /* ausente o corrupto → defaults, o sea autolimpieza apagada */
  }
}

function guardar(): void {
  try {
    const dir = GLib.path_get_dirname(RUTA)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    const marcadas: Record<string, boolean> = {}
    for (const id of ACCIONES_AUTOMATIZABLES) marcadas[id] = acciones[id][0].get()
    GLib.file_set_contents(RUTA, JSON.stringify({
      version: VERSION,
      auto: autoLimpieza.get(),
      intervaloHoras: intervaloHoras.get(),
      umbralUso: umbralUso.get(),
      retenerJournal: retenerJournal.get(),
      diasPapelera: diasPapelera.get(),
      diasDescargas: diasDescargas.get(),
      notificar: notificarLimpieza.get(),
      descargasAPapelera: descargasAPapelera.get(),
      rutasPersonalizadas: rutasPersonalizadas.get(),
      rutasProtegidas: rutasProtegidas.get(),
      acciones: marcadas,
    }, null, 2))
  } catch (_) {
    /* un fallo de escritura no debe romper la UI */
  }
}

/**
 * NO hay nada que arrancar ni que matar al tocar el interruptor, y eso es la consecuencia visible
 * de que la autolimpieza dejara de ser un daemon.
 *
 * Antes esto hacía `pkill -f limpieza-monitor.sh` + relanzar, como los interruptores de
 * `screencast-monitor` y `updates-monitor`, porque había un bucle durmiendo una hora entre pasadas.
 * Hoy `limpieza-arranque.sh` corre una vez al iniciar sesión, lee el JSON y se muere: apagar la
 * opción es simplemente escribir `auto: false`, que es lo que leerá el siguiente arranque. Guardar
 * es toda la sincronización que hace falta.
 */
export function setAutoLimpieza(valor: boolean): void {
  _setAutoLimpieza(valor)
  guardar()
}

export function setAccionAutomatica(id: IdAccion, valor: boolean): void {
  acciones[id][1](valor)
  guardar()
}

export function setIntervaloHoras(valor: number): void {
  if (!Number.isFinite(valor) || valor <= 0) return
  _setIntervaloHoras(Math.round(valor))
  guardar()
}

export function setUmbralUso(valor: number): void {
  if (!Number.isFinite(valor) || valor < 0 || valor > 100) return
  _setUmbralUso(Math.round(valor))
  guardar()
}

/** Solo acepta el formato de systemd; el helper root lo vuelve a validar por su cuenta. */
export function setRetenerJournal(valor: string): void {
  const limpio = valor.trim().toUpperCase()
  if (!/^\d+[KMG]$/.test(limpio)) return
  _setRetenerJournal(limpio)
  guardar()
  invalidarEstimacion()
}

export function setDiasPapelera(valor: number): void {
  if (!Number.isFinite(valor) || valor < 0) return
  _setDiasPapelera(Math.round(valor))
  guardar()
  invalidarEstimacion()
}

export function setDiasDescargas(valor: number): void {
  if (!Number.isFinite(valor) || valor < 0) return
  _setDiasDescargas(Math.round(valor))
  guardar()
  invalidarEstimacion()
}

export function setNotificarLimpieza(valor: boolean): void {
  _setNotificarLimpieza(valor)
  guardar()
}

/**
 * Cambia CUÁNTO libera «Limpiar descargas antiguas» —a la papelera no libera nada, solo mueve—,
 * así que invalida la estimación igual que los días y la retención.
 */
export function setDescargasAPapelera(valor: boolean): void {
  _setDescargasAPapelera(valor)
  guardar()
  invalidarEstimacion()
}

/**
 * Añade una carpeta a la lista. Devuelve `false` si ya estaba — duplicarla no rompe nada (el
 * borrado es idempotente) pero deja dos filas idénticas que el usuario no sabe distinguir.
 */
export function anadirRutaPersonalizada(ruta: string): boolean {
  const limpia = ruta.trim()
  if (!limpia || rutasPersonalizadas.get().includes(limpia)) return false
  _setRutasPersonalizadas([...rutasPersonalizadas.get(), limpia])
  guardar()
  invalidarEstimacion()
  return true
}

export function quitarRutaPersonalizada(ruta: string): void {
  _setRutasPersonalizadas(rutasPersonalizadas.get().filter(r => r !== ruta))
  guardar()
  invalidarEstimacion()
}

/**
 * Protege una ruta. Invalida la estimación como las de borrar, y por el motivo simétrico: proteger
 * RESTA de lo liberable —el analizador descuenta lo protegido de cada categoría—, así que la cifra
 * que enseña la sección deja de valer en cuanto se toca esta lista.
 */
export function anadirRutaProtegida(ruta: string): boolean {
  const limpia = ruta.trim()
  if (!limpia || rutasProtegidas.get().includes(limpia)) return false
  _setRutasProtegidas([...rutasProtegidas.get(), limpia])
  // Proteger algo que también estaba en la lista de «borrar esto» es una contradicción, y la gana
  // la protección: el filtro del script no la borraría nunca. Quitarla de la otra lista es lo que
  // evita dejar una fila que promete un borrado que no va a ocurrir. Se hace aquí y no solo en el
  // script porque es lo único que el usuario VE.
  const enConflicto = rutasPersonalizadas.get().filter(r => r === limpia || r.startsWith(`${limpia}/`))
  if (enConflicto.length > 0) {
    _setRutasPersonalizadas(rutasPersonalizadas.get().filter(r => !enConflicto.includes(r)))
  }
  guardar()
  invalidarEstimacion()
  return true
}

export function quitarRutaProtegida(ruta: string): void {
  _setRutasProtegidas(rutasProtegidas.get().filter(r => r !== ruta))
  guardar()
  invalidarEstimacion()
}

/**
 * Limpia ya, saltándose intervalo y umbral. Es lo que cubre el caso que perdió la sesión al dejar
 * de haber comprobación periódica: un equipo encendido varios días sin volver a iniciar sesión.
 */
export function limpiarAhora(): Promise<string> {
  return execAsync([ARRANQUE, "--ahora"])
}

cargar()
