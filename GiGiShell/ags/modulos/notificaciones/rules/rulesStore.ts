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

const RULES_PATH = `${GLib.get_user_config_dir()}/gigios/notif-rules.json`

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
const initialFile: RulesFile = {
  userRules: archivoCargado.userRules ?? [],
  builtinOverrides: archivoCargado.builtinOverrides ?? {},
}

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

export function upsertUserRule(rule: NotifRule): void {
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

export function setBuiltinOverride(id: string, patch: Partial<NotifRule>): void {
  const f = rulesFile.get()
  recompile({ ...f, builtinOverrides: { ...f.builtinOverrides, [id]: patch } })
}

export function clearBuiltinOverride(id: string): void {
  const f = rulesFile.get()
  const { [id]: _, ...rest } = f.builtinOverrides
  recompile({ ...f, builtinOverrides: rest })
}
