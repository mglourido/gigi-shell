// modulos/notificaciones/rules/types.ts
// Pure type declarations for the notification rule engine. No runtime imports.

export type Lifetime = "flash" | "timed" | "clear-on-boot" | "persistent"

/** Aspecto del popup. "dunst" = skin que replica el dunstrc por defecto (ver style.scss);
 *  "default" = el diseño propio del shell. Una regla que lo fija GANA al hint
 *  `x-gigios-source:system` de los scripts, así que `"default"` sirve para sacar del skin a una
 *  notificación del sistema, y `"dunst"` para metérselo a una app cualquiera. */
export type PopupStyle = "default" | "dunst"
export const POPUP_STYLES: PopupStyle[] = ["default", "dunst"]

export interface StringMatch {
  op: "contains" | "equals" | "regex"
  value: string
  ci?: boolean // case-insensitive (default true)
}

export interface MatchSpec {
  app?: StringMatch
  summary?: StringMatch
  body?: StringMatch
  /** Origen: el hint `x-gigios-source` (los scripts de hypr/scripts mandan "system").
   *  Ausente en las notificaciones de apps normales — y una regla que lo exija NO casará
   *  con ellas, porque un subject vacío no puede ser "system". */
  source?: StringMatch
  /** IDENTIDAD del aviso del sistema: el hint `x-gigios-event` que pone
   *  `hypr/scripts/lib/notif.sh` (`kernel.oom`, `wifi.desconectado`, …). Es lo que permite
   *  configurar CADA notificación del sistema por separado: `source` las mete a todas en el
   *  mismo saco y el título cambia con el contenido (`"RAM muy baja: 812MB disponibles"`),
   *  así que sin esto la única forma de apuntar a una era un `contains` frágil.
   *  Ver `catalogoSistema.ts` para la lista de ids y `sistemaStore.ts` para su config. */
  event?: StringMatch
}

export type DedupKeySpec =
  | "app"
  | "app+summary"
  | "app+summary+body"
  | { template: string } // e.g. "{app}|{summary}"

export interface EffectSpec {
  lifetime?: Lifetime
  ttlMs?: number
  /** Cuánto dura EL POPUP en pantalla, en ms. No confundir con `ttlMs`, que es lo que la
   *  notificación vive en el PANEL: son dos relojes distintos y ninguno implica al otro.
   *  Ausente = decide `popup/logica.ts` con los valores por defecto de Ajustes > General.
   *  Un valor aquí GANA a esos defaults y al `expire_timeout` del emisor —es la forma de
   *  decir «este aviso concreto, 3 s»—, y solo se acota a [1 s, 60 s] para que un 0 o un
   *  valor absurdo del JSON no deje el popup clavado ni lo haga invisible. */
  popupMs?: number
  clearOnBoot?: boolean
  noHistory?: boolean
  suppress?: boolean
  muteAudio?: boolean
  dontShow?: boolean
  /** Ruta absoluta del audio que debe sonar con esta notificación. Es el «ponle este sonido»
   *  del usuario: **hace sonar la notificación aunque quien la emite no pida sonido alguno**
   *  (sin `sound-name` ni `sound-file`), que es justo lo que se busca — una app que nunca ha
   *  sonado no se puede volver sonora de otra forma. Gana al `sound-file`/`sound-name` del
   *  emisor y a su `suppress-sound`, porque es configuración explícita para *estas*
   *  notificaciones concretas; no gana al No molestar ni a `muteAudio` (ver
   *  `sonido/decision.ts`). Un `muteAudio` en la misma regla la deja muda: silenciar es la
   *  intención más específica de las dos. */
  soundFile?: string
  dedupKey?: DedupKeySpec
  conditions?: string[]
  // accent color override (hex, e.g. "#89b4fa"). Highest priority in color resolution:
  // rule color > per-app color > system default (getAppColor).
  color?: string
  // popup skin override. Absent = decide el hint x-gigios-source (sistema → dunst).
  style?: PopupStyle
  // text rewriting templates (see rules/template.ts + rules/notifFields.ts).
  // appName === "" omits the app name entirely from popup/panel.
  rewrite?: { appName?: string; summary?: string; body?: string }
}

export interface NotifRule {
  id: string
  name: string
  enabled: boolean
  priority: number // higher wins on conflict
  /** Procedencia de la REGLA (no confundir con `match.source`, que es el origen de la
   *  NOTIFICACIÓN). `system` = una entrada del catálogo de avisos del sistema: su `match` lo
   *  fija el catálogo y no se edita, solo sus efectos (ver `sistemaStore.ts`). */
  source: "builtin" | "user" | "system"
  match: MatchSpec
  effects: EffectSpec
  stopOnMatch?: boolean
}

// The minimal notification shape the engine needs (decoupled from AstalNotifd / StoredNotification).
export interface NotifInput {
  appName: string
  summary: string
  body: string
  urgency: number
  /** Hint `x-gigios-source`. Ausente = notificación de una app normal. */
  source?: string
  /** Hint `x-gigios-event`. Ausente = el emisor no declara identidad (una app normal, o un
   *  script de sistema al que aún no se le ha dado de alta el id). */
  event?: string
}

export interface NotifMeta {
  lifetime: Lifetime
  expiresAt?: number // ms epoch, only when lifetime === "timed"
  clearOnBoot: boolean
  noHistory: boolean
  muteAudio: boolean
  dontShow: boolean
  dedupKey: string
  conditions: string[]
  matchedRules: string[]
  color?: string // accent color from the highest-priority matched rule, baked at ingest
  style?: PopupStyle // popup skin from the highest-priority matched rule, baked at ingest
  /** Duración del popup en ms fijada por la regla ganadora (ver `EffectSpec.popupMs`).
   *  Se hornea en la meta al ingerir para que la pila de popups no tenga que volver a
   *  evaluar reglas —ni dependa de que sigan existiendo— al programar el descarte. */
  popupMs?: number
}

export interface EvalResult {
  meta: NotifMeta
  suppress: boolean // consumed by ingest; never persisted on the notification
  rewrite?: { appName?: string; summary?: string; body?: string }
  /** `EffectSpec.soundFile` de la regla ganadora. Va aquí y **no en `NotifMeta`** a propósito:
   *  la meta se persiste con la notificación y el sonido se consume una sola vez, al ingerir. */
  soundFile?: string
}
