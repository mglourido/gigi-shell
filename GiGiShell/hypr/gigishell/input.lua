-- Entrada: teclado, ratón, touchpad y gestos.
-- https://wiki.hypr.land/Configuring/Variables/#input

hl.config({
  input = {
    kb_layout  = "es",
    kb_variant = "",
    kb_model   = "",
    kb_options = "",
    kb_rules   = "",
    -- Bloq numérico activo automáticamente, incluso en el lock.
    numlock_by_default = true,
    follow_mouse = 1,

    sensitivity = 0, -- -1.0 - 1.0, 0 = sin modificación.

    touchpad = {
      natural_scroll = true,
      scroll_factor  = 0.4, -- ajusta entre 0.1 y 1.0
    },
  },
})

-- El puntero NO se teletransporta al centro de la ventana.
--
-- Por defecto Hyprland "warpea" el cursor en un montón de casos: mover una
-- ventana a otro escritorio, enfocar por atajo, etc. Medido cuál lo hace en el
-- caso que lo destapó (gigishell/traer-steam.lua): el culpable es el dispatcher
-- `hl.dsp.window.move` — con el cursor en 348,765 y la ventana en 400,300 de
-- 500x400, tras el move el cursor estaba en 650,500, el centro EXACTO. `focus`
-- y `bring_to_top` no lo tocan, así que no basta con evitar enfocar.
--
-- Es global a propósito y no un apaño local (guardar la posición y restaurarla
-- con hl.dsp.cursor.move, que también funciona): el salto molesta igual venga
-- de donde venga. Afecta por igual al anclaje de hypr/scripts/anclaje.py y a
-- los atajos de foco — que es lo que se quiere.
hl.config({
  cursor = {
    no_warps = true,
  },
})

-- Cambiar de workspace deslizando horizontalmente con tres dedos.
-- Se mantiene aquí (y no en gigishell/dispositivos) para no registrarlo dos veces.
hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

-- Tres dedos arriba: maximizar ↔ restaurar. Tres dedos abajo: flotante ↔
-- mosaico. Siempre sobre la ventana con foco.
--
-- Guard: si es la ÚNICA ventana visible de su workspace, el gesto no la
-- maximiza ni la saca a flotante (sola ya ocupa todo el hueco). Deshacer sí se
-- deja: una ventana que ya está maximizada o flotante vuelve atrás aunque esté
-- sola — si no, cerrar la otra ventana la dejaría atascada en ese estado.
--
-- Por eso son callbacks y no las acciones nativas "fullscreen"/"float", que no
-- admiten condición. `finish` se dispara una vez, al levantar los dedos.
-- Ojo: el callback tiene timeout de 100 ms; aquí solo hay consultas en memoria.
local function sola_en_su_workspace()
  local ws = hl.get_active_workspace()
  if not ws then return false end
  local ok, lista = pcall(hl.get_workspace_windows, ws)
  if not ok or not lista then return false end
  local visibles = 0
  for _, v in ipairs(lista) do
    if not v.hidden then visibles = visibles + 1 end
  end
  return visibles <= 1
end

hl.gesture({ fingers = 3, direction = "up", action = { finish = function()
  local w = hl.get_active_window()
  if not w then return end
  -- fullscreen: 0 = normal; 1 = maximizada; 2 = pantalla completa
  if (w.fullscreen or 0) == 0 and sola_en_su_workspace() then return end
  hl.dispatch(hl.dsp.window.fullscreen({ mode = "maximized" }))
end } })

hl.gesture({ fingers = 3, direction = "down", action = { finish = function()
  local w = hl.get_active_window()
  if not w then return end
  if not w.floating and sola_en_su_workspace() then return end
  hl.dispatch(hl.dsp.window.float({ action = "toggle" }))
end } })

-- Ejemplo de config por dispositivo.
-- https://wiki.hypr.land/Configuring/Keywords/#per-device-input-configs
hl.device({
  name        = "epic-mouse-v1",
  sensitivity = -0.5,
})
