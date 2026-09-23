-- Preferencias por monitor: se LEEN de ~/.config/gigios/display.json, la misma
-- fuente de verdad que usa AGS (Ajustes > Pantalla). Antes AGS volcaba además un
-- `monitor-settings.lua` generado y este config lo cargaba con dofile; el dato
-- se escribía dos veces y el fichero generado quedaba dentro del árbol de git.
-- Con Lua no hace falta: aquí hay condiciones y bucles, así que el config lee el
-- JSON y decide. Ver CLAUDE.md.
--
-- Se carga DESPUÉS del comodín de gigios/monitores.lua: una spec con `desc:`
-- concreta gana a la comodín, que sigue cubriendo los monitores sin preferencia
-- guardada. Sin esto, cualquier `hyprctl reload` devolvería la pantalla al modo
-- preferido y escala 1 (240 Hz → 60, 1.25 → 1) sin que AGS se entere.
--
-- Las specs van por `desc:` (la description del EDID, estable entre
-- reconexiones) y no por conector (DP-1), que baila.

local util = require("gigios.util")

local prefs = util.leer_json(util.HOGAR .. "/.config/gigios/display.json")
local monitores = prefs and prefs.monitors
if type(monitores) ~= "table" then return end

--- Número → cadena sin cola de ceros: el decodificador da 1.0 donde el JSON
--- traía 1, y "1" es lo que espera el compositor para una escala entera.
local function num(n)
  return string.format("%.6g", n)
end

--- El modo se guarda como "2560x1440@239.97Hz"; Hyprland lo quiere sin la "Hz".
local function modo(m)
  if type(m) ~= "string" or m == "" then return "preferred" end
  return (m:gsub("Hz$", ""))
end

for descripcion, pref in pairs(monitores) do
  if type(descripcion) == "string" and descripcion ~= "" and type(pref) == "table" then
    local salida = "desc:" .. descripcion

    if pref.enabled == false then
      hl.monitor({ output = salida, disabled = true })
    else
      -- Los campos ausentes se OMITEN a propósito, para que mande el default del
      -- compositor en vez de un valor inventado aquí.
      local spec = {
        output = salida,
        mode = modo(pref.mode),
        position = (type(pref.position) == "string" and pref.position ~= "") and pref.position or "auto",
        scale = type(pref.scale) == "number" and num(pref.scale) or "auto",
      }
      if type(pref.vrr) == "boolean" then spec.vrr = pref.vrr and 1 or 0 end
      if type(pref.mirrorOf) == "string" and pref.mirrorOf ~= "" and pref.mirrorOf ~= "none" then
        spec.mirror = pref.mirrorOf
      end
      if type(pref.transform) == "number" then spec.transform = math.floor(pref.transform) end
      if type(pref.bitdepth) == "number" then spec.bitdepth = math.floor(pref.bitdepth) end
      if type(pref.cm) == "string" and pref.cm ~= "" then spec.cm = pref.cm end
      if type(pref.sdrBrightness) == "number" then spec.sdrbrightness = pref.sdrBrightness end
      if type(pref.sdrSaturation) == "number" then spec.sdrsaturation = pref.sdrSaturation end

      hl.monitor(spec)
    end
  end
end
