-- gigios/reparto-ventanas.lua — que una ventana NUEVA no nazca estrujada.
--
-- El problema es del primer cálculo de tamaño, no del layout en reposo: dwindle
-- parte SIEMPRE la ventana objetivo en dos, y el objetivo por defecto es la
-- última que tuvo el foco en ese escritorio. Abrir cuatro terminales seguidas
-- sin tocar nada da una progresión geométrica, no un reparto (medido en esta
-- máquina, escritorio de 2032x1098):
--
--     1014x1098 · 504x1098 · 252x1098 · 250x1098
--
-- Cada ventana nueva parte a la anterior, que ya era la mitad de la mitad. La
-- quinta habría nacido con 125 px de ancho. Este módulo no cambia el layout ni
-- reordena nada de lo que ya tienes colocado: solo decide, JUSTO ANTES de que
-- la ventana se coloque, DÓNDE se parte y POR QUÉ LADO. Con eso las mismas ocho
-- terminales salen a 504x547 cada una (medido, ver más abajo).
--
-- ES PREVENCIÓN, NO UNA REJILLA FORZADA. Mientras el sitio natural dé una
-- ventana de tamaño razonable el módulo NO interviene y manda dwindle con su
-- `smart_split` (partir por donde tengas el cursor, ver gigios/ventanas.lua).
-- Solo entra cuando el reparto natural bajaría de los mínimos, que es justo el
-- caso que la gente describe como "se ha abierto estrujada".
--
-- ── CÓMO SE INTERVIENE ──────────────────────────────────────────────────────
--
-- Dos palancas, las dos en `window.open_early` (que llega ANTES de colocar la
-- ventana; `window.open` ya sería tarde: ahí solo queda cirugía sobre el árbol):
--
--   1. QUÉ SE PARTE — la ventana en mosaico MÁS CERCANA AL RATÓN de entre las
--      que todavía dan una mitad decente, y se enfoca: dwindle toma como
--      objetivo la última enfocada, así que enfocar es la única forma de
--      redirigir el corte. El foco se lo lleva la ventana nueva al mapearse,
--      así que no se nota; si no se lo lleva (ventana que nace sin foco), se
--      devuelve a donde estaba — ver `cerrar()`.
--   2. POR DÓNDE — `preselect`, que fija dos cosas a la vez: el EJE sale del
--      lado LARGO del objetivo (ancha → se parte en vertical, alta → se apila,
--      que es lo que convierte la progresión en rejilla) y el LADO sale de en
--      qué mitad de esa ventana está el ratón, porque `preselect <dir>` coloca
--      la nueva en ese lado. `preselect` tiene prioridad sobre el cálculo por
--      cuadrante Y sobre smart_split y force_split (ya documentado en
--      gigios/keybinds.lua, donde se usa para el mismo fin en
--      SUPER+SHIFT+dirección).
--
-- LO CERCA QUE ESTÉ DEL RATÓN ES EL SEGUNDO CRITERIO, NO EL PRIMERO. Elegir por
-- cercanía a secas devuelve el problema de partida: el hueco pegado al cursor
-- suele ser justo la rendija de 250 px que acabas de crear. Así que primero se
-- filtran las candidatas por si su mitad da la talla (`mitad_larga` contra los
-- mínimos) y solo entre las que pasan gana la más cercana; a igual distancia,
-- la más grande. Si ninguna pasa —escritorio lleno— manda la mayor: ahí ya no
-- se puede acercar al ratón sin estrujar, y no estrujar manda.
--
-- SIN LA SEGUNDA PALANCA LA PRIMERA NO BASTA, y esto solo se ve midiendo. Con
-- `smart_split = true` el eje NO sale de la forma de la ventana objetivo, sale
-- del cuadrante del cursor sobre ella — y al lanzar desde Orion o desde rofi el
-- cursor está donde lo dejaste, así que el eje sale a suertes y se repite igual
-- ventana tras ventana mientras no muevas el ratón. Medido A/B sobre la misma
-- ventana de 2032x1098: con smart_split salió 2032x547 (apilada); apagándolo,
-- 1014x1098 (lado a lado, que es lo que pide una ventana apaisada). Enfocar la
-- mayor sin arreglar el eje daba así ocho tiras de 2032x134 en vez de ocho
-- ventanas de 504x547. `preselect` arregla el eje SIN tocar smart_split, que
-- sigue mandando en el arrastre y en todo lo que este módulo no toca.
--
-- ── CUÁNDO SE INTERVIENE ────────────────────────────────────────────────────
--
-- Se mira la PEOR mitad posible del objetivo natural: la que sale de partirlo
-- por su lado CORTO, que es la más achatada de las dos. Se toma la peor y no la
-- real porque la real depende del cursor (smart_split) y el cursor no se puede
-- consultar desde aquí. Si esa peor mitad sigue por encima de los mínimos, el
-- sitio natural es bueno pase lo que pase y el módulo se aparta.
--
-- Con dos ventanas de 1014x1098 y mínimos de 480x320: la peor mitad es 507x1098
-- → cabe → NO se interviene, la tercera nace donde diga tu cursor. Con cuatro de
-- 1014x547: la peor mitad es 1014x273 → 273 < 320 → se interviene y la quinta
-- parte a la mayor por su lado largo (507x547). Ese es exactamente el punto en
-- el que "una más" empezaba a estrujar.
--
-- ── LA SEGUNDA VENTANA DE UN ESCRITORIO SIEMPRE VA AL LADO ─────────────────
--
-- Excepción a lo anterior, y la única regla de este módulo que NO es
-- prevención: con UNA sola ventana en mosaico, la siguiente nace **a la
-- derecha**, nunca debajo, pase lo que pase con el ratón. No entra por el
-- camino de los mínimos porque ahí nunca entraría: la peor mitad de una ventana
-- que ocupa el escritorio entero da la talla de sobra, así que el módulo se
-- apartaba y decidía `smart_split` — o sea el cuadrante donde hubieras dejado el
-- cursor. Con el ratón en la mitad de abajo (la barra de tareas, el sitio más
-- normal donde soltarlo) el resultado era un escritorio partido en dos franjas
-- horizontales, que en un panel apaisado es la peor de las dos formas y encima
-- salía distinto en cada arranque sin que se viera por qué.
--
-- Es un FORZADO deliberado, no una heurística: el eje no se calcula, se fija.
-- El lado sí es una convención — derecha, el default de dwindle, para que la
-- ventana que ya tenías no se te mueva de sitio. A partir de la tercera vuelve a
-- mandar todo lo de arriba (mínimos, cercanía al ratón, smart_split).
--
-- ── LÍMITES CONOCIDOS ───────────────────────────────────────────────────────
--
--   · En un escritorio que NO se está viendo no se hace NADA, y eso incluye el
--     eje. Redirigir el corte exige enfocar, y enfocar una ventana de un
--     escritorio oculto ARRASTRA LA VISTA a ese escritorio (medido: la sesión
--     saltó al ws15 durante las pruebas); cambiar dónde nace una ventana no
--     justifica moverte de escritorio. Y corregir SOLO el eje allí, que sí se
--     podía, sale PEOR: sin poder redirigir el objetivo, el corte por el lado
--     largo se ceba con la última ventana y la va dejando cuadrada y diminuta
--     — ocho terminales dieron 123x133 frente a las tiras de 252x1098 de
--     dwindle a secas (medido, mismo escritorio). Misma área, peor forma. Por
--     eso ahí se cede entero. Afecta a lo que se lanza anclado a otro
--     escritorio (Orion, rofi); al llegar tú, lo colocas como quieras.
--   · Esto NO redistribuye lo que ya está abierto. Es el cálculo de la ventana
--     nueva; lo demás lo dejas tú como lo tengas.
--   · Si la ventana acaba flotando por una regla (las reglas aún no están
--     aplicadas en `open_early`), la intervención se deshace sola en
--     `window.open`: `preselect none` + devolver el foco.
--   · Con el escritorio ya lleno interviene igual, aunque no pueda arreglarlo:
--     partir la mayor por su lado largo es de todas formas la menos mala de las
--     opciones. Quien decide que "ya no cabe nadie más" es
--     gigios/limite-ventanas.lua, que corre después y puede mandarla a otro
--     escritorio; allí la coloca dwindle por su cuenta (el `preselect` de aquí
--     ya se consumió en el escritorio de origen).
--
-- Ajustes en ~/.config/gigios/preferences.json, como maxVentanasEscritorio:
--   · `repartoVentanas` — AUSENTE = activado (se comprueba `== false`, un nil
--     tiene que dejar pasar).
--   · `segundaVentanaAlLado` — AUSENTE = activado, mismo criterio. Apaga solo el
--     forzado de la segunda ventana; el resto del módulo sigue igual.
--   · `anchoMinimoVentana` / `altoMinimoVentana` — el listón, en píxeles.
--     Ausentes = 480x320. A 0 los dos = desactivado (nada baja de 0, así que
--     nunca se interviene). Se leen por util.prefs(), o sea una vez por
--     ejecución del config: cambiarlos pide un `hyprctl reload`.
local util = require("gigios.util")

local ANCHO_MIN_DEFECTO = 480
local ALTO_MIN_DEFECTO  = 320
local ESPERA_LIMPIEZA   = 2000   -- ms; red por si `window.open` no llega nunca
local ESPERA_DROP       = 80     -- ms; que dwindle acabe de reinsertar tras soltar
local TOLERANCIA_DROP   = 16     -- px; por debajo de esto "no se ha movido" (ver abajo)

-- Intervención en curso, a la espera de su `window.open`. Solo puede haber una:
-- `preselect` es estado global del compositor, así que una segunda ventana que
-- se abra antes de que la primera se mapee ya le ha pisado el eje de todas
-- formas. Se descarta la vieja sin restaurar nada: su foco lo estamos
-- reescribiendo justo ahora.
local pendiente = nil

--- Ventanas en mosaico de un escritorio (ni flotantes ni ocultas), excluyendo
--- una address. Mismo recuento que gigios/limite-ventanas.lua y que
--- `_hueco_en()` de scripts/anclaje.py: si cambias el criterio, cámbialo en los
--- tres o vuelven a tirar en direcciones distintas.
local function mosaico(ws_id, excluir)
  local out = {}
  local ok, lista = pcall(hl.get_workspace_windows, ws_id)
  if not ok or not lista then return out end
  for _, v in ipairs(lista) do
    if not v.floating and not v.hidden and v.address ~= excluir then
      out[#out + 1] = v
    end
  end
  return out
end

-- OJO: `at` y `size` son tablas {x=, y=}, NO arrays. Un v.size[1] devuelve nil
-- en silencio, el área sale 0 y toda comparación de tamaño pasa a ser cierta
-- (fue el primer fallo real al escribir esto: el módulo creía que todo cabía).
local function area(v) return (v.size.x or 0) * (v.size.y or 0) end

--- La peor mitad de `v`: partirlo por su lado CORTO, que deja la más achatada
--- de las dos formas posibles. Ver "cuándo se interviene" en la cabecera.
local function peor_mitad(v)
  local an, al = v.size.x or 0, v.size.y or 0
  if an <= al then return an / 2, al end
  return an, al / 2
end

--- La mitad que saldría de verdad si este módulo parte `v`: por su lado LARGO,
--- que es lo que deja las dos mitades lo más cuadradas posible.
local function mitad_larga(v)
  local an, al = v.size.x or 0, v.size.y or 0
  if an >= al then return an / 2, al end
  return an, al / 2
end

--- Distancia del cursor al rectángulo de `v`, AL CUADRADO (solo se compara, así
--- que la raíz sobra). 0 si el cursor está dentro.
local function distancia(v, cur)
  local x1, y1 = v.at.x or 0, v.at.y or 0
  local x2, y2 = x1 + (v.size.x or 0), y1 + (v.size.y or 0)
  local dx = math.max(x1 - cur.x, 0, cur.x - x2)
  local dy = math.max(y1 - cur.y, 0, cur.y - y2)
  return dx * dx + dy * dy
end

--- Dirección de `preselect`: el EJE sale del lado largo de `v` (para no dejar
--- tiras) y el LADO, de en qué mitad de `v` está el ratón — `preselect <dir>`
--- coloca la ventana nueva en ese lado, así que con el ratón a la izquierda la
--- nueva nace a la izquierda. Sin cursor legible se cae al lado por defecto de
--- dwindle (derecha / abajo).
local function direccion(v, cur)
  local an, al = v.size.x or 0, v.size.y or 0
  if an >= al then
    if not cur then return "right" end
    return cur.x < (v.at.x or 0) + an / 2 and "left" or "right"
  end
  if not cur then return "down" end
  return cur.y < (v.at.y or 0) + al / 2 and "up" or "down"
end

--- Deshace lo que quede pendiente: limpia el override de `preselect` y devuelve
--- el foco si la ventana nueva no se lo llevó. Un `preselect` sin consumir NO es
--- inocuo: se lo comería la SIGUIENTE ventana que abrieras (ver keybinds.lua).
local function cerrar(p)
  pcall(function()
    hl.dispatch(hl.dsp.layout("preselect none"))
    if not p.enfocada or not p.previo then return end
    local activa = hl.get_active_window()
    -- Solo se restaura si el foco se quedó donde LO DEJAMOS nosotros: si la
    -- ventana nueva (o cualquier otra cosa) se lo llevó, devolverlo sería
    -- robárselo a quien toca.
    if not activa or activa.address ~= p.objetivo then return end
    local previo = hl.get_window("address:" .. p.previo)
    if previo then hl.dispatch(hl.dsp.focus({ window = previo })) end
  end)
end

hl.on("window.open_early", function(ventana)
  -- `open_early` llega ANTES de colocar la ventana y ANTES de aplicar reglas:
  -- es el único momento en el que aún se puede elegir el sitio sin cirugía.
  local ok, err = pcall(function()
    if not ventana or ventana.floating then return end

    local ws = ventana.workspace
    if not ws or ws.special or ws.id <= 0 then return end

    local lista = mosaico(ws.id, ventana.address)
    if #lista == 0 then return end   -- primera del escritorio: no hay nada que partir

    -- SEGUNDA VENTANA: AL LADO, NUNCA DEBAJO. Ver la sección de la cabecera.
    -- Va ANTES del listón de los mínimos porque con una sola ventana el listón
    -- siempre lo aprueba y el eje acabaría saliendo del cuadrante del cursor; y
    -- antes también de `repartoVentanas`, porque no es reparto: apagar la
    -- prevención de ventanas estrujadas no tiene por qué devolverte las dos
    -- franjas horizontales.
    if #lista == 1 and util.prefs().segundaVentanaAlLado ~= false then
      if pendiente then pendiente = nil end   -- ver la nota de la variable
      -- Sin palanca 1: solo hay un objetivo posible, así que no hay nada que
      -- enfocar (ni por tanto el problema de arrastrar la vista a un escritorio
      -- oculto: esta rama sí vale con `ws.visible` falso) y `cerrar()` se
      -- limitará a soltar el override.
      hl.dispatch(hl.dsp.layout("preselect right"))
      local p = { addr = ventana.address, enfocada = false }
      pendiente = p
      hl.timer(function()
        if pendiente == p then
          pendiente = nil
          cerrar(p)
        end
      end, { timeout = ESPERA_LIMPIEZA, type = "oneshot" })
      return
    end

    if util.prefs().repartoVentanas == false then return end
    -- Escritorio que no se ve: nada. Ver "límites conocidos" — sin poder
    -- enfocar (arrastraría la vista) el arreglo a medias empeora el resultado.
    if not ws.visible then return end

    local ancho_min = tonumber(util.prefs().anchoMinimoVentana) or ANCHO_MIN_DEFECTO
    local alto_min  = tonumber(util.prefs().altoMinimoVentana)  or ALTO_MIN_DEFECTO
    if ancho_min <= 0 and alto_min <= 0 then return end

    -- Objetivo natural de dwindle: la última enfocada de ESE escritorio.
    local natural = ws.last_window
    if natural and (natural.address == ventana.address or natural.floating or natural.hidden
                    or not natural.workspace or natural.workspace.id ~= ws.id) then
      natural = nil
    end
    if natural then
      local an, al = peor_mitad(natural)
      if an >= ancho_min and al >= alto_min then return end   -- el sitio natural ya vale
    end
    -- Sin `natural` (la última enfocada de ese escritorio ya no está, o flota) no
    -- hay nada que predecir, y ante la duda se interviene: el coste de hacerlo de
    -- más es pisar el cuadrante del cursor una vez; el de no hacerlo, una ventana
    -- estrujada. Es el caso raro — `last_window` casi siempre está y es de mosaico.

    -- Mejor sitio: la MÁS CERCANA AL RATÓN de entre las que aún dan una mitad
    -- decente. No la mayor a secas — eso repartía bien pero mandaba la ventana
    -- a donde tocara, y abrir algo con el ratón a la izquierda para que aparezca
    -- a la derecha desorienta. El listón (`mitad_larga` contra los mínimos) es
    -- lo que impide que "cerca del ratón" acabe siendo "en la rendija de 250 px
    -- que tengo debajo": una ventana que no da la talla no es candidata, por
    -- pegada al cursor que esté.
    local cur = hl.get_cursor_pos()
    local aptas = {}
    for _, v in ipairs(lista) do
      local an, al = mitad_larga(v)
      if an >= ancho_min and al >= alto_min then aptas[#aptas + 1] = v end
    end

    local mejor
    if cur and #aptas > 0 then
      mejor = aptas[1]
      local dm = distancia(mejor, cur)
      for _, v in ipairs(aptas) do
        local d = distancia(v, cur)
        -- A igual distancia (típico: el cursor DENTRO de una, d=0 en ambas solo
        -- si se tocan) gana la más grande.
        if d < dm or (d == dm and area(v) > area(mejor)) then mejor, dm = v, d end
      end
    else
      -- Sin cursor legible, o con el escritorio tan lleno que ninguna da la
      -- talla: la mayor, que es la menos mala. Aquí ya no se puede "acercar al
      -- ratón" sin estrujar, y no estrujar manda.
      mejor = lista[1]
      for _, v in ipairs(lista) do
        if area(v) > area(mejor) then mejor = v end
      end
    end

    if pendiente then pendiente = nil end   -- ver la nota de la variable

    -- Palanca 1: redirigir el corte. Innecesario si el objetivo natural YA es
    -- la mayor: ahí solo hace falta arreglar el eje.
    local enfocada, previo = false, nil
    if not natural or natural.address ~= mejor.address then
      local activa = hl.get_active_window()
      if activa and activa.address ~= mejor.address then previo = activa.address end
      hl.dispatch(hl.dsp.focus({ window = mejor }))
      enfocada = true
    end

    -- Palanca 2: el eje. Si no se pudo redirigir, al menos que el objetivo
    -- natural se parta por su lado largo en vez de por donde caiga el cursor.
    local objetivo = enfocada and mejor or (natural or mejor)
    hl.dispatch(hl.dsp.layout("preselect " .. direccion(objetivo, cur)))

    local p = { addr = ventana.address, objetivo = mejor.address, previo = previo, enfocada = enfocada }
    pendiente = p

    -- Red: si la ventana no llega a mapearse, `window.open` no se dispara y el
    -- `preselect` se quedaría puesto para la siguiente.
    hl.timer(function()
      if pendiente == p then
        pendiente = nil
        cerrar(p)
      end
    end, { timeout = ESPERA_LIMPIEZA, type = "oneshot" })
  end)
  if not ok then
    util.notificar("reparto-ventanas: " .. tostring(err):sub(1, 200))
  end
end)

hl.on("window.open", function(ventana)
  -- Aquí la ventana ya está colocada y con sus reglas aplicadas: el override ya
  -- se consumió (o no, si acabó flotando) y toca dejar el estado limpio.
  if not pendiente or not ventana or ventana.address ~= pendiente.addr then return end
  local p = pendiente
  pendiente = nil
  cerrar(p)
end)

-- ── SOLTAR UNA VENTANA ARRASTRADA ───────────────────────────────────────────
--
-- Lo de arriba cubre el nacimiento; esto cubre el otro momento en el que un
-- tamaño se decide de golpe sin que tú lo pidas: SUPER + arrastrar y soltar
-- (`bindm` de gigios/keybinds.lua). Al soltar, dwindle reinserta la ventana
-- partiendo el destino en dos, así que soltarla sobre una ventana ya pequeña la
-- deja en la mitad de poco. Aquí no se puede elegir el destino —lo has elegido
-- tú con el ratón— así que la palanca es la otra: **quitarles sitio a los
-- vecinos**. `resizeactive exact` mueve las proporciones del árbol, o sea que
-- el hueco sale de encoger al vecino (y al vecino del vecino si hace falta), no
-- de tapar a nadie.
--
-- SOLO se pide el MÍNIMO, nunca más: el sitio se lo estamos quitando a otro, y
-- pasarse de lo justo sería resolver un estrujón creando otro. Si dwindle no
-- puede dar tanto (topa con su límite de proporción, el vecino ya está en su
-- suelo) da lo que pueda y ahí se queda — mejor algo que nada.
--
-- LA DETECCIÓN DEL SOLTAR SON DOS BINDS MÁS sobre la misma combinación que el
-- `bindm`, uno normal y otro con `{ release = true }`. Hyprland ejecuta todos
-- los binds de una combinación, así que conviven con el arrastre nativo —
-- verificado con un ratón virtual (uinput) haciendo el arrastre de verdad: se
-- registran PRESS y RELEASE y la ventana se mueve igual. Ojo: esto es
-- `release`, NO el `drag` de la advertencia de la cabecera de keybinds.lua, que
-- sí se come el primer arrastre de cada sesión.
--
-- EL PRESS NO SOBRA: guarda la geometría de partida para poder distinguir un
-- arrastre de un SUPER+clic que no movió nada. Sin esa comparación, un clic con
-- SUPER encima de una ventana pequeña la ensancharía sola, que es un efecto
-- secundario que nadie ha pedido y que además nadie relacionaría con el clic.
--
-- Se espera `ESPERA_DROP` antes de mirar porque al llegar el release dwindle
-- todavía está reinsertando: leer ahí da la geometría de antes.
--
-- TRAMPA MEDIDA: `hl.dsp.window.resize` IGNORA `window = ...` y redimensiona
-- SIEMPRE la ventana activa — sin error ni aviso (medido: pidiendo agrandar
-- tst3 se agrandó tst2, que era la activa). Por eso se comprueba que la activa
-- siga siendo la que soltaste antes de tocar nada; si el foco ya se fue a otra
-- (el ratón pasando por encima, con follow_mouse), se deja estar. Agrandar la
-- ventana equivocada sería mucho peor que no agrandar ninguna.
local arrastre = nil

--- SUPER + botón izq, al pulsar: foto de la ventana que se va a arrastrar.
---
--- AQUÍ NO SE VALIDA NADA, y no es dejadez. Cuando llega esta pulsación el
--- `bindm` nativo ya se ha ejecutado y la ventana está **flotando**: así dibuja
--- Hyprland el arrastre (la saca del mosaico y la vuelve a meter al soltar).
--- Descartar lo flotante aquí —que es lo primero que uno escribe— hacía que la
--- foto no se tomara NUNCA y que todo esto no hiciera nada, sin un solo error
--- por ningún lado. La geometría sí es todavía la del mosaico, que es la que
--- interesa. Las comprobaciones van al soltar, donde el estado ya es el bueno;
--- una ventana que YA flotaba antes del arrastre sigue flotando allí y se
--- descarta entonces.
function GiGiShell.reparto_arrastre_inicio()
  arrastre = nil
  pcall(function()
    if util.prefs().repartoVentanas == false then return end
    local v = hl.get_active_window()
    if not v then return end
    arrastre = { addr = v.address, x = v.at.x, y = v.at.y, an = v.size.x, al = v.size.y }
  end)
end

--- SUPER + botón izq, al soltar: si cayó en un sitio demasiado justo, se le
--- hace hueco a costa de los vecinos.
function GiGiShell.reparto_arrastre_fin()
  local a = arrastre
  arrastre = nil
  if not a then return end

  hl.timer(function()
    local ok, err = pcall(function()
      local v = hl.get_window("address:" .. a.addr)
      if not v or v.floating or v.hidden then return end
      local ws = v.workspace
      if not ws or ws.special or ws.id <= 0 then return end

      -- Un SUPER+clic que no arrastró nada no es un drop: fuera. Con TOLERANCIA
      -- y no con una igualdad exacta, porque un clic sin mover TAMPOCO deja la
      -- geometría intacta: Hyprland saca la ventana del mosaico y la vuelve a
      -- meter igual, y al reinsertarla las proporciones bailan unos píxeles
      -- (medido: 223 -> 220 con un clic de cero desplazamiento). Con `==` eso
      -- contaba como movimiento y el clic podía acabar ensanchando la ventana.
      -- Un drop de verdad cae en otra casilla, así que se pasa de largo estos
      -- 16 px sin despeinarse.
      if math.abs(v.at.x - a.x) < TOLERANCIA_DROP and math.abs(v.at.y - a.y) < TOLERANCIA_DROP
         and math.abs(v.size.x - a.an) < TOLERANCIA_DROP and math.abs(v.size.y - a.al) < TOLERANCIA_DROP then
        return
      end

      local ancho_min = tonumber(util.prefs().anchoMinimoVentana) or ANCHO_MIN_DEFECTO
      local alto_min  = tonumber(util.prefs().altoMinimoVentana)  or ALTO_MIN_DEFECTO
      local an, al = v.size.x or 0, v.size.y or 0
      if an >= ancho_min and al >= alto_min then return end   -- cayó bien, nada que hacer

      -- Ver la trampa de arriba: `resize` va a la ACTIVA, no a `window`.
      local activa = hl.get_active_window()
      if not activa or activa.address ~= a.addr then return end

      hl.dispatch(hl.dsp.window.resize({
        exact = true,
        x = math.max(an, ancho_min),
        y = math.max(al, alto_min),
      }))
    end)
    if not ok then
      util.notificar("reparto-ventanas (drop): " .. tostring(err):sub(1, 200))
    end
  end, { timeout = ESPERA_DROP, type = "oneshot" })
end
