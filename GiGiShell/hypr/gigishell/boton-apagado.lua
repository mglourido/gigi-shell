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

-- ═══ CUENTA ATRÁS DE CONFIRMACIÓN ═══
-- Las acciones drásticas no salen al pulsar: se abre una cuenta atrás de
-- SEGUNDOS_CUENTA_ATRAS (overlay de AGS, modulos/cuenta-atras/) y la acción sale al
-- llegar a 0. Volver a pulsar el botón la cancela; cerrar la tapa mientras corre la
-- ADELANTA (gigishell/tapa.lua llama a M.confirmar_pendiente()). Se puede apagar
-- desde Ajustes > Energía (`botonCuentaAtras`; sólo un `false` explícito la quita).
--
-- El estado vive AQUÍ y no en AGS: la tapa y la segunda pulsación tienen que
-- consultarlo dentro de los 100 ms de un callback, y preguntarle a AGS por un
-- proceso no cabe. AGS sólo pinta; el hl.timer es quien ejecuta.
--
-- Sin cuenta atrás, y a propósito:
--   · con la sesión bloqueada — hyprlock tapa cualquier overlay, así que sería una
--     espera invisible; ahí el botón actúa al momento, como siempre;
--   · con AGS caído — el `||` del request confirma en el acto (fail-open: un botón
--     que no hace nada es peor que uno sin confirmación);
--   · en las acciones que no hay que proteger (bloquear, pantalla, menú, nada).
--
-- Límite conocido: un `hyprctl reload` en mitad de la cuenta cancela el hl.timer y
-- reinicia este módulo (ver autostart.lua), así que la acción no sale. Degrada hacia
-- "no pasa nada", que es lo que ya significa cancelar; el overlay se cierra solo.
local SEGUNDOS_CUENTA_ATRAS = 5

local CON_CUENTA_ATRAS = {
  apagar = true, reiniciar = true, suspender = true, hibernar = true, cerrarSesion = true,
}

-- Cuenta atrás en curso: { accion = "…" } o nil. La IDENTIDAD de la tabla es la
-- ficha del timer (mismo patrón que gigishell/reparto-ventanas.lua): si al saltar
-- ya no es la misma, alguien la canceló o la confirmó antes.
local pendiente = nil

local function ejecutar(accion)
  local fn = M.acciones[accion] or M.acciones[ACCION_POR_DEFECTO]
  fn()
end

--- Si hay una cuenta atrás, la cierra y ejecuta su acción YA. Devuelve true si la
--- había. La usan la tapa (adelantar) y la reserva de AGS caído (vía hyprctl eval).
function M.confirmar_pendiente()
  local p = pendiente
  if not p then return false end
  pendiente = nil
  pcall(hl.exec_cmd, "ags request cuenta-atras-cerrar")
  ejecutar(p.accion)
  return true
end

--- Cancela la cuenta atrás si la hay. Devuelve true si la había.
function M.cancelar_pendiente()
  if not pendiente then return false end
  pendiente = nil
  pcall(hl.exec_cmd, "ags request cuenta-atras-cerrar")
  return true
end

local function iniciar_cuenta_atras(accion)
  local p = { accion = accion }
  hl.timer(function()
    if pendiente ~= p then return end
    -- Mismo fail-open que el botón: si la acción lanza, sale la de fábrica.
    local ok, err = pcall(M.confirmar_pendiente)
    if not ok then
      util.notificar("cuenta atrás del botón falló (" .. tostring(err):sub(1, 120)
        .. ") — ejecutando acción de fábrica")
      pcall(M.acciones[ACCION_POR_DEFECTO])
    end
  end, { timeout = SEGUNDOS_CUENTA_ATRAS * 1000, type = "oneshot" })
  -- Se marca DESPUÉS de crear el timer: si hl.timer lanza, el pcall de fuera
  -- ejecuta la acción de fábrica y no queda una cuenta fantasma sin timer.
  pendiente = p
  -- `accion` viene de CON_CUENTA_ATRAS (identificadores sin espacios ni comillas),
  -- así que interpolarla en la línea de shell es seguro.
  hl.exec_cmd("sh -c 'ags request cuenta-atras " .. accion .. " " .. SEGUNDOS_CUENTA_ATRAS
    .. " || hyprctl eval \"GiGiShell.boton_confirmar()\"'")
end

local function cuerpo()
  -- Fichero ausente o JSON corrupto → leer_json da nil → acción de fábrica,
  -- que es el comportamiento histórico del script (jq fallando → "apagar").
  local prefs = util.leer_json(RUTA_PREFS)
  local accion = ACCION_POR_DEFECTO
  local con_cuenta_atras = true
  if type(prefs) == "table" then
    if type(prefs.botonApagado) == "string" then accion = prefs.botonApagado end
    if prefs.botonCuentaAtras == false then con_cuenta_atras = false end
  end
  -- Acción desconocida → fábrica (el `apagar|*)` del case del script).
  if not M.acciones[accion] then accion = ACCION_POR_DEFECTO end

  if con_cuenta_atras and CON_CUENTA_ATRAS[accion] and not bloqueado() then
    iniciar_cuenta_atras(accion)
    return
  end
  ejecutar(accion)
end

function GiGiShell.boton_apagado()
  -- Segunda pulsación con una cuenta atrás en curso: CANCELAR. Va fuera del pcall
  -- de `cuerpo` a propósito — su reserva es apagar, y un fallo aquí no puede
  -- acabar apagando justo cuando el usuario ha pedido que no.
  local ok_c, cancelada = pcall(M.cancelar_pendiente)
  if ok_c and cancelada then return end

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

-- Puntos de entrada para `hyprctl eval`: la reserva de AGS caído (confirmar) y el
-- botón «Cancelar» / Esc del overlay (cancelar).
function GiGiShell.boton_confirmar()
  local ok, err = pcall(M.confirmar_pendiente)
  if not ok then
    util.notificar("boton_confirmar falló (" .. tostring(err):sub(1, 120)
      .. ") — ejecutando acción de fábrica")
    pcall(M.acciones[ACCION_POR_DEFECTO])
  end
end

function GiGiShell.boton_cancelar()
  pcall(M.cancelar_pendiente)
end

return M
