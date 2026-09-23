-- gigios/tapa.lua — qué hace el portátil al CERRAR LA TAPA (Ajustes > Energía).
--
-- Atado en gigios/keybinds.lua a `switch:on:Lid Switch` / `switch:off:Lid Switch`
-- con locked = true: la tapa se cierra sobre todo con la sesión ya bloqueada, que
-- es justo cuando tiene que responder.
--
-- La acción la elige el usuario y se guarda como `accionTapa` en preferences.json.
-- Se lee EN VIVO en cada cierre (util.leer_json, NO util.prefs(), que cachea por
-- ejecución del config): cambiar el ajuste se aplica al cerrar la tapa siguiente,
-- sin relanzar ni recargar nada. Mismo contrato que gigios/boton-apagado.lua, del
-- que además se REUTILIZA la tabla de acciones: el vocabulario ("suspender",
-- "bloquear", …) tiene que significar exactamente lo mismo en los dos sitios —
-- suspender pasa por AGS para respetar la suspensión falsa, bloquear pasa por
-- bloquear.sh, etc. Duplicarlas aquí era la forma segura de que divergieran.
--
-- ═══ QUIÉN MANDA SOBRE LA TAPA (y por qué NO se toca /etc) ═══
-- systemd-logind gestiona el interruptor de la tapa a nivel de asiento
-- (HandleLidSwitch=suspend de fábrica), igual que la tecla de encendido, y lo hace
-- sin pasar por el compositor: sin desactivarlo, logind suspende pase lo que pase
-- y este bind no se nota.
--
-- Con el botón de encendido eso se resolvió cediéndoselo a Hyprland desde /etc
-- (HandlePowerKey=ignore). Aquí NO: `HandleLidSwitch=ignore` es permanente y vale
-- también para el saludador y para los TTY, así que cerrar la tapa en la pantalla
-- de login o con la sesión caída dejaría el portátil ENCENDIDO dentro de la
-- mochila. Un botón de encendido sordo se nota; un portátil que no se duerme al
-- cerrarlo, no — hasta que quema.
--
-- La alternativa es un INHIBIDOR de logind (`handle-lid-switch`, modo block), que
-- no necesita privilegios y sólo vale mientras alguien lo sostiene: lo sostiene
-- scripts/tapa-inhibidor.sh mientras Hyprland viva, y en cuanto la sesión se cae
-- el inhibidor se suelta y logind vuelve a suspender por su cuenta. El fallo, en
-- vez de "el portátil no se duerme nunca", es "el portátil se duerme al cerrarlo",
-- que es exactamente lo que hay que hacer cuando el escritorio no está.
--
-- ═══ FAIL-OPEN hacia SUSPENDER ═══
-- Cualquier error en el cuerpo suspende, que es a la vez el valor de fábrica de
-- este ajuste y lo que haría logind sin nosotros. La asimetría es la misma que en
-- boton-apagado.lua: degradar a "hace lo de siempre" (visible) y nunca a "no hace
-- nada" (silencioso, y aquí encima peligroso).

local util = require("gigios.util")

local ACCION_POR_DEFECTO = "suspender"

-- Acciones ofrecidas para la tapa: las del botón de encendido menos las que no
-- tienen sentido a ciegas, más "suspensionFalsa". La poda no es estética — con la
-- tapa cerrada no hay pantalla que mirar, así que "abrir el menú de energía" sería
-- un menú invisible esperando a que la abras, y "reiniciar" / "cerrar sesión" a
-- ciegas no son nada que nadie quiera atar a un gesto que también se hace sin
-- querer.
local PERMITIDAS = {
  suspender = true, suspensionFalsa = true, hibernar = true, bloquear = true,
  pantalla = true, apagar = true, nada = true,
}

local RUTA_PREFS = (os.getenv("XDG_CONFIG_HOME") or (util.HOGAR .. "/.config"))
    .. "/gigios/preferences.json"

-- Las acciones REALES son las del botón de encendido (ver cabecera). pcall porque
-- este módulo no puede quedarse sin acción por un fallo de carga del otro: sin él,
-- la reserva mínima es suspender de verdad.
local acciones
do
  local ok, boton = pcall(require, "gigios.boton-apagado")
  if ok and type(boton) == "table" and type(boton.acciones) == "table" then
    -- Copia, no la tabla prestada: la extendemos abajo y escribir en la del botón de
    -- encendido le añadiría a ESE menú una acción que su UI no ofrece.
    acciones = setmetatable({}, { __index = boton.acciones })
  else
    acciones = { suspender = function() hl.exec_cmd("systemctl suspend") end }
  end

  -- Única acción propia de la tapa. No se comparte con el botón de encendido porque
  -- allí no se ofrece: la suspensión falsa se pide por su nombre, y "suspender" ya
  -- entra en ella sola cuando el usuario la ha puesto a sustituir a la real.
  --
  -- ENTRAR, no alternar: cerrar la tapa estando ya dentro tiene que dejarla puesta.
  -- Por eso el request es `suspension-falsa-entrar` y no `toggle-suspension-falsa`.
  -- El `||` es la reserva de siempre: sin AGS no hay quien haga una suspensión falsa,
  -- así que la real es la degradación correcta.
  acciones.suspensionFalsa = function()
    hl.exec_cmd("sh -c 'ags request suspension-falsa-entrar || systemctl suspend'")
  end
end

--- ¿Hay una pantalla que NO sea el panel del portátil? Es la noción de "docked" de
--- logind (HandleLidSwitchDocked, `ignore` de fábrica): con un monitor externo
--- enchufado, cerrar la tapa es guardar el portátil para usar la otra pantalla, no
--- irse. Al quitarle la tapa a logind esa regla se perdía SIN AVISAR, así que se
--- repone aquí — y es conmutable desde Ajustes, que logind no lo era.
---
--- hl.get_monitors() sólo enumera monitores habilitados, así que basta con mirar los
--- nombres: eDP/LVDS/DSI son los buses de un panel interno; cualquier otro
--- (HDMI-A-1, DP-2, …) es externo.
local function hay_pantalla_externa()
  local ok, monitores = pcall(hl.get_monitors)
  if not ok or type(monitores) ~= "table" then return false end
  for _, m in ipairs(monitores) do
    local ok_nombre, nombre = pcall(function() return m.name end)
    if ok_nombre and type(nombre) == "string"
        and not nombre:match("^eDP") and not nombre:match("^LVDS") and not nombre:match("^DSI") then
      return true
    end
  end
  return false
end

local M = {}

-- Expuesta en el retorno del módulo por el mismo motivo que la del botón de
-- encendido: para poder COMPROBAR desde fuera —`hyprctl eval` o una prueba— que la
-- herencia por `__index` resuelve de verdad, sin tener que disparar la acción (que
-- aquí suspendería el equipo). En producción nadie la modifica.
M.acciones = acciones

local function cuerpo()
  -- Fichero ausente o corrupto → leer_json da nil → acción de fábrica.
  local prefs = util.leer_json(RUTA_PREFS)
  local accion = ACCION_POR_DEFECTO
  local respetar_externa = true
  if type(prefs) == "table" then
    if type(prefs.accionTapa) == "string" and PERMITIDAS[prefs.accionTapa] then
      accion = prefs.accionTapa
    end
    -- Sólo un `false` explícito desactiva la excepción: clave ausente = de fábrica.
    if prefs.tapaIgnorarConPantallaExterna == false then respetar_externa = false end
  end

  if accion == "nada" then return end
  if respetar_externa and hay_pantalla_externa() then return end

  local fn = acciones[accion] or acciones[ACCION_POR_DEFECTO]
  if fn then fn() end
end

function GiGiShell.tapa_cerrada()
  local ok, err = pcall(cuerpo)
  if not ok then
    util.notificar("tapa_cerrada falló (" .. tostring(err):sub(1, 120)
      .. ") — suspendiendo (acción de fábrica)")
    pcall(function() hl.exec_cmd("systemctl suspend") end)
  end
end

--- Al ABRIR la tapa se enciende la pantalla, siempre y sin mirar la preferencia.
---
--- No es simetría decorativa: con la acción "Apagar la pantalla" nadie más la
--- volvería a encender (mouse_move_enables_dpms = false en gigios/ventanas.lua), y
--- abrir la tapa a un panel negro se lee como que el portátil no ha despertado. En
--- el resto de acciones es inofensivo — al volver de una suspensión hypridle ya
--- manda su propio dpms-on, y encender lo que ya está encendido no hace nada.
---
--- ⚠️ La forma es la TABLA. `hl.dsp.dpms('on')` es un TOGGLE disfrazado: un string
--- no es una tabla, tableToggleAction() tira el 'on' y responde ok — el fallo que
--- dejaba la pantalla negra al salir de suspensión. Ver la cabecera de hypridle.conf.
function GiGiShell.tapa_abierta()
  pcall(function() hl.dispatch(hl.dsp.dpms({ action = "on" })) end)
end

return M
