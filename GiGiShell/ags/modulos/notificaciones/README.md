# Estructura del módulo de notificaciones

La raíz conserva únicamente las fachadas que consumen otros módulos:

- `NotificationPanel.tsx`: ventana del panel lateral.
- `NotificationPopup.tsx`: ventana y conexión de los popups.
- `store.ts`: fachada compatible del estado compartido.

El resto del código se agrupa por responsabilidad:

- `panel/`: composición de cabecera, listas y pie del panel.
- `panel/item/`: tarjeta individual, acciones, respuesta, iconos y lógica asociada.
- `popup/`: elemento visual, pila, disposición, duración y control de ráfagas.
- `estado/`: modelos, almacenamiento, estado de panel, presentación y persistencia JSON.
- `iconos/`: resolución compartida de logos y caché acotada en memoria.
- `procesamiento/`: entrada y transformación de notificaciones recibidas.
- `daemon/`: comprobación del propietario D-Bus y aviso de conflicto.
- `rules/`: motor puro de reglas y validación.
- `history/`: lógica y almacenamiento del historial.
- `cleanup/`: limpieza por arranque, caducidad y programación.
- `autoDnd/`: detección y activación automática de No molestar.
- `settings/`: interfaz y lógica de configuración.

Si se añaden pruebas, deben permanecer junto al código que verifican. Los consumidores externos deben importar
las fachadas de la raíz salvo que necesiten explícitamente una pieza interna concreta.

WhatsApp puede enviar la foto del contacto en `appIcon`. Las tarjetas del panel y
del historial conservan esa imagen y añaden al lado el logo instalado según
`appName` (WhatsApp o ZapZap); no debe usarse la presencia de `appIcon` para ocultar
ese identificador.
Si falta la foto, el logo sigue identificando la aplicación. Tanto ese logo como
los de los popups usan el símbolo anterior como alternativa si no hay imagen
instalada. El estilo dunst continúa ocultándolos y evita resolverlos.

El icono recibido tiene prioridad, pero puede faltar (como ocurre con Discord) o
apuntar a un archivo temporal eliminado. Antes de recurrir al nombre de la app,
las tarjetas buscan su nombre en el tema de iconos y consultan el catálogo
compartido de entradas `.desktop`. También se admiten imágenes con URI `file://`.
Así se recuperan logos instalados sin sustituir avatares válidos ni guardar
iconos adicionales en disco.

La caché de resolución guarda como máximo 128 referencias por último uso; no
retiene texturas, pixbufs ni widgets. Tema y catálogo de aplicaciones comparten
las señales existentes: al cambiar se invalidan aciertos y fallos y se refrescan
las vistas montadas mediante un único aviso diferido por ráfaga. El catálogo se
invalida antes de avisar, para no volver a memorizar una entrada antigua. Cada
vista libera su suscripción al desmontarse.

Las rutas externas, incluidos los avatares, se comprueban en cada reutilización
y no se memorizan: un fallo previo no oculta un archivo que aparece después y
un archivo borrado permite recuperar el logo de la aplicación. Se crea una
representación ajustada al tamaño y la escala actuales, para recoger también
sobrescrituras en la misma ruta sin retener la imagen anterior. No hay sondeo
ni un vigilante por notificación; un cambio aislado de avatar se recoge al
volver a montar la tarjeta o al siguiente cambio de tema/aplicaciones.

Los JSON conservan referencias de icono, no imágenes por notificación. Los PNG
que Astal genera para `image-data` pertenecen a su caché independiente
`~/.cache/astal/notifd/`. No se añaden copias ni barridos periódicos sobre ella:
borrar una imagen todavía usada por el daemon o por un historial rompería su
referencia, y el volumen observado no justifica otro gestor de caché.

Los popups recortan la entrada por tarjeta, con esquinas redondeadas en el estilo
normal y rectas en dunst. GTK puede conservar el alto anterior de su ventana al
retirar una tarjeta: sin recorte, el espacio que queda debajo sigue interceptando
clics aunque ya sea transparente, igual que los huecos entre avisos. La lista de
contenidos se consulta en cada layout y su región se aplica antes de pintar, para
seguir los `transform` de entrada y salida en el mismo fotograma. Medir después de
pintar dejaba un frame de desfase. Al no quedar contenidos se permite vaciar la
región; al remapear se vacía antes de medir para no reutilizar la silueta anterior.

Cada tarjeta conserva y cancela su temporizador de salida al retirarse de la pila.
El descarte es idempotente: varios gestos o la caducidad no programan salidas
duplicadas. Así, una salida antigua no elimina un popup nuevo que reutilice el
mismo ID durante la animación ni deja callbacks pendientes tras cerrar la pila.

La región de entrada del panel abarca la superficie durante la animación de
apertura y recupera la silueta del contenido tras el layout. No debe medirse
como definitiva con `np-preparing`: su `translateX(220px)` también desplaza el
resultado de `compute_bounds()`. El helper de recorte pide un repintado al
aplicar cada región para enviarla al compositor: sin ese frame, el recálculo
final podía quedarse pendiente y el panel solo recuperaba la hitbox al mover
el ratón o volver a abrirlo. Las aplicaciones inmediatas cancelan el tick o
idle anterior para que no vuelva a medir una posición de mitad de animación.

Quick Settings y Calendario usan la misma cobertura durante la entrada y el
seguimiento tras el layout. Orion sigue su silueta pintada, incluidas las curvas
inferiores, para conservar las reservas laterales transparentes. Ese seguimiento
también corrige el recorte al abrir su panel contextual mientras se desliza; un
recálculo aislado podía dejar la franja superior visible sin entrada.

Las cabeceras de los grupos muestran solo el total en una etiqueta de 22 px de
alto, con texto de 11 px y esquinas de 6 px, a juego con los botones del panel.
La cabecera ocupa todo el ancho y conserva las esquinas rectas. Su selector
`.np-panel button.np-group-header` debe superar el reset `.np-panel button` para
conservar el relleno propio. `min-height: 0` y `border-radius: 0` evitan heredar
la altura y las esquinas del tema GTK.

El plegado anima la flecha y la altura del grupo durante 140 ms. El
`Gtk.Revealer` conserva el contenido durante el cierre y lo desmonta al recibir
`notify::child-revealed` con el cierre completado. No hay que desmontarlo al
pulsar: se cortaría la animación. Al reabrir, se monta antes de iniciar el
despliegue; GTK puede invertir una transición en curso sin reconstruir las filas.

Al cambiar entre vista agrupada y plana se comprueba también el montaje
incremental. No basta con esperar `changed` del ajuste del scroll: después de
plegar grupos, las primeras 20 notificaciones pueden caber en el panel sin
cambiar sus medidas. Sin esa comprobación, los siguientes tramos no se cargan y
pueden desaparecer de la vista aplicaciones enteras cuyos avisos son más antiguos.

Para que el regreso a la lista plana no aparezca por tandas, se recuerda solo el
límite que hizo falta para llenar la ventana, sin conservar widgets ocultos ni
los tramos adicionales cargados al desplazarse. La vista anterior se desmonta
antes de cambiar ese límite: `For` reinserta las filas al modificar su array y
reajustarlo justo antes de destruirlo añade trabajo innecesario. Una comprobación
que se retira tras el layout atiende los cambios de tamaño sin depender de
`changed`; sus callbacks pendientes se cancelan al cambiar de vista o desmontar.
