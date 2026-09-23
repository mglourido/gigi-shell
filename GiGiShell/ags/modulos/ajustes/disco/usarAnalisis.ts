// modulos/ajustes/disco/usarAnalisis.ts — el análisis de disco, UNO para todas las vistas vivas.
//
// ── Por qué no vive dentro de la vista, que es donde estaba ──────────────────
// `SettingsPanel` se instancia UNA VEZ POR MONITOR (`app.ts`: `app.get_monitors().map(...)`) y
// `settingsPanelVisible` es global, así que abrir Ajustes > Almacenamiento construye la sección en
// todas las pantallas a la vez. Con el estado dentro de la vista, cada instancia leía la caché,
// se suscribía a `revisionLimpieza` y lanzaba SU PROPIO `analizar-almacenamiento.sh todo`: en un
// equipo de dos pantallas eran dos recorridos completos del sistema de ficheros —unos quince `du`
// cada uno— compitiendo por el mismo disco para medir exactamente lo mismo, más dos escrituras de
// la caché pisándose. En el equipo donde se escribió esto solo hay un monitor, así que el fallo
// estaba latente: aparecía el día que se conecta la segunda pantalla, y sin error visible, solo
// como "Ajustes tarda más en abrir".
//
// Con el estado aquí arriba, la N-ésima vista se engancha a lo que ya hay: `enVuelo` deduplica el
// sondeo y la suscripción a `revisionLimpieza` es una sola.
//
// ── Y por qué SIGUE sin memoizarse el resultado ─────────────────────────────
// Al soltar la última referencia se descarta el análisis (`ANALISIS_VACIO`), igual que antes hacía
// el desmontaje: el catálogo son ~1600 aplicaciones con su descripción —el JSON en disco pesa
// ~260 KB— y retenerlo el resto de la sesión por si vuelves a abrir Ajustes no compra nada, porque
// el siguiente montaje lo relee de `~/.cache/gigios/almacenamiento.json` en ~1 ms. Lo que se
// comparte es el sondeo entre vistas SIMULTÁNEAS, no el resultado a lo largo de la sesión.
//
// El contador es de referencias y no un booleano por el orden de `<With>` al navegar entre
// «Almacenamiento» y «Liberar espacio»: si construye la vista nueva antes de tirar la vieja, el
// contador pasa por 2 y no hay que rearmar nada; si la tira antes, pasa por 0 y lo único que
// cuesta es releer la caché — nunca un reanálisis, porque el `epoch` viene con ella.
import { createState, onCleanup, type Accessor } from "ags"
import { analisisCaducado } from "../../../servicios/disco/catalogo"
import { revisionLimpieza } from "../../../servicios/disco/preferencias"
import { ANALISIS_VACIO, analizar, leerCache, type Analisis } from "../../../servicios/disco/analisis"
import { revisarDiscos } from "../../../servicios/disco/alerta"

const [analisis, setAnalisis] = createState<Analisis>(ANALISIS_VACIO)
const [analizando, setAnalizando] = createState(false)

/** Vistas montadas ahora mismo. A 0 se suelta todo. */
let referencias = 0
/** Baja de `revisionLimpieza`. Una sola, la comparten todas las vistas. */
let cancelarRevision: (() => void) | null = null
/** El sondeo en curso, o `null`. Es lo que impide que dos monitores lancen dos scripts. */
let enVuelo: Promise<void> | null = null
/** Si `analisis` refleja algo (caché o sondeo) o es el vacío de arranque. */
let cargado = false

/**
 * Marca de "lo medido ya no vale" para cuando NO hay ninguna vista mirando. La pone
 * `caducarAnalisis` y la consume el siguiente montaje.
 */
let invalidado = false

/** Alguien pidió reanalizar mientras había un sondeo en vuelo. Se sirve al terminar ese. */
let pendiente = false

/**
 * Lanza el análisis, salvo que ya haya uno corriendo: el segundo llamante se engancha al primero
 * y recibe el mismo resultado por el accessor compartido. Sin esta guarda, dos monitores montando
 * a la vez —o el botón «Volver a analizar» pulsado durante un sondeo— forkeaban un script de más.
 *
 * ── Engancharse NO es lo mismo que descartar ────────────────────────────────
 * Dedupar a secas (`if (enVuelo) return`) es correcto para dos vistas que quieren LO MISMO, pero
 * pierde lo que llega por `revisionLimpieza`: si cambias los días de Descargas mientras corre un
 * sondeo, ese sondeo está midiendo con la configuración ANTERIOR y su resultado es justo el número
 * viejo que el contador existe para tirar. La petición se recuerda y se sirve con UNA repetición
 * al terminar — sin ella vuelve el «escribo 30 días y la cifra no se mueve», solo que ahora
 * dependiendo de si acertabas a escribir durante el análisis o después.
 *
 * Una sola repetición, no una por petición: una ráfaga de cambios seguidos colapsa en «el que
 * corre + uno más», y ese último ya mide el estado final.
 */
export function refrescar(): void {
  if (enVuelo) { pendiente = true; return }
  pendiente = false
  setAnalizando(true)
  enVuelo = analizar()
    .then(nuevo => {
      // El aviso de "disco casi lleno" se decide AQUÍ y no dentro de `analizar()`: medir no debe
      // notificar (ver la cabecera de `servicios/disco/alerta.ts`). Va ANTES del `if`, y a
      // propósito: la medida es igual de válida con Ajustes cerrado —una limpieza larga puede
      // terminar después— y llenar el disco es justo lo que hay que contar aunque ya no haya nadie
      // mirando la sección. Es lo que convierte el `df` que esta sección ya pagaba en la vigilancia
      // de toda la sesión que antes solo existía al iniciarla (`hypr/scripts/disk-monitor.sh`):
      // sin proceso residente, sin temporizador y sin un solo fork de más.
      revisarDiscos(nuevo.discos)
      // Con Ajustes ya cerrado el resultado se tira: `analizar` YA lo dejó en la caché de disco,
      // así que no se pierde nada y no se retiene el catálogo entero sin nadie que lo mire.
      if (referencias > 0) {
        setAnalisis(nuevo)
        cargado = true
      }
    })
    .catch(() => { /* el análisis anterior sigue siendo lo mejor que tenemos */ })
    .finally(() => {
      enVuelo = null
      setAnalizando(false)
      // Solo si queda alguien mirando: con Ajustes ya cerrado la repetición mediría para nadie.
      if (pendiente && referencias > 0) refrescar()
      else pendiente = false
    })
}

/**
 * Declara que lo medido ya no vale — lo llama `usarLimpiezas` cuando una limpieza termina bien.
 *
 * Con la sección abierta es un reanálisis inmediato. Con Ajustes ya cerrado —una limpieza de
 * varios segundos puede terminar después— NO se reanaliza, que sería medir para nadie: se anota y
 * el próximo montaje rehace la medida. Sin esa nota, la caché seguía siendo "reciente" (la ventana
 * de frescura son diez minutos) y volver a abrir Ajustes tras liberar 20 GB enseñaba las cifras de
 * ANTES de la limpieza, que es justo la clase de mentira que esta sección no se puede permitir.
 */
export function caducarAnalisis(): void {
  if (referencias > 0) { refrescar(); return }
  invalidado = true
}

function retener(): void {
  referencias++
  // La suscripción se arma con la PRIMERA vista, no con cada una: cambiar la retención del journal
  // o los días de papelera cambia CUÁNTO libera cada limpieza, y el análisis en caché se queda
  // desfasado sin nada que lo vuelva a disparar (ver el comentario de `revisionLimpieza`). Con una
  // suscripción por vista, un solo cambio de campo lanzaba N refrescos — hoy `enVuelo` los
  // colapsaría igual, pero mantener N bajas vivas para eso es trabajo que no hace falta.
  if (referencias === 1) cancelarRevision = revisionLimpieza.subscribe(refrescar)

  if (!cargado) {
    const cacheado = leerCache()
    if (cacheado) {
      setAnalisis(cacheado)
      cargado = true
    }
  }

  // Una vista que se monta mientras otra ya está sondeando tiene que enseñar el spinner, no una
  // sección aparentemente quieta.
  setAnalizando(enVuelo !== null)

  // Al montar NO se reanaliza si la medida es reciente. Antes se lanzaba siempre, así que abrir
  // Ajustes y pasar de «Almacenamiento» a «Liberar espacio» costaba dos análisis completos
  // (~0,6 s de reloj y ~0,7 s de CPU cada uno) para volver a medir lo mismo. `refrescar` sigue
  // disponible sin condiciones para el botón y para el «después de limpiar».
  if (invalidado || analisisCaducado(analisis.get().epoch, Math.floor(Date.now() / 1000))) {
    invalidado = false
    refrescar()
  }
}

function soltar(): void {
  referencias = Math.max(0, referencias - 1)
  if (referencias > 0) return

  cancelarRevision?.()
  cancelarRevision = null

  // El vaciado se aplaza al siguiente tick, y no es cosmético: `soltar` corre DENTRO del
  // desmontaje de la vista, con su `<With value={analisis}>` aún suscrito. Escribir el estado ahí
  // mismo haría que un árbol de widgets que se está destruyendo reconstruyera su contenido (con
  // `epoch: 0`, o sea el spinner de «Analizando…») a medio disponer. La versión anterior nunca se
  // topó con esto porque el estado moría con la vista en vez de sobrevivirle.
  //
  // De paso arregla el otro orden posible: si `<With>` tira la vista vieja ANTES de construir la
  // nueva al navegar entre «Almacenamiento» y «Liberar espacio», para cuando corra esto ya hay
  // referencias otra vez y el análisis se conserva tal cual, sin releer siquiera la caché.
  Promise.resolve().then(() => {
    if (referencias > 0) return
    setAnalisis(ANALISIS_VACIO)
    cargado = false
    // El sondeo en vuelo NO se cancela: ya está pagado y su resultado va a la caché de disco, que
    // es justo lo que hará rápida la próxima apertura. Lo que se apaga es el spinner, porque no
    // hay ninguna vista que lo esté enseñando.
    setAnalizando(false)
  })
}

/**
 * Devuelve el análisis compartido y lo retiene mientras la vista esté montada.
 *
 * Llamarlo desde el cuerpo de un componente: usa `onCleanup`, así que fuera de un scope de
 * componente la referencia no se soltaría nunca.
 */
export function usarAnalisis(): [Accessor<Analisis>, Accessor<boolean>, () => void] {
  retener()
  onCleanup(soltar)
  return [analisis, analizando, refrescar]
}
