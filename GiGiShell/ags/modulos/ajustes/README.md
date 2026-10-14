# Ajustes

El módulo se organiza por dominios para que cada sección, su lógica y sus
componentes específicos vivan juntos:

- `panel/`: navegación y registro de secciones del panel.
- `componentes/`: piezas visuales reutilizables entre secciones.
- `estado/`: preferencias compartidas y persistencia general.
- `accesibilidad/`, `barra/`, `camara/`, `cuenta/`, `disco/`, `dispositivos/`,
  `energia/`, `fecha-idioma/`, `inicio/`, `juegos/`, `pantalla/`, `personalizacion/`,
  `seguridad/`, `sistema/` y `atajos/`: implementación de cada dominio. `disco/` (Almacenamiento y Liberar
  espacio) se llama así y no `almacenamiento/` porque ese nombre ya identifica a
  `servicios/almacenamiento/`, que es la persistencia JSON del shell.

`SettingsPanel.tsx` es el punto de entrada de la ventana. Los archivos
`preferences.ts`, `ProfileAvatar.tsx`, `trayApps.ts` y `AutoDndSetting.tsx`
son fachadas públicas mantenidas para no romper consumidores externos; la
implementación nueva debe importarse directamente desde su dominio cuando el
consumidor pertenezca a este módulo.

Al añadir una sección, registra su metadato y su fábrica en
`panel/secciones.tsx`. Coloca cada componente con responsabilidad propia en un
archivo separado y conserva en `componentes/` únicamente elementos realmente
compartidos por varios dominios.

Un destino puede existir solo en algunas máquinas: `SeccionNavegacion.visible`
acepta un `Accessor<boolean>` y la navegación oculta el botón (no lo filtra de
la lista, para que el hardware que entra en caliente lo encienda sin
reconstruirla). Lo usa `camara/`, que no se pinta en un equipo sin cámara ni
ajustes de cámara guardados.

## Disposición y listas

Personalización → Diseño → Apariencia incluye `colorBarrasSpotify` (`rgb` o
`blanco`), persistido en las preferencias y aplicado al instante. El RGB de
`OndaSpotify` es independiente del acento adaptativo del fondo y de la carátula:
usa una paleta suave de violeta, azul y turquesa con pasos intermedios para evitar
el contraste excesivo del arcoíris saturado. Cada barra cambia solo al pasar de
bajar a subir y mantiene su color durante ambas fases. Reutiliza el reloj existente
y se detiene con la animación; no añade temporizadores.

Las alturas reales provienen exclusivamente del stream local de Spotify: AstalWp
lo identifica con las mismas reglas que el volumen por reproductor de Orion.
CAVA captura su `object.serial` mediante PipeWire, con `active=0` y sin permitir
reconexión, cambio de destino ni retorno a la salida general o al micrófono.
Se comparte un solo proceso entre monitores y se analiza a 30 Hz; el dibujo
conserva su reloj y suavizado de 60 FPS (24 FPS en ahorro). Las altas, bajas y
transiciones del stream se atienden por señales mientras se necesita el espectro;
al ocultar la barra, pausar, entrar en un juego o desactivar el análisis en ahorro,
se liberan el proceso y sus suscripciones cuando ya no hay consumidores.
Sin stream local o ante un fallo se conserva la animación procedimental existente.

El volumen de escucha no cambia las alturas: se captura a 32 bits, con suficiente
precisión de transporte para el 1 %, y se compensa la ganancia del stream antes de
normalizar las 13 bandas. CAVA tiene `autosens=0` y no acumula suavizado propio;
la referencia de pico sigue la música con caída gradual y un margen del 10 %,
mientras GTK conserva el ataque y la caída visuales existentes. El 0 % o mute
de Spotify o de su salida detiene CAVA y deja las ondas simuladas. Los cambios
llegan por señales; arrastrar el volumen no reinicia el proceso ni añade relojes.
Durante 220 ms tras cambiar la ganancia se conserva la última muestra para
descartar la mezcla de audio anterior y nuevo en la ventana de FFT. Dividir por
el volumen después de recibir alturas recortadas no resolvería la saturación;
tampoco basta con elevar la sensibilidad de una captura de 16 bits que ya haya
perdido la señal al 1 %. El volumen de salida solo se usa para detectar silencio,
porque la captura directa de Spotify no incluye esa ganancia del dispositivo.

No hay que exigir `RUNNING` a un nodo que Astal acaba de adoptar: su estado inicial
puede seguir en `CREATING` aunque PipeWire ya lo tenga reproduciendo. Se admite
ese estado desconocido con captura pasiva y se escuchan las transiciones posteriores;
`IDLE` y `SUSPENDED` detienen el análisis. Esta excepción evita romper la onda al
recargar AGS mientras suena Spotify. Se mantiene CAVA separado porque AstalCava
ejecuta la FFT desde un temporizador del bucle principal y su limpieza espera al
hilo de captura; integrarlo introduciría trabajo y posibles bloqueos en el shell.

La misma tarjeta incluye `bordeRgbCaratulaSpotify`, desactivado por defecto e
independiente del color de las barras. Añade un contorno interior de 1 px a la
portada con la misma paleta; el degradado gira una vuelta cada 8 segundos.
Solo aparece durante la reproducción y se oculta al pausar. Comparte el reloj
de `OndaSpotify`, limita el repintado a 30 FPS y se detiene con la barra oculta
o desmontada; en ahorro respeta la cadencia reducida de la onda. No usa una
animación CSS infinita: la barra autoocultada sigue mapeada y podría mantenerla
repintando fuera de pantalla.

El título de sección pertenece a `SettingsPanel.tsx` y queda fuera del scroll.
Las secciones solo devuelven su contenido. Usa los controles de `componentes/`
para mantener alturas, alineación y texto informativo comunes; las propiedades
explícitas del consumidor deben prevalecer sobre los valores por defecto.

`EntradaTextoAjustes` neutraliza el ancho implícito de GTK con `widthChars` y
`maxWidthChars`: los campos compactos reservan 180 px y los que usan `expandir`
aprovechan el espacio disponible. En filas con descripción, expande el encabezado
y conserva el campo compacto para que el texto pueda envolver con más espacio.

Las listas editables usan `ListaAjustes`: reserva el mismo alto incluso vacía,
muestra un contador y desplaza sus filas dentro. Los campos de búsqueda, filtros
y acciones generales van fuera del scroll y de los bloques reactivos que
reconstruyen filas. Mantén claves estables en los `For` editables: desmontar una
entrada que tiene el foco puede provocar un fallo de GTK.
Atajos usa la variante `kb-lista-scroll` con `expandir`: ocupa el alto restante
del panel y mantiene la descripción y el buscador fuera de su scroll.

Un `ScrolledWindow` no virtualiza sus hijos. Los catálogos de apps de Inicio y
Almacenamiento usan `usarPaginacion` y construyen como máximo 25 filas por página;
no recuperes «mostrar todas», que llegaba a construir miles de widgets. En GTK,
los tamaños CSS son mínimos: el alto estable de una lista lo fijan
`minContentHeight` y `maxContentHeight`, no un supuesto `max-height` CSS.

`DisplaySelect` se monta sobre el `display-select-host` de la sección. La talla
normal se pide con `compact={false}` y admite buscador para listas extensas. Su
posición se acota a los viewports visibles; desplazar un contenedor lo cierra.
El overlay, los controladores y las señales se retiran con `onCleanup`, porque
desmontar una sección no garantiza que GTK emita `destroy`.
Mide el desplegable antes de darle márgenes de posición: GTK los incluye al
medir y puede restarlos del ancho útil. Las barras de Ajustes definen carril y
tirador completos para que el tema GTK no reintroduzca barras gruesas encima
del contenido.

Las columnas de Almacenamiento comparten medidas con `Gtk.SizeGroup`. Las
etiquetas envolventes de sus botones fijan `widthChars` y `maxWidthChars`: sin
un ancho mínimo común, el intercambio entre alto y ancho de GTK puede dejar
botones de distintos tamaños aunque pertenezcan al mismo grupo.
