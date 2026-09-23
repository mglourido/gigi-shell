-- █░█ █▀ █▀▀ █▀█   █▀█ █▀█ █▀▀ █▀▀ █▀
-- █▄█ ▄█ ██▄ █▀▄   █▀▀ █▀▄ ██▄ █▀░ ▄█
--
-- Preferencias personales de Hyprland. Van casi al final del entry point: pisan
-- a lo declarado en los módulos anteriores.
-- https://wiki.hypr.land/Configuring — gigishell/dispositivos.lua (que lee lo
-- guardado en Ajustes > Dispositivos) se carga después y pisa lo de aquí.

-- Descomenta / cambia al valor que prefieras.
-- 🔗 https://wiki.hypr.land/Configuring/Variables/#input
hl.config({
  input = {
    kb_layout    = "es",
    follow_mouse = 1,
    -- sensitivity = 0,
    force_no_accel = false,
    -- accel_profile = "flat",
    numlock_by_default = true,

    -- 🔗 https://wiki.hypr.land/Configuring/Variables/#touchpad
    touchpad = {
      natural_scroll = true,
    },
  },

  -- Para "window swallowing" al estilo devour:
  -- misc = {
  --   enable_swallow = true,
  --   swallow_regex = "(foot|kitty|allacritty|Alacritty|ghostty|Ghostty|org.wezfurlong.wezterm)",
  -- },

  -- No enseñar las novedades de la actualización en el primer arranque.
  ecosystem = {
    no_update_news = true,
  },
})

-- El bloque `gestures {}` del original estaba vacío: no hay nada que portar.
