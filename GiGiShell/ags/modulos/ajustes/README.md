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
