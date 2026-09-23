// Lógica PURA de la sección "Atajos" de Orion: convierte el texto de
// `hypr/gigios/keybinds.lua` (+ `gigios/variables.lua`) en grupos legibles.
// Sin acceso a disco ni a GI, para que los tests de node puedan ejecutarla;
// el envoltorio con IO y estado reactivo es `keybinds.ts`.
// Antes se parseaba `keybinds.conf` + `variables.conf`. Con la migración de
// Hyprland a config Lua esos ficheros dejaron de ser el config vivo y se
// borraron; el origen es ahora el módulo Lua, que trae DOS formas que hyprlang
// no tenía y que este parser sí debe entender:
//
//   1. **Expresiones**, no literales: la tecla se escribe `mod .. " + SHIFT + F"`,
//      con `mod`/`vars.*` viniendo de `gigios/variables.lua` (el sustituto de
//      las `$variables`). `evaluarConcat` las resuelve.
//   2. **Bucles**: los 20 binds de workspace y los 8 de movimiento/foco ya no
//      están escritos uno a uno, sino en un `for`. `expandirBucles` los
//      despliega — sin eso, la lista perdería 28 de los 67 atajos en silencio.
//
// El modo de fallo a vigilar sigue siendo el de antes: esto parsea CÓDIGO
// FUENTE, así que una forma nueva en keybinds.lua (un tercer tipo de bucle, un
// dispatcher no contemplado) no da error — solo hace que ese atajo salga con
// una descripción genérica o no salga. Los tests de node cubren el recuento.


export interface Keybind { binding: string; description: string }
export interface KeybindGroup { name: string; binds: Keybind[] }

/** `gigios/variables.lua` → { mainMod: "SUPER", terminal: "kitty", … }.
 *  Es una tabla de literales (`clave = "valor",`), así que no hace falta
 *  evaluar Lua: basta con leer los pares. */
function loadVars(fuente: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of fuente.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*"([^"]*)"\s*,?\s*$/)
    if (m) vars[m[1]] = m[2]
  }
  return vars
}

const KEY_NAMES: Record<string, string> = {
  SUPER: "Super", CTRL: "Ctrl", SHIFT: "Shift", ALT: "Alt",
  Print: "PrtScn", Space: "Espacio", Return: "Enter", Tab: "Tab",
  period: ".",
  left: "←", right: "→", up: "↑", down: "↓",
  mouse_down: "Scroll↓", mouse_up: "Scroll↑",
  "mouse:272": "Click izq", "mouse:273": "Click der",
  XF86AudioRaiseVolume: "Vol↑", XF86AudioLowerVolume: "Vol↓",
  XF86AudioMute: "Mute", XF86AudioMicMute: "Mic Mute",
  XF86MonBrightnessUp: "Brillo↑", XF86MonBrightnessDown: "Brillo↓",
  XF86AudioNext: "Media Next", XF86AudioPause: "Media Pausa",
  XF86AudioPlay: "Media Play", XF86AudioPrev: "Media Prev",
  XF86Calculator: "Calculadora", XF86PowerOff: "Botón encendido",
}

// El Lua escribe las teclas en mayúsculas (`SPACE`, `LEFT`) donde el .conf las
// traía capitalizadas; se busca sin distinguir caja para no duplicar entradas.
const KEY_NAMES_LOWER: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_NAMES).map(([k, v]) => [k.toLowerCase(), v]),
)

function fmtKey(k: string): string {
  return KEY_NAMES[k] ?? KEY_NAMES_LOWER[k.toLowerCase()] ?? k
}

export function fmtBinding(rawMods: string, rawKey: string): string {
  const parts: string[] = []
  if (rawMods.trim()) rawMods.trim().split(/\s+/).forEach(m => parts.push(fmtKey(m)))
  parts.push(fmtKey(rawKey.trim()))
  return parts.join("+")
}

/** "SUPER + SHIFT + F" → { mods: "SUPER SHIFT", key: "F" }. El último token es
 *  siempre la tecla; el resto, modificadores. */
function partirCombo(combo: string): { mods: string; key: string } {
  const tokens = combo.split("+").map(t => t.trim()).filter(Boolean)
  const key = tokens.pop() ?? ""
  return { mods: tokens.join(" "), key }
}

const EXEC_PATTERNS: [RegExp, string][] = [
  [/toggle-fake-fullscreen/, "Simular ventana maximizada"],
  [/toggle-gaps-borders/, "Pegar ventanas (toggle)"],
  [/compact-workspaces/, "Compactar workspaces"],
  [/kitty/, "Abrir terminal"],
  [/dolphin/, "Abrir gestor de archivos"],
  [/nautilus/, "Abrir gestor de archivos"],
  [/firefox/, "Abrir Firefox"],
  [/\bcode\b/, "Abrir VS Code"],
  [/obsidian/, "Abrir Obsidian"],
  [/discord/, "Abrir Discord"],
  [/emoji-picker|rofimoji/, "Abrir selector de emojis"],
  [/clipboard-history|cliphist.*wl-copy|rofi.*dmenu/, "Abrir portapapeles"],
  [/rofi-launch|rofi.*drun|hyprlauncher|pkill.*rofi/, "Abrir lanzador de apps"],
  [/hyprshot.*region/, "Captura de región"],
  [/hyprshot.*output/, "Captura de pantalla"],
  [/wf-recorder.*slurp/, "Grabar región de pantalla"],
  [/grabar-pantalla\.sh\s+ventana/, "Grabar ventana seleccionada (toggle)"],
  [/grabar-pantalla\.sh|record\.sh|wf-recorder/, "Grabar pantalla (toggle)"],
  [/qalculate/, "Abrir calculadora"],
  [/hyprshutdown|hyprctl.*exit/, "Salir de Hyprland"],
  [/wpctl.*set-volume.*%\+/, "Subir volumen"],
  [/wpctl.*set-volume.*%-/, "Bajar volumen"],
  [/wpctl.*set-mute.*SOURCE/, "Silenciar/activar micrófono"],
  [/wpctl.*set-mute/, "Silenciar/activar audio"],
  [/brightness-up/, "Subir brillo"],
  [/brightness-down/, "Bajar brillo"],
  [/playerctl next/, "Siguiente pista"],
  [/playerctl previous/, "Pista anterior"],
  [/playerctl play-pause/, "Play / Pausa"],
  [/toggle-orion|ags toggle orion/, "Mostrar/ocultar panel Orion"],
  [/toggle-bar|ags-bar-toggle/, "Mostrar/ocultar barra"],
  [/toggle-quicksettings/, "Mostrar/ocultar ajustes rápidos"],
  [/toggle-notifications/, "Mostrar/ocultar notificaciones"],
  [/toggle-settings/, "Mostrar/ocultar ajustes"],
  [/toggle-suspension-falsa/, "Entrar/salir de suspensión falsa"],
]

function describeExec(cmd: string): string {
  for (const [re, label] of EXEC_PATTERNS) if (re.test(cmd)) return label
  return `Ejecutar ${cmd.trim().split(/[\s/]+/).filter(Boolean).pop() ?? cmd}`
}

// Los binds inlineados en Lua no ejecutan un script: llaman a una función del
// global GiGiShell que define su propio módulo (ver el CLAUDE.md raíz).
const GIGIOS_LABELS: Record<string, string> = {
  compactar: "Compactar workspaces",
  toggle_gaps: "Pegar ventanas (toggle)",
  boton_apagado: "Acción del botón de encendido",
  daltonismo: "Filtro de daltonismo",
  saltar_ancla: "Ir al escritorio ancla / volver",
  anclar_escritorio: "Anclar este escritorio (toggle)",
  toggle_orion: "Abrir Orion (toggle)",
}

const DIRS: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", l: "←", r: "→", u: "↑", d: "↓" }

/** Valor de un campo de una tabla Lua inline: `{ workspace = 3 }` → "3". */
function campo(expr: string, nombre: string): string | null {
  const m = expr.match(new RegExp(`${nombre}\\s*=\\s*("([^"]*)"|[\\w.+-]+)`))
  if (!m) return null
  return m[2] ?? m[1]
}

/** Descripción legible a partir de la expresión del dispatcher. */
function describeDispatcher(expr: string, vars: Record<string, string>): string {
  const e = expr.trim()

  // Closure: `function() … GiGiShell.compactar() … end`
  const gigios = e.match(/GiGiShell\.(\w+)\s*\(/)
  if (gigios) return GIGIOS_LABELS[gigios[1]] ?? `GiGiShell: ${gigios[1]}`

  const exec = e.match(/hl\.dsp\.exec_cmd\s*\(/)
  if (exec) {
    // El comando se describe por su TEXTO, así que hay que resolver antes las
    // `vars.*` — `hl.dsp.exec_cmd(vars.terminal)` no casa con ningún patrón,
    // pero `kitty` sí. Sin esto la fila salía como "Ejecutar
    // hl.dsp.exec_cmd(vars.terminal)".
    const llamada = extraerLlamada(e, exec.index!)
    const cmd = llamada ? evaluarConcat(llamada.args.join(","), vars, {}) : e
    return describeExec(cmd)
  }

  if (/hl\.dsp\.window\.fullscreen/.test(e)) {
    return campo(e, "mode") === "maximized" ? "Maximizar ventana" : "Pantalla completa"
  }
  if (/hl\.dsp\.window\.close/.test(e)) return "Cerrar ventana activa"
  if (/hl\.dsp\.window\.float/.test(e)) return "Alternar flotante"
  if (/hl\.dsp\.window\.drag/.test(e)) return "Mover ventana (arrastrar)"
  if (/hl\.dsp\.window\.resize/.test(e)) return "Redimensionar ventana (arrastrar)"
  if (/hl\.dsp\.window\.move/.test(e)) {
    const dir = campo(e, "direction")
    if (dir) return `Mover ventana ${DIRS[dir] ?? dir}`
    const ws = campo(e, "workspace")
    if (ws?.startsWith("special")) return "Mover al scratchpad"
    return `Mover ventana → workspace ${ws}`
  }
  if (/hl\.dsp\.focus/.test(e)) {
    const dir = campo(e, "direction")
    if (dir) return `Mover foco ${DIRS[dir] ?? dir}`
    const ws = campo(e, "workspace")
    if (ws === "e+1") return "Workspace siguiente"
    if (ws === "e-1") return "Workspace anterior"
    return `Ir al workspace ${ws}`
  }
  if (/hl\.dsp\.workspace\.toggle_special/.test(e)) return "Mostrar/ocultar scratchpad"
  if (/hl\.dsp\.layout/.test(e)) {
    return /togglesplit/.test(e) ? "Cambiar división" : "Cambiar layout"
  }
  if (/hl\.dsp\.exit/.test(e)) return "Salir de Hyprland"
  return e.replace(/^hl\.dsp\./, "").split("(")[0]
}

/** Evalúa una expresión Lua de concatenación limitada a lo que usa el módulo:
 *  literales `"…"`, `mod`, `vars.X` y la variable del bucle. */
function evaluarConcat(expr: string, vars: Record<string, string>, bucle: Record<string, string>): string {
  const partes = expr.split("..").map(p => p.trim())
  let out = ""
  for (const p of partes) {
    const lit = p.match(/^"([^"]*)"$/)
    if (lit) { out += lit[1]; continue }
    if (p === "mod") { out += vars.mainMod ?? "SUPER"; continue }
    const v = p.match(/^vars\.(\w+)$/)
    if (v) { out += vars[v[1]] ?? ""; continue }
    if (p in bucle) { out += bucle[p]; continue }
    const tostr = p.match(/^tostring\((\w+)\)$/)
    if (tostr && tostr[1] in bucle) { out += bucle[tostr[1]]; continue }
    out += p   // token desconocido: se deja visible en vez de perderlo
  }
  return out
}

/** Extrae los argumentos de la llamada `bind(` que empieza en `desde`,
 *  equilibrando paréntesis/llaves y respetando las cadenas. Devuelve también
 *  dónde termina, para seguir escaneando. */
function extraerLlamada(src: string, desde: number): { args: string[]; fin: number } | null {
  let i = src.indexOf("(", desde)
  if (i < 0) return null
  let prof = 0
  let enCadena: string | null = null
  const args: string[] = []
  let actual = ""
  for (; i < src.length; i++) {
    const c = src[i]
    if (enCadena) {
      actual += c
      if (c === "\\") { actual += src[++i] ?? ""; continue }
      if (c === enCadena) enCadena = null
      continue
    }
    if (c === '"' || c === "'") { enCadena = c; actual += c; continue }
    if (c === "(" || c === "{") {
      prof++
      if (prof === 1) continue          // el paréntesis de apertura de bind(
      actual += c; continue
    }
    if (c === ")" || c === "}") {
      prof--
      if (prof === 0) { args.push(actual); return { args, fin: i + 1 } }
      actual += c; continue
    }
    if (c === "," && prof === 1) { args.push(actual); actual = ""; continue }
    actual += c
  }
  return null
}

/** Aritmética entera mínima para resolver los `local` de dentro de un bucle
 *  (`tostring(i % 10)` con la `i` ya sustituida). Deliberadamente NO evalúa
 *  expresiones arbitrarias: solo número, `a % b`, `a + b` y `tostring(...)`. */
function evaluarAritmetica(expr: string): string | null {
  let e = expr.trim()
  const ts = e.match(/^tostring\s*\((.*)\)$/)
  if (ts) e = ts[1].trim()
  const lit = e.match(/^"([^"]*)"$/)
  if (lit) return lit[1]
  if (/^\d+$/.test(e)) return e
  const op = e.match(/^(\d+)\s*([%+\-*])\s*(\d+)$/)
  if (!op) return null
  const [a, b] = [Number(op[1]), Number(op[3])]
  switch (op[2]) {
    case "%": return String(a % b)
    case "+": return String(a + b)
    case "-": return String(a - b)
    case "*": return String(a * b)
    default:  return null
  }
}

/** Despliega los `for` de keybinds.lua para que sus binds cuenten como líneas
 *  sueltas. Soporta las dos formas que usa el módulo:
 *    for _, d in ipairs({ "left", … }) do … end
 *    for i = 1, 10 do … end
 *  Cada expansión conserva el número de línea del `for`, que es lo que ancla
 *  el bind a su grupo. */
function expandirBucles(lineas: string[]): { texto: string; linea: number }[] {
  const salida: { texto: string; linea: number }[] = []
  for (let i = 0; i < lineas.length; i++) {
    const ipairs = lineas[i].match(/^\s*for\s+[\w,\s]+\s+in\s+ipairs\(\{(.+?)\}\)\s*do\s*$/)
    const numerico = lineas[i].match(/^\s*for\s+(\w+)\s*=\s*(\d+)\s*,\s*(\d+)\s*do\s*$/)
    if (!ipairs && !numerico) { salida.push({ texto: lineas[i], linea: i }); continue }

    // Cuerpo del bucle hasta su `end` (los bucles de este módulo no anidan).
    const cuerpo: string[] = []
    let j = i + 1
    for (; j < lineas.length && !/^\s*end\s*$/.test(lineas[j]); j++) cuerpo.push(lineas[j])

    let valores: string[] = []
    let nombre = "_"
    if (ipairs) {
      nombre = (lineas[i].match(/for\s+[\w]+\s*,\s*(\w+)\s+in/) ?? [])[1] ?? "_"
      valores = ipairs[1].split(",").map(v => v.trim().replace(/^"|"$/g, ""))
    } else if (numerico) {
      nombre = numerico[1]
      const [ini, fin] = [Number(numerico[2]), Number(numerico[3])]
      for (let n = ini; n <= fin; n++) valores.push(String(n))
    }

    for (const val of valores) {
      // Sustituciones vigentes en esta vuelta: la variable del bucle más los
      // `local` que el cuerpo derive de ella. Sin lo segundo, el bucle de
      // workspaces (`local tecla = tostring(i % 10)`) dejaba 20 atajos con la
      // tecla literal "tecla" en vez de 1..0.
      const subs: Record<string, string> = { [nombre]: /^\d+$/.test(val) ? val : `"${val}"` }
      for (const l of cuerpo) {
        let s = l
        for (const [k, v] of Object.entries(subs)) {
          s = s.replace(new RegExp(`\\b${k}\\b`, "g"), v)
        }
        // `local X = tostring(<aritmética>)` → se calcula y pasa a ser otra
        // sustitución; la línea en sí no aporta ningún bind.
        const asignacion = s.match(/^\s*local\s+(\w+)\s*=\s*(.+?)\s*(--.*)?$/)
        if (asignacion) {
          const valor = evaluarAritmetica(asignacion[2])
          if (valor !== null) { subs[asignacion[1]] = `"${valor}"`; continue }
        }
        salida.push({ texto: s, linea: i })
      }
    }
    i = j   // saltar al `end`
  }
  return salida
}

function formatGroupName(comment: string): string {
  let s = comment.replace(/^[-\s]+/, "").replace(/[-\s]+$/, "").trim()
  // Solo la primera frase: los comentarios del módulo empiezan por el titular
  // y siguen explicando ("Botón de encendido físico. La acción la decide…").
  s = s.split(/\.\s/)[0].replace(/\.$/, "").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""
}

/** Grupo vigente en cada línea del fichero original. Un grupo empieza en un
 *  banner (`----------- nombre`) o en un comentario de UNA sola línea precedido
 *  de línea en blanco.
 *
 *  Lo de "una sola línea" es la diferencia con la regla que se usaba en
 *  keybinds.conf, y hace falta porque el módulo Lua documenta bastante más:
 *  sin ella, cada párrafo explicativo (el del botón de encendido, el del
 *  envoltorio bind) abría un grupo con su primera frase de título. Un titular
 *  de sección va solo; la prosa viene en bloque. */
function gruposPorLinea(lineas: string[]): string[] {
  const out: string[] = []
  let actual = "General"
  let prevBlank = true
  for (let i = 0; i < lineas.length; i++) {
    const t = lineas[i].trim()
    if (!t) { prevBlank = true; out.push(actual); continue }
    const banner = t.match(/^-{4,}\s*(\S.*)$/)
    const suelto = t.match(/^--\s+(\S.*)$/)
    const siguienteEsComentario = /^\s*--/.test(lineas[i + 1] ?? "")
    if (banner) {
      const n = formatGroupName(banner[1])
      if (n) actual = n
    } else if (suelto && prevBlank && !siguienteEsComentario) {
      const n = formatGroupName(suelto[1])
      if (n) actual = n
    }
    prevBlank = false
    out.push(actual)
  }
  return out
}

/** Núcleo puro: recibe el TEXTO de los dos módulos Lua, sin tocar disco ni GI,
 *  para que los tests de node puedan cubrirlo (ver keybinds.parse.test.ts). */
export function parseKeybindsFrom(fuenteKeybinds: string, fuenteVariables: string): KeybindGroup[] {
  const vars = loadVars(fuenteVariables)
  const lineas = fuenteKeybinds.split("\n")

  const grupoDe = gruposPorLinea(lineas)
  const expandido = expandirBucles(lineas)

  // El escaneo va sobre el texto unido para que una llamada repartida en varias
  // líneas (las hay: los exec largos y los closures) se lea entera.
  const texto = expandido.map(e => e.texto).join("\n")
  const inicioDeLinea: number[] = []
  let acc = 0
  for (const e of expandido) { inicioDeLinea.push(acc); acc += e.texto.length + 1 }

  const orden: string[] = []
  const porGrupo = new Map<string, Keybind[]>()
  // Global, no por grupo: una combinación es única en toda la configuración.
  const vistos = new Set<string>()

  // `[^\w.]` descarta `hl.bind(`; el `function` descarta la DEFINICIÓN del
  // envoltorio (`local function bind(keys, dsp, opts)`), que si no se cuela
  // como un atajo fantasma con la firma por combinación.
  const re = /(^|[^\w.])bind\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(texto)) !== null) {
    if (/\bfunction\s*$/.test(texto.slice(Math.max(0, m.index - 12), m.index + 1))) continue
    const llamada = extraerLlamada(texto, m.index)
    if (!llamada || llamada.args.length < 2) continue
    re.lastIndex = llamada.fin

    const combo = evaluarConcat(llamada.args[0], vars, {})
    if (!combo.trim()) continue
    const { mods, key } = partirCombo(combo)
    const binding = fmtBinding(mods, key)

    // UNA fila por COMBINACIÓN, no por llamada a bind(). Hyprland ejecuta todos
    // los binds de una combinación, y el config se apoya en eso: SUPER + clic
    // izquierdo lleva TRES (el arrastre nativo más los dos enganches con los que
    // gigios/reparto-ventanas.lua sabe cuándo empieza y acaba). Los enganches no
    // son atajos que el usuario pueda pulsar por separado, así que listarlos
    // duplicaba la fila y la llenaba de nombres internos
    // (`GiGiShell: reparto_arrastre_inicio`). Gana el PRIMERO: es el que describe lo
    // que la combinación hace de cara al usuario, porque los enganches se
    // registran después a propósito (conviven con el bindm, no lo sustituyen).
    // Esto es además lo que hace que el recuento cuadre con la tabla `usados` de
    // gigios/keybinds.lua, que también es un conjunto de combinaciones.
    if (vistos.has(binding)) continue
    vistos.add(binding)

    const description = describeDispatcher(llamada.args.slice(1).join(","), vars)

    // Línea original de esta llamada → grupo al que pertenece.
    let idx = inicioDeLinea.findIndex(p => p > m!.index) - 1
    if (idx < 0) idx = expandido.length - 1
    const grupo = grupoDe[expandido[idx]?.linea ?? 0] ?? "General"

    if (!porGrupo.has(grupo)) { porGrupo.set(grupo, []); orden.push(grupo) }
    porGrupo.get(grupo)!.push({ binding, description })
  }

  return orden.map(name => ({ name, binds: porGrupo.get(name)! }))
}
