# CLAUDE.md — vista-escritorio

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`vista-escritorio/` (binario Rust `gigishell-vista-escritorio`: la miniatura en vivo de un escritorio
de la barra, con `hyprland_workspace_image_capture_source_v1` + `ext-image-copy-capture`. Vive solo
mientras la miniatura está abierta: `ags/modulos/barra/escritorios/vistaEnVivo.ts` lo lanza y lo mata.
El menú de escritorios usa el modo `--sesiones`.
Medidas, límites y respaldo en [`ags/modulos/barra/CLAUDE.md`](../ags/modulos/barra/CLAUDE.md)).

- **Captura `windows_only`, no `everything`:** el segundo mete en la imagen todas las capas de AGS
  (barra, títulos flotantes, la propia miniatura). `no_screen_share` en esas capas no es alternativa:
  en capturas normales y al compartir pantalla las pinta como un rectángulo negro. El fondo lo pone la barra debajo.
- **Contrato con la barra (`--escritorio NOMBRE`):** fotogramas BGRA premultiplicados de `ancho*alto*4` bytes por stdout, sin cabecera,
  y solo cuando la imagen cambia. Termina al cerrarse stdin. Códigos de salida en `src/main.rs`; el 3
  es «el compositor no ofrece el protocolo». Salir sin fotogramas activa el respaldo de la barra.
- **Modo `--sesiones` (menú de escritorios, un proceso para todos):** por stdin, una orden por línea,
  `+CLAVE NOMBRE` añade y `-CLAVE` quita (`CLAVE` es un `u32`; un `+` con la clave ya abierta se ignora,
  y un nombre aún no anunciado espera a que exista). Por stdout, `u32` LE con la clave + `ancho*alto*4`
  bytes BGRA. Quedarse sin escritorios no lo termina: termina con código 0 al cerrarse stdin. Un fallo en
  un escritorio cierra solo esa sesión, sin aviso por stdout. Un `Removed` de Hyprland, igual: para
  volver a verlo hay que mandar otro `+`. Todo el proceso comparte una medida de búfer, la de la primera
  sesión lista: vale porque el menú solo enseña el monitor enfocado. Un cambio de modo del monitor con
  el menú abierto hace fallar sus capturas, y hay que relanzarlo.
- **Búferes: 3 para las miniaturas.** Medido en 1440p a 760×428 con 3 sesiones animadas: 1 → 24 fps,
  2 → 26, 3 → 28, 4 → 28 (lo que da la app). RSS 34/48/62/75 MB: cada búfer son 14 MB. CPU ~105 % de un
  núcleo en todos: unos 13 ms por miniatura, con la caja a dos hilos y la firma.
- **Una captura en curso se abandona, no se espera,** al cerrar su sesión (`cerrar_sesion`) y a los 2 s
  sin respuesta (`ESPERA_MAX_CAPTURA`): un hueco que no vuelve deja sin imagen a los demás escritorios.
  Consecuencia: `read` de Wayland da `WouldBlock` si todo lo leído era para esos objetos destruidos, y
  no es un error (`tolerar_bloqueo`). Sin eso, `-CLAVE` tumbaba el proceso con código 1.
- **El periodo se cuenta desde que se pide la captura, no desde que llega** (`procesar`). Contado desde
  la llegada, el ritmo sería `intervalo + latencia` y la vista grande a 16 ms caería siempre al respaldo.
- **Firma y cursor:** detecta el 100 % de 43 apariciones y desapariciones del cursor hueco de un kitty
  oculto, en cualquier tamaño hasta 280×158. Una barra fina de 2 px: 100 % de posiciones a 760 de ancho,
  75 % a 480 y 44 % a 280 (calculado, no medido); kitty no la pinta sin foco.
- **El XML va en `protocolos/`** porque `hyprland-protocols` no se instala aquí. Copiado de Hyprland
  v0.57.0. Hay que actualizarlo a mano si el protocolo sube de versión.
- Compila en `~/.cache/gigishell/cargo/vista-escritorio`, no en `target/` (ver `docs/rust-migracion.md`).
  `opt-level = 3`, al contrario que los otros crates: reducir la imagen es su ruta caliente.
