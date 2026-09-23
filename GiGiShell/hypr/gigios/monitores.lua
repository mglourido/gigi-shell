-- Monitores: la regla comodín, el fallback para cualquier salida sin
-- preferencia guardada (las concretas salen de display.json, ver gigios/pantalla.lua).
--
-- Configuración genérica: usa la resolución preferida del monitor a escala 1.
-- Es solo el fallback: gigios/pantalla.lua se carga DESPUÉS y sus specs por
-- `desc:` pisan a esta comodín — sin él, un `hyprctl reload` devolvería la
-- pantalla a modo preferido/escala 1.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "1" })

-- Mejora la nitidez en apps XWayland.
hl.config({
  xwayland = {
    force_zero_scaling = true,
  },
})
