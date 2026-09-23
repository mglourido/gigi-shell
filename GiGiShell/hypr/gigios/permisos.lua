-- Permisos del ecosistema Hyprland (screencopy, plugins).
-- https://wiki.hypr.land/Configuring/Permissions/
--
-- OJO: los cambios de permisos requieren reiniciar Hyprland — por seguridad no
-- se aplican en caliente. Todo sigue COMENTADO, como en el original: el
-- enforcement no está activado.

-- hl.config({
--   ecosystem = {
--     enforce_permissions = true,
--   },
-- })

-- hl.permission("/usr/(bin|local/bin)/grim", "screencopy", "allow")
-- hl.permission("/usr/(lib|libexec|lib64)/xdg-desktop-portal-hyprland", "screencopy", "allow")
-- hl.permission("/usr/(bin|local/bin)/hyprpm", "plugin", "allow")
