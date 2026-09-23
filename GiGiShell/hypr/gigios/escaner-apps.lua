-- gigios/escaner-apps.lua — al empezar la sesión, te lleva al escritorio donde
-- hayan abierto las apps de autostart.
--
-- Problema: al iniciar sesión (autostart, restauración tras un apagado) se
-- abren ventanas SOLAS y no siempre en el escritorio que estás mirando: acabas
-- delante de uno vacío mientras tus apps están en otro. Durante VENTANA_SEGS
-- (30 s) se apunta cada ventana NUEVA y, al terminar, se salta al escritorio
-- donde hayan quedado:
--
--   - 0 ventanas nuevas       → nada.
--   - 1 escritorio destino    → saltar a él.
--   - 2 o más                 → GiGiShell.compactar() primero (que no queden
--                               huecos) y saltar al destino MÁS CERCANO al
--                               activo (empate → id menor).
--
-- LA DECISIÓN SE TOMA AL FINAL, no en cada evento — es la diferencia entre la
-- función y un tic nervioso: actuar sobre la marcha haría rebotar el escritorio
-- activo cinco veces mientras arranca la sesión, justo el ruido que esto quita.
-- El coste asumido es que la corrección llega a los 30 s.
--
-- Qué desaparece respecto al .sh: el lector del socket de eventos (nc/socat),
-- su fallback a sondeo (aquí no existe el modo de fallo "el lector no habló":
-- hl.on es parte del compositor) y toda la normalización de direcciones — en la
-- API Lua las address ya vienen tipadas CON `0x` (medido), que era el primer
-- fallo real del script (cruzar socket y `hyprctl clients` sin normalizar daba
-- cero coincidencias en silencio).
--
-- Solo cuentan las ventanas que NO existían al arrancar: lo ya abierto no es un
-- autolanzamiento. Los escritorios especiales (id < 0) se ignoran — no son una
-- posición donde dejar al usuario.
--
-- Ajuste: `escanerAppsInicio` en preferences.json. AUSENTE = DESACTIVADO, al
-- revés que la mayoría de claves del fichero: mover el escritorio activo por su
-- cuenta es intrusivo y se opta a ello. Se lee UNA vez, al arrancar la sesión —
-- cambiarlo aplica en la próxima, como el .sh (que era de un solo uso, no un
-- daemon). GIGIOS_ESCANER_SEGS acorta la ventana para probarlo sin esperar
-- medio minuto (misma costura que en el .sh).
local util = require("gigios.util")

local function destinos(nuevas)
  -- Escritorios (normales, únicos, ordenados) de las apuntadas que SIGUEN
  -- abiertas. Se re-resuelve tras compactar porque la compactación renumera:
  -- un id leído antes ya no valdría.
  local apuntadas = {}
  for _, addr in ipairs(nuevas) do apuntadas[addr] = true end
  local vistos, ids = {}, {}
  for _, v in ipairs(hl.get_windows()) do
    local ws = v.workspace
    if apuntadas[v.address] and ws and ws.id > 0 and not vistos[ws.id] then
      vistos[ws.id] = true
      ids[#ids + 1] = ws.id
    end
  end
  table.sort(ids)
  return ids
end

local function decidir(nuevas)
  if #nuevas == 0 then return end
  local ws = destinos(nuevas)
  if #ws == 0 then return end

  if #ws > 1 then
    -- compactar() es síncrono (Lua nativo): la re-resolución va justo después,
    -- sin timers de por medio.
    if GiGiShell.compactar then GiGiShell.compactar() end
    ws = destinos(nuevas)
    if #ws == 0 then return end
  end

  local activo = hl.get_active_workspace()
  if not activo then return end

  -- El más cercano al activo; a igual distancia gana el id menor (la lista va
  -- ordenada y solo se cambia con una mejora estricta).
  local destino = ws[1]
  local mejor = math.abs(destino - activo.id)
  for _, id in ipairs(ws) do
    local d = math.abs(id - activo.id)
    if d < mejor then
      mejor, destino = d, id
    end
  end

  if destino ~= activo.id then
    hl.dispatch(hl.dsp.focus({ workspace = destino }))
  end
end

hl.on("hyprland.start", function()
  -- Preferencia: comparación estricta con true — ausente = desactivado.
  if util.prefs().escanerAppsInicio ~= true then return end

  local segs = tonumber(os.getenv("GIGIOS_ESCANER_SEGS") or "") or 30

  -- Línea base: lo que ya está abierto en el arranque no cuenta.
  local conocidas = {}
  for _, v in ipairs(hl.get_windows()) do
    conocidas[v.address] = true
  end

  local nuevas = {}
  local sub = hl.on("window.open", function(ventana)
    -- Callback verificado en la anidada: recibe la HL.Window recién abierta.
    local addr = ventana and ventana.address
    if addr and not conocidas[addr] then
      conocidas[addr] = true
      nuevas[#nuevas + 1] = addr
    end
  end)

  hl.timer(function()
    -- El .sh moría a los 30 s; el equivalente aquí es dejar de escuchar.
    pcall(function() sub:remove() end)
    local ok, err = pcall(decidir, nuevas)
    if not ok then
      util.notificar("escaner-apps: " .. tostring(err):sub(1, 200))
    end
  end, { timeout = segs * 1000, type = "oneshot" })
end)
