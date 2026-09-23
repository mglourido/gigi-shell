// servicios/energia/gamingState.ts
//
// Puente del estado "jugando" hacia DISCO, para que scripts de shell (bash)
// puedan leerlo. El registro compartido de servicios/juegos ya alimenta el indicador,
// auto-DND y este puente; aquí solo se persiste el estado para el lado Bash.
// y escribe ~/.config/gigios/runtime-state.json = { "gaming": bool } cuando
// cambia. hypr/scripts/oom-monitor.sh lo lee para pausar el escaneo de descargas
// mientras juegas.
//
// Mismo patrón dirigido por eventos que IndicadorJuegos (client-added/removed + evento
// "fullscreen", sin polling). Se arranca una vez desde app.ts vía
// initGamingState() (igual que initAutoDnd()).

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "ags"
import { backgroundJobsSuspended } from "./powerState.ts"
import {
  clienteJuegoEnFoco,
  clientesJuego,
  iniciarRegistroJuegos,
} from "../juegos/registro"
import { escanerJuegos } from "../../modulos/ajustes/preferences"

const STATE_PATH = `${GLib.get_user_config_dir()}/gigios/runtime-state.json`

// Estado reactivo compartido por si algún widget lo quiere consumir en el futuro.
export const [isGaming, _setGaming] = createState(false)

let started = false

// ¿Hay una ventana-juego con el foco AHORA?, y epoch (s) del último instante en que
// la hubo. Ver el comentario de writeFlag() para el porqué.
let gameFocused = false
let lastGameFocus = 0

// Mismo gesto que la lectura de PID en `mantenerDespierto.ts`. Un 0 (no se pudo obtener)
// no rompe nada: el lado bash no encontrará /proc/0 y hará fail-open, o sea que la
// congelación deja de aplicarse — que es el modo de fallo que queremos.
function getPid(): number {
  try {
    return new Gio.Credentials().get_unix_pid()
  } catch (e) {
    console.error("[gamingState] no se pudo obtener el pid:", e)
    return 0
  }
}

// Se escribe TAMBIÉN el pid de AGS, y no es informativo: es una guarda.
//
// Mientras el flag solo pausaba el escáner de descargas (una pausa opcional y
// apagada por defecto), que se quedara pegado en `true` daba casi igual. Ahora
// además CONGELA updates-monitor y los sondeos de SMART y de unidades
// (hypr/scripts/lib/gaming-gate.sh), así que si AGS muere con un juego abierto el
// fichero se quedaría diciendo "jugando" para siempre y esos monitores no volverían
// a correr en toda la sesión — en silencio, y sin UI donde notarlo. Con el pid, el
// lado bash comprueba /proc/<pid> y, al no encontrarlo, hace su trabajo igual.
//
// Es la mitad de la cadena; la otra es que initGamingState() reescribe el fichero al
// arrancar el shell, y hace falta porque los pid se RECICLAN: tras un reinicio el del
// AGS anterior puede estar ocupado por otro proceso vivo. Mismo patrón que
// wakeup.json (ver mantenerDespierto.ts y CLAUDE.md).
// `gameFocused` + `lastGameFocus` existen para un caso que `gaming` a secas no sabe
// distinguir: un juego ABIERTO no es lo mismo que un juego que ESTÁS JUGANDO.
//
// `gaming` vive hasta que la ventana cierra (a propósito: irte a otro workspace 30 s
// no es dejar de jugar, y descongelar ahí lanzaría clamscan con el juego residente,
// además de oscilar en cada alt-tab). Pero con eso solo, dejar un juego aparcado en
// otro workspace mientras trabajas congelaba el mantenimiento el día entero, en
// silencio. Con el instante del último foco, el gate aplica una GRACIA: mientras el
// juego esté delante —o lo hayas tenido hace poco— congela; si lleva mucho sin tocarse,
// descongela solo, y vuelve a congelar en cuanto le des foco otra vez.
//
// Se escribe el epoch ABSOLUTO, no un contador, por lo mismo que `until` en
// wakeup.json: así el lado bash resuelve la gracia contra el reloj de pared sin que
// nadie tenga que reescribir el fichero, y no se desfasa tras una suspensión.
//
// `powerSaveFreeze` viaja en este mismo fichero, y no en uno propio, porque el fichero
// se reescribe ENTERO en cada cambio: dos escritores sobre el mismo JSON se pisarían.
// Es el mismo gate (lib/gaming-gate.sh) congelando el mismo sondeo prescindible por otro
// motivo —ahorro de energía en vez de partida—, así que comparte también la guarda del
// pid: si AGS muere, bash hace fail-open y el mantenimiento vuelve a correr.
// El valor ya viene COMBINADO desde powerState.ts (ahorro activo Y el usuario lo pidió),
// igual que spotifyBarSuspended y compañía; bash no reevalúa nada.
//
// `gameScanner` es la preferencia `escanerJuegos` (Ajustes > Juegos > "Detectar juegos
// en marcha"). Con ella apagada el registro no detecta nada, así que `gaming` y
// `gameFocused` valen `false` DE FORMA PERMANENTE — y eso es exactamente lo que el
// lado bash necesita saber: nunca hay que congelar el mantenimiento por una partida.
// Se escribe el motivo además del efecto para que quien lea el fichero pueda distinguir
// "ahora mismo no hay ningún juego" de "en este equipo no se juega"; ningún consumidor
// está obligado a mirarlo, porque `gaming: false` ya basta para hacer lo correcto.
function writeFlag(gaming: boolean) {
  try {
    const dir = GLib.path_get_dirname(STATE_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(STATE_PATH, JSON.stringify({
      gaming,
      gameFocused,
      lastGameFocus,
      gameScanner: escanerJuegos.get(),
      powerSaveFreeze: backgroundJobsSuspended.get(),
      pid: getPid(),
    }))
  } catch (e) {
    console.error("[gamingState] write failed:", e)
  }
}

export function initGamingState(): void {
  if (started) return
  started = true
  iniciarRegistroJuegos()

  const recompute = () => {
    const gaming = clientesJuego.get().length > 0
    if (gaming === isGaming.get()) return
    _setGaming(gaming)
    writeFlag(gaming)
  }

  // Foco. Solo se escribe en la TRANSICIÓN (juego coge foco / lo pierde), no en cada
  // cambio de ventana: alt-tabear entre el navegador y el editor no toca este fichero.
  // Al PERDERLO se sella el instante, que es justo el origen de la cuenta de gracia.
  const refreshFocus = () => {
    const now = clienteJuegoEnFoco.get() !== null
    if (now === gameFocused) return
    gameFocused = now
    lastGameFocus = Math.floor(Date.now() / 1000)
    if (isGaming.get()) writeFlag(true)
  }

  // El registro compartido ya sembró los clientes existentes antes de publicar.
  recompute()
  refreshFocus()
  // Si AGS reinicia con un juego ya delante, el instante del último foco es AHORA:
  // un 0 heredado lo daría por abandonado hace 55 años y no congelaría nada.
  lastGameFocus = Math.floor(Date.now() / 1000)
  writeFlag(isGaming.get())

  // El ahorro entra y sale sin que pase nada con las ventanas, así que sin esto el
  // fichero solo se actualizaría la próxima vez que abrieras o cerraras un juego.
  backgroundJobsSuspended.subscribe(() => writeFlag(isGaming.get()))
  // Y el escáner, por lo mismo: al apagarlo sin ningún juego abierto no cambia la lista
  // de clientes, así que nadie más reescribiría el fichero y `gameScanner` se quedaría
  // mintiendo hasta la próxima ventana. Al apagarlo con un juego delante sí llega por
  // `clientesJuego` (el registro vacía la lista), pero recompute() volvería a salir por
  // su guarda de "no ha cambiado" si el orden fuera el otro; escribir aquí es lo que
  // hace que el resultado no dependa de ese orden.
  escanerJuegos.subscribe(() => writeFlag(isGaming.get()))
  clientesJuego.subscribe(() => {
    recompute()
    refreshFocus()
  })
  clienteJuegoEnFoco.subscribe(refreshFocus)
}
