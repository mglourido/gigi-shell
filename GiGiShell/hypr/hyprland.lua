-- Config de GiGiShell para Hyprland. ESTE es el config vivo: desde 0.55, si existe
-- `hyprland.lua` Hyprland lo carga y NO mira ningún `hyprland.conf` (la
-- comprobación es una sola vez, al arrancar). Los `.conf` de hyprlang ya no
-- existen en el repo — se borraron tras la migración; `git` los conserva si
-- hiciera falta consultarlos.
--
-- Los `.conf` que SIGUEN aquí (hypridle, hyprlock, hyprpaper) no son de este
-- programa: son binarios `hypr*` aparte, que mantienen hyprlang a propósito.
--
-- Estructura: cada bloque vive en gigios/*.lua y se carga con util.carga()
-- (require + pcall). Un módulo roto avisa en pantalla y NO tumba el resto —
-- importa porque un error de Lua sin capturar deja la sesión SIN ATAJOS (solo
-- el SUPER+Q de emergencia), y `--verify-config` solo detecta errores de
-- parseo, no de ejecución.
--
-- EL ORDEN DE CARGA ES SIGNIFICATIVO, no estético: gigios.pantalla pisa al
-- comodín de monitores, gigios.dispositivos pisa a userprefs, y los binds sordos
-- van después de TODOS los binds reales (si no, no sabrían cuáles ya se usan).
--
-- Lo que AGS ajusta desde la UI llega por JSON, no por código generado:
-- gigios.pantalla lee display.json, gigios.dispositivos lee devices.json y
-- gigios.env lee el idioma de datetime.json. AGS escribe el dato y este config
-- decide — ya no hay ficheros .lua generados que cargar (ni que versionar).
--
-- `hyprctl keyword` no existe bajo Lua: los cambios en caliente llegan por
-- `hyprctl eval` (así los aplica AGS) o llamando a las funciones del global
-- GiGiShell que definen los módulos — GiGiShell.toggle_gaps(), GiGiShell.daltonismo(modo),
-- GiGiShell.compactar(), GiGiShell.boton_apagado() —, visibles desde `eval` porque
-- comparte el estado Lua del config (medido).

GiGiShell = {}  -- espacio de funciones invocables desde `hyprctl eval`

local util = require("gigios.util")

-- Render: la gestión de color del compositor SIGUE apagada — hyprsunset es el
-- único dueño del CTM del KMS (luz nocturna + atenuación); con las dos activas
-- la imagen se lava. Ver CLAUDE.md.
hl.config({ render = { cm_enabled = false } })

util.carga("gigios.env")            -- variables de entorno (Qt, toolkits, idioma)
util.carga("gigios.monitores")      -- regla comodín de monitores (el fallback)
util.carga("gigios.pantalla")       -- lee display.json (AGS · Ajustes > Pantalla); pisa al comodín
util.carga("gigios.input")          -- teclado, ratón, touchpad y gestos
util.carga("gigios.ventanas")       -- aspecto: gaps, bordes, sombras, blur, layout
util.carga("gigios.animaciones")    -- curvas y animaciones
util.carga("gigios.reglas")         -- reglas de ventana y de capa
-- Funciones GiGiShell.* que los binds invocan con enlace tardío (closures): se
-- cargan antes de keybinds solo por claridad — el orden real no las ata.
util.carga("gigios.compactar")      -- GiGiShell.compactar()
util.carga("gigios.boton-apagado")  -- GiGiShell.boton_apagado()
util.carga("gigios.tapa")           -- GiGiShell.tapa_cerrada() / tapa_abierta()
util.carga("gigios.daltonismo")     -- GiGiShell.daltonismo(modo)
util.carga("gigios.orion")          -- GiGiShell.toggle_orion()
util.carga("gigios.ancla-escritorio") -- GiGiShell.anclar_escritorio() / saltar_ancla()
util.carga("gigios.keybinds")       -- los atajos reales (+ GiGiShell.toggle_gaps)
util.carga("gigios.autostart")      -- arranque escalonado (hl.on "hyprland.start")
util.carga("gigios.escaner-apps")   -- salto al escritorio de las apps de autostart
util.carga("gigios.reparto-ventanas") -- que una ventana nueva no nazca estrujada
util.carga("gigios.limite-ventanas") -- tope de ventanas en mosaico por escritorio
util.carga("gigios.traer-steam")    -- trae aquí la ventana single-instance de Steam
util.carga("gigios.permisos")       -- permisos del ecosistema (screencopy, plugins)
util.carga("gigios.gpu")            -- perfil por máquina (~/.config/gigios/gpu-perfil)
util.carga("gigios.gaming")         -- ajustes para juegos (tearing, VRR)
util.carga("gigios.userprefs")      -- preferencias personales (pisan a lo anterior)
util.carga("gigios.dispositivos")   -- lee devices.json (AGS · Ajustes > Dispositivos); pisa a userprefs
util.carga("gigios.env-firefox")    -- variables de Firefox/Wayland

-- Binds sordos (absorber SUPER+tecla sin atajo): SIEMPRE al final, cuando ya
-- está registrado todo atajo real de los módulos anteriores.
util.carga("gigios.nop-binds")      -- absorbe SUPER+tecla sin atajo (bucle, no fichero)

-- Filtro de daltonismo: semántica del `exec =` original — se (re)aplica también
-- en cada `hyprctl reload`, restaurando el modo guardado en preferences.json.
if GiGiShell.daltonismo then GiGiShell.daltonismo() end
