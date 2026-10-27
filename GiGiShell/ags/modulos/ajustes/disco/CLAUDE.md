# CLAUDE.md — Ajustes > Almacenamiento

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../../CLAUDE.md)). Aquí: análisis, catálogo de apps por tamaño y autolimpieza.

- `modulos/ajustes/disco/SeccionAlmacenamiento.tsx` + `servicios/disco/` — **Ajustes > Almacenamiento**
  («Almacenamiento» = qué ocupa el disco + catálogo de apps por tamaño; «Liberar espacio» = limpiezas
  manuales y autolimpieza). El trabajo sucio lo hacen tres scripts bash
  (`hypr/scripts/analizar-almacenamiento.sh`, `limpiar-almacenamiento.sh`, `limpieza-arranque.sh`) y un
  helper root (`system/limpieza/`); **el porqué de cada decisión está en la sección «Almacenamiento y
  autolimpieza» de [`docs/hyprland-modulos.md`](../docs/hyprland-modulos.md) — léela antes de tocar
  nada de esto.** Lo que hay que saber del lado del shell:
  - **El directorio se llama `disco/`, no `almacenamiento/`, y el servicio `servicios/disco/`.** Ese
    nombre ya está cogido por `servicios/almacenamiento/`, que es la lectura y escritura de los JSON
    del shell — nada que ver con el espacio en disco. Dos cosas con el mismo nombre a dos niveles del
    árbol es una trampa para el siguiente que grepee.
  - **El análisis TAMBIÉN es el vigilante de «disco casi lleno» del resto de la sesión.** Cada
    medida recién tomada pasa por `revisarDiscos()` (`servicios/disco/alerta.ts`) desde
    `usarAnalisis.ts`, que emite el evento `disco.casi-lleno` — el **mismo** que `disk-monitor.sh`
    manda al iniciar sesión, con el mismo texto, los mismos umbrales y una espera de 6 h compartida
    en `~/.cache/gigishell/disco-avisos`. Existe porque **el espacio libre no tiene fuente de eventos
    en Linux** (comprobado: ni kernel, ni udisks2, ni systemd, ni nada de CachyOS; GNOME y KDE
    sondean cada 60 s), así que en vez de añadir un sondeo propio se reaprovecha el `df` que esta
    sección ya pagaba: coste marginal cero. La decisión es pura y testeada
    (`servicios/disco/vigilancia.ts`); **la llamada va en `usarAnalisis.ts` y no dentro de
    `analizar()`, a propósito**: medir no debe notificar, o cualquier consumidor futuro dispararía
    avisos por el mero hecho de leer el disco. Va **antes** del `if (referencias > 0)`: con Ajustes
    ya cerrado la medida sigue siendo válida y llenar el disco es justo lo que hay que contar
    aunque no quede nadie mirando la sección. Los tres puntos que deben seguir coincidiendo con el
    script bash están en `docs/hyprland-modulos.md`.
  - **Se pinta llena en el primer frame**, con la caché de `~/.cache/gigishell/almacenamiento.json`
    (síncrona, ~1 ms) mientras el análisis nuevo entra por detrás. Mismo patrón que
    `modulos/ajustes/sistema/informacion.ts`: el análisis tarda ~1,4 s y puede volver con la
    sección ya desmontada, así que el resultado tardío se descarta si no queda nadie mirándolo.
  - **El análisis es UNO para todas las vistas vivas** (`disco/usarAnalisis.ts`): estado a nivel de
    módulo con contador de referencias, no un `createState` por vista. `SettingsPanel` se instancia
    **una vez por monitor** y `settingsPanelVisible` es global, así que con el estado dentro de la
    vista dos pantallas lanzaban dos `analizar-almacenamiento.sh todo` simultáneos —dos recorridos
    completos del sistema de ficheros para medir lo mismo, compitiendo por el disco— y dos
    escrituras de la caché pisándose. Latente en un equipo de un solo monitor: no da error, solo
    hace que Ajustes tarde más en abrir el día que conectas la segunda pantalla. Al soltar la
    última referencia se descarta el análisis y se da de baja la suscripción, así que **cerrar
    Ajustes sigue sin dejar nada vivo**; el vaciado va aplazado un tick porque `onCleanup` corre
    con el `<With>` de la vista todavía suscrito.
  - **Cada categoría trae DOS cifras: `bytes` (lo que ocupa) y `liberable` (lo que se liberaría al
    limpiarla).** La estimación de «Liberar espacio» suma **`liberable`**; sumar `bytes` era el
    fallo original — prometía 28,2 GiB donde se liberaban 21,7. Nada aquí recalcula el reparto: lo
    calcula el analizador aplicando las mismas reglas que el borrado, y las tres cachés de
    `~/.cache` son **disjuntas** por construcción (`hypr/scripts/lib/limpieza-rutas.sh`), así que la
    suma es exacta para cualquier combinación de casillas y no hay que descontar solapes en el
    shell. `liberable: null` = «no se ha podido saber» (hoy solo Flatpak): la frase pasa a «se
    liberarían **al menos** X» en vez de tragárselo como un 0. Hay tests para los tres casos.
  - **Tocar `retenerJournal`/`diasPapelera`/`diasDescargas` INVALIDA el análisis.** Esos campos
    deciden *cuánto* libera cada acción, y la caché sigue siendo «reciente» durante su ventana de
    diez minutos, así que la cifra se quedaba congelada tras editarlos. `preferencias.ts` publica el
    contador `revisionLimpieza` y `usarAnalisis` se suscribe para reanalizar.
  - **El estado de las limpiezas vive en `usarLimpiezas.ts`, POR ENCIMA del `<With value={analisis}>`
    y a nivel de MÓDULO**, con el mismo contador de referencias que `usarAnalisis.ts`. Dos razones
    encadenadas: (1) estaba en cada fila, y al terminar una limpieza la fila llama a `refrescar()`
    — el análisis nuevo reemite ~0,6 s después, el `<With>` reconstruye todas las filas y el «Se han
    liberado 3,4 GB» aparecía y desaparecía solo; (2) subirlo a la vista dejaba una copia por
    monitor, así que pulsar «Vaciar papelera» en una pantalla dejaba a la otra con el botón normal y
    **pulsable** mientras la limpieza corría, y el guardia de reentrada no cruzaba de una instancia a
    la otra. Es un mapa único y no doce pares de `createState`, de los que como mucho hay uno o dos
    vivos a la vez. Al soltar la última referencia se tiran los MENSAJES pero **no `ocupadas`**: es el
    guardia de reentrada de limpiezas que siguen corriendo con Ajustes cerrado, y vaciarlo dejaría
    ese botón clavado en «Limpiando…» en la siguiente apertura. «Limpiar ahora» (`ejecutarAutolimpieza`)
    está ahí por lo mismo.
  - **Una limpieza que termina con Ajustes ya CERRADO no reanaliza: anota `caducarAnalisis()`.**
    Reanalizar sería medir para nadie, pero dejarlo estar hacía que la caché siguiera siendo
    «reciente» durante sus diez minutos, así que volver a abrir tras liberar 20 GB enseñaba las
    cifras de ANTES. La marca la consume el siguiente montaje.
  - **«Borrar lo que yo elija» (`rutasPersonalizadas`) acepta carpetas y ficheros**: de una carpeta
    se borra el contenido (la carpeta sobrevive) y un fichero se borra él mismo. Lo reparte
    `objetivos_de_ruta` en la lib de bash, compartido con el analizador para que lo medido sea
    exactamente lo borrado. Valida llamando al script, no con una copia de
    las reglas en TypeScript.** `limpiar-almacenamiento.sh --validar-ruta` usa el mismo
    `ruta_personalizada_valida` que después borra; dos criterios acabarían discrepando y aquí
    discrepar significa borrar algo que la pantalla había dado por rechazado. `RutasPersonalizadas.tsx`
    tampoco usa `<For>`: el `Gtk.Entry` vive FUERA de la lista que se reconstruye y las filas solo
    tienen etiqueta y botón, así que no hay nada enfocable dentro cuando la lista cambia — el
    SIGSEGV de las franjas horarias no se evita con cuidado, se evita por diseño.
  - **La lista hermana, `rutasProtegidas`, es lo que NINGUNA limpieza toca** (misma pantalla, mismo
    widget con otro verbo: `EditorDeRutas` y `--validar-protegida`). No es solo un "no borrar": si
    proteges algo **dentro** de una carpeta que sí se limpia, el filtro **desciende** y borra el
    resto, así que proteger un fichero de 4 KB no cancela la limpieza del gigabyte que lo rodea. Se
    aplica en bash (`filtrar_protegidos`), en el punto por el que pasa todo lo que borra el script;
    **lo que borran pacman/paru/npm/pip/flatpak no lo respeta** porque no aceptan exclusiones, y eso
    se dice en la UI. Protegerla **descuenta de la estimación**, así que su setter invalida el
    análisis igual que los días y la retención, y al proteger una ruta que estaba en la lista de
    borrar se la quita de allí: la contradicción la gana siempre la protección.
  - **«Limpiar descargas antiguas» BORRA; la papelera es opt-in (`descargasAPapelera`, apagado).**
    Usaba `gio trash` siempre y la cifra mentía: la papelera está en el mismo sistema de ficheros,
    así que mover 5 GB no libera un byte, pero la sección decía «5 GB liberados». Con el interruptor
    encendido la contabilidad se invierte y sigue siendo honesta: `liberado: 0` + un `mensaje` con
    lo movido, y `liberable: 0` en el analizador — lo liberará «Vaciar papelera», que tiene su
    propia fila. De ahí que `textoResultado` enseñe el `mensaje` de un `ok` cuando lo trae; sin esa
    rama decía «No había nada que liberar» tras mover 5 GB.
  - **`bytes: null` NO es `0`.** `null` = no se ha podido medir (`du` agotó su timeout, o sin
    permisos); `0` = medido y vacío. `formatearBytes` los distingue (`—` vs `0 B`) y `agrupar` manda
    los `null` al final de la lista. Unificarlos hace creer que ya está limpio lo que pueden ser
    decenas de GB. Hay test.
  - **`catalogo.ts` es la única lista**, y de él sale `ACCIONES_AUTOMATIZABLES` filtrando por
    `privilegio !== "pkexec"` **y `!manual`** en vez de escribirse a mano: eso es lo que impide que una acción con
    diálogo de contraseña acabe en el lote desatendido, donde el diálogo aparecería solo de madrugada.
    La invariante tiene prueba propia.
  - **`manual` es el segundo motivo para quedarse fuera del lote, y no tiene que ver con los
    permisos.** Hoy solo lo lleva **`cacheSombreadores`** («Limpiar caché de sombreadores»: Mesa,
    NVIDIA, AMDVLK, Qt, CUDA y el `steamapps/shadercache` de Steam, ~15 GB en este equipo), que corre
    entera bajo `$HOME` sin pedir nada pero cuyo coste no se paga en disco: se paga recompilando en
    la siguiente partida y, en el caso de Steam, **volviendo a descargar** lo que ya tenías. Por eso
    tiene botón y no casilla. Sin el campo, la única forma de dejarla fuera habría sido mentir en
    `privilegio`; la barrera de verdad sigue siendo la lista blanca de `limpieza-arranque.sh`. Una categoría que llegue del script y no esté catalogada se
    **ignora**, no se pinta con el id crudo — el bash puede ir por delante del shell.
  - **Las acciones de `pkexec` van envueltas en `withPrivilegedPrompt`** (`limpieza.ts`). Sin eso el
    diálogo queda detrás de la ventana de Ajustes, que es una capa OVERLAY, y el botón se queda
    pensando para siempre. Mismo caso que `servicios/dispositivos/printers.ts`.
  - **Ningún camino puede acabar sin algo que pintar**: `ejecutarLimpieza` convierte cualquier
    rechazo en un `ResultadoLimpieza` con estado `error`, porque quien llama es un `onClicked` y una
    promesa rechazada ahí deja el botón en «Limpiando…» el resto de la sesión.
  - **`{ACCIONES.map(...)}` suelto junto a otro hijo revienta la sección entera.** Un array como
    hijo *único* se aplana; dos hijos donde uno es un array llegan a `Fragment.append` sin aplanar y
    lanzan «Object … is not a subclass of GObject_Object, it's a Array», que tumba la construcción de
    toda la vista (medido: «Liberar espacio» salía en blanco). El `.map` va dentro de su propia caja.
  - **El catálogo de apps se recorta a 12 filas** con «Ver más»: son ~1600 paquetes dentro de un
    `ScrolledWindow` que no virtualiza nada. El `<For>` va con `id={app => app.nombre}` por lo mismo
    que la barra (ver «Escritorios» en `modulos/barra/CLAUDE.md`): sin clave, cada tecla del buscador reconstruiría
    las doce filas enteras.
  - Las preferencias viven en `~/.config/gigishell/almacenamiento.json` y **nacen todas apagadas**, al
    revés que `security.json`: allí los defaults deciden si algo se *vigila*, aquí si algo se *borra
    sin preguntar*. Los scripts las releen en cada pasada, así que solo el interruptor maestro
    necesita `pkill` + relanzar el vigilante.
