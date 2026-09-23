-- gigios/ancla-escritorio.lua — un escritorio "ancla" al que ir y del que volver.
--
--   SUPER + SHIFT + S  →  GiGiShell.anclar_escritorio()  (anclar / desanclar aquí)
--   SUPER + S          →  GiGiShell.saltar_ancla()       (ir al ancla / volver)
--
-- La idea: marcas un escritorio como ancla (donde tienes lo que consultas cada
-- dos por tres) y a partir de ahí SUPER+S es un vaivén. Estando FUERA del ancla
-- te lleva a ella y se apunta de dónde venías; estando YA en ella, te devuelve
-- a ese sitio apuntado.
--
--   ancla = w1.  Estás en w3 → SUPER+S → vuelta=w3, vas a w1
--                Estás en w1 → SUPER+S → vuelves a w3
--
-- `vuelta` se reescribe en CADA salto hacia el ancla, y de ahí sale el caso que
-- parece raro pero es el que se pidió: si tras saltar a w1 te vas a w2 por tu
-- cuenta y pulsas otra vez, se apunta w2 (no w3) y vas a w1 — el "volver"
-- siempre te devuelve al sitio desde el que hiciste el ÚLTIMO salto, no a un
-- historial. Verificado en vivo con los dos recorridos del ejemplo.
--
-- ── Por qué el estado va a un FICHERO y no a un local de Lua ──────────────────
-- GiGiShell.toggle_gaps() guarda su flag en un local a propósito (ver keybinds),
-- pero ahí el reload resetea a la vez el flag y los gaps, así que quedan
-- coherentes. Aquí no hay nada en el compositor que resetear: el ancla es una
-- intención del usuario, y `hyprctl reload` la borraría SIN QUE SE NOTE hasta
-- que pulsaras el atajo y no fuera a ninguna parte. Y los reloads no son raros:
-- AGS dispara uno al tocar `absorberSuperSinAtajo` en Ajustes, entre otros.
--
-- Va a $XDG_RUNTIME_DIR (tmpfs, se borra al cerrar sesión), que es justo la
-- duración que se quiere: el ancla es POR SESIÓN, como el Wake up o el menú de
-- funciones. Un fichero en ~/.config la haría sobrevivir a un reinicio y te
-- encontrarías saltando a un escritorio de ayer.
--
-- ── Fail-open hacia "el atajo no hace nada" ───────────────────────────────────
-- Todo va en pcall y cualquier error (fichero ilegible, contenido raro, la API
-- devolviendo nil) degrada a "no hay ancla": el atajo se queda mudo y se
-- arregla volviendo a anclar. Lo contrario —saltar a un escritorio cualquiera
-- por leer mal un número— sería mover al usuario de sitio sin que lo pidiera,
-- que es el fallo molesto de verdad.

local util = require("gigios.util")

-- Un fichero de dos líneas: ancla y vuelta, con 0 = "ninguna". Texto plano y no
-- JSON porque son dos enteros: json.lua aquí solo sabe DECODIFICAR (no hay
-- encoder), así que escribirlo habría que hacerlo a mano igualmente.
local RUTA = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/gigios-ancla-escritorio"

-- Los escritorios especiales (id < 0, el scratchpad) quedan fuera: ni se anclan
-- ni se apuntan como sitio al que volver. No son una posición donde dejar al
-- usuario — el mismo criterio que gigios/limite-ventanas.lua y compactar.lua.
local function id_actual()
  local ws = hl.get_active_workspace()
  if not ws or ws.special or (ws.id or 0) <= 0 then return nil end
  return ws.id
end

local function leer()
  local texto = util.leer_fichero(RUTA) or ""
  local ancla, vuelta = texto:match("^(-?%d+)%s+(-?%d+)")
  ancla, vuelta = tonumber(ancla) or 0, tonumber(vuelta) or 0
  -- Un id <= 0 en el fichero se trata como "ninguno", así que un fichero
  -- truncado o a medio escribir degrada a "no hay ancla" en vez de a un salto.
  return (ancla > 0 and ancla or nil), (vuelta > 0 and vuelta or nil)
end

local function guardar(ancla, vuelta)
  local f = io.open(RUTA, "w")
  if not f then return end
  f:write(("%d %d\n"):format(ancla or 0, vuelta or 0))
  f:close()
end

local function avisar(texto, color)
  util.notificar(texto, { timeout = 2000, color = color, crudo = true })
end

local VERDE = "0xff44cc88"
local GRIS  = "0xff888888"

--- Ancla el escritorio actual. Repetido sobre el que ya es ancla, lo desancla.
function GiGiShell.anclar_escritorio()
  pcall(function()
    local actual = id_actual()
    if not actual then return end

    local ancla = leer()
    if ancla == actual then
      guardar(nil, nil) -- desanclar se lleva por delante el sitio de vuelta
      avisar("escritorio " .. actual .. " desanclado", GRIS)
    else
      -- La vuelta se limpia al anclar: la que hubiera apuntaba al vaivén del
      -- ancla ANTERIOR y no significa nada respecto a esta.
      guardar(actual, nil)
      avisar("escritorio " .. actual .. " anclado  ·  SUPER+S para ir y volver", VERDE)
    end
  end)
end

--- Vaivén: fuera del ancla va a ella (apuntando de dónde vienes); en ella,
--- vuelve a ese sitio.
function GiGiShell.saltar_ancla()
  pcall(function()
    local actual = id_actual()
    if not actual then return end

    local ancla, vuelta = leer()

    -- Sin ancla, la primera pulsación ancla aquí en vez de no hacer nada. Un
    -- atajo mudo es exactamente lo que había antes con el scratchpad vacío: no
    -- pasaba nada y no había forma de saber si el atajo estaba roto.
    if not ancla then
      guardar(actual, nil)
      avisar("escritorio " .. actual .. " anclado  ·  SUPER+S para ir y volver", VERDE)
      return
    end

    if actual ~= ancla then
      guardar(ancla, actual)
      hl.dispatch(hl.dsp.focus({ workspace = ancla }))
      return
    end

    -- Ya estás en el ancla: volver. Sin sitio apuntado (acabas de anclar y no
    -- has saltado aún) no hay a dónde ir, y se dice — callar aquí es lo que
    -- hace parecer que el atajo está roto.
    if vuelta and vuelta ~= ancla then
      hl.dispatch(hl.dsp.focus({ workspace = vuelta }))
    else
      avisar("ancla en el escritorio " .. ancla .. "  ·  aún no hay sitio al que volver", GRIS)
    end
  end)
end

return {}
