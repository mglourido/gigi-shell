// modulos/notificaciones/rules/defaults.ts
// Built-in seed rules. Low priority (<100) so user rules and overrides win.
// Editing/disabling a builtin is done via overrides in config/notif-rules.json (rulesStore).
import type { NotifRule } from "./types.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

export const BUILTIN_RULES: NotifRule[] = [
  {
    // Las notificaciones de hypr/scripts (hint `x-gigios-source:system`) se pintan con el skin
    // dunst. Prioridad 10 y SIN stopOnMatch a propósito: es una regla puramente cosmética y no
    // debe tapar a las otras builtin que también casan con notificaciones de sistema
    // (builtin.low-battery, builtin.coredump…). Como el fold es set-once por prioridad y solo
    // esta toca `style`, cualquier regla de usuario que fije un `style` la gana.
    //
    // OJO: al ser una regla, lo que case con ella queda FUERA del historial de "Tipos sin regla"
    // (`shouldIndex`: solo se indexa lo que no casa con ninguna). Es el precio de tenerla visible
    // y desactivable desde la UI; el hint por sí solo hacía lo mismo sin ese efecto.
    id: "builtin.system-dunst",
    name: textos.predefinidas.sistemaDunst,
    enabled: true, priority: 10, source: "builtin",
    match: { source: { op: "equals", value: "system" } },
    effects: { style: "dunst" },
  },
  // NOTA sobre las cuatro builtin de abajo que casan por TEXTO (`crash`, `coredump`,
  // `reboot`, `batería`): siguen aquí porque también pescan notificaciones de APPS que digan
  // eso, pero los avisos del sistema que motivaron su existencia ya no dependen de ellas —
  // cada uno lleva su `clearOnBoot`/`flash` en `catalogoSistema.ts`, atado a su id en vez de
  // a una palabra que cualquiera puede escribir en un título.
  {
    id: "builtin.screenshot",
    name: textos.predefinidas.capturas,
    enabled: true, priority: 50, source: "builtin", stopOnMatch: true,
    match: { summary: { op: "contains", value: "captura" } },
    effects: { suppress: true, noHistory: true },
  },
  {
    id: "builtin.app-crash",
    name: textos.predefinidas.fallosApps,
    enabled: true, priority: 40, source: "builtin",
    match: { summary: { op: "contains", value: "crash" } },
    effects: { clearOnBoot: true },
  },
  {
    id: "builtin.coredump",
    name: textos.predefinidas.volcados,
    enabled: true, priority: 40, source: "builtin",
    match: { body: { op: "contains", value: "coredump" } },
    effects: { clearOnBoot: true },
  },
  {
    id: "builtin.reboot-recommended",
    name: textos.predefinidas.reinicio,
    enabled: true, priority: 40, source: "builtin",
    match: { summary: { op: "contains", value: "reboot" } },
    effects: { clearOnBoot: true },
  },
  {
    id: "builtin.low-battery",
    name: textos.predefinidas.bateriaBaja,
    enabled: true, priority: 30, source: "builtin",
    match: { summary: { op: "contains", value: "batería" } },
    effects: { lifetime: "flash", conditions: ["battery-resolved"] },
  },
  {
    id: "builtin.battery-app",
    name: textos.predefinidas.bateria,
    enabled: true, priority: 30, source: "builtin",
    match: { app: { op: "equals", value: "Batería" } },
    effects: { clearOnBoot: true },
  },
  {
    id: "builtin.whatsapp",
    name: textos.predefinidas.whatsapp,
    enabled: true, priority: 20, source: "builtin",
    match: { app: { op: "contains", value: "whatsapp" } },
    effects: { lifetime: "timed", ttlMs: TWO_DAYS_MS, dedupKey: "app+summary" },
  },
]
