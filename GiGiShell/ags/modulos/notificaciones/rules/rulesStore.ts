// modulos/notificaciones/rules/rulesStore.ts
// Loads built-in rules + user rules/overrides from config/notif-rules.json, exposes a
// reactive compiled index. Editing/disabling a builtin = an override entry keyed by builtin id.
import { createState } from "ags"
import GLib from "gi://GLib"
import type { NotifRule } from "./types.ts"
import { BUILTIN_RULES } from "./defaults.ts"
import { compileRules, type RuleIndex } from "./engine.ts"
import { archivoSistema, reglasSistema } from "./sistemaStore.ts"
import { cargarJson, crearGuardadoJsonProgramado } from "../estado/persistencia.ts"
import { sanearOverrides, sanearReglasUsuario } from "../estado/saneado.ts"

const RULES_PATH = `${GLib.get_user_config_dir()}/gigishell/notif-rules.json`

interface RulesFile {
  userRules: NotifRule[]
  builtinOverrides: Record<string, Partial<NotifRule>> // keyed by builtin id
}

/** Compose builtin seeds (with overrides applied) + the system catalog + user rules.
 *
 *  Las del catálogo NO viven en este fichero (ver `sistemaStore.ts`) pero sí comparten índice
 *  compilado: son reglas normales, con el mismo `EffectSpec` y el mismo plegado por
 *  prioridad, y tenerlas aparte en tiempo de evaluación habría significado dos motores. */
function composeRules(file: RulesFile): NotifRule[] {
  const builtins = BUILTIN_RULES.map(b => {
    const ov = file.builtinOverrides[b.id]
    return ov ? { ...b, ...ov, effects: { ...b.effects, ...(ov.effects ?? {}) }, match: { ...b.match, ...(ov.match ?? {}) } } : b
  })
  return [...builtins, ...reglasSistema(), ...file.userRules]
}

const archivoCargado = cargarJson<Partial<RulesFile>>(RULES_PATH, {}, "rules")
const descartesReglas: string[] = []
const initialFile: RulesFile = {
  // Saneado al cargar: una regla editada a mano sin `match` hacía reventar `compileRules` al
  // importar el módulo, y con él el arranque del shell; un efecto con otro tipo llegaba al motor
  // (perdiendo la notificación entera) o al `text=` de un `Gtk.Entry`. Ver `estado/saneado.ts`.
  userRules: sanearReglasUsuario(archivoCargado.userRules, descartesReglas) as unknown as NotifRule[],
  builtinOverrides: sanearOverrides(archivoCargado.builtinOverrides, descartesReglas) as Record<string, Partial<NotifRule>>,
}
// Se avisa y NO se reescribe el fichero: lo descartado sigue en disco hasta que el usuario guarde
// esa regla, por si quiere arreglarlo a mano en vez de perderlo.
for (const d of descartesReglas) console.warn(`[notif rules] ${RULES_PATH}: ${d}`)

// Reactive: the full rule list and the compiled index.
export const [rulesFile, setRulesFile] = createState<RulesFile>(initialFile)
export const [ruleIndex, setRuleIndex] = createState<RuleIndex>(compileRules(composeRules(initialFile)))

const programarGuardado = crearGuardadoJsonProgramado(
  RULES_PATH,
  "rules",
  800,
  () => rulesFile.get(),
)

function recompile(file: RulesFile): void {
  setRulesFile(file)
  setRuleIndex(compileRules(composeRules(file)))
  programarGuardado()
}

// Tocar un aviso del sistema cambia el índice igual que tocar una regla, pero NO debe
// reescribir `notif-rules.json`: son ficheros distintos y cada uno se guarda solo. De ahí que
// esto recompile a mano en vez de llamar a `recompile`.
archivoSistema.subscribe(() => setRuleIndex(compileRules(composeRules(rulesFile.get()))))

/** Todas las reglas, incluidas las ~100 del catálogo del sistema. La pestaña Reglas las
 *  filtra fuera (`source !== "system"`): tienen su propia pestaña y ahogarían la lista. */
export function allRules(): NotifRule[] { return composeRules(rulesFile.get()) }

/** Lo que se escribe pasa por el MISMO saneado que lo que se lee: así el almacén es la única
 *  puerta, también para quien guarde reglas por código sin pasar por el editor. */
function avisarDescartes(descartes: string[]): void {
  for (const d of descartes) console.warn(`[notif rules] al guardar: ${d}`)
}

export function upsertUserRule(entrada: NotifRule): void {
  const descartes: string[] = []
  const [rule] = sanearReglasUsuario([entrada], descartes) as unknown as NotifRule[]
  avisarDescartes(descartes)
  if (!rule) return // sin `match` válido no hay regla que guardar (ya está en el log)
  const f = rulesFile.get()
  const idx = f.userRules.findIndex(r => r.id === rule.id)
  const userRules = idx >= 0
    ? [...f.userRules.slice(0, idx), rule, ...f.userRules.slice(idx + 1)]
    : [...f.userRules, rule]
  recompile({ ...f, userRules })
}

export function removeUserRule(id: string): void {
  const f = rulesFile.get()
  recompile({ ...f, userRules: f.userRules.filter(r => r.id !== id) })
}

export function setBuiltinOverride(id: string, entrada: Partial<NotifRule>): void {
  const descartes: string[] = []
  const patch = sanearOverrides({ [id]: entrada }, descartes)[id] as Partial<NotifRule>
  avisarDescartes(descartes)
  const f = rulesFile.get()
  recompile({ ...f, builtinOverrides: { ...f.builtinOverrides, [id]: patch } })
}

export function clearBuiltinOverride(id: string): void {
  const f = rulesFile.get()
  const { [id]: _, ...rest } = f.builtinOverrides
  recompile({ ...f, builtinOverrides: rest })
}
