-- Redimensionado continuo de touchpad: ambos ejes, sin interpolación visual.
--
-- En Hyprland 0.56.2 `window.resize({x,y})` solo cambia la geometría objetivo.
-- No entra en el dragController que fuerza los tamaños visuales del ratón:
-- las ventanas seguían las animaciones normales y parecían perseguir los dedos,
-- incluso con misc.animate_manual_resizes = false. Una etiqueta temporal activa
-- no_anim solo en la ventana flotante o en las ventanas del mosaico afectado.
-- No tocamos ajustes globales ni overrides de set_prop que sean del usuario.
local util = require("gigishell.util")
local ETIQUETA = "gigishell-redimensionado-touchpad"
local sesion
local pendiente

hl.window_rule({
  name = "redimensionado-touchpad-inmediato",
  match = { tag = ETIQUETA },
  no_anim = true,
})

local function marcar(ventana, activar)
  hl.dispatch(hl.dsp.window.tag({
    tag = (activar and "+" or "-") .. ETIQUETA,
    window = ventana,
  }))
end

local function limpiar(estado)
  if not estado or estado.limpio then return end
  estado.limpio = true
  for _, ventana in ipairs(estado.ventanas) do
    pcall(function()
      if ventana.mapped then marcar(ventana, false) end
    end)
  end
end

-- Las etiquetas de dispatcher sobreviven a una recarga; los callbacks y timers
-- no. Quitar restos evita que recargar durante el gesto deje ventanas sin animar.
for _, ventana in ipairs(hl.get_windows({ tag = ETIQUETA })) do
  pcall(marcar, ventana, false)
end

local function finalizar()
  local estado = sesion
  sesion = nil
  if not estado then return end
  pendiente = estado
  -- Dejar pasar el último frame antes de quitar no_anim: si se retira en el
  -- mismo evento de fin, el último incremento puede volver a interpolarse.
  -- Un solo disparo al terminar, nunca sondeo ni temporizadores por movimiento.
  local ok = pcall(hl.timer, function()
    limpiar(estado)
    if pendiente == estado then pendiente = nil end
  end, { timeout = 50, type = "oneshot" })
  if not ok then
    limpiar(estado)
    pendiente = nil
  end
end

return {
  start = function()
    limpiar(pendiente)
    pendiente = nil
    limpiar(sesion)
    sesion = nil
    local ventana = hl.get_active_window()
    if not ventana or (ventana.fullscreen or 0) ~= 0 then return end
    local estado = {
      ventana = ventana,
      escritorio = ventana.workspace,
      flotante = ventana.floating,
      ventanas = {},
    }
    sesion = estado
    local ok, err = pcall(function()
      local ventanas = ventana.floating and { ventana } or hl.get_workspace_windows(ventana.workspace)
      for _, otra in ipairs(ventanas) do
        if otra.mapped and not otra.hidden and (ventana.floating or not otra.floating) then
          estado.ventanas[#estado.ventanas + 1] = otra
          marcar(otra, true)
        end
      end
      hl.exec_scheduled_prop_refresh_immediately()
    end)
    if not ok then
      sesion = nil
      limpiar(estado)
      util.notificar("redimensionado de touchpad: " .. tostring(err):sub(1, 160))
    end
  end,
  update = function(evento)
    if not sesion then return end
    local ventana = hl.get_active_window()
    if not ventana or ventana ~= sesion.ventana or (ventana.fullscreen or 0) ~= 0
       or ventana.workspace ~= sesion.escritorio or ventana.floating ~= sesion.flotante then
      finalizar()
      return
    end
    -- Incrementos directos en los dos ejes, sin elegir una esquina mediante el
    -- cursor. Un eje que ocupa todo el mosaico sigue limitado por ese espacio.
    local desplazamiento = evento.delta
    if desplazamiento.x == 0 and desplazamiento.y == 0 then return end
    local ok, err = pcall(function()
      hl.dispatch(hl.dsp.window.resize({
        x = desplazamiento.x,
        y = desplazamiento.y,
        relative = true,
      }))
    end)
    if not ok then
      finalizar()
      util.notificar("redimensionado de touchpad: " .. tostring(err):sub(1, 160))
    end
  end,
  finish = finalizar,
}
