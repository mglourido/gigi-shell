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
- `procesamiento/`: entrada y transformación de notificaciones recibidas.
- `daemon/`: comprobación del propietario D-Bus y aviso de conflicto.
- `rules/`: motor puro de reglas y validación.
- `history/`: lógica y almacenamiento del historial.
- `cleanup/`: limpieza por arranque, caducidad y programación.
- `autoDnd/`: detección y activación automática de No molestar.
- `settings/`: interfaz y lógica de configuración.

Si se añaden pruebas, deben permanecer junto al código que verifican. Los consumidores externos deben importar
las fachadas de la raíz salvo que necesiten explícitamente una pieza interna concreta.

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
