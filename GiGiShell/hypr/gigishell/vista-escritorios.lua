-- gigishell/vista-escritorios.lua — el submap de SUPER+Tab.
--
-- Con SUPER pulsado, los binds de ratón de keybinds.lua se quedan con el clic y la rueda, que son
-- los gestos del menú. Este submap no los tiene, así que llegan a la ventana de AGS.
--
-- Soltar SUPER devuelve siempre al submap normal AQUÍ, sin esperar a AGS: si AGS muere con el menú
-- abierto, los atajos vuelven igual. La decisión de cerrar o fijar es de AGS
-- (ags/modulos/vista-escritorios/cierre.ts).
--
-- ⚠️ LOS SOLTADOS SON `submap_universal`, y no es adorno. Hyprland empareja un soltar con el submap
-- que había al PULSAR la tecla (keybinds/Manager.cpp: `.submap = pressedInput->submapAtPress`), no
-- con el de ahora. SUPER y el primer Tab se pulsan en el submap normal y se sueltan en este: un
-- `release` definido solo dentro del submap NO LLEGA NUNCA, no da error y el submap se queda
-- activo sin salida (medido en 0.57.0: solo llegaba `tab`). `submap_universal` hace que el bind
-- case en cualquier submap; por eso cada callback comprueba que de verdad estamos dentro, y
-- `non_consuming` evita que el Tab/SUPER sueltos en el submap normal se traguen la pulsación.

local SUBMAP = "vista-escritorios"

local function avisar(evento)
  hl.exec_cmd("ags request vista-escritorios-" .. evento)
end

local function dentro()
  return hl.get_current_submap() == SUBMAP
end

local function salir_del_submap()
  hl.dispatch(hl.dsp.submap("reset"))
end

local function soltar_super()
  if not dentro() then return end
  salir_del_submap()
  avisar("soltar-super")
end

local SOLTAR = { release = true, ignore_mods = true, submap_universal = true, non_consuming = true, transparent = true }

hl.define_submap(SUBMAP, function()
  hl.bind("SUPER + Tab", function() avisar("tab") end)
  hl.bind("Tab", function()
    if not dentro() then return end
    avisar("soltar-tab")
    -- SUPER soltado ANTES que Tab: su release no llega (con Tab sujeta, Hyprland no lo empareja
    -- con ningún bind), así que se comprueba aquí, al soltar Tab.
    if not hl.is_key_down("Super_L") and not hl.is_key_down("Super_R") then soltar_super() end
  end, SOLTAR)
  hl.bind("Super_L", soltar_super, SOLTAR)
  hl.bind("Super_R", soltar_super, SOLTAR)
  hl.bind("Escape", function()
    salir_del_submap()
    avisar("soltar-super")
  end, { ignore_mods = true })
end)

function GiGiShell.vista_escritorios_abrir()
  hl.dispatch(hl.dsp.submap(SUBMAP))
  avisar("tab")
end

-- BLUR MÁS FUERTE MIENTRAS EL MENÚ ESTÁ ABIERTO. La regla de capa de reglas.lua solo admite
-- `blur`/`ignore_alpha`: Hyprland 0.57 no tiene tamaño de blur por capa, así que `size` es global y
-- se sube mientras dura el menú. `passes` NO se toca (es lo caro en una iGPU).
-- El valor vigente se lee del propio config; `base` guarda el original para devolverlo. Un
-- `hyprctl reload` reaplica el config y recarga este módulo, así que `base` vuelve a nil.
local base_blur = nil

function GiGiShell.vista_escritorios_blur(activar)
  if activar then
    -- Idempotente: un segundo «activar» no duplica el doble sobre el doble.
    if base_blur ~= nil then return end
    local actual = hl.get_config("decoration.blur.size")
    if type(actual) ~= "number" then return end
    base_blur = actual
    hl.config({ decoration = { blur = { size = actual * 2 } } })
  elseif base_blur ~= nil then
    hl.config({ decoration = { blur = { size = base_blur } } })
    base_blur = nil
  end
end
