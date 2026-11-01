-- Gaming: ajustes de rendimiento (válidos en AMBAS máquinas).
--
-- Tearing y VRR global los decide Ajustes y su única fuente de verdad es `global` en
-- ~/.config/gigishell/display.json: se releen aquí porque un `hyprctl reload` devuelve
-- a su valor por defecto lo que AGS aplicó en caliente con `hyprctl eval`. Un JSON
-- ausente o corrupto degrada a apagado, igual que los valores por defecto de
-- ags/servicios/pantalla/service.ts.

local util = require("gigishell.util")

local prefs = util.leer_json(util.HOGAR .. "/.config/gigishell/display.json")
local global = type(prefs) == "table" and type(prefs.global) == "table" and prefs.global or {}

-- 0 = off, 1 = on, 2 = fullscreen, 3 = fullscreen_game.
local vrr = global.vrrMode
if type(vrr) ~= "number" or vrr < 0 or vrr > 3 or vrr ~= math.floor(vrr) then vrr = 0 end

hl.config({
  render = {
    -- Deja que un juego a pantalla completa se salte el compositor
    -- (menos latencia y overhead).  0 = disable, 1 = enable, 2 = auto.
    direct_scanout = 1,
  },

  general = {
    -- Imagen sin V-Sync para los juegos que lo pidan: solo surte efecto en ventanas
    -- con la regla 'immediate = true' (ver la windowrule 'tearing-games' en reglas.lua).
    allow_tearing = global.allowTearing == true,
  },

  misc = {
    vrr = math.floor(vrr),
  },
})
