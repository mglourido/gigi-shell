# CLAUDE.md — Ajustes > Apps al inicio

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../../CLAUDE.md)). Aquí: qué se abre solo al entrar al escritorio.

- `modulos/ajustes/inicio/SeccionAppsInicio.tsx` + `servicios/aplicaciones/appsInicio.ts` —
  **Ajustes > Apps al inicio**: qué se abre solo al entrar al escritorio. El shell **escribe**
  `~/.config/gigishell/apps-inicio.json` y no lanza nada; quien ejecuta la lista es
  `inicializador/apps-inicio.sh`, llamado desde `hypr/gigishell/autostart.lua` a t=7. **El porqué está
  en la sección «Apps al inicio» de [`docs/hyprland-modulos.md`](../docs/hyprland-modulos.md).** Del
  lado del shell:
  - **Si AGS lanzara estas apps, dejarían de arrancar en la sesión en que el shell falla** — que es
    cuando más falta hace tener delante el navegador. Por eso el reparto es escribir/ejecutar. La
    única llamada que sale de aquí es el botón «probar», y va por `apps-inicio.sh --probar <id>`,
    o sea por el MISMO camino que el arranque: un botón de probar que ejecute por otro sitio diría
    que funciona cuando el que falla es el camino real.
  - **La lógica pura vive en `appsInicioModelo.ts` (con prueba)** y no en el servicio, que importa
    `gi://GLib` y no correría bajo `node --test`. Ahí está el saneado del comando —códigos de campo
    `%U`, aplanado a una sola línea— y la regla de que **sin escritorio fijado no se guarda el
    silencio**: `silent` solo existe como regla de exec al enviar la ventana a otro escritorio
    (medido: `[noinitialfocus]` no es una regla de exec), así que guardarlo encendido enseñaría un
    ajuste que no se aplica.
  - **Los tres `Gtk.Entry` viven FUERA de toda lista que se reconstruya**, misma precaución que
    `disco/RutasPersonalizadas.tsx`: reconstruir una lista que contiene el widget con el foco es lo
    que aquí acaba en SIGSEGV. Los resultados del buscador sí se rehacen a cada tecla, y por eso
    dentro no hay nada editable. Las filas guardadas van con `<For id>` y **leen por accessor
    derivado de `appsInicio`**, no del objeto que recibieron: con clave, una fila se construye una
    sola vez y su prop no vuelve a llegar (ver «`<For>` INDEXA POR IDENTIDAD DE OBJETO» en `modulos/barra/CLAUDE.md`).
  - El catálogo del buscador reutiliza `modulos/orion/data/appsInfo.ts` (la caché compartida de
    `Gio.AppInfo.get_all()`, que se invalida sola al instalar o desinstalar algo) en vez de abrir un
    quinto escaneo de los mismos `.desktop`.
