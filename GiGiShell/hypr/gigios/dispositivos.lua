-- Teclado, ratón y touchpad del usuario: se LEEN de
-- ~/.config/gigios/devices.json, la misma fuente de verdad que usa AGS (Ajustes
-- > Dispositivos). Antes AGS volcaba además un `input-settings.lua` generado que
-- este config cargaba con dofile; el dato se escribía dos veces y el fichero
-- generado quedaba dentro del árbol de git. Ver CLAUDE.md.
--
-- Se carga DESPUÉS de gigios/userprefs.lua, para que estas preferencias pisen a
-- las de ahí. Fichero ausente (máquina recién instalada, el usuario no ha tocado
-- nada) → no se aplica NADA y manda userprefs, igual que cuando el generado no
-- existía todavía.
--
-- Los defaults de abajo son el espejo de DEFAULT_DEVICE_SETTINGS
-- (ags/servicios/dispositivos/service.ts) y solo entran en juego por clave
-- ausente o de tipo raro: AGS ya escribe el JSON normalizado.

local util = require("gigios.util")

local d = util.leer_json(util.HOGAR .. "/.config/gigios/devices.json")
if type(d) ~= "table" then return end

local function cadena(v, def)
  if type(v) ~= "string" then return def end
  return (v:gsub("^%s*(.-)%s*$", "%1"))
end

local function bool(v, def)
  if type(v) ~= "boolean" then return def end
  return v
end

local function numero(v, min, max, def)
  if type(v) ~= "number" then return def end
  return math.max(min, math.min(max, v))
end

local function entero(v, min, max, def)
  return math.floor(numero(v, min, max, def) + 0.5)
end

local cursor = entero(d.tamanoCursor, 16, 64, 24)
hl.env("XCURSOR_SIZE", tostring(cursor))
hl.env("HYPRCURSOR_SIZE", tostring(cursor))

-- Tema del puntero (Ajustes > Dispositivos > Puntero). Las DOS variables van al
-- mismo nombre: hyprcursor dibuja el cursor del compositor y XCursor sigue
-- cubriendo XWayland y los toolkits, que no saben nada de hyprcursor — por eso
-- esto no es "quitar XCursor", es dejar de depender de él para el compositor.
--
-- Sin esto el tema del compositor quedaba SIN FIJAR, que no es lo mismo que sin
-- hyprcursor. Sin XCURSOR_THEME/HYPRCURSOR_THEME, Hyprland cae a gsettings
-- (`default`), un nombre que libhyprcursor no sabe resolver —casa por nombre de
-- directorio con manifest.hl y no sigue el `Inherits` de index.theme—; y ante un
-- nombre que no encuentra NO falla: coge el primer tema con manifest.hl que se
-- cruce, por orden de lectura del directorio (medido con el logger de la propia
-- librería: "trying without name of Adwaita" → "Found theme Adwaita at
-- …/Bibata-Modern-Ice"). O sea que el puntero del escritorio lo decidía el orden
-- del sistema de ficheros, y bastaba instalar otro tema para cambiarlo sin tocar
-- nada. Fijar el nombre quita esa lotería.
--
-- Clave ausente o vacía = no se emite nada y manda el tema de la sesión, igual
-- que con el `locale` de gigios/env.lua: fijar aquí un tema de fábrica cambiaría
-- el puntero sin que nadie lo pida, y nombraría un tema que puede no existir.
local tema = cadena(d.temaCursor, "")
if tema:match("^[%w%._%+%-]+$") then
  hl.env("XCURSOR_THEME", tema)
  hl.env("HYPRCURSOR_THEME", tema)
end

-- Ojo con los nombres: en Lua el campo es `tap_to_click` (HL.ConfigOpt.Input.Touchpad),
-- no el `tap-to-click` de hyprlang — verificado con getoption en instancia anidada.
hl.config({
  input = {
    kb_layout = cadena(d.kbLayout, "es"),
    kb_variant = cadena(d.kbVariant, ""),
    repeat_rate = entero(d.repeatRate, 1, 100, 25),
    repeat_delay = entero(d.repeatDelay, 100, 2000, 600),
    numlock_by_default = bool(d.numlock, true),
    follow_mouse = entero(d.followMouse, 0, 3, 1),
    sensitivity = numero(d.sensitivity, -1, 1, 0),
    accel_profile = d.accelProfile == "flat" and "flat" or "adaptive",
    force_no_accel = bool(d.forceNoAccel, false),
    left_handed = bool(d.leftHanded, false),
    natural_scroll = bool(d.mouseNaturalScroll, false),
    scroll_factor = numero(d.mouseScrollFactor, 0.1, 5, 1),

    touchpad = {
      natural_scroll = bool(d.touchpadNaturalScroll, true),
      scroll_factor = numero(d.touchpadScrollFactor, 0.1, 5, 0.4),
      tap_to_click = bool(d.tapToClick, true),
      tap_button_map = d.tapButtonMap == "lmr" and "lmr" or "lrm",
      disable_while_typing = bool(d.disableWhileTyping, true),
      clickfinger_behavior = bool(d.clickfinger, false),
      middle_button_emulation = bool(d.middleEmulation, false),
      drag_lock = bool(d.dragLock, false),
    },
  },
})
