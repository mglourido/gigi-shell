-- gigishell/vista-en-vivo.lua — que las apps de un escritorio oculto sigan pintando
-- solo mientras su miniatura de la barra está abierta.
--
-- Hyprland no manda `frame callback` a una ventana oculta, así que la app deja de
-- dibujar y la captura repite su último fotograma. `render_unfocused` hace que se
-- los mande. Lo abre y lo cierra AGS (modulos/barra/escritorios/gestorVistaPrevia.ts).
--
-- Medido con un kitty animado en un escritorio oculto y captura a 30 fps, en
-- fotogramas distintos por segundo: 0,2 sin nada, 30,4 con esto.
--
-- ── Tres trampas de Hyprland 0.57, medidas ───────────────────────────────────
-- 1. `hl.dsp.window.set_prop` con render_unfocused responde `ok` y no hace NADA:
--    la ventana solo entra en la lista del temporizador al reevaluar sus reglas
--    (0,2/s). Una etiqueta sí las reevalúa; de ahí la regla por etiqueta.
-- 2. QUITAR la etiqueta NO la saca de la lista: el temporizador no mira la regla y
--    solo limpia cuando muere una ventana de la lista (30,4/s tras quitarla). El
--    único freno es el límite global, y por eso FPS_REPOSO. Queda ese goteo (FPS_REPOSO
--    fotogramas/s) en las ventanas ya vistas hasta que se cierre alguna de ellas.
-- 3. render_unfocused_fps = 0 NO se puede poner: el temporizador divide entre él.
-- 4. render_unfocused no quita el estado SUSPENDED de xdg_toplevel. Hyprland se lo pone
--    a toda ventana de un escritorio oculto cada vez que alguien cambia de escritorio
--    o mueve una ventana, y kitty deja de dibujar y de pedir llamadas de marco hasta
--    perderlo: 0 fotogramas/s. `resize` relativo de 0,0 lo quita, porque acaba en
--    setHidden(false) y este en setSuspended(false). Medido con dos kitty ocultos: 0/s
--    los dos, y al aplicarlo a uno solo, 30/s ese y 0/s el otro. Ver despertar().
--
-- ── Los juegos quedan FUERA, y es una decisión ───────────────────────────────
-- Por las trampas 2 y el `min_size` de despertar(), lo que se hace a una ventana no se
-- puede deshacer: un juego visto una vez seguiría recibiendo frame callbacks estando
-- oculto. Ni se etiqueta ni se despierta, así que su miniatura enseña el último
-- fotograma en vez de vídeo en vivo. El criterio es la clase (util.es_clase_juego), el
-- mismo de la regla `tearing-games`; una ventana que reciba su clase después de abrirse
-- no se reconoce al abrirse, pero sí la siguiente vez que se abra la miniatura.

local util = require("gigishell.util")

local ETIQUETA = "vista-en-vivo"
local FPS_VISTA = 30
-- Hyprland reprograma el temporizador al vencer, no al cambiar la opción: subir los fps no adelanta
-- el tick ya en marcha, y al reabrir la app espera ese tick (Renderer.cpp, medido: 112-953 ms con 1
-- fps; 95-260 ms con 4). 4 deja el retraso por debajo de los 500 ms que pide la vista de escritorios.
local FPS_REPOSO = 4

-- Escritorios con la miniatura abierta. Puede haber uno por monitor.
local vistos = {}
local fps_vista = FPS_VISTA

hl.config({ misc = { render_unfocused_fps = FPS_REPOSO } })

hl.window_rule({
  name  = "vista-en-vivo",
  match = { tag = ETIQUETA },
  render_unfocused = true,
})

local function marcar(ventana, activar)
  if activar and util.es_clase_juego(ventana.class) then return end
  hl.dispatch(hl.dsp.window.tag({
    tag = (activar and "+" or "-") .. ETIQUETA,
    window = ventana,
  }))
end

-- Ver trampa 4. `hidden` es una ventana tragada, y el resize la destaparía de verdad.
-- En el escritorio visible no hay nada que quitar. A pantalla completa `resize` responde
-- con error sin llegar a setHidden, así que va por min_size, que también acaba ahí
-- (medido: 0/s -> 30/s, misma geometría). Esa forma deja el mínimo de 1x1 mientras viva
-- la ventana y no se puede deshacer; solo se nota al encogerla a mano estando flotante.
local function despertar(ventana)
  if util.es_clase_juego(ventana.class) then return end
  if ventana.hidden or (ventana.workspace and ventana.workspace.visible) then return end
  if ventana.fullscreen ~= 0 then
    hl.dispatch(hl.dsp.window.set_prop({ prop = "min_size", value = "1 1", window = ventana }))
  else
    hl.dispatch(hl.dsp.window.resize({ x = 0, y = 0, relative = true, window = ventana }))
  end
end

-- Se difiere porque workspace.active se emite ANTES de que Hyprland recalcule SUSPENDED
-- (Monitor::changeWorkspace), que desharía lo hecho dentro del propio evento.
local redespertar_pendiente = false

-- Medido con 20 ventanas ocultas en 3 escritorios: 1-2 ms por pasada, muy por debajo de
-- los 50 ms que da Hyprland al callback de hl.timer; no hace falta limitar el trabajo.
local function redespertar_pasada()
  for id in pairs(vistos) do
    -- Un escritorio de `vistos` puede haber dejado de existir: no debe perder el resto.
    pcall(function()
      for _, ventana in ipairs(hl.get_workspace_windows(id)) do
        pcall(despertar, ventana)
      end
    end)
  end
end

-- Es el manejador de los eventos tal cual: un fallo aquí no debe propagarse al evento.
local function redespertar_luego()
  pcall(function()
    if redespertar_pendiente or next(vistos) == nil then return end
    hl.timer(function()
      redespertar_pendiente = false
      redespertar_pasada()
    end, { timeout = 1, type = "oneshot" })
    redespertar_pendiente = true
  end)
end

local function soltar_no_vistas()
  for _, ventana in ipairs(hl.get_windows({ tag = ETIQUETA })) do
    pcall(function()
      if not (ventana.workspace and vistos[ventana.workspace.id]) then marcar(ventana, false) end
    end)
  end
  if next(vistos) == nil then
    fps_vista = FPS_VISTA
    hl.config({ misc = { render_unfocused_fps = FPS_REPOSO } })
  end
end

-- Las etiquetas sobreviven a una recarga y este estado no. También limpia lo que
-- deje un AGS caído con una miniatura abierta (ver vista_en_vivo_limpiar).
soltar_no_vistas()

function GiGiShell.vista_en_vivo(id_escritorio, activar)
  if activar then
    vistos[id_escritorio] = true
    hl.config({ misc = { render_unfocused_fps = fps_vista } })
    for _, ventana in ipairs(hl.get_workspace_windows(id_escritorio)) do
      pcall(marcar, ventana, true)
      pcall(despertar, ventana)
    end
  else
    vistos[id_escritorio] = nil
    soltar_no_vistas()
  end
end

-- Cambia el ritmo mientras haya algún escritorio visto; sin ninguno, soltar_no_vistas lo repone.
function GiGiShell.vista_en_vivo_fps(fps)
  fps_vista = fps
  if next(vistos) ~= nil then
    hl.config({ misc = { render_unfocused_fps = fps } })
  end
end

function GiGiShell.vista_en_vivo_limpiar()
  vistos = {}
  soltar_no_vistas()
end

-- Lo que llega al escritorio con la miniatura ya abierta también tiene que pintar.
local function al_llegar(ventana, escritorio)
  pcall(function()
    if escritorio and vistos[escritorio.id] then marcar(ventana, true) end
  end)
end

hl.on("window.open", function(ventana)
  al_llegar(ventana, ventana and ventana.workspace)
end)

hl.on("window.move_to_workspace", function(ventana, escritorio)
  al_llegar(ventana, escritorio)
  redespertar_luego()
end)

-- Lo único que vuelve a poner SUSPENDED (GlobalWindowController::updateSuspendedStates).
hl.on("workspace.active", redespertar_luego)
hl.on("workspace.special_active", redespertar_luego)
hl.on("workspace.move_to_monitor", redespertar_luego)
