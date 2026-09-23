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

Los tests permanecen junto al código que verifican. Los consumidores externos deben importar
las fachadas de la raíz salvo que necesiten explícitamente una pieza interna concreta.
