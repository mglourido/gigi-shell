-- gigios/nop-binds.lua — los binds sordos, antes un fichero generado de 335 líneas
-- (scripts/generar-nop-binds.sh): un bind "sordo" (hl.dsp.no_op) por cada
-- combinación con SUPER que NO sea ya un atajo, para que SUPER+<tecla> no
-- escriba la tecla en la aplicación (comportamiento de Windows con la tecla
-- Win). Hyprland solo se traga una tecla si algún bind la captura; no hay
-- opción global (`catchall` solo se admite dentro de submaps — medido).
--
-- Ya NO hay regeneración ni parseo de `hyprctl binds`: al vivir en el mismo
-- config que los atajos reales, cada reload recalcula la lista solo — la tabla
-- `usados` que llena el envoltorio bind() de gigios/keybinds.lua es la fuente,
-- fresca en cada ejecución. Desaparecen de paso las dos trampas del generador
-- (el JSON roto de `hyprctl binds -j` en 0.56 y el filtro de sus propios binds
-- para no auto-apagarse). El único modo de fallo restante: un atajo añadido
-- con hl.bind directo en vez del envoltorio queda con un no_op sordo de más —
-- inofensivo (Hyprland ejecuta ambos binds), ver el aviso gordo en keybinds.lua.
--
-- Este módulo se carga SIEMPRE al final del entry point, cuando ya está
-- registrado todo atajo real. hl.dsp.no_op() es interno al compositor: cero
-- forks por pulsación.

local util = require("gigios.util")

-- Ajuste: absorberSuperSinAtajo (Ajustes > Personalización > Ventanas y
-- escritorios). AUSENTE = ACTIVADO: solo un `false` literal desactiva — un
-- truthiness a secas leería el nil de una instalación sin la clave como
-- "apagado" y la función moriría en silencio (el primo Lua del tropiezo del
-- operador `//` de jq documentado por todo el repo). Se aplica en caliente
-- igual que antes: el setter de AGS ya recarga, y el reload re-evalúa esto.
if util.prefs().absorberSuperSinAtajo == false then
  return
end

-- require cachea: esta es LA MISMA tabla que llenó keybinds.lua al registrar
-- sus atajos, y su misma función de normalizar — no una copia ni un re-parseo.
local kb = require("gigios.keybinds")
local usados, normalizar = kb.usados, kb.normalizar

-- Teclas que producen un carácter (o que no hacen nada útil sueltas con
-- SUPER). No se tocan las de multimedia/XF86 ni las del ratón. Lista heredada
-- tal cual del generador.
local TECLAS = {
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "minus", "equal", "bracketleft", "bracketright", "semicolon", "apostrophe",
  "grave", "backslash", "comma", "period", "slash", "less",
  "space", "Tab", "Return", "BackSpace", "Delete", "Insert", "Escape",
  "Home", "End", "Page_Up", "Page_Down",
  "Up", "Down", "Left", "Right",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "KP_0", "KP_1", "KP_2", "KP_3", "KP_4", "KP_5", "KP_6", "KP_7", "KP_8", "KP_9",
  "KP_Add", "KP_Subtract", "KP_Multiply", "KP_Divide", "KP_Decimal", "KP_Enter",
}

local MODIFICADORES = { "SUPER", "SUPER + SHIFT", "SUPER + CTRL", "SUPER + ALT" }

for _, mods in ipairs(MODIFICADORES) do
  for _, tecla in ipairs(TECLAS) do
    local combo = mods .. " + " .. tecla
    if not usados[normalizar(combo)] then
      -- hl.bind directo A PROPÓSITO: los sordos no deben apuntarse en
      -- `usados` (no son atajos) ni pisarse a sí mismos.
      hl.bind(combo, hl.dsp.no_op())
    end
  end
end
