// servicios/energia/powerState.ts
// Battery / power-save state for the shell. Detects "power save" from the real battery level
// (there is no Hyprland-level power-save signal, so we derive it from AstalBattery) and exposes
// a flag other subsystems can use to suspend battery-consuming background work.
//
// Config lives OUTSIDE the ags config tree, in the conventional XDG config dir under its own
// namespace: ~/.config/power-save/config.json.
import { createState } from "ags"
import GLib from "gi://GLib"
import AstalBattery from "gi://AstalBattery"
import textos from "../../textos/ajustes/energia.json" with { type: "json" }
import { formatearTexto } from "../../textos/formatear.ts"

const POWER_CONFIG_PATH = `${GLib.get_user_config_dir()}/power-save/config.json`

/** Cómo se calcula el brillo objetivo del ahorro: apuntar a un valor fijo o restar
 *  puntos al que haya en ese momento. */
export type BrilloAhorroModo = "fijo" | "relativo"

/** Un tiempo de inactividad del modo ahorro: minutos + si ese listener se usa. */
export interface TiempoAhorro { min: number; on: boolean }

interface PowerConfig {
  thresholdPct: number         // battery % at/under which power-save turns on (0..100)
  forcePowerSave: boolean      // when true, power-save is ON regardless of battery level/charging/presence
  suspendNotifFilters: boolean // when true, notification filter timers pause during power-save
  pauseWsPreview: boolean      // when true, the workspace preview (grim capture) pauses during power-save
  hideSpotifyBar: boolean      // when true, the Spotify pill is unmounted during power-save
  freezeBackground: boolean    // when true, background maintenance polling freezes during power-save
  fallbackWave: boolean        // when true, the Spotify wave drops cava for its procedural animation
  hideMascota: boolean         // when true, the desktop pet window is unmounted during power-save
  opaquePanels: boolean        // when true, the shell's translucent surfaces turn fully opaque during power-save
  opaqueWindows: boolean       // when true, Hyprland's window opacity is forced to 1.0 during power-save
  reduceBrightness: boolean    // when true, screen brightness drops during power-save
  /** Cómo se calcula el brillo del ahorro. "fijo" apunta a `brightnessPct`; "relativo" resta
   *  `brightnessDropPct` PUNTOS al brillo que hubiera puesto (30 % con 10 → 20 %). El modo
   *  fijo NUNCA sube el brillo: si ya se está por debajo del objetivo, cae al cálculo
   *  relativo (ver `brilloAhorro.ts`), que es la razón de que los dos valores convivan
   *  aunque solo se edite uno. */
  brightnessMode: BrilloAhorroModo
  brightnessPct: number        // target brightness (0..100) while power-save is on, modo "fijo"
  brightnessDropPct: number    // puntos porcentuales que se restan al brillo actual, modo "relativo"
  tlpAuto: boolean             // when true, the TLP profile switches to "ahorro" during power-save
  idleOverride: boolean        // when true, hypridle timeouts are replaced by the three below
  idleDpms: TiempoAhorro       // screen off
  idleLock: TiempoAhorro       // lock session
  idleSuspend: TiempoAhorro    // suspend
  /** Brillo de antes de que el ahorro lo bajara, o `null` si no hay reducción vigente.
   *  NO es un ajuste: es un APUNTE, y por eso vive en disco y no solo en RAM. El brillo es
   *  lo único de este módulo que deja residuo FÍSICO — por DDC se graba en la firmware del
   *  monitor y sobrevive al proceso, así que si AGS muere con el ahorro puesto la pantalla
   *  se queda baja para siempre y, peor, `brightness.subscribe(saveDisplayConfig)` adopta
   *  ese valor impuesto como si lo hubiera elegido el usuario y borra el real. Es el mismo
   *  fallo que documenta `applyScheduledBrightness` para las franjas horarias, y se cura
   *  igual: con el apunte en disco, la restauración pendiente se cobra en el arranque
   *  siguiente. Va en este fichero y no en uno propio porque se reescribe entero de una vez. */
  brightnessBefore: number | null

  // ── Suspensión falsa (docs/suspension-falsa.md) ─────────────────────────────
  // Viven aquí, y no en `suspension-falsa.json`, porque eso es ESTADO VIVO con guarda de
  // pid y esto son AJUSTES de usuario. Un fichero con dos ciclos de vida distintos acaba
  // borrándose entero cuando alguien limpia el que caduca.
  sfLock: boolean            // bloquear con hyprlock al entrar (es la puerta de salida)
  sfDnd: boolean             // No molestar mientras dure
  sfMuteNotis: boolean       // callar el sonido de las notificaciones normales
  /** Callar también alarmas / temporizador / cronómetro. Nace en FALSE a propósito: bajo el
   *  DND normal ya estarían mudas (`decidirSonido` corta el sonido con No molestar y una
   *  crítica NO se lo salta), así que si este ajuste no las dejara sonar por defecto no
   *  tendría nada que silenciar y el despertador no sonaría sin un solo aviso. Ver la
   *  sección «Alarmas, temporizador y No molestar» del documento. */
  sfMuteReloj: boolean
  sfLeds: boolean            // retroiluminación de teclado y LEDs a 0
  sfTlp: SfTlp               // perfil TLP mientras dure ("no-tocar" = no se toca ni se restaura)
  /** Perfil de `power-profiles-daemon` mientras dure. Es el HERMANO de `sfTlp` para las
   *  máquinas donde TLP no está —empezando por cualquier sobremesa, donde `tlpAvailable`
   *  es falso y la tarjeta de TLP ni se pinta—, y en esta casa es el ajuste que más vatios
   *  mueve de toda la sección: medido con RAPL en el sobremesa Intel, el paquete pasa de
   *  ~17-22 W en `performance` a ~10 W en `power-saver` con el escritorio en reposo. Ver
   *  `suspensionFalsa/perfilEnergia.ts`. */
  sfPpd: SfPpd
  sfFreezeApps: string[]     // allowlist EXPLÍCITO de apps a congelar; nace vacío
  sfSuspendMin: number       // suspender de verdad tras N minutos; 0 = nunca
  /** SUSTITUIR la suspensión real por la falsa en todo el sistema. No es un ajuste más de
   *  la suspensión falsa: cambia lo que hacen la inactividad de hypridle, el menú de energía
   *  y el botón físico de encendido. Existe porque hay equipos cuyo S3 no vuelve bien —el
   *  caso típico son los drivers de la GPU—, y ahí una suspensión que no gasta tan poco pero
   *  siempre vuelve es mejor que una que a veces deja el equipo colgado. Ver la sección
   *  «Sustituir la suspensión real» de docs/suspension-falsa.md. */
  sfSustituirReal: boolean
  sfBluetooth: boolean       // apagar el BT mientras dure
  sfMuteAudio: boolean       // silenciar el audio del sistema mientras dure
}

/** Perfil TLP durante la suspensión falsa. Solo hay tres valores porque `tlp.ts` solo
 *  conoce dos perfiles (`TlpMode`), y el tercero es no tocar nada — que es distinto de
 *  "normal": lo que no se impone tampoco se restaura al salir. */
export type SfTlp = "no-tocar" | "ahorro" | "normal"

/** Perfil de energía del sistema durante la suspensión falsa, en los nombres que entiende
 *  `powerprofilesctl`. Como en `SfTlp`, "no-tocar" no es sinónimo de "balanced": lo que no
 *  se impone tampoco se restaura al salir, así que deja pasar intacto lo que hubiera puesto
 *  el usuario (o un juego, o GNOME) sin que la suspensión falsa se lo coma.
 *
 *  `performance` NO está en la lista, y no es un olvido: este selector existe para GASTAR
 *  MENOS con el equipo desatendido. Ofrecer el perfil que gasta más sería un pie de foto sin
 *  ningún caso de uso detrás. */
export type SfPpd = "no-tocar" | "power-saver" | "balanced"
const DEFAULTS: PowerConfig = {
  thresholdPct: 15,
  forcePowerSave: false,
  suspendNotifFilters: false,
  pauseWsPreview: true,
  hideSpotifyBar: true,
  freezeBackground: true,
  fallbackWave: true,
  hideMascota: true,
  // Apagado por defecto, como el brillo y TLP: es la única medida de esta sección que
  // CAMBIA EL ASPECTO del escritorio en vez de quitar algo que sobra, y encontrarse los
  // paneles opacos sin haberlo pedido se lee como un fallo del tema, no como un ahorro.
  opaquePanels: false,
  // Apagado por defecto por lo mismo que `opaquePanels`, del que es el gemelo para las
  // ventanas del compositor: se VE (desaparece el velo de las ventanas sin foco) y una
  // medida que se ve tiene que pedirse.
  opaqueWindows: false,
  reduceBrightness: false,
  // "fijo" por compatibilidad con lo que ya había: es el único modo que existía y el que
  // describen los ajustes guardados de cualquier instalación anterior a este campo.
  brightnessMode: "fijo",
  brightnessPct: 40,
  brightnessDropPct: 20,
  tlpAuto: false,
  idleOverride: false,
  idleDpms: { min: 2, on: true },
  // Apagado por defecto: el listener general de bloqueo también lo está en esta
  // máquina, y que entrar en ahorro empezara a pedir contraseña sería una sorpresa.
  idleLock: { min: 3, on: false },
  idleSuspend: { min: 5, on: true },
  brightnessBefore: null,
  // Regla heredada de esta sección: lo que SE VE o puede perder datos nace apagado
  // (`opaquePanels`, `opaqueWindows`, `reduceBrightness`, `tlpAuto`). El bloqueo es la
  // excepción justificada: es la puerta de salida de la función, no un adorno.
  sfLock: true,
  sfDnd: true,
  sfMuteNotis: true,
  sfMuteReloj: false,
  sfLeds: true,
  sfTlp: "no-tocar",
  // "no-tocar" por el mismo criterio que `sfTlp`, y es DELIBERADO aunque aquí cueste vatios
  // medidos: cambiar el perfil de energía del sistema es una decisión que se toma a
  // sabiendas, no un efecto colateral de estrenar la suspensión falsa. El ahorro está a un
  // clic en Ajustes > Energía y la tarjeta dice lo que gana.
  sfPpd: "no-tocar",
  sfFreezeApps: [],
  sfSuspendMin: 0,
  // Apagado por defecto y no puede ser otra cosa: cambia el comportamiento del botón de
  // encendido y de la inactividad para TODO el sistema. Es de las poquísimas opciones del
  // shell que quien la enciende tiene que saber exactamente lo que hace.
  sfSustituirReal: false,
  sfBluetooth: false,
  sfMuteAudio: false,
}

function loadConfig(): PowerConfig {
  try {
    const [ok, content] = GLib.file_get_contents(POWER_CONFIG_PATH)
    if (ok) {
      const data = JSON.parse(new TextDecoder().decode(content))
      return {
        thresholdPct: typeof data.thresholdPct === "number" ? clampPct(data.thresholdPct) : DEFAULTS.thresholdPct,
        forcePowerSave: !!data.forcePowerSave,
        suspendNotifFilters: !!data.suspendNotifFilters,
        pauseWsPreview: typeof data.pauseWsPreview === "boolean" ? data.pauseWsPreview : DEFAULTS.pauseWsPreview,
        hideSpotifyBar: typeof data.hideSpotifyBar === "boolean" ? data.hideSpotifyBar : DEFAULTS.hideSpotifyBar,
        freezeBackground: typeof data.freezeBackground === "boolean" ? data.freezeBackground : DEFAULTS.freezeBackground,
        fallbackWave: typeof data.fallbackWave === "boolean" ? data.fallbackWave : DEFAULTS.fallbackWave,
        hideMascota: typeof data.hideMascota === "boolean" ? data.hideMascota : DEFAULTS.hideMascota,
        opaquePanels: typeof data.opaquePanels === "boolean" ? data.opaquePanels : DEFAULTS.opaquePanels,
        opaqueWindows: typeof data.opaqueWindows === "boolean" ? data.opaqueWindows : DEFAULTS.opaqueWindows,
        reduceBrightness: typeof data.reduceBrightness === "boolean" ? data.reduceBrightness : DEFAULTS.reduceBrightness,
        brightnessMode: data.brightnessMode === "relativo" || data.brightnessMode === "fijo"
          ? data.brightnessMode : DEFAULTS.brightnessMode,
        brightnessPct: typeof data.brightnessPct === "number" ? clampPct(data.brightnessPct) : DEFAULTS.brightnessPct,
        brightnessDropPct: typeof data.brightnessDropPct === "number"
          ? clampPct(data.brightnessDropPct) : DEFAULTS.brightnessDropPct,
        tlpAuto: typeof data.tlpAuto === "boolean" ? data.tlpAuto : DEFAULTS.tlpAuto,
        idleOverride: typeof data.idleOverride === "boolean" ? data.idleOverride : DEFAULTS.idleOverride,
        idleDpms: leerTiempo(data.idleDpms, DEFAULTS.idleDpms),
        idleLock: leerTiempo(data.idleLock, DEFAULTS.idleLock),
        idleSuspend: leerTiempo(data.idleSuspend, DEFAULTS.idleSuspend),
        brightnessBefore: typeof data.brightnessBefore === "number"
          ? Math.max(0, Math.min(1, data.brightnessBefore))
          : null,
        sfLock: typeof data.sfLock === "boolean" ? data.sfLock : DEFAULTS.sfLock,
        sfDnd: typeof data.sfDnd === "boolean" ? data.sfDnd : DEFAULTS.sfDnd,
        sfMuteNotis: typeof data.sfMuteNotis === "boolean" ? data.sfMuteNotis : DEFAULTS.sfMuteNotis,
        sfMuteReloj: typeof data.sfMuteReloj === "boolean" ? data.sfMuteReloj : DEFAULTS.sfMuteReloj,
        sfLeds: typeof data.sfLeds === "boolean" ? data.sfLeds : DEFAULTS.sfLeds,
        sfTlp: data.sfTlp === "ahorro" || data.sfTlp === "normal" || data.sfTlp === "no-tocar"
          ? data.sfTlp : DEFAULTS.sfTlp,
        sfPpd: data.sfPpd === "power-saver" || data.sfPpd === "balanced" || data.sfPpd === "no-tocar"
          ? data.sfPpd : DEFAULTS.sfPpd,
        sfFreezeApps: leerListaApps(data.sfFreezeApps),
        sfSuspendMin: typeof data.sfSuspendMin === "number" && data.sfSuspendMin > 0
          ? Math.min(1440, Math.round(data.sfSuspendMin)) : 0,
        sfSustituirReal: typeof data.sfSustituirReal === "boolean"
          ? data.sfSustituirReal : DEFAULTS.sfSustituirReal,
        sfBluetooth: typeof data.sfBluetooth === "boolean" ? data.sfBluetooth : DEFAULTS.sfBluetooth,
        sfMuteAudio: typeof data.sfMuteAudio === "boolean" ? data.sfMuteAudio : DEFAULTS.sfMuteAudio,
      }
    }
  } catch (_) {}
  return { ...DEFAULTS }
}

function clampPct(v: number): number { return Math.max(0, Math.min(100, Math.round(v))) }

/** Un tiempo del disco, campo a campo: una clave ausente cae a su valor por defecto
 *  en vez de invalidar el objeto entero (mismo criterio que el resto de este loader). */
function leerTiempo(bruto: any, porDefecto: TiempoAhorro): TiempoAhorro {
  if (!bruto || typeof bruto !== "object") return { ...porDefecto }
  return {
    min: typeof bruto.min === "number" && bruto.min >= 1 ? Math.round(bruto.min) : porDefecto.min,
    on: typeof bruto.on === "boolean" ? bruto.on : porDefecto.on,
  }
}

/** El allowlist de apps a congelar, saneado. Cualquier cosa que no sea una cadena no
 *  vacía se descarta en vez de invalidar la lista entera: una entrada rota no puede
 *  hacer que se pierdan las demás, y aquí "perderse" significa que una app que el
 *  usuario quería congelada se queda corriendo (visible) — nunca al revés. */
function leerListaApps(bruto: any): string[] {
  if (!Array.isArray(bruto)) return []
  const vistas = new Set<string>()
  for (const v of bruto) {
    if (typeof v !== "string") continue
    const nombre = v.trim()
    if (nombre) vistas.add(nombre)
  }
  return [...vistas]
}

const initial = loadConfig()

// ── Persisted user settings ────────────────────────────────────────────────────
export const [powerSaveThreshold, _setThreshold] = createState(initial.thresholdPct)
export const [forcePowerSave, _setForcePowerSave] = createState(initial.forcePowerSave)
export const [suspendNotifFilters, _setSuspend] = createState(initial.suspendNotifFilters)
export const [pauseWsPreviewInPowerSave, _setPauseWsPreview] = createState(initial.pauseWsPreview)
export const [hideSpotifyBarInPowerSave, _setHideSpotifyBar] = createState(initial.hideSpotifyBar)
export const [freezeBackgroundInPowerSave, _setFreezeBackground] = createState(initial.freezeBackground)
export const [fallbackWaveInPowerSave, _setFallbackWave] = createState(initial.fallbackWave)
export const [hideMascotaInPowerSave, _setHideMascota] = createState(initial.hideMascota)
export const [opaquePanelsInPowerSave, _setOpaquePanels] = createState(initial.opaquePanels)
export const [opaqueWindowsInPowerSave, _setOpaqueWindows] = createState(initial.opaqueWindows)
export const [reduceBrightnessInPowerSave, _setReduceBrightness] = createState(initial.reduceBrightness)
export const [powerSaveBrightnessMode, _setBrightnessMode] = createState(initial.brightnessMode)
export const [powerSaveBrightnessPct, _setBrightnessPct] = createState(initial.brightnessPct)
export const [powerSaveBrightnessDropPct, _setBrightnessDropPct] = createState(initial.brightnessDropPct)
export const [tlpAutoInPowerSave, _setTlpAuto] = createState(initial.tlpAuto)
export const [idleOverrideInPowerSave, _setIdleOverride] = createState(initial.idleOverride)
export const [idleDpmsAhorro, _setIdleDpms] = createState(initial.idleDpms)
export const [idleLockAhorro, _setIdleLock] = createState(initial.idleLock)
export const [idleSuspendAhorro, _setIdleSuspend] = createState(initial.idleSuspend)

// ── Ajustes de la suspensión falsa ─────────────────────────────────────────────
// Solo AJUSTES. El estado vivo (activa/no, plazo, pid) es de `suspensionFalsa.ts` y no
// pasa por este fichero ni por el disco de aquí: un crash de AGS tiene que devolver el
// escritorio a su sitio, y para eso el estado tiene que morirse con el proceso.
export const [sfBloquear, _setSfLock] = createState(initial.sfLock)
export const [sfNoMolestar, _setSfDnd] = createState(initial.sfDnd)
export const [sfSilenciarNotificaciones, _setSfMuteNotis] = createState(initial.sfMuteNotis)
export const [sfSilenciarReloj, _setSfMuteReloj] = createState(initial.sfMuteReloj)
export const [sfApagarLeds, _setSfLeds] = createState(initial.sfLeds)
export const [sfPerfilTlp, _setSfTlp] = createState<SfTlp>(initial.sfTlp)
export const [sfPerfilEnergia, _setSfPpd] = createState<SfPpd>(initial.sfPpd)
export const [sfAppsCongeladas, _setSfFreezeApps] = createState<string[]>(initial.sfFreezeApps)
export const [sfMinutosSuspensionReal, _setSfSuspendMin] = createState(initial.sfSuspendMin)
export const [sfSustituirReal, _setSfSustituirReal] = createState(initial.sfSustituirReal)
export const [sfApagarBluetooth, _setSfBluetooth] = createState(initial.sfBluetooth)
export const [sfSilenciarAudio, _setSfMuteAudio] = createState(initial.sfMuteAudio)

// El apunte del brillo previo (ver `brightnessBefore` arriba). No es reactivo: su único
// consumidor es `brilloAhorro.ts`, que lo lee al arrancar y lo reescribe en las dos
// transiciones. Se guarda SÍNCRONO —no por el debounce de 600 ms de `persist()`— porque
// justo después de escribirlo se cambia el brillo de verdad: si AGS muriera en esa
// ventana, el disco diría que no hay nada que restaurar y la pantalla se quedaría baja.
let brilloAntesDelAhorro: number | null = initial.brightnessBefore
export function leerBrilloAntesDelAhorro(): number | null { return brilloAntesDelAhorro }
export function guardarBrilloAntesDelAhorro(v: number | null): void {
  brilloAntesDelAhorro = v
  persistAhora()
}

let saveTimer: number | null = null
function persist() {
  if (saveTimer !== null) GLib.source_remove(saveTimer)
  saveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
    persistAhora()
    saveTimer = null
    return GLib.SOURCE_REMOVE
  })
}

function persistAhora() {
  try {
    const dir = GLib.path_get_dirname(POWER_CONFIG_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(POWER_CONFIG_PATH, JSON.stringify({
      thresholdPct: powerSaveThreshold.get(),
      forcePowerSave: forcePowerSave.get(),
      suspendNotifFilters: suspendNotifFilters.get(),
      pauseWsPreview: pauseWsPreviewInPowerSave.get(),
      hideSpotifyBar: hideSpotifyBarInPowerSave.get(),
      freezeBackground: freezeBackgroundInPowerSave.get(),
      fallbackWave: fallbackWaveInPowerSave.get(),
      hideMascota: hideMascotaInPowerSave.get(),
      opaquePanels: opaquePanelsInPowerSave.get(),
      opaqueWindows: opaqueWindowsInPowerSave.get(),
      reduceBrightness: reduceBrightnessInPowerSave.get(),
      brightnessMode: powerSaveBrightnessMode.get(),
      brightnessPct: powerSaveBrightnessPct.get(),
      brightnessDropPct: powerSaveBrightnessDropPct.get(),
      tlpAuto: tlpAutoInPowerSave.get(),
      idleOverride: idleOverrideInPowerSave.get(),
      idleDpms: idleDpmsAhorro.get(),
      idleLock: idleLockAhorro.get(),
      idleSuspend: idleSuspendAhorro.get(),
      brightnessBefore: brilloAntesDelAhorro,
      sfLock: sfBloquear.get(),
      sfDnd: sfNoMolestar.get(),
      sfMuteNotis: sfSilenciarNotificaciones.get(),
      sfMuteReloj: sfSilenciarReloj.get(),
      sfLeds: sfApagarLeds.get(),
      sfTlp: sfPerfilTlp.get(),
      sfPpd: sfPerfilEnergia.get(),
      sfFreezeApps: sfAppsCongeladas.get(),
      sfSuspendMin: sfMinutosSuspensionReal.get(),
      sfSustituirReal: sfSustituirReal.get(),
      sfBluetooth: sfApagarBluetooth.get(),
      sfMuteAudio: sfSilenciarAudio.get(),
    }))
  } catch (e) {
    console.error("[power] save failed:", e)
  }
}

export function setPowerSaveThreshold(v: number) {
  _setThreshold(clampPct(v))
  recompute()
  persist()
}
export function setForcePowerSave(v: boolean) {
  _setForcePowerSave(v)
  recompute()
  persist()
}
export function setSuspendNotifFilters(v: boolean) {
  _setSuspend(v)
  recompute()
  persist()
}
export function setPauseWsPreviewInPowerSave(v: boolean) {
  _setPauseWsPreview(v)
  recompute()
  persist()
}
export function setHideSpotifyBarInPowerSave(v: boolean) {
  _setHideSpotifyBar(v)
  recompute()
  persist()
}
export function setFreezeBackgroundInPowerSave(v: boolean) {
  _setFreezeBackground(v)
  recompute()
  persist()
}
export function setFallbackWaveInPowerSave(v: boolean) {
  _setFallbackWave(v)
  recompute()
  persist()
}
export function setHideMascotaInPowerSave(v: boolean) {
  _setHideMascota(v)
  recompute()
  persist()
}
export function setOpaquePanelsInPowerSave(v: boolean) {
  _setOpaquePanels(v)
  recompute()
  persist()
}
export function setOpaqueWindowsInPowerSave(v: boolean) {
  _setOpaqueWindows(v)
  recompute()
  persist()
}
export function setReduceBrightnessInPowerSave(v: boolean) {
  _setReduceBrightness(v)
  recompute()
  persist()
}
export function setPowerSaveBrightnessMode(v: BrilloAhorroModo) {
  _setBrightnessMode(v === "relativo" ? "relativo" : "fijo")
  recompute()
  persist()
}
export function setPowerSaveBrightnessPct(v: number) {
  _setBrightnessPct(clampPct(v))
  recompute()
  persist()
}
export function setPowerSaveBrightnessDropPct(v: number) {
  _setBrightnessDropPct(clampPct(v))
  recompute()
  persist()
}
export function setTlpAutoInPowerSave(v: boolean) {
  _setTlpAuto(v)
  recompute()
  persist()
}
export function setIdleOverrideInPowerSave(v: boolean) {
  _setIdleOverride(v)
  recompute()
  persist()
}
export function setIdleDpmsAhorro(v: TiempoAhorro) {
  _setIdleDpms({ min: Math.max(1, Math.round(v.min)), on: v.on })
  recompute()
  persist()
}
export function setIdleLockAhorro(v: TiempoAhorro) {
  _setIdleLock({ min: Math.max(1, Math.round(v.min)), on: v.on })
  recompute()
  persist()
}
export function setIdleSuspendAhorro(v: TiempoAhorro) {
  _setIdleSuspend({ min: Math.max(1, Math.round(v.min)), on: v.on })
  recompute()
  persist()
}

// Los ajustes de la suspensión falsa NO llaman a `recompute()`: no entran en ninguno de
// los derivados de la batería. Solo se persisten (y `suspensionFalsa.ts` los lee al
// entrar y al salir, que es cuando importan).
export function setSfBloquear(v: boolean) { _setSfLock(v); persist() }
export function setSfNoMolestar(v: boolean) { _setSfDnd(v); persist() }
export function setSfSilenciarNotificaciones(v: boolean) { _setSfMuteNotis(v); persist() }
export function setSfSilenciarReloj(v: boolean) { _setSfMuteReloj(v); persist() }
export function setSfApagarLeds(v: boolean) { _setSfLeds(v); persist() }
export function setSfPerfilTlp(v: SfTlp) {
  _setSfTlp(v === "ahorro" || v === "normal" ? v : "no-tocar")
  persist()
}
export function setSfPerfilEnergia(v: SfPpd) {
  _setSfPpd(v === "power-saver" || v === "balanced" ? v : "no-tocar")
  persist()
}
/** Tope de 24 h y suelo de 0 (= desactivado). El tope no es paranoia: el campo es un
 *  número que teclea una persona y un plazo absurdo se guarda igual de bien que uno
 *  bueno, pero luego no hay forma de distinguir "se me fue un dígito" de "lo quiso así"
 *  mirando el chip de la barra. */
export function setSfMinutosSuspensionReal(v: number) {
  const n = Math.round(v)
  _setSfSuspendMin(Number.isFinite(n) && n > 0 ? Math.min(1440, n) : 0)
  persist()
}
export function setSfSustituirReal(v: boolean) { _setSfSustituirReal(v); persist() }
export function setSfApagarBluetooth(v: boolean) { _setSfBluetooth(v); persist() }
export function setSfSilenciarAudio(v: boolean) { _setSfMuteAudio(v); persist() }
/** Reemplaza el allowlist entero (la UI edita la lista completa, no entradas sueltas). */
export function setSfAppsCongeladas(v: string[]) {
  _setSfFreezeApps(leerListaApps(v))
  persist()
}

// ── Derived power state ─────────────────────────────────────────────────────────
// powerSaveActive: on battery and at/under the threshold.
// notifProcessingSuspended: powerSaveActive AND the user opted in to suspending notif filters.
export const [powerSaveActive, _setPowerSaveActive] = createState(false)
export const [notifProcessingSuspended, _setSuspended] = createState(false)
// wsPreviewSuspended: powerSaveActive AND the user opted in to pausing the workspace preview.
export const [wsPreviewSuspended, _setWsPreviewSuspended] = createState(false)
// spotifyBarSuspended: powerSaveActive AND the user opted in to hiding the Spotify pill.
// Barra.tsx lo usa para DESMONTAR el widget (no solo ocultarlo): la pastilla trae un timer
// de 1 s y el waveform engancha el reloj de FRAMES del monitor (240 Hz en este equipo,
// medido), y un widget meramente invisible seguiría pagando ambos. Al desmontarlo, su
// handler de "destroy" quita el timer, suelta el tick callback y cancela la suscripción.
export const [spotifyBarSuspended, _setSpotifyBarSuspended] = createState(false)
// backgroundJobsSuspended: powerSaveActive AND the user opted in to freezing background work.
// A diferencia de los tres de arriba, este NO lo consume ningún widget: lo publica
// gamingState.ts en runtime-state.json para el lado BASH (lib/gaming-gate.sh), que congela
// el mismo sondeo prescindible que ya congela al jugar (actualizaciones, SMART, unidades).
// Se combina aquí, y no en bash, a propósito: rederivar allí "¿ahorro activo?" ya salió mal
// una vez —/sys/class/power_supply lista también la pila del ratón (ver oom-monitor.sh)— y
// AstalBattery/upower ya distingue la batería del equipo. Una sola fuente de verdad.
export const [backgroundJobsSuspended, _setBackgroundJobsSuspended] = createState(false)
// spectrumSuspended: powerSaveActive AND the user opted in to dropping the audio analysis.
// Lo consume OndaSpotify.tsx para NO lanzar `cava` y ceder a su animación procedimental, que
// no cuesta ni un proceso. Es un escalón ANTES que spotifyBarSuspended: con este la pastilla
// se sigue viendo y la onda se sigue moviendo, solo deja de seguir la música. Van por separado
// a propósito — quien quiera conservar el reproductor visible durante el ahorro puede querer
// justo eso y aun así no pagar la captura de audio.
export const [spectrumSuspended, _setSpectrumSuspended] = createState(false)
// mascotaSuspended: powerSaveActive AND the user opted in to hiding the desktop pet.
// `Lagarto.tsx` lo suma a su `visible`, que ahí NO es solo cosmético: la ventana se
// desmapea y su suscripción a `visible` para el temporizador de la marcha, así que oculto
// no cuesta ni un timeout ni un frame (el propio fichero ya lo documenta). Y eso es lo que
// se busca: el lagarto anima a ~11 fotogramas/s y cada uno es un commit de una capa
// layer-shell que Hyprland tiene que recomponer. Por diseño solo pasea cuando el escritorio
// está vacío o sin foco — o sea, justo en los ratos en que el equipo estaría en reposo y la
// batería no debería estar pagando una animación decorativa.
export const [mascotaSuspended, _setMascotaSuspended] = createState(false)
// transparenciaSuspendida: powerSaveActive AND the user opted in to opaque panels.
// Lo consume `opacidadAhorro.ts`, que redefine las variables `--lamina-*` del tema.
// Lo que se ahorra no es GTK —pintar un color sólido o uno con alfa cuesta lo mismo—
// sino HYPRLAND: cada lámina translúcida lleva `blur = true` en `hypr/gigishell/reglas.lua`
// (quick-settings, notification-panel, calendar-panel, orion, osd), y desenfocar lo que
// se ve por debajo es trabajo de GPU por fotograma mientras el panel esté abierto. Con
// la lámina opaca, GTK declara la región como opaca y el compositor puede saltarse tanto
// el desenfoque como el pintado del escritorio de detrás. Es la única medida de la
// sección que ahorra mientras el usuario MIRA algo, no mientras el equipo está en reposo.
export const [transparenciaSuspendida, _setTransparenciaSuspendida] = createState(false)
// opacidadVentanasForzada: powerSaveActive AND the user opted in to opaque windows.
// El gemelo del de arriba para las ventanas DEL COMPOSITOR, y por eso su consumidor no es
// un widget: `opacidadVentanas.ts` lo publica en ~/.config/gigishell/opacidad-ventanas.json y
// llama a `GiGiShell.opacidad_ahorro()` de `hypr/gigishell/ventanas.lua`, que es quien conoce la
// opacidad a la que hay que VOLVER (0.92 para las ventanas sin foco). Se combina aquí, como
// todos los demás, para que el lado Lua no tenga que rederivar "¿hay ahorro?".
export const [opacidadVentanasForzada, _setOpacidadVentanasForzada] = createState(false)
// Pre-composed human label so the UI doesn't have to combine three states in one binding.
export const [batteryStatusText, _setBatteryStatusText] = createState(textos.estado.sinBateria)

// ── Batería en crudo ────────────────────────────────────────────────────────────
// Los tres datos que `recompute()` ya lee de AstalBattery, publicados tal cual para quien
// necesite decidir con OTRO umbral que el del ahorro. Se exportan desde aquí, y no
// conectando un segundo AstalBattery en el módulo consumidor, para que solo haya una fuente
// de verdad de "hay batería / está cargando / va por X %": es el mismo criterio que ya
// documenta `backgroundJobsSuspended` sobre rederivar el estado de batería en bash.
export const [bateriaPresente, _setBateriaPresente] = createState(false)
export const [bateriaCargando, _setBateriaCargando] = createState(false)
/** Carga en porcentaje ENTERO (0..100), no la fracción 0..1 de AstalBattery. */
export const [bateriaNivel, _setBateriaNivel] = createState(0)

const bat = (() => { try { return AstalBattery.get_default() } catch { return null } })()

// Segundo motivo de las suspensiones del shell, además del ahorro: la SUSPENSIÓN FALSA.
// Es una variable suelta y no un `createState` importado de `suspensionFalsa.ts` para no
// cerrar un ciclo de importación (aquel módulo lee los ajustes `sf*` de este). Vive en
// RAM y solo en RAM, que es el diseño: ver «NO reusar forcePowerSave» en
// docs/suspension-falsa.md — un crash de AGS tiene que devolver el escritorio a su sitio,
// y un ajuste persistido dejaría al usuario en ahorro forzado permanente sin UI donde
// apagarlo.
let motivoSuspensionFalsa = false
export function fijarMotivoSuspensionFalsa(v: boolean): void {
  if (motivoSuspensionFalsa === v) return
  motivoSuspensionFalsa = v
  recompute()
}

function recompute() {
  const present = !!(bat && bat.isPresent)
  const charging = present ? bat!.charging : false
  const pct = present ? Math.round(bat!.percentage * 100) : 0
  _setBateriaPresente(present)
  _setBateriaCargando(charging)
  _setBateriaNivel(pct)
  _setBatteryStatusText(present
    ? formatearTexto(charging ? textos.estado.bateriaCargando : textos.estado.bateria, { porcentaje: pct })
    : textos.estado.sinBateria)

  // pct > 0 guards against a transient 0 read before the proxy has the real value.
  // forcePowerSave overrides the battery-derived condition: it turns power-save ON regardless
  // of level/charging/presence, so it also works on a desktop with no battery.
  const active = forcePowerSave.get() || (present && !charging && pct > 0 && pct <= powerSaveThreshold.get())
  _setPowerSaveActive(active)
  _setSuspended(active && suspendNotifFilters.get())
  // La suspensión falsa enciende TODAS estas sin mirar los interruptores del ahorro, y no
  // es un descuido: allí cada uno existe porque la medida se ve o cuesta algo mientras el
  // usuario está delante. Aquí no hay nadie delante y la pantalla está apagada, así que la
  // pregunta que responden esos interruptores no se plantea. `powerSaveActive` en cambio NO
  // se toca: sigue significando "batería baja", y falsearlo haría mentir al indicador de
  // batería y a todo lo que lo lee.
  const sf = motivoSuspensionFalsa
  // notifProcessingSuspended se queda FUERA a propósito: no es una medida de gasto sino un
  // cambio en cómo se procesan las notificaciones, y la suspensión falsa ya tiene su propio
  // trato para ellas (DND + los dos ajustes de silencio). Que además se pausaran los filtros
  // cambiaría el historial que el usuario se encuentra al volver.
  _setWsPreviewSuspended(sf || (active && pauseWsPreviewInPowerSave.get()))
  _setSpotifyBarSuspended(sf || (active && hideSpotifyBarInPowerSave.get()))
  _setBackgroundJobsSuspended(sf || (active && freezeBackgroundInPowerSave.get()))
  _setSpectrumSuspended(sf || (active && fallbackWaveInPowerSave.get()))
  _setMascotaSuspended(sf || (active && hideMascotaInPowerSave.get()))
  _setTransparenciaSuspendida(sf || (active && opaquePanelsInPowerSave.get()))
  _setOpacidadVentanasForzada(sf || (active && opaqueWindowsInPowerSave.get()))
}

if (bat) {
  bat.connect("notify::percentage", recompute)
  bat.connect("notify::charging", recompute)
  bat.connect("notify::is-present", recompute)
}
recompute()
