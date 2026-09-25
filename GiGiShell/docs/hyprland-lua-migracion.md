# Hyprland: migración a config Lua

Detalle completo de la migración de hyprlang a Lua (motivo, qué cambió, trampas medidas).
Referenciado desde `CLAUDE.md`. Leer antes de tocar cualquier `.lua` bajo `hypr/` si hace falta el porqué completo.

## ⚠️ El config es LUA (migrado el 2026-07-23, hyprlang ya retirado del repo)

Desde Hyprland 0.55 hyprlang está deprecado: **si existe `hyprland.lua`, Hyprland lo carga y no
mira ningún `hyprland.conf`** (no conviven; la comprobación es una sola vez al arrancar). El config
de esta máquina es **`hypr/hyprland.lua`** + los módulos de **`hypr/gigishell/*.lua`**. Los `.conf` de
hyprlang **ya no están en el repo**: se borraron al terminar la migración, tras verificar la sesión
real. `git` los conserva si hiciera falta consultarlos.

Los `.conf` que **siguen** en `hypr/` son de **otros programas** —`hypridle`, `hyprlock`,
`hyprpaper`—, binarios `hypr*` aparte que mantienen hyprlang a propósito. Toda la lógica de
`idle-action.sh`, la puerta del Wake Up y el truco `# GIGISHELL-OFF` sigue exactamente igual.

**Si un arranque sale mal** (desde una TTY con Ctrl+Alt+F2 si no hay escritorio): **un error de Lua
deja la sesión SIN ATAJOS** salvo el de emergencia (`SUPER + Q`, que aquí abre kitty), así que desde
esa terminal se arregla el módulo o se recupera con
`dotfiles checkout -- GiGiShell/hypr`. `--verify-config` solo detecta errores de **parseo**, no de
ejecución — por eso cada módulo se carga con `util.carga` (require + pcall): uno roto avisa en
pantalla y el resto sigue, que es lo que evita el escenario "sin atajos" en la práctica.
`bin/preflight.sh` pasa `--verify-config` sobre `hyprland.lua`, así que un error de sintaxis no
llega a commitearse.

**Lo que cambia para cualquiera que toque esto:**

- **`hyprctl keyword` YA NO EXISTE** (`keyword can't work with non-legacy parsers. Use eval.`).
  El equivalente es `hyprctl eval 'hl.config({...})'`.
- **`hyprctl dispatch` con sintaxis legacy TAMPOCO funciona** — se reinterpreta como código Lua y
  da error de sintaxis. La forma es `hyprctl dispatch "hl.dsp.exec_cmd('cmd')"`. Ojo: en sesión
  legacy la forma Lua responde `Invalid dispatcher` **con rc=0**, y en sesión Lua la legacy también
  falla sin rc útil — **hay que mirar el stdout (`ok`), nunca el código de salida**. Los scripts
  migrados (`idle-action.sh`, `anclaje.py`, `lanzar-anclado.py`) llevan por eso fallback inline.
- **UN DISPATCHER CONMUTABLE CON ARGUMENTO DE CADENA ES UN TOGGLE, Y RESPONDE `ok`.** El caso
  medido: `hl.dsp.dpms('on')`. `Internal::tableToggleAction()` (`LuaBindingsInternal.cpp:444`)
  empieza por `if (!lua_istable(L, idx)) return CA::TOGGLE_ACTION_TOGGLE` — un string no es una
  tabla, así que el `'on'` **no se llega ni a leer**. `parseToggleStr()` sí entiende
  `on/off/enable/disable`, pero solo se le llama desde la rama de tabla. La forma correcta es
  `hl.dsp.dpms({ action = 'on' })`, la que ya usaba `gigishell/boton-apagado.lua`.
  Afecta a todos los `eTogglableAction`, no solo a dpms.
  **Por qué es tan caro de encontrar**: no hay error, el rc es 0 y el stdout es `ok`, así que la
  regla de "mira el stdout, no el rc" —la del punto anterior— tampoco lo detecta; un `|| repliegue`
  guardado por `grep -q "^ok"` nunca dispara. El único síntoma es que el estado sale invertido, y
  solo cuando el estado de partida no era el que suponías. Ver la sección de suspensión en
  [`hyprland-modulos.md`](hyprland-modulos.md).
- **`hyprctl binds -j` devuelve JSON válido desde 0.56.1**; en 0.56.0 usa la salida de texto por el fallo de esa versión.
- **Los callbacks (`hl.on`, binds con función) tienen timeout de 100 ms**: nada bloqueante dentro.
  Los `*-monitor.sh` siguen en bash por eso, lanzados igual desde `gigishell/autostart.lua`.
- **Lo que se inlineó** (ya no se invocan sus scripts, que quedan solo para la config legacy):
  `toggle-gaps-borders.sh` → `GiGiShell.toggle_gaps()`, `aplicar-filtro-daltonismo.sh` →
  `GiGiShell.daltonismo(modo)`, `boton-apagado.sh` → `GiGiShell.boton_apagado()`,
  `compact-workspaces.sh` → `GiGiShell.compactar()`, `escaner-apps-inicio.sh` →
  `gigishell/escaner-apps.lua`. Son globals del config, así que **AGS los llama por
  `hyprctl eval 'GiGiShell.daltonismo("...")'`** (verificado: `eval` comparte el estado Lua del config).
- **`keybinds-nop.conf` (335 líneas) y `generar-nop-binds.sh` están OBSOLETOS**: los 317 binds
  sordos los calcula ahora un bucle en `gigishell/nop-binds.lua` contra la tabla `usados` que llena el
  envoltorio `bind()` de `gigishell/keybinds.lua`. **Todo atajo nuevo debe pasar por ese envoltorio**,
  no por `hl.bind` directo (no da error: solo deja un bind sordo duplicado encima). El no-op es
  `hl.dsp.no_op()` nativo, no el `submap, reset` de antes.
- **El perfil de GPU ya no se descomenta a mano**: lo elige `~/.config/gigishell/gpu-perfil`, un
  fichero local de una línea (`sobremesa-nvidia`) **fuera del repo** — la elección de máquina es
  estado local, como manda `docs/anadir-perfiles-por-equipo.md`. Ausente o inválido = ningún perfil
  + aviso en pantalla (fail-open: el compositor arranca igual).
- **AGS YA NO GENERA CÓDIGO: escribe JSON y el config lo lee.** Fue lo último que quedó de la
  migración y se cerró después: los ajustes de la UI viajaban como chunks Lua generados
  (`monitor-settings.lua`, `input-settings.lua`) más un bloque de idioma reescrito dentro de
  `gigishell/env.lua`. Hoy `gigishell/pantalla.lua` lee `display.json`, `gigishell/dispositivos.lua` lee
  `devices.json` y `gigishell/env.lua` saca el idioma de `datetime.json` — con `util.leer_json` y
  condiciones, que es justo lo que hyprlang no permitía. Se quitaron tres problemas de raíz: el
  mismo dato escrito **dos veces** (y capaz de divergir si el volcado fallaba, que lo hacía en
  silencio), ficheros **machine-specific dentro del árbol de git**, y el **escapado** de cadenas
  interpoladas en un chunk (la `description` del EDID sale del monitor: una comilla suelta rompía
  la config entera). `util.carga_opcional` desapareció con ellos. Un JSON ausente o corrupto
  degrada al comodín (240 Hz → 60, escala 1.25 → 1) sin tumbar la sesión.
- **Sin decodificador JSON nativo** en el intérprete embebido: hay uno vendorizado en
  `gigishell/json.lua` (solo lectura). `io`, `os.execute`, `require` y `dofile` sí están (Lua 5.5), y
  `package.path` apunta al directorio del config, así que `require("gigishell.x")` resuelve solo.

**Trampas medidas al portar** (no las redescubras):

- **`size = "60% 60%"` NO funciona en Lua.** `size`/`move` van al motor de expresiones (muParser),
  que **no tiene operador `%`**: la regla se registra sin error, no sale nada en el log ni en
  `configerrors`, y el tamaño sencillamente no se aplica. Se escribe `monitor_w*0.6 monitor_h*0.6`.
- **Los `bindm` van SIN OPTS.** Las dos opciones que parecen valer fallan, cada una a su manera.
  **`{mouse=true}`** —la del ejemplo oficial de `/usr/share/hypr/hyprland.lua`— **no existe**:
  `hlBind` nunca lee esa clave (medido: `Keybind.mouse` queda `false`), así que es un adorno.
  **`{drag=true}` sí se lee, y por eso es la peligrosa: se come el PRIMER arrastre de cada sesión**
  —el segundo y siguientes van—, tanto al mover como al redimensionar. `drag` fuerza
  `release = true`, y en `handleKeybinds` la **pulsación** de un bind con release solo llega al
  dispatcher si es un `SPECIALDISPATCHER`; para un handler `__lua` eso significa tener ya puesto
  `releasePending`, flag que pone el propio dispatcher del ratón **al ejecutarse**. En el primer
  clic aún es falso: la pulsación se traga sin iniciar nada y solo el soltar (que llega como
  "terminar arrastre", o sea nada) deja el flag listo para la vez siguiente. El ciclo entero se
  retrasa un clic, sin ningún error por ningún lado. Sin opts la pulsación entra directa, arranca
  el arrastre y de paso pone `releasePending` — que es lo que hace entrar también al soltar, el
  camino que el compositor tiene pensado para los dispatchers de ratón en Lua. Peaje aceptado: un
  SUPER+clic sin mover inicia y termina el arrastre al instante (inofensivo, y es el
  comportamiento clásico de `bindm`; con `binds:drag_threshold = 0` no había umbral que perder).
- **`cursor:no_hardware_cursors = false` se descarta en silencio** en 0.56 (queda en auto). Por eso
  `gpu/laptop-hibrida.lua` no la pone.
- **En `hl.dsp.window.move`, "silent" se dice `follow = false`** (un `silent = true` se ignora), y el
  selector por string necesita el prefijo `address:` — un `'0x…'` a secas no casa y el dispatcher
  mueve **la ventana activa**. `hl.get_window("0x…")` devuelve `nil`: el objeto sale de
  `hl.get_windows()`.

**Lo que se llevó por delante la limpieza** (todo sustituido, nada perdido): los `.conf` portados,
`keybinds-nop.conf` y `generar-nop-binds.sh`, y los cinco scripts inlineados
(`toggle-gaps-borders.sh`, `aplicar-filtro-daltonismo.sh`, `boton-apagado.sh`,
`compact-workspaces.sh`, `escaner-apps-inicio.sh`). `bin/preflight.sh` ya no parsea `source =`:
valida los `util.carga()` de `hyprland.lua`, los perfiles de `gigishell/gpu.lua`, las rutas de
`gigishell/autostart.lua` y que el config pase `--verify-config`.

**La sección "Atajos" de Orion parsea el CONFIG COMO CÓDIGO FUENTE**, y eso era el bloqueante de
esta limpieza: leía `keybinds.conf` + `variables.conf` como texto. Hoy lee `gigishell/keybinds.lua` +
`gigishell/variables.lua` (`ags/modulos/orion/data/keybinds.parse.ts`, lógica pura; este checkout no contiene su archivo de pruebas). El
Lua trae dos formas que hyprlang no tenía y que el parser **debe** entender: expresiones
(`mod .. " + SHIFT + F"`) y **bucles** — los 20 atajos de workspace y los 8 de foco/movimiento ya no
están escritos uno a uno. Sin expandir los bucles la lista perdía 28 de 67 atajos **en silencio**,
de ahí la comprobación que cuenta las combinaciones.

**La comprobación cuenta COMBINACIONES, no llamadas a `bind()`, y esa distinción no es cosmética.**
Hyprland ejecuta **todos** los binds de una combinación, y el config se apoya en eso: `SUPER + clic
izquierdo` lleva **tres** (el `bindm` del arrastre más los dos enganches con los que
`gigishell/reparto-ventanas.lua` sabe cuándo empieza y cuándo acaba). Los enganches no son atajos que
se puedan pulsar por separado, así que listarlos duplicaba la fila en Orion y la llenaba de nombres
internos (`GiGiShell: reparto_arrastre_inicio`). El parser **deduplica por combinación y gana el
primero**, que es el que describe lo que la combinación hace de cara al usuario — los enganches se
registran después a propósito. Así el recuento cuadra con la tabla `usados` de `gigishell/keybinds.lua`,
que también es un conjunto de combinaciones (verificado en vivo: 69 y 69). Sin la dedup la prueba de regresión
fallaba, porque el número esperado se escribió contra `usados` y el parser contaba
llamadas.

**Un atajo nuevo cuyo bind llame a una función de `GiGiShell` necesita su etiqueta** en
`GIGISHELL_LABELS` (`keybinds.parse.ts`), o sale en la lista como `GiGiShell: <nombre_de_la_función>`. Y
**el titular de una sección tiene que ir en UNA sola línea**, precedido de una línea en blanco y sin
otro comentario debajo: es lo que distingue un encabezado de la prosa que documenta el módulo. Un
bloque explicativo de varias líneas **no abre grupo**, y sus atajos se cuelan en la sección
anterior sin dar ningún error.
