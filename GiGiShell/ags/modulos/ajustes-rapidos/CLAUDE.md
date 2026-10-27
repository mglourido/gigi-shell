# CLAUDE.md — Quick Settings

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: Wi-Fi, recorte de entrada y Bluetooth.

- `modulos/ajustes-rapidos/QuickSettings.tsx` — panel grande de controles (Wi-Fi, Bluetooth, audio, pantalla). Aquí quedan Wi-Fi, el recorte de entrada y Bluetooth; **el audio** (switch-on-connect, endpoints, presets de volumen, mezcla de aplicaciones) vive en [`servicios/multimedia/CLAUDE.md`](../../servicios/multimedia/CLAUDE.md).

  **El formulario de contraseña Wi-Fi va FIJO fuera del `<For>`, no dentro de la fila.** `QsWifiMenu` lo monta entre la cabecera y la `ScrolledWindow`, gobernado por `passwordTarget` (el SSID, o `null`) vía un `<With>` **metido en su propia `<box>`**. Esa caja es obligatoria: **un `<With>` cuyo valor cambia después de construirse añade su hijo con `append`, es decir, AL FINAL de su contenedor**, no en el hueco donde está escrito (solo el valor inicial sale en orden, porque se vuelca al construir el padre). Colgado a pelo de `qs-wifi-menu`, el formulario aparecía **debajo de la lista**. Envuelto, es el único hijo de su caja y el final es su sitio (medido en una ventana de prueba: cabecera y=0, formulario y=18, lista y=108). Metido dentro del `<For>`, cada refresco de APs lo rompía por dos vías, las dos sin error: (1) `For` hace `fragment.remove(child)` + `append(child)` de **todos** los hijos en cada re-evaluación del `each` para poder reordenar, así que el `Gtk.Entry` se reparentaba y perdía foco/cursor; (2) un `notify::access-points` —que NM emite **solo** al fluctuar la señal, cada pocos segundos, sin que nadie reescanee— cambia las referencias de los AP GObjects afectados y reconstruye esa fila entera, rehaciendo el `Entry`: al re-pedir el foco por código GTK **selecciona todo el texto** (`gtk-entry-select-on-focus`), y el reordenado de la lista lo desplazaba de sitio. Fijo y construido una sola vez (solo se rehace si cambia `passwordTarget`, nunca al teclear: `passwordStr` no entra en el `each`), el campo queda quieto. El `$` del `Entry` hace `grab_focus()` + `set_position(-1)` en un idle para deshacer esa selección total inicial. Y el `Gtk.EventControllerKey` que redirige teclas al buscador **se inhibe mientras `passwordTarget` no sea `null`** (si no, escribir la contraseña filtraba la lista y el foco saltaba al buscador). El `qsView.subscribe` **limpia `passwordTarget`/`passwordStr`/`passwordError` al salir de la vista**: `QsWifiMenu` no se desmonta (solo se oculta con `visible`), así que sin eso un intento de contraseña a medias seguía en pantalla al volver a entrar (y al cerrar el panel, que resetea `qsView` a `main`).

  **El recorte de entrada de QS va con `seguirAsignacion: true`** (`utilidades/inputRegion.ts`). Cuando el panel crece (el formulario, la ficha de info de una red, un desplegable), `notify::height` de la superficie llega **antes** de que GTK reasigne los hijos a la medida nueva: el tick+idle del helper medía el contenido con la altura vieja y ya no volvía a medir. Medido en una ventana de prueba: superficie a 288 px y región aplicada `330×198` tres veces seguidas. La franja nueva de abajo se quedaba **sin entrada**: el puntero, al pasar por ella, «salía» del panel y `handlePointerLeave` lo cerraba. La opción re-mide en el `after-paint` del reloj de frames (el layout ya está hecho) y solo reaplica si la silueta cambió; sin frames no corre (0 frames pintados en reposo, medido). Es **opt-in**: el lagarto se mueve cada frame y reaplicaría la región en cada uno, deshaciendo su holgura de recorte.

  **Auditoría del `<For>` sin `id` en este panel** (mismo fallo que en la barra; ver «Escritorios» en `modulos/barra/CLAUDE.md`): las listas cuyos elementos son **GObjects** —`endpoints` (`AstalWp.Endpoint`), los tres bloques de Bluetooth (`AstalBluetooth.Device`) y los puntos de acceso wifi— son **correctas tal cual**: filtrar y ordenar conserva la referencia, y sus filas ya son reactivas vía `createBinding`. Las de **strings** (barras de señal) se indexan por valor. Las dos que sí fabrican objetos nuevos son las que salen de un sondeo: las **pastillas de pantalla** (`hyprctl monitors -j` cada 2 s) ya van con `id={m.name}` y leen `focused` del state; y la **mezcla de aplicaciones**, que estuvo sin clave **a propósito** mientras se alimentaba de un sondeo `pactl` cada 2 s —era la reconstrucción de la fila lo que re-sembraba `currentVol` desde el valor real del sistema, así que ponerle `id` habría dejado el slider sordo a los cambios hechos fuera del panel—, hoy **va con `id`** porque su fuente es AstalWp: cada fila escucha el `notify::volume` de SU stream. Con esa inversión se fueron también los dos apaños que sostenían aquello: la firma `streamsSignature` (publicar solo si algo cambió) y el congelado de 2,5 s tras tocar el slider (`spkLastInteraction`, para que la vuelta siguiente del sondeo no pisara el arrastre). **Es el patrón general de este panel**: una lista de GObjects con `id` y filas reactivas; el sondeo era lo que forzaba la excepción.

  **Bluetooth — el "apagado" del usuario lo borraba el propio BlueZ, y el tile mentía.** Tres bugs
  con la misma raíz: *nadie puede distinguir "lo encendió el usuario" de "lo encendió
  BlueZ" si no se le da tiempo al adaptador*.
  1. **`AutoEnable` (activado por defecto en `/etc/bluetooth/main.conf`) enciende el controlador él
     solo en cuanto lo encuentra — y lo hace DESPUÉS de registrar el adaptador.** Queda una ventana
     en la que el adaptador ya existe y sigue apagado, indistinguible de "el usuario lo dejó
     apagado". `resolverRestauracionBluetooth` (`bluetooth/estadoInicio.ts`) daba la restauración
     por terminada ahí mismo, solo porque el estado coincidía con el objetivo; el power-on de BlueZ
     llegaba justo después, nadie lo corregía, y `guardarEstadoSistema` lo **adoptaba como decisión
     del usuario** reescribiendo `bluetooth: true` en `system_state.json`. Resultado medido con un
     A/B: con la lógica vieja, arrancar con el BT apagado y guardado como apagado terminaba con
     `Powered: yes` **y el `false` del disco pisado a `true`** — o sea que el apagado no sobrevivía
     ni a ese arranque, y menos al siguiente. Hoy "coincide con el objetivo" **no basta** para
     cerrar: hace falta el parámetro `asentado`, que se arma con `BT_SETTLE_MS` (5 s) contados
     **desde que el adaptador aparece**, no desde que arranca AGS — es un dongle USB (RTL8761 aquí)
     y puede tardar en enumerarse, así que una gracia contada desde el shell expiraría antes de que
     BlueZ llegue a verlo (mismo razonamiento que el gate de audio de `servicios/multimedia/CLAUDE.md`). Mientras no está
     asentado no se actúa, pero la restauración **sigue viva** y corrige el encendido automático.
     **Una acción explícita del usuario cierra la restauración en el acto**
     (`finalizarRestauracionBluetooth()` desde `toggleBluetoothPower`): sin eso, encender el BT
     dentro de esos 5 s haría que la restauración se lo volviera a apagar en la cara. Un encendido
     externo *pasada* la ventana sí se adopta y se guarda, como siempre.
  2. **Pero la ventana era de UN SOLO USO, y un dongle USB no es un adaptador estable.** El punto 1
     arregla el arranque; el mismo encendido vuelve a mitad de sesión y ahí no lo corregía nadie.
     Al volver de una suspensión el kernel **reenumera el dongle** (`Bluetooth: hci0: RTL: loading
     rtl_bt/rtl8761bu_fw.bin` en el log de esta máquina, en el mismo segundo que el `PM: suspend
     exit`), BlueZ lo registra **como si acabara de aparecer** y su `AutoEnable` lo enciende otra
     vez — solo que con `restauracionBluetoothCompletada` ya en `true`, así que
     `registrarEstadoBluetoothConfirmado` lo adoptaba como decisión del usuario y
     `guardarEstadoSistemaAhora` reescribía `bluetooth: true`. En la sesión siguiente ya no quedaba
     nada que restaurar: **el apagado no sobrevivía a una suspensión**, que es lo que se veía como
     "casi siempre lo apago y vuelve encendido". Hoy **la ventana se REABRE** con
     `reabrirVentanaRestauracion` (puro, con test) en las dos rutas que hacen falta y que no se
     cubren entre sí: (a) cuando el adaptador pasa de **ausente a presente** — se sigue con
     `habiaAdaptadorBluetooth`, y por eso `adapter-removed` también está conectado a
     `sincronizarEstadoBluetooth`: es lo único que baja esa bandera si el adaptador desaparece **ya
     apagado**, porque entonces `is-powered` no cambia y no se emite; y (b) al recibir
     `PrepareForSleep(false)` de logind, porque si el kernel recupera el dongle con `reset_resume`
     el objeto de BlueZ **nunca desaparece** y no hay alta que observar, pero el controlador sí ha
     pasado por un reinicio; y (c) al entrar el adaptador en **`PowerState: off-blocked`**, o sea un
     bloqueo de rfkill, que tampoco da de baja el objeto. Con reenumeración se solapan y la segunda
     reapertura es idempotente.
     **(c) es además el único reproductor sin privilegios, y con él está medido el A/B**: con
     `bluetooth: false` en disco, el BT apagado y la restauración ya cerrada, `rfkill block
     bluetooth` + `rfkill unblock bluetooth` terminaba en `Powered: yes` **y el fichero reescrito a
     `true`**; con el arreglo, la traza de `dbus-monitor` sobre `/org/bluez/hci0` enseña la
     secuencia completa — `off-blocked` → `off-enabling` → `on` (**lo enciende BlueZ**) →
     `on-disabling` → `off` (**lo corrige AGS**) — y el disco se queda en `false`. Se engancha a
     `off-blocked` y **no** al encendido posterior porque es lo único que distingue ese encendido de
     uno pedido a mano con `bluetoothctl` o blueman, que **sí** se adoptan: pelearse con ellos sería
     peor que el bug. `on-disabling`/`off-enabling`, por los que pasa cualquier apagado o encendido
     normal, se ignoran a propósito. De paso, `objetivoBluetoothInicial` (congelado en el arranque) y
     `ultimoEstadoBluetoothConfirmado` (el que se guardaba) se **fundieron en `intencionBluetooth`**:
     eran dos nombres de la misma cosa y en cuanto la ventana se reabre a mitad de sesión discrepan
     — la ventana nueva habría restaurado el valor del arranque en vez del último que pidió el
     usuario.
  3. **El tile tenía dos fuentes de verdad para el mismo hecho.** El CSS salía de
     `createComputed(() => btSupported() && btPowered())` sobre un `createBinding(bt, "isPowered")`,
     y el texto de un `createState` que escribía `syncBtInfo`. Los dos cuelgan de
     `notify::is-powered`, pero son **handlers distintos** y GObject los invoca en orden de
     conexión: `syncBtInfo` se conecta al construir el componente y el del binding al renderizar,
     o sea después — el CSS iba un handler por detrás y los dos se contradecían (medido:
     `CSS=ACTIVE` con `TEXTO="Desactivado"`). Ahora `getBluetoothTileInfo` devuelve también
     **`active`**, y el icono, el texto y el CSS salen del **mismo objeto y del mismo setter**:
     contradecirse es imposible por construcción (hay test). De paso se fue `btDevices`, que era
     código muerto. Y se escucha **`notify::is-connected`**: conectar unos cascos **ya emparejados**
     no cambia la lista, así que `notify::devices` no salta y el tile se quedaba en "Desconectado"
     con los cascos puestos.
     **Queda una asimetría que no cierra sola: el tile es una FOTO y el interruptor del submenú es
     un `createBinding`.** Una foto que se pierda una emisión miente el resto de la sesión; un
     binding relee la propiedad y se recompone. Eso es exactamente el segundo síntoma reportado —el
     texto en "Desactivado" con el interruptor encendido, o sea las dos lecturas del *mismo*
     `bt.isPowered` contradiciéndose— y por eso `syncBtInfo` (y el `btSupported` del submenú) se
     **resiembran al abrir Quick Settings**, igual que ya hacía el tile de red. No sustituye a las
     señales, las cubre: **no se ha aislado qué emisión concreta se pierde** (el ciclo
     quitar/poner adaptador de AstalBluetooth acaba siempre en un `sync()` que debería notificar),
     así que se ataca la clase entera en vez de un caso. Si vuelve a aparecer el síntoma **con el
     panel ya abierto**, ahí sí hay que buscar la emisión.
