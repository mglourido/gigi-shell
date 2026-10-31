# CLAUDE.md — vista-escritorio

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`vista-escritorio/` (binario Rust `gigishell-vista-escritorio`: la miniatura en vivo de un escritorio
de la barra, con `hyprland_workspace_image_capture_source_v1` + `ext-image-copy-capture`. Vive solo
mientras la miniatura está abierta: `ags/modulos/barra/escritorios/vistaEnVivo.ts` lo lanza y lo mata.
Medidas, límites y respaldo en [`ags/modulos/barra/CLAUDE.md`](../ags/modulos/barra/CLAUDE.md)).

- **Captura `windows_only`, no `everything`:** el segundo mete en la imagen todas las capas de AGS
  (barra, títulos flotantes, la propia miniatura). `no_screen_share` en esas capas no es alternativa:
  en capturas normales y al compartir pantalla las pinta como un rectángulo negro. El fondo lo pone la barra debajo.
- **Contrato con la barra:** fotogramas BGRA premultiplicados de `ancho*alto*4` bytes por stdout, sin cabecera,
  y solo cuando la imagen cambia. Termina al cerrarse stdin. Códigos de salida en `src/main.rs`; el 3
  es «el compositor no ofrece el protocolo». Salir sin fotogramas activa el respaldo de la barra.
- **El XML va en `protocolos/`** porque `hyprland-protocols` no se instala aquí. Copiado de Hyprland
  v0.57.0. Hay que actualizarlo a mano si el protocolo sube de versión.
- Compila en `~/.cache/gigishell/cargo/vista-escritorio`, no en `target/` (ver `docs/rust-migracion.md`).
  `opt-level = 3`, al contrario que los otros crates: reducir la imagen es su ruta caliente.
