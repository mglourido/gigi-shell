-- Los atajos de teclado. Los nombres de app y las rutas salen de
-- gigios/variables.lua (lo que en hyprlang eran las $variables).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️  TODO ATAJO DE ESTE MÓDULO PASA POR EL ENVOLTORIO bind(), NUNCA POR
--     hl.bind DIRECTO.
-- ═══════════════════════════════════════════════════════════════════════════
-- El envoltorio anota cada combinación en `usados` (normalizada), y esa tabla
-- es la que gigios/nop-binds.lua consulta para NO poner un bind sordo encima
-- de un atajo real. Un atajo nuevo registrado con hl.bind directo NO da ningún
-- error: simplemente nop-binds no se entera y la combinación queda con DOS
-- binds — el tuyo y un no_op sordo de más. Hyprland ejecuta ambos, así que es
-- inofensivo, pero deja los sordos sin reflejar la realidad. Usa el
-- envoltorio.
--
-- Mapeo de tipos de bind de hyprlang a opts de hl.bind:
--   bind   → sin opts          bindl  → { locked = true }
--   bindel → { repeating = true, locked = true }
--   bindm  → SIN OPTS. Ni { mouse = true } (la clave no existe en el parser de
--     opts de hl.bind — medido en 0.56: Keybind.mouse queda false con ella; el
--     ejemplo oficial de /usr/share/hypr/hyprland.lua la lleva de adorno sin
--     que nadie la lea) ni { drag = true }, que ROMPE el primer arrastre. Ver
--     el porqué junto a los binds del ratón, más abajo.

local util = require("gigios.util")
local vars = require("gigios.variables")

local mod = vars.mainMod

-- gigios/ventanas.lua presta el envoltorio que apaga dwindle:smart_split
-- mientras dura una inserción en la que NO hay un ratón señalando el destino
-- (allí está el porqué y la medición). Aquí lo pide SUPER+SHIFT+número.
--
-- pcall + repliegue a "ejecuta la acción tal cual", por el mismo motivo que el
-- require de `aspecto` del final: si ventanas.lua llegara a fallar, un error en
-- este módulo dejaría la sesión SIN NINGÚN ATAJO, y mover una ventana con el
-- reparto de antes es infinitamente mejor que no poder mover nada.
local sin_smart_split = function(accion) return accion() end
do
  local ok, ventanas = pcall(require, "gigios.ventanas")
  if ok and type(ventanas) == "table" and type(ventanas.sin_smart_split) == "function" then
    sin_smart_split = ventanas.sin_smart_split
  end
end

-- Forma canónica de una combinación: mods ordenados + tecla, todo en
-- mayúsculas — así "SUPER SHIFT + E", "SUPER + SHIFT + E" y "shift+super+e"
-- casan igual aunque cambien el orden, el separador o la caja. La comparte
-- nop-binds (se exporta abajo) para que ambos lados normalicen idéntico.
local function normalizar(keys)
  local partes = {}
  for token in keys:upper():gmatch("[^%s+]+") do
    partes[#partes + 1] = token
  end
  local tecla = table.remove(partes) -- el último token es la tecla; el resto, mods
  table.sort(partes)
  return table.concat(partes, " ") .. "+" .. (tecla or "")
end

local usados = {}

local function bind(keys, dsp, opts)
  usados[normalizar(keys)] = true
  return hl.bind(keys, dsp, opts)
end

--------------------------------------------------------------------- ventanas
bind(mod .. " + SHIFT + F", hl.dsp.window.fullscreen())
-- compactar workspaces (elimina huecos, te sigue al nuevo ID). Enlace TARDÍO a
-- propósito: GiGiShell.compactar la define gigios/compactar.lua y el orden de
-- carga no debe importar aquí — si ese módulo no cargó, el atajo calla (el
-- fallo de carga ya avisó por util.carga).
bind(mod .. " + ALT + C", function()
  if GiGiShell.compactar then GiGiShell.compactar() end
end)

------------------------------------------------------------------ herramientas
-- capturas y grabaciones: la TECLA dice el alcance y el SHIFT dice si es foto o
-- vídeo, así que no hay que recordar cuatro combinaciones sueltas:
--
--            captura (foto)        grabación (vídeo)
--   Z  recorte / selección    SUPER+Z          SUPER+SHIFT+Z
--   X  pantalla completa      SUPER+X          SUPER+SHIFT+X
--
-- Estaban en CTRL+F / CTRL+S / CTRL+SHIFT+F / CTRL+SHIFT+S. Moverlas a mainMod
-- devuelve además CTRL+S y CTRL+F a las aplicaciones: eran binds GLOBALES, así
-- que el compositor se los tragaba antes de que llegara a ninguna ventana y en
-- esta sesión no se podía guardar ni buscar con el atajo de siempre.
bind(mod .. " + Z", hl.dsp.exec_cmd("mkdir -p " .. vars.ruta_captura_pantalla
  .. " && hyprshot -m region -o " .. vars.ruta_captura_pantalla))
bind(mod .. " + X", hl.dsp.exec_cmd("mkdir -p " .. vars.ruta_captura_pantalla
  .. " && hyprshot -m output -m active -o " .. vars.ruta_captura_pantalla))

-- modo gestos por cámara (toggle). La MISMA tecla enciende y apaga, como las
-- grabaciones: es un modo, y un modo que se enciende con una combinación y se
-- apaga con otra se queda encendido.
--
-- El atajo lanza el conmutador y no el demonio: `gestos.sh` es quien decide el
-- sentido, comprueba el killswitch de la cámara y avisa si algo falta. Ojo, este
-- modo NO se autoarranca (no hay línea suya en gigios/autostart.lua) — enciende
-- la webcam y la deja ocupada para el resto de apps, así que se pide a
-- propósito. Ver la sección de gestos en docs/hyprland-modulos.md.
bind(mod .. " + SHIFT + G", hl.dsp.exec_cmd("~/.config/hypr/scripts/gestos.sh"))

-- portapapeles
bind(mod .. " + V", hl.dsp.exec_cmd("~/.config/hypr/scripts/clipboard-history.sh picker"))
-- selector de emojis al estilo Windows; `period` es la tecla física "."
bind(mod .. " + period", hl.dsp.exec_cmd("~/.config/hypr/scripts/emoji-picker.sh"))
-- panel de notificaciones (toggle)
bind(mod .. " + N", hl.dsp.exec_cmd("ags request toggle-notifications"))
-- menú desplegable apps (con traer-instancia-única al workspace actual)
bind(mod .. " + SPACE", hl.dsp.exec_cmd("~/.config/hypr/scripts/rofi-launch.py"))
-- maximizar ventana (el `fullscreen, 1` de hyprlang)
bind(mod .. " + SHIFT + W", hl.dsp.window.fullscreen({ mode = "maximized" }))
-- pegar ventanas (modo compacto) — inline, ver GiGiShell.toggle_gaps abajo
bind(mod .. " + SHIFT + E", function() GiGiShell.toggle_gaps() end)

-- Grabaciones de pantalla

-- Toggle: la misma tecla inicia y detiene (ver grabar-pantalla.sh). Pareja de las
-- capturas de arriba: SHIFT + la misma tecla de alcance.
-- Ventana seleccionada con audio del sistema.
bind(mod .. " + SHIFT + Z", hl.dsp.exec_cmd("~/.config/hypr/scripts/grabar-pantalla.sh ventana"))
-- Monitor activo con audio del sistema.
bind(mod .. " + SHIFT + X", hl.dsp.exec_cmd("~/.config/hypr/scripts/grabar-pantalla.sh"))

-- Grabación de una región arbitraria con slurp. Se queda donde estaba (no entra
-- en el esquema Z/X) porque no es un tercer alcance sino OTRA herramienta:
-- wf-recorder a pelo, sin el toggle ni el audio del sistema que sí trae
-- grabar-pantalla.sh — se detiene matando el proceso, no repitiendo el atajo.
bind(mod .. " + SHIFT + P", hl.dsp.exec_cmd('wf-recorder -g "$(slurp)" -f '
  .. vars.ruta_grabacion_pantalla .. "/$(date +%Y%m%d_%H%M%S).mp4"))

-- otros
bind(mod .. " + Q", hl.dsp.exec_cmd(vars.terminal))
bind(mod .. " + SHIFT + C", hl.dsp.window.close()) -- killactive
-- Cierra una instantánea de las ventanas del workspace activo. Cada cierre se
-- dirige a su ventana original para que el cambio de foco entre cierres no
-- afecte al siguiente; un cliente que falle tampoco impide cerrar los demás.
bind(mod .. " + CTRL + SHIFT + C", function()
  local workspace = hl.get_active_workspace()
  if not workspace then return end

  local ok, ventanas = pcall(hl.get_workspace_windows, workspace)
  if not ok then return end

  for _, ventana in ipairs(ventanas) do
    pcall(function()
      hl.dispatch(hl.dsp.window.close({ window = ventana }))
    end)
  end
end)
bind(mod .. " + M", hl.dsp.exec_cmd("ags request toggle-quicksettings"))
bind(mod .. " + E", hl.dsp.exec_cmd(vars.fileManager))
bind(mod .. " + SHIFT + Q", hl.dsp.window.float({ action = "toggle" }))

-- mover ventanas con teclado / mover el foco
--
-- El SHIFT + flecha va con un `preselect` DELANTE, y no es adorno: sin él el
-- lado en el que aterriza la ventana no lo decide la tecla que has pulsado.
-- dwindle resuelve `movewindow <dir>` sacando la ventana del árbol y volviendo
-- a insertarla junto a un "punto focal" = 1 px más allá del borde de tu ventana
-- en esa dirección, a la mitad de ese borde (focalPointForDir). El lado y el eje
-- del corte salen entonces de en qué CUADRANTE del vecino cae ese punto — un
-- ángulo, no la dirección. Con dos ventanas coincide; con tres o más deja de
-- coincidir según las proporciones del vecino, y de ahí que "la misma acción
-- unas veces haga una cosa y otras otra". Medido: lab1 a la izquierda y lab2/lab3
-- partiendo la derecha, mover lab3 a la izquierda la dejaba EN MEDIO (a la
-- derecha de lab1, x=518), no a la izquierda.
--
-- `preselect` fija `m_overrideDirection`, que en dwindle tiene prioridad sobre
-- ese cálculo por cuadrante (y sobre smart_split y force_split): el eje sale de
-- la dirección — izq/dcha parten en vertical, arriba/abajo apilan — y la ventana
-- cae en el lado que has pedido. Con el mismo caso: x=8, a la izquierda del todo.
--
-- El `preselect none` de después limpia el override. Hyprland ya lo consume al
-- reinsertar, pero un `movewindow` que no mueve nada (ventana sola, o el borde
-- del monitor con binds:window_direction_monitor_fallback apagado) sale antes de
-- tocar el árbol y lo dejaría puesto: la SIGUIENTE ventana que abrieras nacería
-- en esa dirección sin que nadie la haya pedido.
for _, d in ipairs({ "left", "right", "up", "down" }) do
  bind(mod .. " + SHIFT + " .. d, function()
    hl.dispatch(hl.dsp.layout("preselect " .. d))
    hl.dispatch(hl.dsp.window.move({ direction = d }))
    hl.dispatch(hl.dsp.layout("preselect none"))
  end)
  bind(mod .. " + " .. d, hl.dsp.focus({ direction = d }))
end

-- cambiar de workspace (mod+[0-9]) y llevarse la ventana (mod+SHIFT+[0-9])
--
-- El SHIFT + número va envuelto: la ventana se REINSERTA en el árbol del
-- escritorio destino, y con smart_split el eje de ese corte lo decidiría el
-- cuadrante del cursor, que aquí no señala nada (has pulsado una tecla, no
-- soltado un ratón). Ver gigios/ventanas.lua.
for i = 1, 10 do
  local tecla = tostring(i % 10) -- la tecla 0 es el workspace 10
  bind(mod .. " + " .. tecla, hl.dsp.focus({ workspace = i }))
  bind(mod .. " + SHIFT + " .. tecla, function()
    sin_smart_split(function()
      hl.dispatch(hl.dsp.window.move({ workspace = i }))
    end)
  end)
end

-- Escritorio ancla

-- El motor está en gigios/ancla-escritorio.lua. Aquí vivía el workspace especial `magic` (toggle_special + mover ventana al
-- especial). Se quitó porque no se usaba, y su modo de fallo era desconcertante:
-- el scratchpad se DESTRUYE al quedarse vacío (misc.close_special_on_empty), y
-- un especial vacío que se abre no dibuja absolutamente nada — ni marco ni
-- fondo. O sea que el atajo funcionaba (verificado: los binds se registraban, el
-- dispatcher respondía y con una ventana dentro se veía a pantalla completa)
-- pero parecía roto en el único estado en que uno lo prueba. Si alguien lo echa
-- de menos: `hl.dsp.workspace.toggle_special("magic")` y
-- `hl.dsp.window.move({ workspace = "special:magic" })`.
--
-- Enlace TARDÍO por el mismo motivo que SUPER+ALT+C: si el módulo no cargó, el
-- atajo calla en vez de tumbar la sesión (util.carga ya avisó del fallo).
bind(mod .. " + S", function()
  if GiGiShell.saltar_ancla then GiGiShell.saltar_ancla() end
end)
bind(mod .. " + SHIFT + S", function()
  if GiGiShell.anclar_escritorio then GiGiShell.anclar_escritorio() end
end)

-- recorrer workspaces existentes con mod + rueda
bind(mod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
bind(mod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }))

-- mover/redimensionar con mod + botón izq/dcho arrastrando (los bindm)
--
-- ⚠️ SIN OPTS, y NO con { drag = true }: esa opción se comía el PRIMER arrastre
-- de cada sesión (el segundo y siguientes sí iban), tanto al mover como al
-- redimensionar. `drag` fuerza `release = true` (LuaBindingsToplevel.cpp), y en
-- handleKeybinds la pulsación de un bind con release solo llega al dispatcher
-- si es un SPECIALDISPATCHER — que para un handler `__lua` significa tener ya
-- puesto `releasePending`. Ese flag lo pone el propio dispatcher del ratón al
-- ejecutarse, así que en el primer clic aún es falso: la pulsación se traga sin
-- iniciar nada, y solo el soltar (que llega como "terminar arrastre", o sea
-- nada) deja el flag listo para la siguiente vez. El ciclo entero se retrasa un
-- clic. Sin opts la pulsación entra directa, arranca el arrastre y de paso pone
-- `releasePending`, que es lo que hace que el soltar también entre — el camino
-- que el compositor tiene pensado para los dispatchers de ratón en Lua.
--
-- El { mouse = true } del ejemplo oficial no vale como alternativa: hl.bind no
-- lee esa clave (ver la cabecera del módulo).
bind(mod .. " + mouse:272", hl.dsp.window.drag())
bind(mod .. " + mouse:273", hl.dsp.window.resize())

-- Dos binds MÁS sobre la misma combinación que el arrastre: gigios/reparto-ventanas.lua
-- necesita saber cuándo empieza y cuándo acaba para, si la ventana cayó en un
-- sitio demasiado justo, hacerle hueco a costa de los vecinos. Hyprland ejecuta
-- TODOS los binds de una combinación, así que conviven con el `bindm` de arriba
-- (verificado con un ratón virtual por uinput haciendo el arrastre de verdad:
-- llegan pulsación y soltado, y la ventana se mueve igual). Ojo: esto es
-- `release`, NO el `drag` de la advertencia de aquí arriba — `drag` fuerza
-- release Y cambia el camino de la pulsación, que es lo que rompía el primer
-- arrastre; un bind aparte con release no toca el del dispatcher del ratón.
-- Enlace tardío (el módulo se carga después que este): si no está, no pasa nada.
bind(mod .. " + mouse:272", function()
  if GiGiShell.reparto_arrastre_inicio then GiGiShell.reparto_arrastre_inicio() end
end)
bind(mod .. " + mouse:272", function()
  if GiGiShell.reparto_arrastre_fin then GiGiShell.reparto_arrastre_fin() end
end, { release = true })

-------------------------------------------------------- teclas multimedia (bindel)
bind("XF86AudioRaiseVolume",
  hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+; ags request volume-osd"),
  { repeating = true, locked = true })
bind("XF86AudioLowerVolume",
  hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-; ags request volume-osd"),
  { repeating = true, locked = true })
bind("XF86AudioMute",
  hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle; ags request volume-osd"),
  { repeating = true, locked = true })
bind("XF86AudioMicMute",
  hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle; ags request mic-osd"),
  { repeating = true, locked = true })
-- El brillo lo aplica AGS (servicios/pantalla/brightness.ts), no brightnessctl
-- desde aquí: el hardware depende de la máquina — panel interno (sysfs) en el
-- portátil, DDC/CI sobre el cable de vídeo en el sobremesa — y solo el shell
-- sabe cuál hay. Llamar a `brightnessctl` a pelo era además activamente dañino
-- en un sobremesa: sin dispositivos de clase `backlight` no falla, cae al
-- primer dispositivo `leds` y enciende el LED de scroll-lock.
bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("ags request brightness-up"),
  { repeating = true, locked = true })
bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("ags request brightness-down"),
  { repeating = true, locked = true })
bind("XF86Calculator", hl.dsp.exec_cmd("qalculate-gtk"))

-- Botón de encendido físico. La acción la decide `botonApagado` de
-- preferences.json (Ajustes > Energía), leída EN CADA PULSACIÓN por
-- GiGiShell.boton_apagado (gigios/boton-apagado.lua — enlace tardío, este módulo
-- NO lo requiere: lo carga el entry point).
-- `locked = true` (el `bindl` de antes): tiene que funcionar también con la
-- sesión bloqueada, que es justo cuando más se pulsa.
-- Requiere HandlePowerKey=ignore en logind, o logind apagará el PC igualmente
-- (system/logind.conf.d/99-gigios-powerkey.conf).
-- Si el módulo no cargó, cae a la acción de fábrica: el botón físico no puede
-- quedar muerto por un error de Lua (misma asimetría fail-open que el módulo).
bind("XF86PowerOff", function()
  if GiGiShell.boton_apagado then
    GiGiShell.boton_apagado()
  else
    hl.exec_cmd("systemctl poweroff")
  end
end, { locked = true })

-- Tapa del portátil. Mismo contrato que el botón de encendido: la acción la
-- decide `accionTapa` de preferences.json (Ajustes > Energía), leída EN CADA
-- CIERRE por GiGiShell.tapa_cerrada (gigios/tapa.lua — enlace tardío, este módulo
-- NO lo requiere: lo carga el entry point).
-- `locked = true`: la tapa se cierra sobre todo con la sesión ya bloqueada.
-- El nombre del dispositivo es literal y va sin normalizar — "Lid Switch" es como
-- llama el kernel al interruptor ACPI de la tapa en cualquier portátil, y
-- Hyprland compara la cadena TAL CUAL contra "switch:on:" .. nombre (no hay
-- comodín). Para ver el nombre real de una máquina: `hyprctl devices`, sección
-- Switches. En un equipo sin tapa el bind simplemente no se dispara nunca.
-- Requiere que logind suelte el interruptor: lo hace scripts/tapa-inhibidor.sh
-- desde el autostart, mientras esta sesión viva (ver su cabecera).
-- Si el módulo no cargó, suspende: la tapa no puede quedarse sin acción.
bind("switch:on:Lid Switch", function()
  if GiGiShell.tapa_cerrada then
    GiGiShell.tapa_cerrada()
  else
    hl.exec_cmd("systemctl suspend")
  end
end, { locked = true })
-- Abrir la tapa enciende la pantalla SIEMPRE (ver el porqué en gigios/tapa.lua):
-- con la acción "Apagar la pantalla" no hay nadie más que la encienda.
bind("switch:off:Lid Switch", function()
  if GiGiShell.tapa_abierta then GiGiShell.tapa_abierta() end
end, { locked = true })

-- Requiere playerctl (los bindl de multimedia)
bind("XF86AudioNext", hl.dsp.exec_cmd("playerctl next"), { locked = true })
bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
bind("XF86AudioPlay", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
bind("XF86AudioPrev", hl.dsp.exec_cmd("playerctl previous"), { locked = true })

------------------------------------------------------------------------ paneles
-- panel de ajustes (toggle)
bind(mod .. " + J", hl.dsp.exec_cmd("ags request toggle-settings"))
bind(mod .. " + SHIFT + J", hl.dsp.layout("togglesplit")) -- dwindle
-- Orion. Enlace TARDÍO como los demás GiGiShell.*: lo define gigios/orion.lua, que
-- comprueba la preferencia `orion` antes de mandar el toggle a AGS.
bind(mod .. " + ALT + SPACE", function()
  if GiGiShell.toggle_orion then GiGiShell.toggle_orion() end
end)
-- toggle de la barra (muestra/oculta; se auto-oculta al pasar el mouse)
bind(mod .. " + B", hl.dsp.exec_cmd("ags request toggle-bar"))

-- Suspensión falsa: entrar y salir (el mismo atajo hace las dos cosas, como el
-- resto de los toggles de aquí). El punto de entrada es el `requestHandler` de
-- ags/app.ts, no un script: la lógica —DPMS, bloqueo, DND, brillo, TLP,
-- deshielo— vive entera en AGS y este bind solo la llama.
--
-- `locked = true` NO ES OPCIONAL, y es el motivo por el que este atajo existe.
-- La suspensión falsa bloquea la sesión al entrar (es su puerta de salida
-- normal: desbloquear dispara la secuencia de salida), así que cuando hace
-- falta la red de seguridad hay un hyprlock delante — y un bind SIN `locked`
-- sencillamente no llega a dispararse con un inhibidor de entrada puesto. Sin
-- el flag, el atajo funcionaría en todos los escenarios menos en el único para
-- el que se puso, sin dar ningún error: parecería que la combinación no está
-- asignada. Mismo flag y mismo motivo que las teclas de volumen, brillo,
-- multimedia y el botón de encendido de más arriba.
--
-- OJO con lo que hace y lo que no: salir de la suspensión falsa NO DESBLOQUEA.
-- Restaura brillo, opacidad, DND, perfil TLP y descongela las apps, pero
-- hyprlock sigue delante pidiendo la contraseña — que es justo lo que se quiere
-- de una función que asume que el usuario no está delante.
bind(mod .. " + SHIFT + D", hl.dsp.exec_cmd("ags request toggle-suspension-falsa"),
  { locked = true })

---------------------------------------------------------------------------------
-- GiGiShell.toggle_gaps() — inline de scripts/toggle-gaps-borders.sh.
--
-- El estado "modo compacto" vive en una local de Lua, no en un fichero de
-- $XDG_RUNTIME_DIR como hacía el script: la misma semántica efímera (muere con
-- la sesión), aceptada a propósito. Diferencia menor y ASUMIDA con un
-- `hyprctl reload`: el reload re-ejecuta el config, así que resetea a la vez
-- los gaps (a los valores de ventanas.lua) y este flag — quedan coherentes. El
-- esquema viejo era peor: el reload restauraba los gaps pero el fichero de
-- estado sobrevivía, y el siguiente toggle "restauraba" un estado en el que ya
-- estabas.
--
-- LOS VALORES DE VUELTA YA NO ESTÁN ESCRITOS AQUÍ: salen de la tabla `aspecto`
-- de gigios/ventanas.lua, que es quien los aplica. Antes eran literales
-- copiados (2.5 / 8 / 6) con una advertencia de "replícalo si los cambias" —
-- una advertencia que no da ningún error cuando se incumple: el toggle
-- "restauraba" un espaciado que ya no era el tuyo y parecía que el atajo
-- estropeaba el diseño. Al leerlos, cambiar los gaps en ventanas.lua basta.
--
-- El require va en pcall y con repliegue a los valores de siempre: si
-- ventanas.lua llegara a fallar, un error aquí dejaría la sesión SIN NINGÚN
-- ATAJO (la trampa nº 1 del config Lua), y perder el toggle de gaps no vale
-- eso. Se resuelve al cargar el config, no en cada pulsación: el callback de un
-- bind tiene 100 ms y esto es una lectura de tabla ya cacheada por require.
local compacto = false
local NORMAL = { gaps_in = 2.5, gaps_out = 8, border_size = 0, rounding = 6 }
do
  local ok, ventanas = pcall(require, "gigios.ventanas")
  if ok and type(ventanas) == "table" and type(ventanas.aspecto) == "table" then
    for clave in pairs(NORMAL) do
      local v = ventanas.aspecto[clave]
      if type(v) == "number" then NORMAL[clave] = v end
    end
  end
end

-- El modo compacto pone A CERO las mismas cuatro claves que gobierna
-- ventanas.lua, `border_size` incluido — el atajo se llamaba
-- "toggle-gaps-borders" pero nunca tocó el borde, porque el diseño de hoy ya lo
-- tiene a 0 y no se notaba. Poniendo el borde a 0 también, subirlo algún día en
-- ventanas.lua no deja un marco pintado en un modo cuya única razón es que las
-- ventanas se toquen; y la vuelta lo restaura al valor que tenga entonces.
function GiGiShell.toggle_gaps()
  compacto = not compacto
  local v = compacto and 0 or nil
  hl.config({
    general = {
      gaps_in     = v or NORMAL.gaps_in,
      gaps_out    = v or NORMAL.gaps_out,
      border_size = v or NORMAL.border_size,
    },
    decoration = { rounding = v or NORMAL.rounding },
  })
end

-- `usados`/`normalizar` los consume gigios/nop-binds.lua (require cachea: es
-- la misma tabla que acabamos de llenar, no una copia).
return { usados = usados, normalizar = normalizar }
