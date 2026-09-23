-- gigios/orion.lua — GiGiShell.toggle_orion(), el atajo del launcher Orion
-- (SUPER + ALT + SPACE, bind en gigios/keybinds.lua).
--
-- Inline de scripts/toggle-orion.sh, que ya no existe. El script hacía dos
-- cosas y la primera era la cara: leer `orion` de preferences.json con jq —un
-- fork de bash y otro de jq en cada pulsación— más una rama de repuesto con
-- grep para cuando jq no estuviera instalado. Aquí la lectura es
-- util.leer_json, sin procesos y sin depender de jq.
--
-- Se lee EN VIVO en cada pulsación (util.leer_json, NO util.prefs(): prefs()
-- cachea por ejecución del config, así que apagar Orion en Ajustes no surtiría
-- efecto hasta el siguiente reload). Mismo criterio que gigios/boton-apagado.lua.
--
-- Ausente = ACTIVADO, para conservar el comportamiento en una máquina que
-- todavía no tiene preferences.json. Por eso la comprobación es `== false`
-- explícito y no una negación: un `nil` tiene que dejar pasar.
--
-- Con Orion desactivado no se manda el toggle porque, deliberadamente, no hay
-- ninguna ventana registrada en AGS que responda.

local util = require("gigios.util")

local RUTA_PREFS = util.HOGAR .. "/.config/gigios/preferences.json"

-- La parte que SÍ tiene que salir a un shell: es una llamada a AGS y su
-- repuesto. Durante una recarga, el config en disco puede actualizarse antes
-- que la instancia de AGS en marcha; conservar el toggle directo evita dejar el
-- atajo inservible en esa breve ventana. Va por hl.exec_cmd (asíncrono): un
-- `ags request` dentro del callback del bind lo bloquearía, y los callbacks
-- tienen 100 ms.
local CMD = [[r=$(ags request toggle-orion 2>/dev/null); [ "$r" = ok ] || ags toggle orion]]

function GiGiShell.toggle_orion()
  local ok = pcall(function()
    local prefs = util.leer_json(RUTA_PREFS)
    if type(prefs) == "table" and prefs.orion == false then return end
    hl.exec_cmd(CMD)
  end)
  -- Fail-open hacia "el atajo funciona": si la lectura del JSON falla por lo
  -- que sea, se manda el toggle igual. El peor caso es abrir un panel con la
  -- función apagada; el contrario sería un atajo muerto sin ningún aviso.
  if not ok then hl.exec_cmd(CMD) end
end

return {}
