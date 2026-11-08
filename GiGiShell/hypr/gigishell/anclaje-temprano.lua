-- gigishell/anclaje-temprano.lua — ancla DENTRO del compositor las ventanas
-- posteriores de una app lanzada, sin que lleguen a dibujarse en otro sitio.
--
-- EL PROBLEMA: la regla del exec (`[workspace N silent]`, la que pone
-- lanzar-anclado.py) solo cubre la PRIMERA ventana del proceso. Medido en
-- Hyprland 0.57.1: el token del exec caduca en 1 s y la regla se registra como
-- no persistente (Executor.cpp: `markAsExecRule(token, pid, false /* TODO */)`).
-- Las apps con splash se la gastan en ella: LibreOffice abre la splash en el
-- escritorio correcto, la cierra a los 0,7 s y Writer nace en el ACTIVO. Lo
-- mismo con los multiventana (las ventanas tardías de Steam). El observador de
-- anclaje.py las mueve después, pero llega tarde: socket → Python → hyprctl son
-- varios frames, y la ventana se ve aparecer en tu escritorio y saltar.
--
-- Lo nativo no sirve (leído en el fuente de 0.57.1):
--   · `misc.initial_workspace_tracking = 2` (token persistente) borra el token
--     cuando se cierra la PRIMERA ventana que lo usó (Window.cpp, unmap): justo
--     la splash. Y si no, dura 1337 meses y lo heredan los hijos de cualquier
--     terminal. Medido: con 2, Writer seguía naciendo en el activo.
--   · Una regla de usuario no puede casar por pid: `exec_pid`/`exec_token` son
--     internos, no están en MATCH_PROP_STRINGS (Rule.cpp). Y por clase no vale:
--     en LibreOffice cambia entre ventanas (splash sin clase, libreoffice-writer,
--     soffice).
--
-- LA SOLUCIÓN: `window.open` se emite SÍNCRONO dentro de mapWindow(), antes de
-- dibujar ningún frame. Mover la ventana ahí hace que nunca se pinte en el
-- escritorio equivocado. Medido en vivo: `openwindow …,1` y `movewindow …,9`
-- con la MISMA marca de tiempo, y el usuario sin moverse del 1.
--
-- Quién ancla qué: anclaje.py, al fijar la identidad de la app con su primera
-- ventana, registra aquí su pid con GiGiShell.anclar_pid(pid, ws) y lo suelta
-- al acabar la observación (GiGiShell.soltar_pid). Toda ventana nueva cuyo
-- proceso cuelgue de un pid registrado va a su escritorio; si cuelga de varios,
-- manda el ancestro más cercano. Es la misma regla 1 de `cede()` en anclaje.py
-- (el árbol de procesos manda), así que los dos lados reparten igual. Lo que no
-- cuelga del árbol (casos solo por clase) lo sigue moviendo anclaje.py.
--
-- Antes que el pid manda la ESPERA: mientras un lanzamiento aguarda su primera
-- ventana, la que case con su programa es suya aunque cuelgue del pid de otro
-- lanzamiento (dos Firefox seguidos: el proceso del primero crea la ventana del
-- segundo). Ver `esperas` más abajo.
--
-- El registro caduca solo a los TTL segundos: si el observador muriera sin
-- soltar, la entrada no se queda anclando ventanas para siempre.
--
-- El tope de ventanas manda (la jerarquía de siempre: el lanzador decide dónde
-- nace, el tope si cabe): a un destino LLENO no se trae, la ventana se queda
-- donde nació. No basta con dejárselo a limite-ventanas.lua, que la apartaría
-- después SIGUIÉNDOLA y te arrastraría a otro escritorio. El recuento es el
-- mismo, compartido en util.en_mosaico(). Orden de carga: ANTES que
-- limite-ventanas.lua, para que su `window.open` vea la ventana ya colocada.
--
-- Coste: sin nada registrado (casi siempre), el callback sale en el primer
-- `next()`. Con registro, lee unos pocos /proc/<pid>/stat: microsegundos,
-- lejos del timeout de 50 ms de los callbacks.
local util = require("gigishell.util")

local sin_smart_split = function(accion) return accion() end
do
  local ok, ventanas = pcall(require, "gigishell.ventanas")
  if ok and type(ventanas) == "table" and type(ventanas.sin_smart_split) == "function" then
    sin_smart_split = ventanas.sin_smart_split
  end
end

local TTL = 20          -- s; la observación de anclaje.py dura 15
local PROFUNDIDAD = 12  -- niveles de ancestros, igual que PID_MAX_DEPTH en anclaje.py

local pendientes = {}   -- [pid] = { ws = id, hasta = os.time() + TTL }

-- Lanzamientos que aún ESPERAN su primera ventana, con la pista de su programa
-- (`/usr/lib/firefox/firefox` -> "firefox"). Van ANTES que los pids: es la
-- regla 0 de `cede()` en anclaje.py. Dos Firefox lanzados seguidos: la ventana
-- del segundo la crea el proceso del primero, así que por pid iría al
-- escritorio del primero; la pista dice que es la que acabas de pedir.
local esperas = {}      -- [clave] = { pista = "firefox", ws = id, hasta = … }

--- `comm` del proceso en minúsculas (el kernel lo trunca a 15 caracteres).
local function comm_de(pid)
  local f = io.open("/proc/" .. pid .. "/comm", "r")
  if not f then return "" end
  local c = f:read("*l") or ""
  f:close()
  return c:lower()
end

--- Clave de la espera más reciente que casa con la ventana, o nil. Mismo
--- criterio que `casa_pista()` en anclaje.py: pista contra comm o clase.
local function espera_de(ventana, ahora)
  local mejor
  local comm, clase
  for clave, e in pairs(esperas) do
    if e.hasta < ahora then
      esperas[clave] = nil
    else
      comm = comm or comm_de(ventana.pid)
      clase = clase or (ventana.initial_class or ""):lower()
      if (e.pista:sub(1, 15) == comm or e.pista == clase)
          and (not mejor or clave > mejor) then
        mejor = clave
      end
    end
  end
  return mejor
end

--- Padre de un pid por /proc, o nil. El nombre del proceso va entre
--- paréntesis y puede llevar espacios y paréntesis: se parte tras el ÚLTIMO ")".
local function ppid(pid)
  local f = io.open("/proc/" .. pid .. "/stat", "r")
  if not f then return nil end
  local datos = f:read("*l")
  f:close()
  if not datos then return nil end
  local resto = datos:match(".*%)(.*)")
  if not resto then return nil end
  return tonumber(resto:match("^%s*%S+%s+(%d+)"))
end

--- Escritorio al que debe ir una ventana del proceso `pid`, o nil.
local function destino_de(pid, ahora)
  for p, e in pairs(pendientes) do
    if e.hasta < ahora then pendientes[p] = nil end
  end
  if next(pendientes) == nil then return nil end
  for _ = 1, PROFUNDIDAD do
    if not pid or pid <= 1 then return nil end
    local e = pendientes[pid]
    if e then return e.ws end
    pid = ppid(pid)
  end
  return nil
end

GiGiShell = GiGiShell or {}

--- Lo llama anclaje.py por `hyprctl eval` al fijar la identidad de la app.
function GiGiShell.anclar_pid(pid, ws)
  pid, ws = tonumber(pid), tonumber(ws)
  if not pid or pid <= 1 or not ws or ws <= 0 then return end
  pendientes[pid] = { ws = ws, hasta = os.time() + TTL }
end

--- Lo llama anclaje.py al terminar la observación.
function GiGiShell.soltar_pid(pid)
  pid = tonumber(pid)
  if pid then pendientes[pid] = nil end
end

--- Lo llama anclaje.py al crear el registro de un lanzamiento, ANTES del exec.
function GiGiShell.esperar_lanzamiento(clave, pista, ws)
  ws = tonumber(ws)
  if type(clave) ~= "string" or type(pista) ~= "string" or pista == ""
      or not ws or ws <= 0 then return end
  esperas[clave] = { pista = pista, ws = ws, hasta = os.time() + TTL }
end

--- Lo llama anclaje.py al fijar la identidad o al terminar.
function GiGiShell.fin_espera(clave)
  if clave then esperas[clave] = nil end
end

hl.on("window.open", function(ventana)
  if next(pendientes) == nil and next(esperas) == nil then return end
  local ok, err = pcall(function()
    if not ventana or not ventana.pid then return end
    local ws = ventana.workspace
    if not ws or ws.special or ws.id <= 0 then return end
    local ahora = os.time()
    local destino
    local clave = espera_de(ventana, ahora)
    if clave then
      -- La espera se consume: esta ventana ES la primera de ese lanzamiento.
      destino = esperas[clave].ws
      esperas[clave] = nil
    else
      destino = destino_de(ventana.pid, ahora)
    end
    if not destino or destino == ws.id then return end
    -- Si el destino está LLENO no se trae: limite-ventanas.lua la apartaría
    -- después SIGUIÉNDOLA (follow = true) y te arrastraría a otro escritorio.
    -- Se queda donde nació, igual que hace `_hueco_en()` en anclaje.py.
    -- Las flotantes no cuentan para el tope, así que siempre caben.
    local limite = util.limite_mosaico()
    if not ventana.floating and limite > 0
        and util.en_mosaico(destino, ventana.address) >= limite then
      return
    end
    sin_smart_split(function()
      hl.dispatch(hl.dsp.window.move({
        workspace = destino,
        window = ventana,      -- el OBJETO, no la address (ver compactar.lua)
        follow = false,        -- "silent": no arrastrar al usuario
      }))
    end)
  end)
  if not ok then
    util.notificar("anclaje-temprano: " .. tostring(err):sub(1, 200))
  end
end)
