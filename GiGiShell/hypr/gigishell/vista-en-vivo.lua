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
--    único freno es el límite global, y por eso FPS_REPOSO. Queda ese goteo (1,2/s)
--    en las ventanas ya vistas hasta que se cierre alguna de ellas.
-- 3. render_unfocused_fps = 0 NO se puede poner: el temporizador divide entre él.

local ETIQUETA = "vista-en-vivo"
local FPS_VISTA = 30
local FPS_REPOSO = 1

-- Escritorios con la miniatura abierta. Puede haber uno por monitor.
local vistos = {}

hl.config({ misc = { render_unfocused_fps = FPS_REPOSO } })

hl.window_rule({
  name  = "vista-en-vivo",
  match = { tag = ETIQUETA },
  render_unfocused = true,
})

local function marcar(ventana, activar)
  hl.dispatch(hl.dsp.window.tag({
    tag = (activar and "+" or "-") .. ETIQUETA,
    window = ventana,
  }))
end

local function soltar_no_vistas()
  for _, ventana in ipairs(hl.get_windows({ tag = ETIQUETA })) do
    pcall(function()
      if not (ventana.workspace and vistos[ventana.workspace.id]) then marcar(ventana, false) end
    end)
  end
  if next(vistos) == nil then
    hl.config({ misc = { render_unfocused_fps = FPS_REPOSO } })
  end
end

-- Las etiquetas sobreviven a una recarga y este estado no. También limpia lo que
-- deje un AGS caído con una miniatura abierta (ver vista_en_vivo_limpiar).
soltar_no_vistas()

function GiGiShell.vista_en_vivo(id_escritorio, activar)
  if activar then
    vistos[id_escritorio] = true
    hl.config({ misc = { render_unfocused_fps = FPS_VISTA } })
    for _, ventana in ipairs(hl.get_workspace_windows(id_escritorio)) do
      pcall(marcar, ventana, true)
    end
  else
    vistos[id_escritorio] = nil
    soltar_no_vistas()
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

hl.on("window.move_to_workspace", al_llegar)
