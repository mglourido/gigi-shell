-- gigios/traer-steam.lua — traer al escritorio actual la ventana de Steam que
-- Steam se niega a duplicar.
--
-- El caso: la lista de amigos y los chats son single-instance. Si ya tienes uno
-- abierto en otro escritorio y lo pides otra vez desde la ventana principal de
-- Steam, Steam NO abre una segunda ventana — reutiliza la que ya existe, donde
-- esté. Con misc.focus_on_activate = false (gigios/ventanas.lua) Hyprland
-- tampoco cambia el foco ni el escritorio: solo marca esa ventana como urgent.
-- El síntoma es "hago clic y no pasa nada", cuando en realidad la ventana se
-- abrió en un escritorio que no estás mirando.
--
-- Esto es el mismo razonamiento que ya documenta hypr/scripts/anclaje.py
-- ("urgent de una dirección que YA existía -> relanzamiento single-instance ->
-- mover"), pero aquel solo vigila lo que lanzas DESDE EL LANZADOR, durante una
-- ventana de observación tras el exec. Pedir un chat desde la UI de Steam no
-- pasa por el lanzador, así que ahí no hay nadie escuchando: de ahí este módulo.
--
-- ── Por qué move con selector y no asignar la propiedad ──────────────────────
-- HL.Window.workspace parece escribible y NO lo es: `w.workspace = ws` se acepta
-- sin error, devuelve ok en pcall, y la ventana se queda donde estaba (medido en
-- vivo con la ventana principal de Steam). Es un fallo silencioso perfecto — el
-- código parece correcto y no hace nada. La vía real es dispatcher.
--
-- ── El mensaje de error de la API MIENTE por omisión ─────────────────────────
-- Llamar a hl.dsp.window.move con una clave inválida enumera lo que espera:
-- "direction, x+y(+relative), workspace, into_group, out_of_group". `window` NO
-- sale en esa lista, pero SÍ se acepta y SÍ funciona. Es la diferencia entre
-- esta versión y la anterior, y no es cosmética:
--
--   sin selector -> move actúa sobre la ventana ACTIVA, así que hay que enfocar
--                   primero; focus salta a SU escritorio y move trae la vista de
--                   vuelta. Funciona, pero se ve el PARPADEO del escritorio.
--   con selector -> un solo dispatch, la ventana viene sola, la vista no se
--                   mueve en ningún momento. Sin parpadeo.
--
-- Comprobado en vivo: estando en el escritorio 2 con kitty enfocado y la ventana
-- de Steam en el 3, este único dispatch la trajo al 2 dejando `activews` en 2.
--
-- OJO con `silent`, que promete menos de lo que parece: NO impide que la vista
-- siga a la ventana si la que mueves es la ACTIVA (medido: mover con silent la
-- ventana enfocada se llevó `activews` con ella). Lo que garantiza que aquí no
-- haya salto no es la bandera, es que la ventana urgente por definición NO es la
-- activa — si lo fuera, ya estarías mirándola y no habría nada que traer. Se
-- mantiene `silent` porque en ese caso degenerado es justo lo que evita el
-- rebote; no porque sea lo que arregla el parpadeo.
--
-- ── Acotado a Steam a propósito ──────────────────────────────────────────────
-- Se limita a class = "steam" en vez de valer para cualquier urgent. anclaje.py
-- ya midió el precio de generalizar: cualquier ventana que pida atención acaba
-- viajando al escritorio del usuario, y el síntoma es "ventanas que aparecen de
-- repente y se van solas". Un urgent puede venir de un diálogo de fondo, y
-- teletransportarlo sería peor que el problema que arregla.

local M = {}

--- Escritorio donde dejar la ventana: nil si no es un sitio válido.
--- Los especiales (id <= 0, el scratchpad) quedan fuera, mismo criterio que
--- gigios/ancla-escritorio.lua y compactar.lua: no son una posición donde
--- plantarle una ventana al usuario.
local function destino()
  local ws = hl.get_active_workspace()
  if not ws or ws.special or (ws.id or 0) <= 0 then return nil end
  return ws.id
end

-- Todo en pcall y fail-open hacia "no hacer nada": si la API devuelve nil o el
-- evento trae algo inesperado, el peor caso es que la ventana se quede donde
-- estaba — exactamente el comportamiento de antes de este módulo. Lo contrario,
-- mover una ventana equivocada, sí molestaría de verdad.
--
-- OJO al hacer cambios aquí: los callbacks de la API Lua tienen timeout de
-- 100 ms (ver docs/hyprland-lua-migracion.md). Los dispatch son inmediatos; no
-- metas nada que espere.
hl.on("window.urgent", function(ventana)
  pcall(function()
    -- El argumento del evento es la vía normal; get_urgent_window() es el
    -- respaldo por si esta versión no lo pasa. Sin ninguno de los dos no hay
    -- nada que mover.
    local w = ventana or hl.get_urgent_window()
    if not w or w.class ~= "steam" then return end

    local aqui = destino()
    if not aqui then return end

    local sel = "address:" .. tostring(w.address)

    -- Enfocar y ELEVAR son dos cosas distintas, y hace falta decir las dos.
    -- Enfocar una flotante NO la sube en el z-order: si ya había otra flotante
    -- solapada, la ventana llega enfocada pero TAPADA, y el usuario ve
    -- exactamente el mismo "no ha pasado nada" que este módulo venía a arreglar.
    -- Medido con dos ventanas flotantes idénticamente colocadas y grim sobre la
    -- zona solapada: tras focus() el píxel seguía siendo el de la ventana de
    -- arriba; solo tras bring_to_top() pasó a ser el de la traída.
    local function traer_al_frente()
      hl.dispatch(hl.dsp.focus({ window = sel }))
      hl.dispatch(hl.dsp.window.bring_to_top({ window = sel }))
    end

    -- Ya está donde estás: no hay nada que mover, pero sí que elevar — este es
    -- justo el caso en el que estaba tapada por otra flotante.
    if w.workspace and w.workspace.id == aqui then
      traer_al_frente()
      return
    end

    hl.dispatch(hl.dsp.window.move({ workspace = aqui, window = sel, silent = true }))

    -- El move ya la deja enfocada (observado), pero eso es un efecto colateral,
    -- no una garantía de la API. Se enfoca explícitamente: llegados aquí la
    -- ventana YA está en tu escritorio, así que este focus no puede provocar
    -- ningún salto de vista — no reintroduce el parpadeo.
    traer_al_frente()
  end)
end)

return M
