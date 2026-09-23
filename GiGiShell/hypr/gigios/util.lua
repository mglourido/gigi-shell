-- Utilidades compartidas por todos los módulos del config Lua.
--
-- La regla de oro aquí es la trampa nº 1 de la migración: un error de Lua sin
-- capturar deja el compositor SIN ATAJOS (solo SUPER+Q de emergencia), y
-- `--verify-config` solo pilla errores de parseo, no de ejecución. Por eso todo
-- lo que pueda fallar (leer un JSON, cargar un módulo) pasa por pcall aquí, y un
-- fallo degrada a "esta pieza no se aplica + aviso visible", nunca a "sesión rota".
local json = require("gigios.json")

local M = {}

M.HOGAR = os.getenv("HOME") or ""

-- Directorio del config (…/hypr/): se saca de package.path, que Hyprland fija a
-- "<dir del config>/?.lua;…" (medido en Fase 0). Sirve para localizar los
-- ficheros generados por AGS que viven junto a hyprland.lua.
M.DIR_CONFIG = (package.path:match("^(.-)%?%.lua") or (M.HOGAR .. "/.config/hypr/"))

--- Aviso en pantalla del propio compositor (no necesita daemon de notificaciones,
--- que en el arranque aún no existe). Color por defecto: rojo error.
---
--- `opts.crudo` quita el prefijo "[GiGiShell Lua]". El prefijo existe para que un
--- fallo del config se distinga de un aviso de cualquier otro programa, así que
--- sobra —y confunde, porque se lee como un error— en las confirmaciones
--- rutinarias de una función que el usuario acaba de invocar a propósito
--- (gigios/ancla-escritorio.lua). Para avisos de fallo, sin tocar.
function M.notificar(texto, opts)
  opts = opts or {}
  pcall(function()
    hl.notification.create({
      text = (opts.crudo and "" or "[GiGiShell Lua] ") .. texto,
      timeout = opts.timeout or 10000,
      color = opts.color or "0xffcc4444",
    })
  end)
end

--- Contenido completo de un fichero, o nil si no existe / no se puede leer.
function M.leer_fichero(ruta)
  local f = io.open(ruta, "r")
  if not f then return nil end
  local contenido = f:read("*a")
  f:close()
  return contenido
end

--- JSON de disco → tabla. nil si el fichero falta o está corrupto (sin lanzar).
function M.leer_json(ruta)
  local texto = M.leer_fichero(ruta)
  if not texto or texto == "" then return nil end
  local ok, v = pcall(json.decode, texto)
  if not ok then return nil end
  return v
end

local _prefs_cache = nil
--- ~/.config/gigios/preferences.json, cacheado durante esta ejecución del config
--- (cada `hyprctl reload` re-ejecuta el Lua desde cero, así que la caché no
--- envejece). Fichero ausente o corrupto → {} y cada consumidor aplica su default.
function M.prefs()
  if _prefs_cache == nil then
    _prefs_cache = M.leer_json(M.HOGAR .. "/.config/gigios/preferences.json") or {}
  end
  return _prefs_cache
end

--- require() protegido para módulos PROPIOS (versionados): si el módulo lanza,
--- se avisa en pantalla y se sigue con el resto del config — mejor un bloque de
--- config ausente que una sesión sin atajos.
function M.carga(nombre)
  local ok, res = pcall(require, nombre)
  if not ok then
    M.notificar("error cargando " .. nombre .. ": " .. tostring(res):sub(1, 200))
    return nil
  end
  return res
end

-- Aquí vivía carga_opcional(), el dofile protegido de los chunks que AGS
-- generaba (monitor-settings.lua, input-settings.lua). Ya no hay código
-- generado: los ajustes de la UI se leen de su JSON con M.leer_json() y los
-- aplican gigios/pantalla.lua y gigios/dispositivos.lua. Ver CLAUDE.md.

return M
