-- gigishell/boton-apagado.lua — la acción del
-- botón de encendido físico (tecla XF86PowerOff, bind con locked=true en
-- gigishell/keybinds.lua — tiene que responder también con la sesión bloqueada,
-- que es justo cuando más se pulsa).
--
-- La acción la elige el usuario en Ajustes > Energía y se guarda como
-- `botonApagado` en preferences.json. Se lee EN VIVO, en cada pulsación —
-- util.leer_json, NO util.prefs(): prefs() cachea por ejecución del config y
-- cambiar el ajuste no se aplicaría hasta el siguiente reload. Igual que el
-- script (que releía el JSON con jq en cada invocación), cambiar el ajuste se
-- aplica al momento, sin relanzar nada.
--
-- OJO — systemd-logind maneja esta MISMA tecla por su cuenta (HandlePowerKey,
-- `poweroff` de fábrica) a nivel de asiento, sin pasar por el compositor. Si
-- logind no está en `ignore`, gana su apagado elijas lo que elijas aquí. Ver
-- system/logind.conf.d/99-gigishell-powerkey.conf y la sección en CLAUDE.md.
--
-- ═══ FAIL-OPEN, y la asimetría es el diseño ═══
-- Cualquier error de Lua en el cuerpo (JSON con forma inesperada, io.popen
-- fallando, lo que sea) ejecuta la acción de fábrica (apagar) en vez de tragar
-- el error: el botón físico NUNCA puede quedar muerto por un fallo nuestro —
-- el script funcionaba igual con AGS caído o jq ausente. Un fallo aquí debe
-- degradar a "el botón hace lo de fábrica" (visible: el PC se apaga y lo
-- notas), nunca a "el botón no hace nada", que es silencioso y deja el
-- hardware aparentemente roto. Mismo patrón que la puerta del Wake Up
-- (idle-action.sh): ante la duda, la acción sale.

local util = require("gigishell.util")

local ACCION_POR_DEFECTO = "apagar"

-- La misma ruta que resolvía el script (${XDG_CONFIG_HOME:-$HOME/.config}).
local RUTA_PREFS = (os.getenv("XDG_CONFIG_HOME") or (util.HOGAR .. "/.config"))
    .. "/gigishell/preferences.json"

-- ¿Hay un hyprlock puesto? io.popen es aceptable aquí: pidof tarda ~2-3 ms y
-- el callback del bind tiene 100 ms de margen; solo corre al pulsar el botón.
local function bloqueado()
  local f = io.popen("pidof hyprlock 2>/dev/null")
  if not f then return false end
  local salida = f:read("*a") or ""
  f:close()
  return salida:match("%d") ~= nil
end

local M = {}

-- Tabla de acciones EXPUESTA en el retorno del módulo, y solo por las pruebas:
-- permite sustituir "apagar" por un stub inofensivo (touch a un fichero) sin
-- tocar el código productivo — disparar la real desde un test apagaría la
-- máquina. En producción nadie la modifica.
M.acciones = {
  nada = function() end,
  menu = function()
    -- Bajo hyprlock el menú quedaría dibujado por debajo del bloqueo:
    -- invisible ahora y abierto al desbloquear. No es una acción útil ahí.
    if bloqueado() then return end
    hl.exec_cmd("ags request toggle-power-menu")
  end,
  bloquear = function()
    -- Por bloquear.sh, no por `hyprlock` a pelo: es quien sortea el fondo del
    -- bloqueo (hyprlock.conf no puede: hyprlang no sustituye comandos). La guarda
    -- de `bloqueado()` es redundante con la que lleva el script dentro, pero se
    -- mantiene para no pagar el fork cuando ya hay un bloqueo puesto.
    -- Se conserva el `setsid -f`: hyprlock debe sobrevivir a la shell intermedia
    -- de exec_cmd.
    if bloqueado() then return end
    hl.exec_cmd("setsid -f " .. util.HOGAR .. "/.config/hypr/scripts/bloquear.sh")
  end,
  pantalla = function()
    -- Solo una tecla la vuelve a encender: mouse_move_enables_dpms = false.
    hl.dispatch(hl.dsp.dpms({ action = "off" }))
  end,
  -- Pasa por AGS, que es quien conoce el ajuste «sustituir la suspensión real por la
  -- falsa» (Ajustes > Energía). Sin este rodeo, encender ese ajuste arreglaría la
  -- inactividad y dejaría el BOTÓN FÍSICO suspendiendo de verdad — el camino más fácil de
  -- pulsar sin pensar y justo el que el usuario quiere evitar en un equipo cuyo S3 no
  -- vuelve. El `||` es la reserva para AGS caído: allí no hay quien haga una suspensión
  -- falsa, así que la real es la degradación correcta.
  suspender = function() hl.exec_cmd("sh -c 'ags request suspend || systemctl suspend'") end,
  hibernar = function() hl.exec_cmd("systemctl hibernate") end,
  cerrarSesion = function() hl.dispatch(hl.dsp.exit()) end,
  reiniciar = function() hl.exec_cmd("systemctl reboot") end,
  apagar = function() hl.exec_cmd("systemctl poweroff") end,
}

local function cuerpo()
  -- Fichero ausente o JSON corrupto → leer_json da nil → acción de fábrica,
  -- que es el comportamiento histórico del script (jq fallando → "apagar").
  local prefs = util.leer_json(RUTA_PREFS)
  local accion = ACCION_POR_DEFECTO
  if type(prefs) == "table" and type(prefs.botonApagado) == "string" then
    accion = prefs.botonApagado
  end
  -- Acción desconocida → fábrica (el `apagar|*)` del case del script).
  local fn = M.acciones[accion] or M.acciones[ACCION_POR_DEFECTO]
  fn()
end

function GiGiShell.boton_apagado()
  local ok, err = pcall(cuerpo)
  if not ok then
    -- Fail-open: se avisa (para que el fallo sea arreglable) y la acción de
    -- fábrica sale igualmente. El segundo pcall es deliberado: si hasta la
    -- acción de fábrica lanza, ya no queda nada mejor que hacer.
    util.notificar("boton_apagado falló (" .. tostring(err):sub(1, 120)
      .. ") — ejecutando acción de fábrica")
    pcall(M.acciones[ACCION_POR_DEFECTO])
  end
end

return M
