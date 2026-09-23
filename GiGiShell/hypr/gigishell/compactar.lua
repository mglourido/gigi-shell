-- gigishell/compactar.lua — renumera los escritorios ocupados a IDs consecutivos.
--
-- GiGiShell.compactar() renumera los escritorios OCUPADOS a IDs consecutivos desde
-- 1, moviendo ventanas en silencio y siguiendo al escritorio activo hasta su
-- nuevo número. Sin ventanas en ningún escritorio no hace nada. Los especiales
-- (id < 0) se ignoran.
--
-- Frente al script, todo ocurre SÍNCRONO dentro de la llamada (cero forks: el
-- .sh lanzaba un hyprctl+jq por escritorio a mover) — por eso
-- gigishell/escaner-apps.lua puede re-resolver escritorios justo después de
-- llamarlo, sin timers de por medio. Medido en la anidada: 3 ventanas en 3
-- escritorios ≈ 0,2 ms.
--
-- Firma verificada en instancia anidada (no supuesta — las dos formas obvias
-- fallan EN SILENCIO): `window` tiene que ser el OBJETO HL.Window, no su
-- address en string (con string el selector no casa y el dispatcher mueve la
-- ventana activa), y el "silent" se dice `follow = false` (un `silent = true`
-- se ignora y el foco se va detrás de la ventana):
--   hl.dsp.window.move({ workspace = N, window = <HL.Window>, follow = false })
--
-- VA ENTERO DENTRO DE `sin_smart_split`, y es el caso que más lo necesita: aquí
-- no se mueve una ventana, se VACÍA un escritorio en otro. El destino se
-- reconstruye ventana a ventana, así que con smart_split el eje de CADA corte
-- salía del cuadrante del cursor sobre la anterior — y como el cursor no se
-- mueve entre iteraciones, el mismo eje se repetía y el escritorio compactado
-- salía en tiras en vez de en la rejilla que tenías. Ver gigishell/ventanas.lua.
local util = require("gigishell.util")

-- pcall + repliegue: si ventanas.lua fallara, compactar mal es mejor que no
-- compactar (y el fallo de carga ya avisó por util.carga).
local sin_smart_split = function(accion) return accion() end
do
  local ok, ventanas = pcall(require, "gigishell.ventanas")
  if ok and type(ventanas) == "table" and type(ventanas.sin_smart_split) == "function" then
    sin_smart_split = ventanas.sin_smart_split
  end
end

--- El renumerado en sí. Sale como función suelta para poder pasarla entera a
--- `sin_smart_split` sin anidar otro nivel: los `return` de aquí abortan el
--- compactado completo, que es lo que hacían antes dentro del pcall.
local function renumerar()
  local activo = hl.get_active_workspace()
  local activo_id = activo and activo.id or nil

  -- Ocupados = con ventanas y de id positivo (fuera especiales), ordenados.
  local ocupados = {}
  for _, ws in ipairs(hl.get_workspaces()) do
    if ws.id > 0 and ws.windows > 0 then
      ocupados[#ocupados + 1] = ws.id
    end
  end
  if #ocupados == 0 then return end
  table.sort(ocupados)

  -- Mismo recorrido que el script: al i-ésimo ocupado le toca el id i. Las
  -- ventanas se leen POR escritorio y en el momento de moverlo — como los ids
  -- destino siempre van por detrás del recorrido, ningún movimiento pisa un
  -- escritorio aún pendiente.
  local nuevo_activo = -1
  local nuevo_id = 1
  for _, ws_id in ipairs(ocupados) do
    if ws_id == activo_id then nuevo_activo = nuevo_id end
    if ws_id ~= nuevo_id then
      for _, ventana in ipairs(hl.get_workspace_windows(ws_id)) do
        hl.dispatch(hl.dsp.window.move({
          workspace = nuevo_id,
          window = ventana,
          follow = false,
        }))
      end
    end
    nuevo_id = nuevo_id + 1
  end

  -- Seguir al activo: si estaba en un ocupado, a su nuevo número; si estaba
  -- en uno vacío, al último ocupado (igual que el script).
  if nuevo_activo < 0 then nuevo_activo = nuevo_id - 1 end
  hl.dispatch(hl.dsp.focus({ workspace = nuevo_activo }))
end

function GiGiShell.compactar()
  local ok, err = pcall(sin_smart_split, renumerar)
  if not ok then
    util.notificar("compactar: " .. tostring(err):sub(1, 200))
  end
end
