-- Variables de entorno del sistema: las lee el SO y las apps.
--
-- El idioma (LANG/LC_ALL) NO se escribe aquí: se LEE al final del fichero de
-- ~/.config/gigios/datetime.json, que es lo que guarda AGS (Ajustes > Región,
-- fecha y hora). Antes AGS reescribía un bloque entre marcadores DENTRO de este
-- fichero, que está versionado — estado de máquina ensuciando git, y un
-- marcador tocado a mano dejaba el bloque huérfano. Ver CLAUDE.md.

local util = require("gigios.util")

hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("LC_TIME", "es_ES.UTF-8")

hl.env("XDG_CURRENT_DESKTOP", "Hyprland")
hl.env("XDG_SESSION_TYPE", "wayland")
hl.env("XDG_SESSION_DESKTOP", "Hyprland")

-- Integra las aplicaciones Qt con la paleta oscura de qt6ct. Sin un tema de
-- plataforma, Dolphin ignora el esquema oscuro de kdeglobals bajo Hyprland.
hl.env("QT_QPA_PLATFORMTHEME", "qt6ct")
-- Reduce la densidad de Breeze en pantallas con escalado fraccional sin cambiar
-- la escala del resto del escritorio.
hl.env("QT_SCALE_FACTOR", "0.9")

-- Idioma elegido en Ajustes. Sin fichero (o sin la clave) se deja el LANG que
-- traiga la sesión de logind: poner uno de fábrica aquí pisaría en silencio la
-- configuración del sistema en una máquina que nunca ha tocado este ajuste.
local dt = util.leer_json(util.HOGAR .. "/.config/gigios/datetime.json")
local idioma = dt and dt.locale
if type(idioma) == "string" and idioma ~= "" then
  hl.env("LANG", idioma)
  hl.env("LC_ALL", idioma)
end

