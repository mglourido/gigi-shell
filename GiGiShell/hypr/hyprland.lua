-- Config de GiGiShell para Hyprland. ESTE es el config vivo: desde 0.55, si existe
-- `hyprland.lua` Hyprland lo carga y NO mira ningún `hyprland.conf` (la
-- comprobación es una sola vez, al arrancar). Los `.conf` de hyprlang ya no
-- existen en el repo — se borraron tras la migración; `git` los conserva si
-- hiciera falta consultarlos.
--
-- Los `.conf` que SIGUEN aquí (hypridle, hyprlock, hyprpaper) no son de este
-- programa: son binarios `hypr*` aparte, que mantienen hyprlang a propósito.
--
-- Estructura: cada bloque vive en gigishell/*.lua y se carga con util.carga()
-- (require + pcall). Un módulo roto avisa en pantalla y NO tumba el resto —
-- importa porque un error de Lua sin capturar deja la sesión SIN ATAJOS (solo
-- el SUPER+Q de emergencia), y `--verify-config` solo detecta errores de
-- parseo, no de ejecución.
--
-- EL ORDEN DE CARGA ES SIGNIFICATIVO, no estético: gigishell.pantalla pisa al
-- comodín de monitores, gigishell.dispositivos pisa a userprefs, y los binds sordos
-- van después de TODOS los binds reales (si no, no sabrían cuáles ya se usan).
--
-- Lo que AGS ajusta desde la UI llega por JSON, no por código generado:
-- gigishell.pantalla lee display.json, gigishell.dispositivos lee devices.json y
-- gigishell.env lee el idioma de datetime.json. AGS escribe el dato y este config
-- decide — ya no hay ficheros .lua generados que cargar (ni que versionar).
--
-- `hyprctl keyword` no existe bajo Lua: los cambios en caliente llegan por
-- `hyprctl eval` (así los aplica AGS) o llamando a las funciones del global
-- GiGiShell que definen los módulos — GiGiShell.toggle_gaps(), GiGiShell.daltonismo(modo),
-- GiGiShell.compactar(), GiGiShell.boton_apagado() —, visibles desde `eval` porque
-- comparte el estado Lua del config (medido).

GiGiShell = {}  -- espacio de funciones invocables desde `hyprctl eval`

local util = require("gigishell.util")

-- Render: la gestión de color del compositor SIGUE apagada — hyprsunset es el
-- único dueño del CTM del KMS (luz nocturna + atenuación); con las dos activas
-- la imagen se lava. Ver CLAUDE.md.
hl.config({ render = { cm_enabled = false } })

util.carga("gigishell.env")            -- variables de entorno (Qt, toolkits, idioma)
util.carga("gigishell.monitores")      -- regla comodín de monitores (el fallback)
util.carga("gigishell.pantalla")       -- lee display.json (AGS · Ajustes > Pantalla); pisa al comodín
util.carga("gigishell.input")          -- teclado, ratón, touchpad y gestos
util.carga("gigishell.ventanas")       -- aspecto: gaps, bordes, sombras, blur, layout
util.carga("gigishell.animaciones")    -- curvas y animaciones
util.carga("gigishell.reglas")         -- reglas de ventana y de capa
-- Funciones GiGiShell.* que los binds invocan con enlace tardío (closures): se
-- cargan antes de keybinds solo por claridad — el orden real no las ata.
util.carga("gigishell.compactar")      -- GiGiShell.compactar()
util.carga("gigishell.boton-apagado")  -- GiGiShell.boton_apagado()
util.carga("gigishell.tapa")           -- GiGiShell.tapa_cerrada() / tapa_abierta()
util.carga("gigishell.daltonismo")     -- GiGiShell.daltonismo(modo)
util.carga("gigishell.orion")          -- GiGiShell.toggle_orion()
util.carga("gigishell.ancla-escritorio") -- GiGiShell.anclar_escritorio() / saltar_ancla()
util.carga("gigishell.keybinds")       -- los atajos reales (+ GiGiShell.toggle_gaps)
util.carga("gigishell.autostart")      -- arranque escalonado (hl.on "hyprland.start")
util.carga("gigishell.escaner-apps")   -- salto al escritorio de las apps de autostart
util.carga("gigishell.reparto-ventanas") -- que una ventana nueva no nazca estrujada
util.carga("gigishell.limite-ventanas") -- tope de ventanas en mosaico por escritorio
util.carga("gigishell.traer-steam")    -- trae aquí la ventana single-instance de Steam
util.carga("gigishell.permisos")       -- permisos del ecosistema (screencopy, plugins)
util.carga("gigishell.gpu")            -- perfil por máquina (~/.config/gigishell/gpu-perfil)
util.carga("gigishell.gaming")         -- ajustes para juegos (tearing, VRR)
util.carga("gigishell.userprefs")      -- preferencias personales (pisan a lo anterior)
util.carga("gigishell.dispositivos")   -- lee devices.json (AGS · Ajustes > Dispositivos); pisa a userprefs
util.carga("gigishell.env-firefox")    -- variables de Firefox/Wayland

-- Binds sordos (absorber SUPER+tecla sin atajo): SIEMPRE al final, cuando ya
-- está registrado todo atajo real de los módulos anteriores.
util.carga("gigishell.nop-binds")      -- absorbe SUPER+tecla sin atajo (bucle, no fichero)

-- Filtro de daltonismo: semántica del `exec =` original — se (re)aplica también
-- en cada `hyprctl reload`, restaurando el modo guardado en preferences.json.
if GiGiShell.daltonismo then GiGiShell.daltonismo() end
