-- gigios/limite-ventanas.lua — tope de ventanas EN MOSAICO por escritorio.
--
-- A partir de cierto número de ventanas en mosaico un escritorio deja de ser
-- útil: dwindle sigue partiendo el espacio y acabas con columnas de 200 px que
-- ni se leen ni se pueden usar. Esto pone un techo (`maxVentanasEscritorio`, 8
-- por defecto) y, cuando una ventana nueva lo rebasaría, la MUEVE al primer
-- escritorio con sitio en vez de dejarla apretujar a las que ya estaban.
--
-- Hyprland NO trae esta opción — no hay ningún `max_tiled_windows` en el
-- compositor (ni en 0.56 ni en el stub de la API Lua). Lo que sí trae ahora es
-- lo que hace falta para implementarla desde el config: el evento tipado
-- `window.open` y `hl.dsp.window.move` con selector por objeto. En hyprlang
-- esto habría sido un daemon leyendo el socket de eventos y cruzando
-- direcciones con `hyprctl clients` (el mismo montaje que tenía
-- escaner-apps.sh, con su trampa de las address sin `0x`); aquí son 40 líneas
-- dentro del propio config, sin ningún proceso vivo.
--
-- QUÉ CUENTA Y QUÉ NO — el límite es del MOSAICO, no de ventanas:
--   · Flotantes: ni cuentan ni se mueven. No compiten por el espacio del
--     layout, que es lo único que este tope protege; mover un diálogo o un
--     Picture-in-Picture "porque el escritorio está lleno" sería absurdo.
--   · Ocultas (`hidden`): tampoco cuentan. Es el estado de una terminal
--     tragada por `swallow` — existe, pero no ocupa un hueco del layout.
--   · Especiales (id < 0): fuera. El scratchpad no es un escritorio donde
--     dejar al usuario ni donde imponer un tope.
--
-- LA VENTANA SE SIGUE (`follow = true`), al revés que en compactar.lua y en el
-- anclaje. Es deliberado: aquí el usuario ACABA de lanzar la app, y el peor
-- fallo posible sería que su ventana desapareciera en silencio a un escritorio
-- que no sabe cuál es. El escritorio lleno se queda como estaba y tú vas donde
-- fue la ventana. Cambiarlo es poner SEGUIR = false, pero entonces conviene
-- avisar de algún modo o la app parecerá no haber arrancado.
--
-- Interacción con el anclaje (`anclaje.py` / `lanzar-anclado.py`): el anclaje
-- decide DÓNDE nace la ventana; esto decide si ahí cabe. Si el escritorio de
-- lanzamiento está lleno, este módulo gana — es el que sabe algo que el
-- lanzador no puede saber en el momento de lanzar.
--
-- Ajuste: `maxVentanasEscritorio` en ~/.config/gigios/preferences.json.
-- AUSENTE = 8 (activado). Un valor <= 0 lo DESACTIVA — es la forma de apagarlo
-- sin borrar la clave, y hace falta una porque el default es "encendido". Se
-- lee por `util.prefs()`, o sea una vez por ejecución del config: cambiarlo
-- pide un `hyprctl reload` (que no reinicia nada — no hay proceso detrás).
local util = require("gigios.util")

-- El traslado va envuelto: la ventana se REINSERTA en el árbol del escritorio
-- destino y con dwindle:smart_split el eje de ese corte lo decidiría el
-- cuadrante del cursor, que aquí señala el escritorio LLENO del que viene, no
-- el destino. Ver gigios/ventanas.lua. pcall + repliegue por la trampa nº 1.
local sin_smart_split = function(accion) return accion() end
do
  local ok, ventanas = pcall(require, "gigios.ventanas")
  if ok and type(ventanas) == "table" and type(ventanas.sin_smart_split) == "function" then
    sin_smart_split = ventanas.sin_smart_split
  end
end

local LIMITE_DEFECTO = 8
local SEGUIR = true      -- ver arriba: la ventana recién lanzada no se pierde
local WS_MAX = 20        -- techo del barrido de candidatos (ids normales)

--- Ventanas en mosaico de un escritorio: ni flotantes ni ocultas.
local function en_mosaico(ws_id)
  local n = 0
  local ok, ventanas = pcall(hl.get_workspace_windows, ws_id)
  if not ok or not ventanas then return 0 end
  for _, v in ipairs(ventanas) do
    if not v.floating and not v.hidden then n = n + 1 end
  end
  return n
end

--- Primer escritorio con sitio: hacia arriba desde el actual y, si no queda
--- ninguno, dando la vuelta por debajo. Un escritorio que aún no existe cuenta
--- como vacío (get_workspace_windows devuelve nada) y Hyprland lo crea al
--- mover, que es justo lo que se quiere. nil = no hay sitio en ningún lado.
local function hueco(desde, limite)
  for id = desde + 1, WS_MAX do
    if en_mosaico(id) < limite then return id end
  end
  for id = 1, desde - 1 do
    if en_mosaico(id) < limite then return id end
  end
  return nil
end

hl.on("window.open", function(ventana)
  -- `window.open` (no `window.open_early`) llega con las reglas YA aplicadas,
  -- así que `floating` es el valor definitivo y no el de antes de la regla.
  local ok, err = pcall(function()
    local limite = tonumber(util.prefs().maxVentanasEscritorio) or LIMITE_DEFECTO
    if limite <= 0 then return end            -- apagado explícito

    if not ventana or ventana.floating or ventana.hidden then return end
    local ws = ventana.workspace
    if not ws or ws.special or ws.id <= 0 then return end

    -- El recuento incluye a la recién llegada: con el tope en 8, la novena es
    -- la que se va.
    if en_mosaico(ws.id) <= limite then return end

    local destino = hueco(ws.id, limite)
    if not destino then return end            -- todo lleno: mejor apretujar que
                                              -- mandarla a un sitio igual de malo
    sin_smart_split(function()
      hl.dispatch(hl.dsp.window.move({
        workspace = destino,
        window = ventana,                     -- el OBJETO, no la address (ver compactar.lua)
        follow = SEGUIR,                      -- "silent" se dice follow = false
      }))
    end)
  end)
  if not ok then
    util.notificar("limite-ventanas: " .. tostring(err):sub(1, 200))
  end
end)
