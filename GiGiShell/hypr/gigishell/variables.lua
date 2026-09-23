-- Nombres de app y rutas compartidos por varios módulos: una tabla que los
-- módulos requieren (sobre todo keybinds). Las rutas conservan el `~` porque
-- solo se usan dentro de comandos de shell (hl.dsp.exec_cmd), donde lo expande
-- la shell igual que hacía con el `exec` de hyprlang.
return {
  mainMod = "SUPER",
  terminal = "kitty",
  fileManager = "dolphin",
  menu = "hyprlauncher",
  ruta_captura_pantalla = "~/Imágenes/Capturas_Pantalla/",
  ruta_grabacion_pantalla = "~/Videos/Grabaciones_Pantalla",
}
