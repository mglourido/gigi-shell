// servicios/disco/vigilancia.ts — decidir si el análisis de Ajustes debe AVISAR de un disco
// casi lleno. Módulo PURO (sin GLib ni Gio): lo prueba `node --test`. El efecto —leer el
// fichero de estado, mandar el `notify-send`, reescribirlo— vive en `alerta.ts`.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// `hypr/scripts/disk-monitor.sh` comprueba el espacio UNA vez, al iniciar sesión, y sale. No es
// un daemon a propósito: el espacio libre **no tiene fuente de eventos en Linux**. No la hay en
// el kernel (inotify/fanotify vigilan ficheros, y `FAN_FS_ERROR` reporta corrupción, no ENOSPC),
// no la publica udisks2 (solo montajes y medios), no la da systemd, y CachyOS no trae nada. Lo
// único parecido es el netlink de CUOTAS (`quota_nl`, que sí empuja un evento al pasar el límite
// blando), pero es por usuario, exige `quotaon`, y **btrfs no implementa cuotas de usuario** —solo
// qgroups, que no emiten netlink—, así que en este equipo (todo btrfs sobre un solo NVMe) no
// existe. GNOME (`gsd-housekeeping`) y KDE (`kded freespacenotifier`) sondean cada 60 s: nadie
// escucha, todos preguntan.
//
// De ahí este módulo: en vez de añadir un sondeo propio, se aprovecha el `df` que **ya** hace
// `analizar-almacenamiento.sh` cada vez que se abre Ajustes > Almacenamiento. Coste marginal:
// cero procesos, cero temporizadores. Cobertura: el aviso deja de ser solo del arranque sin que
// nada quede corriendo el resto de la sesión.
//
// ── Y por qué NO hay un ajuste nuevo para esto ──────────────────────────────
// El aviso es `disco.casi-lleno`, el MISMO id que emite `disk-monitor.sh`, así que ya se
// configura (silenciar, color, duración) en Ajustes > Notificaciones > Sistema. Un interruptor
// aparte para "avisar también desde el análisis" daría dos sitios donde apagar la misma cosa.
import { formatearBytes } from "./formato.ts"
import type { Disco } from "./analisis.ts"

/**
 * Umbrales. **Deben coincidir con `hypr/scripts/disk-monitor.sh`** (`WARN_GB` / `MIN_GB`): los dos
 * emiten el mismo aviso, y que uno avise a 5 GiB y el otro a 3 haría que el mismo disco pareciera
 * lleno al iniciar sesión y sano al abrir Ajustes. Se repiten aquí en vez de leerse de un sitio
 * común porque el script es bash sin dependencias y este módulo es puro: compartir fichero
 * obligaría a uno de los dos a forkear un parser.
 */
export const AVISO_LIBRE_BYTES = 5 * 1024 * 1024 * 1024
/** Particiones más pequeñas que esto se ignoran enteras (`/boot`, la ESP: siempre "casi llenas"). */
export const AVISO_MIN_TOTAL_BYTES = 6 * 1024 * 1024 * 1024

/**
 * Espera entre dos avisos del MISMO punto de montaje.
 *
 * Sin ella el aviso se vuelve ruido: el análisis corre en cada apertura de Ajustes, así que con
 * el disco al límite bastaba entrar tres veces a mirar cuánto queda para recibir tres avisos
 * diciendo lo que acabas de leer en pantalla. La espera la comparten los dos emisores (el fichero
 * de estado es común), o sea que abrir Ajustes justo después de iniciar sesión tampoco repite el
 * aviso del arranque.
 */
export const AVISO_ESPERA_S = 6 * 3600

export interface AvisoDisco {
  punto: string
  libre: number
}

/**
 * Lo que se decidió: a quién avisar ahora, y el estado que hay que persistir.
 *
 * `avisados` NO es "el estado anterior más lo nuevo": se reconstruye SOLO con los discos que
 * siguen en riesgo. Así, un disco que se libera pierde su marca y vuelve a avisar en cuanto se
 * llene otra vez, sin esperar las seis horas — y un montaje que ya no existe (un USB retirado)
 * no deja basura creciendo en el fichero para siempre.
 */
export interface Decision {
  avisar: AvisoDisco[]
  avisados: Map<string, number>
}

/**
 * @param discos   los del análisis (`analizar-almacenamiento.sh discos`), ya deduplicados por
 *                 dispositivo — un btrfs con siete subvolúmenes llega como un solo disco.
 * @param previos  punto de montaje → epoch en segundos del último aviso.
 * @param ahora    epoch en segundos.
 */
export function decidirAvisos(
  discos: readonly Disco[],
  previos: ReadonlyMap<string, number>,
  ahora: number,
): Decision {
  const avisar: AvisoDisco[] = []
  const avisados = new Map<string, number>()

  for (const disco of discos) {
    if (!disco.punto) continue
    if (!Number.isFinite(disco.total) || disco.total < AVISO_MIN_TOTAL_BYTES) continue
    if (!Number.isFinite(disco.libre) || disco.libre >= AVISO_LIBRE_BYTES) continue

    const ultimo = previos.get(disco.punto)
    // Una marca del FUTURO (reloj cambiado, fichero de otro equipo) no puede silenciar el aviso
    // durante horas: solo cuenta como reciente lo que está dentro de la ventana hacia atrás.
    if (ultimo !== undefined && ahora - ultimo >= 0 && ahora - ultimo < AVISO_ESPERA_S) {
      avisados.set(disco.punto, ultimo)
      continue
    }
    avisar.push({ punto: disco.punto, libre: disco.libre })
    avisados.set(disco.punto, ahora)
  }

  return { avisar, avisados }
}

/**
 * El fichero de estado, en TEXTO PLANO (`<epoch>\t<punto>` por línea) y no en JSON, para que
 * `disk-monitor.sh` lo lea con un `read` de bash: hoy ese script no forkea un solo proceso más
 * allá de su `df`, y obligarle a un `jq` por un contador de dos columnas sería pagar el arranque
 * de sesión por nada.
 *
 * El epoch va PRIMERO porque un punto de montaje puede llevar espacios: partiendo por el primer
 * tabulador, todo lo que sigue es la ruta, tal cual.
 */
export function leerAvisados(texto: string): Map<string, number> {
  const salida = new Map<string, number>()
  for (const linea of texto.split("\n")) {
    const corte = linea.indexOf("\t")
    if (corte <= 0) continue
    const epoch = Number(linea.slice(0, corte))
    const punto = linea.slice(corte + 1)
    if (!punto || !Number.isInteger(epoch) || epoch < 0) continue
    salida.set(punto, epoch)
  }
  return salida
}

export function serializarAvisados(avisados: ReadonlyMap<string, number>): string {
  let texto = ""
  for (const [punto, epoch] of avisados) texto += `${epoch}\t${punto}\n`
  return texto
}

/**
 * Título y cuerpo del aviso, **calcados de lo que produce `lib/notif-agrupar.sh`** para el grupo
 * `lleno` de `disk-monitor.sh`: un disco da el título fijo y el texto suelto; varios se funden en
 * «N discos casi llenos» con el detalle en viñetas. Es palabra por palabra el mismo aviso porque
 * es el mismo evento (`disco.casi-lleno`): que el texto cambiara según quién lo detectó obligaría
 * a leer dos redacciones distintas del mismo problema, y rompería cualquier regla de usuario
 * escrita con un `contains`.
 *
 * El título fijo es justo lo que permite fundir dos discos en uno; por eso el punto de montaje va
 * en el cuerpo y no en el título.
 */
export function componerAviso(avisar: readonly AvisoDisco[]): { titulo: string; cuerpo: string } | null {
  if (avisar.length === 0) return null
  const linea = (a: AvisoDisco) => `Solo quedan ${formatearBytes(a.libre)} libres en ${a.punto}. Libera espacio.`
  if (avisar.length === 1) return { titulo: "Disco casi lleno", cuerpo: linea(avisar[0]) }
  return {
    titulo: `${avisar.length} discos casi llenos`,
    cuerpo: avisar.map(a => `· ${linea(a)}`).join("\n"),
  }
}
