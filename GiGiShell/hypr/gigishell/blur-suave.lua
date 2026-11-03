-- gigishell/blur-suave.lua — blur más suave mientras esté abierta una vista a pantalla completa.
--
-- Hyprland 0.57 no tiene intensidad de blur por capa: `decoration.blur` es global, así que se baja
-- mientras dure. El radio crece con size * 2^passes, y con los valores normales (6 y 3) las ventanas
-- de detrás no se distinguen. Cada vista (menú de escritorios, Ajustes, menú de energía) se registra
-- con su nombre, porque pueden coincidir: cerrar una no debe devolver el blur fuerte con otra abierta.
--
-- `base` guarda los valores vigentes para devolverlos. Un `hyprctl reload` reaplica el config y
-- recarga este módulo, así que `base` vuelve a nil y no queda nadie registrado.

local BLUR_SUAVE = { size = 3, passes = 2 }
-- Reponer al instante hace PARPADEAR el cierre: el fundido de salida de la capa dura unos 150 ms
-- (`layersOut` y `fadeLayersOut` en animaciones.lua) y, con el blur fuerte ya repuesto, lo que se
-- desvanece es de golpe otra imagen. Medido: el brillo saltaba de 23 a 25 a los 30 ms en vez de bajar
-- de 23 a 18 sin saltos. Hay que subir esto si esas animaciones se alargan.
local ESPERA_REPONER_MS = 200
local activas = {}
local base = nil

local function reponer()
  -- Puede haberse abierto otra vista durante la espera.
  if next(activas) ~= nil or base == nil then return end
  hl.config({ decoration = { blur = base } })
  base = nil
end

-- Vistas que además quitan la transparencia de las ventanas sin foco mientras están abiertas
-- (`inactive_opacity`, GiGiShell.opacidad_forzada en ventanas.lua). Van aquí porque este es el
-- aviso de abrir y cerrar que ya manda AGS, incluido el de limpieza tras un AGS caído.
local OPACAS = { escritorios = true }

local function opacidad(quien, activar)
  if not OPACAS[quien] or not GiGiShell.opacidad_forzada then return end
  if activar then
    GiGiShell.opacidad_forzada(quien, true)
  else
    -- Mismo retraso que el blur: devolverla durante el fundido de salida también salta.
    hl.timer(function()
      if not activas[quien] then GiGiShell.opacidad_forzada(quien, false) end
    end, { timeout = ESPERA_REPONER_MS, type = "oneshot" })
  end
end

function GiGiShell.blur_suave(quien, activar)
  activas[quien] = activar or nil
  opacidad(quien, activar)
  local alguna = next(activas) ~= nil
  if alguna and base == nil then
    local size = hl.get_config("decoration.blur.size")
    local passes = hl.get_config("decoration.blur.passes")
    if type(size) ~= "number" or type(passes) ~= "number" then return end
    base = { size = size, passes = passes }
    hl.config({ decoration = { blur = BLUR_SUAVE } })
  elseif not alguna and base ~= nil then
    hl.timer(reponer, { timeout = ESPERA_REPONER_MS, type = "oneshot" })
  end
end
