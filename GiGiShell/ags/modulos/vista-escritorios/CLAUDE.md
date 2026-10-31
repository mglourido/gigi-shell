# CLAUDE.md — Vista de escritorios (SUPER+Tab)

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: el menú que enseña en vivo los escritorios del monitor enfocado, con una vista grande bajo demanda. El submap y sus trampas, en la sección «Vista de escritorios» de [`docs/hyprland-modulos.md`](../../../docs/hyprland-modulos.md); el binario, en [`vista-escritorio/CLAUDE.md`](../../../vista-escritorio/CLAUDE.md).

## Archivos

- `cierre.ts` — máquina de estados pura de abrir, fijar y cerrar (con test).
- `estado.ts` — aplica esa máquina: visibilidad, plazo de 250 ms para el segundo toque de Tab y salida del submap. `ags/puentes.ts` le pasa los avisos de `hypr/gigishell/vista-escritorios.lua`.
- `disposicion.ts` — filas, tamaños, salto de fila de la rueda y tope de iconos, en lógica pura (con test).
- `capturaEscritorios.ts` — cliente del ayudante en modo `--sesiones`.
- `VistaEscritorios.tsx` — la ventana, las miniaturas y la vista grande.
- Fuera de la carpeta: `estilos/_vista-escritorios.scss`; `fondo-bloqueo` en `estilos/_colores.scss`; `utilidades/blurSuave.ts` con `hypr/gigishell/blur-suave.lua`; `GiGiShell.vista_en_vivo_fps()` en `hypr/gigishell/vista-en-vivo.lua`.

## Por qué es así

- **Submap propio:** con SUPER pulsado, los binds de ratón de `keybinds.lua` se quedan con el clic y la rueda, que son los gestos del menú. Dentro del submap no casan y llegan a AGS. La salida vive en Hyprland: si AGS cae con el menú abierto, soltar SUPER o pulsar Esc devuelve los atajos igual.
- **Soltar Tab no cierra al instante:** entre los dos toques de Tab la tecla está suelta, así que soltarla arma 250 ms.
- **Clic en el fondo:** cierra solo con el menú fijado. En modo mantener no hace nada.
- **Siempre 3 por fila, con 9 visibles sin scroll:** la miniatura sale del mayor tamaño con el que caben 3×3, porque el texto solo gana nitidez con más píxeles en pantalla. Desde 10 hay scroll, y cada paso de rueda salta una fila.
- **Vista grande de 2,5 veces la miniatura,** con el alto limitado para que debajo quepa la primera fila entera. La miniatura del escritorio abierto sigue en su sitio, marcada con `ve-seleccionada`.
- **Nunca se envían imágenes mayores que el tamaño en pantalla:** una textura mayor cuesta más al subirla y no añade detalle. Por eso el ayudante recibe `ancho` y `alto` físicos. Bajar al 95 % tampoco compensa: ahorra un 10 % y emborrona.
- **No se añade a `panelStates`,** por lo mismo que Orion: abrirla no debe desplegar la barra. Al abrirse cierra los paneles y el calendario, pero **no Orion**.
- **Fundido al aparecer, sin escalas:** decisión del usuario.

## Filtro: Lanczos en la grande, caja en las miniaturas

- **Miniaturas:** caja en 2 hilos mientras cambian y una pasada de Lanczos al congelarse.
- **Vista grande:** siempre Lanczos (`soloRefinado`, `--solo-refinado`). Con caja, un spinner o un cursor la dejaban borrosa hasta 10 s después del último cambio. **El precio:** a 21-24 ms por fotograma no llega a 60 fps con movimiento continuo y cae a su respaldo de 30. Solo se paga con fotogramas que cambian.
- **2 hilos:** es el reparto medido. A 760 px con caja, 8,7 ms con 1 hilo, 6,0 con 2 y 6,8 con 6.
- **Texto pequeño:** en una miniatura no se puede hacer legible. Es un límite físico de los píxeles que ocupa, y el usuario lo aceptó.

## Trampas

- **Sin `backdrop-filter` no hay blur, y no da error.** GTK 4.24 pide la región con `ext_background_effect`, y en esa superficie Hyprland ignora la regla de capa (`CLayerSurface::shouldBlur`). Medido solo con la regla: el detalle y el contraste caían justo lo que da el oscurecido.
- **El blur no sale del CSS,** sino de `decoration.blur`, global. Por eso `blurSuave` lo baja mientras haya abierto un menú con `fondo-bloqueo`.
- **Reponer el blur al cerrar hay que retrasarlo** (`ESPERA_REPONER_MS`, 200 ms). Al instante hace parpadear el fundido de salida, que dura unos 150 ms: el brillo saltaba de 23 a 25 a los 30 ms en vez de bajar de 23 a 18 sin saltos.
- **El blur ocurre detrás de la superficie,** así que no puede desenfocar la miniatura bajo su rótulo. El rótulo solo sube la opacidad.
- **Una app oculta puede dejar de pintar:** Hyprland le pone `SUSPENDED` y kitty se para. Lo resuelve `despertar()` en `hypr/gigishell/vista-en-vivo.lua`; sin la solución, 12 de 12 atascos, y con ella, 0 de 50.
- **Probar en vivo sin molestar:** `"9 silent"` en Lua es un **nombre** de escritorio, no un modificador. Unas pruebas cambiaron así el escritorio activo 24 veces. Usa `follow=false`, y no más de 2 ventanas: 20 desbordaron `limite-ventanas.lua`.

## Medidas

En 2560×1440 a 240 Hz, con i5-12400F y RX 9070.

- **Abrir:** con 9 escritorios capturados a 33 ms, Hyprland usa 50-58 % de un núcleo en los primeros 500 ms y 51-54 % después. Primer fotograma: 116 ms en el peor caso. Se hizo sin juegos ni vídeo.
- **3 miniaturas animadas:** 28 fps, unos 105 % de un núcleo en el ayudante y 62 MB con 3 búferes. No llega del todo a los 30 fps del objetivo.
- **Filtro, en un banco sintético:** a 1520×855, caja 5,9 ms y Lanczos 20,9 ms; a 1900×1069, caja 7,5 ms y Lanczos 23,7 ms. Un búfer real escrito por Hyprland se lee en frío y puede costar más.
- **Dibujar en GTK, con texturas sintéticas:** 2240×1218 a 60 fps da gjs 54 % y GPU 15,6 %; 9 miniaturas cambiando dan gjs 35 % y GPU 15 %. Sin crecimiento de memoria.

**Sin medir:** el menú real con 1, 4 y 10 escritorios (CPU, GPU y RAM de Hyprland, ayudante y AGS); el retraso de descongelado y la detección al abrir con 10 escritorios; si el respaldo a 1 s salta bajo carga real; un juego y un vídeo ocultos al abrir; 50 reaperturas con el menú real; la limpieza tras matar AGS; los 30 fps reales de la vista grande con movimiento continuo; y **un portátil con iGPU**, que es el mayor riesgo abierto.
