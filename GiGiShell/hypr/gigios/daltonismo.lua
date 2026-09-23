-- gigios/daltonismo.lua — corrección global de color (Ajustes > Accesibilidad).
--
-- Define GiGiShell.daltonismo(modo?). Sin argumento restaura el `modoDaltonismo`
-- guardado en preferences.json; con argumento aplica ese modo (así lo invoca
-- AGS al cambiar el ajuste: `hyprctl eval 'GiGiShell.daltonismo("protanopia")'`).
-- El entry point lo llama sin argumento al final de CADA ejecución del config —
-- la semántica del `exec =` original: un `hyprctl reload` re-ejecuta el Lua y
-- descarta lo aplicado por eval, así que la restauración tiene que venir del
-- propio config.
local util = require("gigios.util")

-- Mismas rutas que el script: relativas a XDG_CONFIG_HOME, no a DIR_CONFIG —
-- así funcionan igual aunque el config se cargue desde otro sitio (pruebas).
local RAIZ = os.getenv("XDG_CONFIG_HOME") or (util.HOGAR .. "/.config")
local DIR_SHADERS = RAIZ .. "/hypr/shaders"

local VALIDOS = {
  protanopia = true,
  deuteranopia = true,
  tritanopia = true,
}

function GiGiShell.daltonismo(modo)
  -- pcall interno: se llama desde el entry en cada reload — un error aquí no
  -- puede tumbar el resto del config (sesión sin atajos, trampa nº 1).
  local ok, err = pcall(function()
    if modo == nil or modo == "" then
      -- Lectura FRESCA de disco, no util.prefs(): el script leía sin caché a
      -- propósito — AGS acaba de escribir la preferencia cuando llama aquí.
      local prefs = util.leer_json(RAIZ .. "/gigios/preferences.json") or {}
      modo = prefs.modoDaltonismo
      if type(modo) ~= "string" or modo == "" then modo = "ninguno" end
    end

    if VALIDOS[modo] then
      local shader = DIR_SHADERS .. "/daltonismo-" .. modo .. ".frag"
      local f = io.open(shader, "r")
      if not f then
        -- Shader ausente: se avisa y NO se toca el que hubiera (como el script,
        -- que salía con error sin aplicar nada).
        util.notificar("no se encuentra el shader de daltonismo: " .. shader)
        return
      end
      f:close()
      hl.config({ decoration = { screen_shader = shader } })
    else
      -- "ninguno" — o un modo desconocido, que degrada a quitar el filtro (con
      -- aviso): mejor sin filtro que con uno que ya no es el elegido.
      if modo ~= "ninguno" then
        util.notificar("modo de daltonismo no válido: " .. tostring(modo))
      end
      hl.config({ decoration = { screen_shader = "" } })
    end
  end)
  if not ok then
    util.notificar("daltonismo: " .. tostring(err):sub(1, 200))
  end
end
