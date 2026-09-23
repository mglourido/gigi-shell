-- Decodificador JSON puro-Lua, solo lectura. Vendorizado porque Hyprland no
-- expone ninguno en su intérprete embebido (medido en Fase 0: ni `json` global,
-- ni `hl.json`, ni cjson). Cubre lo que consumen los módulos del config:
-- objetos, arrays, strings (con escapes y \uXXXX incl. pares sustitutos),
-- números, true/false/null (null → nil).
local M = {}

local function error_en(s, i, msg)
  error(string.format("JSON: %s en el byte %d (…%s…)", msg, i, s:sub(i, i + 12)), 0)
end

local function saltar(s, i)
  local _, j = s:find("^[ \t\r\n]*", i)
  return j + 1
end

local parse_valor

local function parse_string(s, i)
  -- i apunta a la comilla de apertura
  local partes, n = {}, 0
  i = i + 1
  while true do
    local c = s:sub(i, i)
    if c == "" then error_en(s, i, "string sin cerrar") end
    if c == '"' then return table.concat(partes), i + 1 end
    if c == "\\" then
      local e = s:sub(i + 1, i + 1)
      if e == "u" then
        local hex = s:sub(i + 2, i + 5)
        if not hex:match("^%x%x%x%x$") then error_en(s, i, "escape \\u inválido") end
        local cp = tonumber(hex, 16)
        i = i + 6
        if cp >= 0xD800 and cp <= 0xDBFF then
          -- par sustituto: debe seguir \uDC00-\uDFFF
          local hex2 = s:match("^\\u(%x%x%x%x)", i)
          local lo = hex2 and tonumber(hex2, 16)
          if lo and lo >= 0xDC00 and lo <= 0xDFFF then
            cp = 0x10000 + (cp - 0xD800) * 0x400 + (lo - 0xDC00)
            i = i + 6
          end
        end
        n = n + 1; partes[n] = utf8.char(cp)
      else
        local mapa = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b",
                       f = "\f", n = "\n", r = "\r", t = "\t" }
        local trad = mapa[e]
        if not trad then error_en(s, i, "escape desconocido \\" .. e) end
        n = n + 1; partes[n] = trad
        i = i + 2
      end
    else
      -- tramo literal hasta el siguiente \ o "
      local j = s:find('[\\"]', i)
      if not j then error_en(s, i, "string sin cerrar") end
      n = n + 1; partes[n] = s:sub(i, j - 1)
      i = j
    end
  end
end

local function parse_numero(s, i)
  local num = s:match("^-?%d+%.?%d*[eE]?[+%-]?%d*", i)
  local v = tonumber(num)
  if not v then error_en(s, i, "número inválido") end
  return v, i + #num
end

parse_valor = function(s, i)
  i = saltar(s, i)
  local c = s:sub(i, i)
  if c == "" then error_en(s, i, "fin inesperado") end
  if c == '"' then return parse_string(s, i) end
  if c == "{" then
    local obj = {}
    i = saltar(s, i + 1)
    if s:sub(i, i) == "}" then return obj, i + 1 end
    while true do
      i = saltar(s, i)
      if s:sub(i, i) ~= '"' then error_en(s, i, "se esperaba clave") end
      local clave; clave, i = parse_string(s, i)
      i = saltar(s, i)
      if s:sub(i, i) ~= ":" then error_en(s, i, "se esperaba ':'") end
      local v; v, i = parse_valor(s, i + 1)
      obj[clave] = v
      i = saltar(s, i)
      local sep = s:sub(i, i)
      if sep == "," then i = i + 1
      elseif sep == "}" then return obj, i + 1
      else error_en(s, i, "se esperaba ',' o '}'") end
    end
  end
  if c == "[" then
    local arr = {}
    i = saltar(s, i + 1)
    if s:sub(i, i) == "]" then return arr, i + 1 end
    while true do
      local v; v, i = parse_valor(s, i)
      arr[#arr + 1] = v
      i = saltar(s, i)
      local sep = s:sub(i, i)
      if sep == "," then i = i + 1
      elseif sep == "]" then return arr, i + 1
      else error_en(s, i, "se esperaba ',' o ']'") end
    end
  end
  if s:sub(i, i + 3) == "true" then return true, i + 4 end
  if s:sub(i, i + 4) == "false" then return false, i + 5 end
  if s:sub(i, i + 3) == "null" then return nil, i + 4 end
  if c == "-" or c:match("%d") then return parse_numero(s, i) end
  error_en(s, i, "valor inesperado")
end

--- Decodifica `texto`. Lanza error() con mensaje si el JSON es inválido;
--- envuélvelo en pcall si la fuente no es de confianza.
function M.decode(texto)
  local v, i = parse_valor(texto, 1)
  i = saltar(texto, i)
  if i <= #texto then error_en(texto, i, "contenido tras el valor") end
  return v
end

return M
