-- Aspecto y comportamiento de ventanas: general, decoration, layouts y misc.
-- Aspecto de las ventanas: gaps, bordes, sombras, blur y layout.

local util = require("gigishell.util")

-- FUENTE ÚNICA del "modo normal" del espaciado. GiGiShell.toggle_gaps()
-- (gigishell/keybinds.lua, SUPER+SHIFT+E) restaura EXACTAMENTE esta tabla al salir
-- del modo compacto, en vez de los literales que llevaba copiados: cambiar un
-- gap aquí ya no deja el toggle restaurando un valor obsoleto. Es la única
-- escritura de estas cuatro claves en todo el config (verificado: reglas.lua
-- solo las nombra en ejemplos comentados), así que no hay otro escritor con el
-- que desincronizarse.
local aspecto = {
  -- Espaciado UNIFORME de 4 px: `gaps_in` es MEDIO hueco (se aplica a cada uno
  -- de los dos lados que se tocan), así que 2 aquí son los mismos 4 px que deja
  -- `gaps_out` contra los bordes de la pantalla y contra la zona exclusiva de la
  -- barra. Antes eran 2.5/8 (el 2.5 venía de hyprlang y se truncaba a 2), y el
  -- resultado medido era 4 px entre ventanas contra 8 px en todo lo demás: el
  -- doble, que es justo lo que se veía descuadrado.
  gaps_in  = 2,
  gaps_out = 4,
  border_size = 0,
  rounding    = 6,

  -- Opacidad "de siempre" de las ventanas. Está aquí, y no suelta dentro del
  -- bloque `decoration` de abajo, por el mismo motivo que los gaps: el modo
  -- ahorro las fuerza a 1.0 y luego tiene que devolverlas, y con el valor
  -- escrito a mano en dos sitios el día que se cambie aquí la restauración
  -- pondría el de antes. Ver `opacidad_ahorro` más abajo.
  active_opacity   = 1.0,
  inactive_opacity = 0.92,
}

-- FUENTE ÚNICA de los ajustes de dwindle, por el mismo motivo que `aspecto`:
-- `sin_smart_split()` (más abajo) los apaga y los vuelve a encender, y con el
-- valor escrito a mano en dos sitios el día que se cambie aquí el envoltorio
-- restauraría el de antes.
local dwindle = {
  -- preserve_split = true CONGELA la orientación del nodo padre: al arrastrar
  -- (SUPER + clic izq) la ventana solo INTERCAMBIA posición, nunca cambia de
  -- horizontal a vertical — había que pasar antes por SUPER + SHIFT + J
  -- (togglesplit). En false, dwindle recalcula la orientación al reinsertar la
  -- ventana en el árbol, que es justo lo que hace un drop.
  preserve_split = false,

  -- Y smart_split es lo que da el control fino al soltar: la orientación sale
  -- del CUADRANTE de la ventana destino sobre el que sueltas (mitad izq/dcha →
  -- se parten en vertical, lado a lado; mitad sup/inf → se apilan). Ignora
  -- preserve_split y force_split por diseño; también aplica al abrir ventana
  -- nueva, que pasa a nacer partiendo por donde tengas el cursor.
  --
  -- ⚠️ Y ESO ÚLTIMO ES SU PRECIO: el cuadrante del cursor solo significa algo
  -- cuando ACABAS de señalar con el ratón, o sea en el drop. En cualquier otra
  -- inserción el cursor está donde lo dejaste hace un rato y la orientación
  -- sale a suertes. Ver `sin_smart_split` aquí abajo.
  smart_split = true,
}

-- ── OPACIDAD FORZADA DEL MODO AHORRO ───────────────────────────────────────
--
-- Gemelo, para las ventanas de Hyprland, del ajuste "quitar la transparencia de
-- los paneles" del shell (Ajustes > Energía; ver `ags/servicios/energia/
-- opacidadAhorro.ts`). Aquel deja opacas las láminas de AGS; este deja opacas
-- las VENTANAS, que es lo que `inactive_opacity` transparenta.
--
-- Lo que se ahorra es lo mismo y es del compositor, no del cliente: una ventana
-- con alfa < 1 obliga a Hyprland a componer lo que hay DEBAJO de ella (el resto
-- del mosaico y el fondo) en cada fotograma que se redibuje, y además la excluye
-- de cualquier atajo de superficie opaca. Con todas las ventanas a 1.0, la de
-- delante tapa de verdad. Como el ajuste de los paneles, es de los pocos que
-- ahorran mientras el usuario MIRA algo, no mientras el equipo está en reposo.
--
-- LA CONDICIÓN VIENE YA RESUELTA DE AGS, y esto no la reevalúa. El fichero
-- ~/.config/gigishell/opacidad-ventanas.json trae `forzada`, que AGS escribe como
-- (modo ahorro activo Y el ajuste encendido) — mismo criterio que
-- `powerSaveFreeze` en runtime-state.json: una sola fuente de verdad, porque
-- rederivar aquí "¿hay ahorro?" nos obligaría a mirar /sys/class/power_supply,
-- que lista también la pila del ratón. Fichero ausente o corrupto → `false`, o
-- sea la opacidad de siempre; nunca una sesión con las ventanas opacas sin
-- haberlo pedido.
local RUTA_OPACIDAD = util.HOGAR .. "/.config/gigishell/opacidad-ventanas.json"

local function ahorro_pide_opaco()
  local j = util.leer_json(RUTA_OPACIDAD)
  return type(j) == "table" and j.forzada == true
end

--- Aplica (o retira) la opacidad forzada del ahorro. `forzar` verdadero → las
--- dos opacidades a 1.0; falso → las de `aspecto`, que son las únicas de verdad.
---
--- ES EL PUNTO DE ENTRADA EN VIVO: `ags/servicios/energia/opacidadVentanas.ts`
--- lo llama con `hyprctl eval "GiGiShell.opacidad_ahorro(true)"` en cada
--- transición, igual que scripts/anclaje.py usa GiGiShell.sin_smart_split. No se
--- exporta un `hl.config` suelto desde AGS a propósito: el valor al que hay que
--- VOLVER solo lo sabe este fichero, y duplicarlo en TypeScript es la misma
--- desincronización que ya documenta `aspecto` para el toggle de gaps.
local function opacidad_ahorro(forzar)
  pcall(hl.config, {
    decoration = {
      active_opacity   = forzar and 1.0 or aspecto.active_opacity,
      inactive_opacity = forzar and 1.0 or aspecto.inactive_opacity,
    },
  })
end

-- El estado de arranque se lee ANTES del hl.config de abajo y se aplica dentro
-- de él, en vez de con una segunda llamada después: un `hyprctl reload` re-
-- ejecuta este módulo entero, y con la corrección aparte habría un instante con
-- las ventanas transparentes. Es el mismo motivo por el que pantalla.lua relee
-- display.json en cada carga en vez de fiarlo todo a que AGS lo reaplique.
local opaco_ahorro = ahorro_pide_opaco()

hl.config({
  general = {
    gaps_in  = aspecto.gaps_in,
    gaps_out = aspecto.gaps_out,

    border_size = aspecto.border_size,

    -- https://wiki.hypr.land/Configuring/Variables/#variable-types (colores)
    col = {
      active_border   = { colors = { "rgba(ccccccee)", "rgba(888888ee)" }, angle = 45 },
      inactive_border = "rgba(595959aa)",
    },

    -- true = redimensionar ventanas arrastrando desde bordes y huecos.
    resize_on_border = false,

    -- Ver https://wiki.hypr.land/Configuring/Tearing/ antes de activarlo.
    -- (gaming.lua lo pone a true después; ver allí.)
    allow_tearing = false,

    layout = "dwindle",
  },

  decoration = {
    rounding       = aspecto.rounding,
    rounding_power = 4,
    -- Ver `opacidad_ahorro` arriba: con el ahorro pidiendo opaco, las dos van
    -- a 1.0 y este módulo las devuelve a `aspecto` al salir.
    active_opacity   = opaco_ahorro and 1.0 or aspecto.active_opacity,
    inactive_opacity = opaco_ahorro and 1.0 or aspecto.inactive_opacity,

    -- Sombra CORTA y tenue: lo justo para que la ventana se lea despegada del
    -- fondo, sin la neblina que dejaba la de antes (range 10 / alpha 88).
    --
    -- `render_power` es lo que hace que una sombra tan pequeña se siga viendo, y
    -- 4 es su MÁXIMO (Hyprland clampa a [1,4]: subirlo no da error, simplemente
    -- no cambia nada). Concentra la caída pegada al borde, así que los pocos
    -- píxeles disponibles quedan donde se notan. Sin él, acortar `range` no da
    -- una sombra nítida: da la misma neblina, más pequeña.
    --
    -- Los otros dos valores salen de descartar a mano las alternativas:
    --  · alpha por encima de ~0x99 comprimido en pocos px produce BANDING — el
    --    degradado da saltos visibles de 8 bits y se ve un anillo escalonado
    --    alrededor de la ventana. Medido con range 6 / alpha cc.
    --  · un `offset` grande (probado 0,5) concentra la masa bajo el borde
    --    inferior y deja el canto superior desnudo. Se lee como altura, pero con
    --    `range` corto la sombra se despega del borde y parece un subrayado.
    shadow = {
      enabled      = true,
      range        = 5,
      render_power = 4,
      offset       = { 0, 2 },
      color        = "rgba(00000066)",
    },

    blur = {
      enabled = true,
      size    = 3,
      passes  = 1,
    },
  },

  -- https://wiki.hypr.land/Configuring/Dwindle-Layout/
  dwindle = dwindle,

  -- https://wiki.hypr.land/Configuring/Master-Layout/
  master = {
    new_status = "master",
  },

  -- https://wiki.hypr.land/Configuring/Variables/#misc
  misc = {
    force_default_wallpaper = 0,   -- 0 o 1 desactiva los fondos con mascota anime.
    disable_hyprland_logo   = true, -- true quita el logo/anime girl aleatorio. :(

    focus_on_activate       = false, -- no roba el foco al abrirse apps
    mouse_move_enables_dpms = false, -- no despierta pantalla al mover ratón
    key_press_enables_dpms  = true,  -- sí la despierta al pulsar tecla
    disable_autoreload      = false, -- recarga conf automáticamente al guardar

    -- Una ventana maximizada NO pierde el maximizado porque se abra otra en su
    -- workspace: la nueva se coloca detrás, ya tileada al hueco que le toca.
    -- 0 = ignore (esto), 1 = take_over (la nueva hereda el maximizado y la
    -- vieja lo pierde), 2 = exit_fullscreen (el DEFAULT de Hyprland: la
    -- maximizada sale del estado y las dos se reparten el workspace).
    -- OJO: la opción que citan las guías, misc:new_window_takes_over_fullscreen,
    -- NO existe desde 0.5x — la sustituye esta, y ponerla no da ningún error.
    -- Peaje aceptado: la ventana nueva nace tapada y sin foco, así que abrir
    -- una app sobre una maximizada parece "que no ha hecho nada" hasta que
    -- sales del maximizado (SUPER+SHIFT+W) o cambias de foco.
    on_focus_under_fullscreen = 0,
  },
})

-- ── smart_split y las inserciones QUE NO SON UN DROP ────────────────────────
--
-- MOVER UNA VENTANA A OTRO ESCRITORIO DESORDENABA EL ESCRITORIO DESTINO, y la
-- causa es `smart_split`, no el módulo que la mueve. dwindle resuelve un
-- `movetoworkspace` sacando la ventana de un árbol y REINSERTÁNDOLA en el otro,
-- exactamente igual que si naciera allí: parte la última enfocada del destino y,
-- con smart_split, el eje del corte sale del cuadrante del CURSOR sobre ella. En
-- un drop eso es justo lo que quieres (acabas de señalar con el ratón); en un
-- movimiento por teclado el cursor está donde lo dejaste hace diez minutos, así
-- que el eje sale a suertes y encima repetido — la misma tecla parte siempre por
-- el mismo sitio mientras no muevas el ratón, que es como se acaba con tiras de
-- pantalla completa en vez de una rejilla.
--
-- MEDIDO en instancia anidada a 2032x1098, destino con tres ventanas en rejilla
-- (una columna de 1004x1080 y dos de 1004x537) y el cursor abajo a la derecha:
--
--   smart_split = true   la que llega parte la COLUMNA por su lado corto y
--                        salen dos tiras de 500x1080 — la rejilla se rompe.
--   smart_split = false  la que llega cae en 1019,552 con 1004x537: la rejilla
--                        se completa.
--
-- `preselect` NO SIRVE AQUÍ, aunque sea el truco que usa gigishell/keybinds.lua
-- para SUPER+SHIFT+dirección. Medido: con smart_split activo, un `preselect
-- right` inmediatamente antes del `movetoworkspace` —incluso en el mismo
-- `hyprctl --batch`, para descartar que se perdiera entre llamadas— da el MISMO
-- resultado que sin él. El override solo lo consulta el camino de ventana nueva.
--
-- De ahí este envoltorio: apagar smart_split durante la inserción y volver a
-- encenderlo. Sin él, el arrastre pierde el control por cuadrante, que es la
-- única razón por la que smart_split está puesto. Lo usan los tres sitios que
-- mueven ventanas entre escritorios sin que haya un ratón señalando el destino:
-- gigishell/keybinds.lua (SUPER+SHIFT+número), gigishell/compactar.lua y
-- gigishell/limite-ventanas.lua; y scripts/anclaje.py por `hyprctl eval`, a través
-- del global GiGiShell.sin_smart_split de abajo.
--
-- El apagado es GLOBAL mientras dura la llamada, así que `accion` tiene que ser
-- corta y síncrona: nada de timers ni de esperar a un evento dentro. Los tres
-- consumidores despachan y vuelven.
local function sin_smart_split(accion)
  if not dwindle.smart_split then return accion() end
  pcall(hl.config, { dwindle = { smart_split = false } })
  -- pcall para que el restaurado ocurra SIEMPRE: dejar smart_split apagado por
  -- un fallo de `accion` sería un cambio de comportamiento permanente y mudo
  -- (el arrastre dejaría de responder al cuadrante) hasta el siguiente reload.
  local ok, err = pcall(accion)
  pcall(hl.config, { dwindle = { smart_split = dwindle.smart_split } })
  if not ok then error(err, 0) end
end

-- Para quien no puede requerir el módulo: scripts/anclaje.py lo invoca con
-- `hyprctl eval`, que comparte el estado Lua del config (ver hyprland.lua).
GiGiShell = GiGiShell or {}
GiGiShell.sin_smart_split = sin_smart_split
-- Lo llama AGS por `hyprctl eval` en cada transición del modo ahorro (ver arriba).
GiGiShell.opacidad_ahorro = opacidad_ahorro

-- Lo consume gigishell/keybinds.lua (require cachea: es la misma tabla que acaba de
-- aplicarse, no una copia). hyprland.lua carga este módulo con util.carga() e
-- ignora el retorno; el valor solo importa para quien lo pida.
return { aspecto = aspecto, dwindle = dwindle, sin_smart_split = sin_smart_split, opacidad_ahorro = opacidad_ahorro }
