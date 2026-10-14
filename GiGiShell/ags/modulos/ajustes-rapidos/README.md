# Ancho de Ajustes rápidos

El panel conserva 330 px de contenido y 10 px de padding por lado. El conector
transparente añade otros 18 px a la ventana. Todas las vistas comparten
`ContenedorAnchoQs`: fija el ancho mínimo y natural a 350 px y mide la altura
del contenido para ese ancho. La altura puede seguir cambiando al desplegar
listas o el formulario Wi-Fi.

En GTK, `widthRequest` y `min-width` son mínimos, no límites superiores.
`ellipsize` tampoco basta por sí solo para controlar cómo se reparte el ancho.
Un nombre largo podía ensanchar las dos columnas de la rejilla homogénea.
No se debe sustituir el contenedor por un `max-width` de CSS, que GTK no admite.

Los nombres de tarjetas, redes, dispositivos, aplicaciones y del pie usan
`TextoAcotadoQs`. Su `maxWidthChars={1}` limita la medida natural; **no recorta
la cadena a un carácter**. `halign=FILL`, `hexpand` y `xalign=0` permiten usar
todo el hueco asignado, y Pango añade la elipsis al final cuando hace falta.
El texto completo se conserva en la etiqueta y en su tooltip, también cuando
se actualiza mediante un accessor. No se cortan cadenas por longitud.

Los buscadores y la contraseña Wi-Fi también neutralizan la reserva implícita
de ancho de `Gtk.Entry` con `widthChars={1}` y `maxWidthChars={1}`. Los mensajes
multilínea que incluyen un SSID usan `wrapMode=WORD_CHAR`, de modo que un nombre
sin espacios puede envolver sin imponer su longitud como ancho mínimo.

Al añadir controles, su ancho mínimo combinado debe caber en los 330 px útiles.
Por eso se retiró la reserva de 96 px del subtítulo de red: sumada a iconos,
flecha, separaciones y padding de ambas columnas, superaba el ancho de diseño.
El límite del contenedor protege la ventana, pero no sustituye a dimensionar
correctamente los controles de dentro.

El contenedor sigue el patrón de `CajaFija` de Orion: hereda de `Gtk.Box` y
desactiva su `BoxLayout` para usar las vfuncs de medida y asignación. Conserva
la limpieza nativa de los hijos; no usa `Gtk.CustomLayout` ni un `dispose`
implementado en JavaScript, que ya causaron fallos en GJS en ese módulo.
