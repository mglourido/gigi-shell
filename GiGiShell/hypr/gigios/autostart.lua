-- gigios/autostart.lua — lo que se lanza al iniciar la sesión, escalonado.
--
-- Todo va dentro de hl.on("hyprland.start"): se dispara UNA vez por sesión y un
-- `hyprctl reload` NO lo repite (medido en Fase 0) — la semántica exacta de
-- `exec-once`. El código top-level de un módulo, en cambio, se re-ejecuta en
-- cada reload (semántica `exec`), y relanzar AGS/monitores en cada recarga
-- sería un desastre.
--
-- ── Calendario de arranque (por qué hay `sleep N &&`) ────────────────────────
-- Todos estos exec salían A LA VEZ, compitiendo con la carga del propio
-- Hyprland y del shell (AGS) justo cuando la caché está fría: journal sin
-- cachear, firmas de ClamAV sin cargar, discos aún despertando. Lo caro no es
-- ninguno por separado, es que ~12 procesos pidan datos del sistema a la vez
-- que se pinta el escritorio.
--
-- La regla: lo que el usuario VE o lo que no puede perder eventos va a t=0; lo
-- que solo consulta el estado del PC (disco, sensores, batería, journal) se
-- aparta unos segundos (calendario comprimido: este equipo aguanta la carga). Nada de esto es urgente al segundo 0 — un disco lleno o
-- un ventilador parado siguen estándolo 20 s después.
--
-- Van ESCALONADOS, no todos con el mismo sleep: darles a todos `sleep 5` solo
-- movería la misma avalancha 5 s más tarde. Cada uno tiene su hueco.
--
-- **Los `sleep N &&` NO se cambian por `hl.timer`, y no es pereza: un
-- `hyprctl reload` CANCELA los timers pendientes** (medido con un A/B — timer a
-- 5 s con un reload por medio: no dispara; el mismo timer sin reload: dispara).
-- O sea que una recarga dentro de los primeros 30 s de sesión se llevaría por
-- delante todo el arranque escalonado que aún no hubiera saltado —los monitores
-- no arrancarían nunca, sin un solo error— y recargar justo después de entrar,
-- mientras se afina algo, es de lo más normal. Un `sleep` es un proceso suelto
-- que ya no depende del compositor. El único hl.timer del repo (la ventana de
-- 30 s de gigios/escaner-apps.lua) sí acepta ese riesgo: perderla solo cuesta
-- que no se salte de escritorio esa vez.
--
-- Además, los tiempos están medidos y razonados, y el retardo vive en el punto de llamada
-- y no dentro de los scripts a propósito — `screencast-monitor` y
-- `updates-monitor` también los lanza AGS en caliente desde sus interruptores
-- de Ajustes (pkill + re-exec), y un sleep interno haría que encender el
-- interruptor tardara 15 s en hacer nada. El retardo es una propiedad del
-- ARRANQUE, no del script.
--
-- Excepción: `oom-monitor.sh` se escalona por dentro. No es una unidad — son 6
-- sub-monitores con riesgos distintos: los que siguen el journal (con `-n 0`)
-- no pueden retrasarse sin abrir una ventana ciega; el escaneo de descargas y
-- el sondeo SMART sí. Ver su cabecera.

hl.on("hyprland.start", function()

  -- ── t=0 · lo que se ve, o lo que no puede perder eventos ───────────────────

  -- Tema oscuro e iconos coherentes para aplicaciones GTK y KDE. Van delante de
  -- AGS a propósito: son dos spawn de milisegundos, y fijar el color-scheme
  -- DESPUÉS de arrancar el shell dejaría a GTK resolviendo el tema a media carga.
  hl.exec_cmd("gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'")
  hl.exec_cmd("gsettings set org.gnome.desktop.interface icon-theme 'Tela-circle-grey'")

  -- La mitad KDE del tema oscuro. Cualquier app KDE que guarde ajustes globales
  -- (Dolphin > Preferencias) reescribe ~/.config/kdeglobals ENTERO con KConfig y
  -- se deja por el camino [UiSettings], que es el grupo que lee
  -- KColorSchemeManager: a partir de ahí Dolphin se abre en CLARO aunque
  -- [General] ColorScheme, los [Colors:*] y QT_QPA_PLATFORMTHEME=qt6ct sigan
  -- intactos. Bajo Plasma lo repondría el escritorio; aquí no hay nadie, así que
  -- se repone al entrar. Falla en silencio y no se nota hasta que abres el
  -- gestor de archivos, que es justo por lo que conviene mirarlo cada sesión.
  --
  -- Va a t=0 y no molesta: es un `awk` sobre un fichero de 4 KB, y cuando la
  -- clave está (lo normal) no escribe nada. Medido con inotifywait: abrir y
  -- cerrar Dolphin NO toca el fichero, así que una comprobación por sesión basta
  -- y no hace falta ningún watcher permanente. Lo mismo hace bin/link.sh en cada
  -- pasada, llamando a este mismo script.
  hl.exec_cmd("~/.config/hypr/scripts/reparar-kdeglobals.sh")

  -- El fondo va DELANTE del shell, y es una decisión de gusto, no de coste:
  -- preferimos ver el escritorio vestido y que la barra entre encima, antes que
  -- una barra flotando sobre el vacío. Se probó al revés y se descartó.
  --
  -- Tiene un peaje medido, y conviene saberlo antes de tocar este orden:
  -- `awww-daemon` inicializa su propio contexto GL, y el arranque de AGS está
  -- dominado por exactamente lo mismo — la inicialización del renderer GPU de
  -- GTK4 (GSK) al realizar su primera ventana. Medido en este equipo con caché
  -- caliente y sin competencia: 935 ms desde el exec hasta que la barra existe
  -- como layer surface, de los cuales ~500 ms son ese GSK. El resto del reparto:
  -- ~66 ms de bundle, ~50 ms de gjs + typelibs, ~180 ms de evaluar los 375
  -- módulos y ~90 ms de construir todas las ventanas con sus widgets.
  --
  -- O sea que los dos pelean por el mismo driver justo en el medio segundo que
  -- decide cuándo se ve la barra. Subir la línea de `ags run` por encima de
  -- estas dos es el cambio de una línea que recupera esa contención, a cambio de
  -- ver la barra antes que el fondo.
  --
  -- Lo que NO merece la pena buscar aquí (medido, para no repetir el intento):
  -- el CSS no cuesta nada (los 130 KB de out.css contra un `window{}` mínimo dan
  -- la misma cifra), los ~20 indicadores de la barra son 40 ms ENTRE TODOS, y
  -- quitar los paneles enteros —imports y construcción— solo baja a ~830 ms,
  -- porque ya se construyen después de la barra. La parte cara no es código
  -- nuestro: es el driver.
  hl.exec_cmd("awww-daemon")
  hl.exec_cmd("~/.config/hypr/scripts/wallpaper.sh")

  -- Antes esto era `pkill …; sleep 0.3; ags run`, con el sleep INCONDICIONAL: se
  -- pagaba también al iniciar sesión, que es justo cuando no hay ninguna
  -- instancia que matar. Los tres trozos de abajo son cada uno para un caso, y
  -- los tres están medidos:
  --
  -- `ags quit` es SÍNCRONO — cuando vuelve, el proceso ya no está (comprobado
  -- con pgrep inmediatamente después). Por eso sustituye al `sleep`: no hay nada
  -- que esperar a ojo. Reiniciar el shell pasa de 309 ms a ~75 ms, y en un login
  -- limpio sale por rc=1 en 3 ms.
  --
  -- `timeout 2` NO es paranoia: contra una instancia viva que no atiende su IPC,
  -- `ags quit` se queda colgado PARA SIEMPRE (medido con un SIGSTOP: a los 20 s
  -- seguía esperando). Sin el timeout ese cuelgue se traga el resto de la línea y
  -- la sesión se queda SIN SHELL, en silencio y sin nada que lo delate.
  --
  -- El `pkill` sigue detrás como red, y es la mitad importante: si `ags quit`
  -- falla o se agota, `ags run` NO arranca nada. Al haber ya una instancia se
  -- comporta como cliente, le manda el argv como petición, recibe "unknown
  -- request" y **sale con rc=0** — o sea que el fallo sería mudo y con cara de
  -- éxito. El `&&` mantiene el `sleep` solo cuando el pkill de verdad señaló a
  -- alguien, que es el único caso en que hay que darle tiempo a morir.
  --
  -- Medido en los tres caminos: login 10 ms · reinicio sano 75 ms · instancia
  -- encallada 2,3 s pero RECUPERA (antes: colgada indefinidamente).
  --
  -- La ruta es `~/.config/ags/` (el symlink), no `~/GiGiShell/ags/`: la ruta
  -- canónica XDG es el contrato de este repo, y es la que usan las demás líneas.
  --
  -- `compilar-css.sh` va delante porque out.css es una caché sin versionar: lo
  -- recompila solo si falta o algún .scss es más nuevo (si no, es un `find`).
  hl.exec_cmd([[~/.config/ags/scripts/compilar-css.sh; timeout 2 ags quit 2>/dev/null; pkill -f "ags\.js$" 2>/dev/null && sleep 0.3; ags run ~/.config/ags/]])

  hl.exec_cmd("hypridle")
  -- Le quita a systemd-logind el interruptor de la TAPA mientras esta sesión
  -- viva, para que la acción de cerrarla la decida Ajustes > Energía. Va a t=0 y
  -- sin retardo: hasta que el inhibidor no está puesto, cerrar la tapa suspende
  -- por logind, y los primeros segundos de sesión son un momento tan bueno como
  -- otro para cerrarla. Cuesta un `pgrep` y un `tail` bloqueado en el kernel.
  -- Ver la cabecera del script: el inhibidor muere con Hyprland A PROPÓSITO.
  hl.exec_cmd("~/.config/hypr/scripts/tapa-inhibidor.sh")
  hl.exec_cmd("~/.config/inicializador/init.sh")
  -- OJO A LA RUTA SI ALGÚN DÍA SE ACTUALIZA hyprpolkitagent. Esta es la del
  -- 0.1.3 de los repos (Qt/QML): un directorio con el ejecutable dentro. La
  -- reescritura en hyprtoolkit lo MUEVE a /usr/lib/hyprpolkitagent a secas, que
  -- pasa a ser el propio ejecutable. Medido al probar hyprpolkitagent-git.
  -- Apuntar mal aquí no da ningún error visible: exec_cmd falla en silencio y la
  -- sesión se queda sin agente, o sea sin poder autenticar nada por GUI, y no se
  -- nota hasta que algo pide root ya en mitad de la sesión.
  hl.exec_cmd("/usr/lib/hyprpolkitagent/hyprpolkitagent")
  -- La limpieza es condicional y termina antes de arrancar el watcher, evitando
  -- que este vuelva a guardar el contenido heredado de la sesión anterior.
  hl.exec_cmd("~/.config/hypr/scripts/limpiar-portapapeles.sh al-iniciar; ~/.config/hypr/scripts/clipboard-history.sh start")
  -- Monitor de eventos de seguridad. Sin retardo: sus seguidores del journal
  -- (`journalctl -kf -n 0`) no ven el backlog, así que arrancar tarde = ventana
  -- ciega en OOM/panic/sudo/SSH. Sus partes caras (SMART, unidades, descargas)
  -- se apartan solas dentro del script.
  hl.exec_cmd("~/.config/hypr/scripts/oom-monitor.sh")
  -- (el escáner de apps de inicio vive en gigios/escaner-apps.lua, que escucha
  -- `window.open` nativo desde su propio hl.on("hyprland.start") — misma ventana
  -- de 30 s, sin socket ni nc. Su .sh ya no existe: se borró con la migración.)

  -- ── t=1..3,5 · monitores dirigidos por eventos ────────────────────────────
  -- Bloquean en un socket (udev/D-Bus/nmcli/PipeWire): en reposo no cuestan
  -- nada, pero su arranque compite con el de los propios servicios a los que se
  -- enganchan. Los dispositivos ya presentes al encender NO generan eventos
  -- después del login (los emitió el kernel durante el boot, antes de que estos
  -- existieran), así que el retardo solo se saltaría algo que enchufes en esos
  -- primeros segundos.
  hl.exec_cmd("sleep 1 && ~/.config/hypr/scripts/bt-monitor.sh")
  hl.exec_cmd("sleep 1.5 && ~/.config/hypr/scripts/usb-monitor.sh")
  -- WiFi: además, arrancar tarde estrecha una carrera real — el script busca la
  -- interfaz con `nmcli` nada más nacer, y NetworkManager arranca a la vez que
  -- este autostart. El script ya no depende solo de este margen: si no hay
  -- interfaz distingue "no hay antena" (salida silenciosa) de "hay antena y NM
  -- aún no la publica" (reintenta 30 s antes de avisar). Ver su cabecera.
  -- OJO al depurar: en un equipo SIN wifi (este sobremesa: solo enp4s0 +
  -- tailscale0) no aparece en `ps` y ES lo correcto. Lo mismo con
  -- battery/temp-monitor, que salen solos si su toggle está en `false` en
  -- preferences.json (aquí ambos lo están).
  hl.exec_cmd("sleep 2 && ~/.config/hypr/scripts/wifi-monitor.sh")
  -- Screencast: necesita que PipeWire haya publicado sus nodos para que
  -- `pw-dump` vea algo.
  hl.exec_cmd("sleep 2.5 && ~/.config/hypr/scripts/screencast-monitor.sh")
  -- Cámara en uso (el indicador de privacidad de la barra). Encaja en esta
  -- franja por lo mismo que sus vecinos: se BLOQUEA en inotify sobre los
  -- `/dev/videoN` y en reposo no cuesta nada —ni sondeo, ni timer, ni forks—,
  -- pero al nacer enumera los nodos preguntándole a `udevadm` por cada uno, y
  -- eso sí compite con el arranque. No se puede adelantar a t=0 gratis, además,
  -- porque una webcam USB puede no haber terminado de registrar sus nodos
  -- mientras udev procesa la avalancha del arranque.
  --
  -- Retrasarlo no abre ninguna ventana ciega, que es lo que decidiría lo
  -- contrario: el script no cuenta eventos, siembra su primer estado con un
  -- `fuser` sobre los nodos vivos (ver su cabecera), así que una cámara ya
  -- abierta al entrar la ve igual aunque el OPEN se emitiera antes.
  --
  -- En un equipo SIN cámara —este sobremesa— no aparece en `ps` y ES lo
  -- correcto: escribe el estado "libre" y sale. Mismo caso que wifi-monitor sin
  -- antena; no lo busques como si fuera un fallo.
  --
  -- Los medios segundos no son un capricho: con el calendario comprimido los
  -- huecos son de medio segundo, y la regla sigue siendo que cada arranque
  -- tenga el suyo (darles a todos el mismo sleep solo mueve la avalancha de
  -- sitio). `sleep` de coreutils acepta decimales.
  hl.exec_cmd("sleep 3 && ~/.config/hypr/scripts/camara-monitor.sh")

  -- Apps de inicio del usuario (Ajustes > Apps al inicio). La LISTA es dato en
  -- ~/.config/gigios/apps-inicio.json; aquí solo vive el momento en que se
  -- abre, que es lo que le toca decidir a este calendario. Sin lista, el script
  -- sale en un `test -r`.
  --
  -- A t=3,5 y no antes: son apps de escritorio completas —lo más caro que puede
  -- entrar en esta lista— y compiten por la GPU con el arranque de AGS, que es
  -- el medio segundo que decide cuándo se ve la barra (ver la nota del fondo, a
  -- t=0). Y no mucho más tarde tampoco: quien pone Spotify en el inicio lo
  -- quiere ahí al llegar al escritorio, no medio minuto después. El script
  -- escalona además las apps entre sí.
  --
  -- Cae DENTRO de la ventana de 30 s de gigios/escaner-apps.lua a propósito:
  -- son justo las ventanas que ese escáner existe para encontrar. Ojo si
  -- combinas las dos cosas — con `escanerAppsInicio` activado, el escáner te
  -- lleva al escritorio de estas apps al terminar su ventana, lo que deshace en
  -- la práctica el "sin traerme a él" de una entrada silenciosa.
  hl.exec_cmd("sleep 3.5 && ~/.config/inicializador/apps-inicio.sh")

  -- ── t=4..5,5 · sondeos de estado del PC ───────────────────────────────────
  -- Ninguno es urgente al arrancar: la RAM está libre, la CPU fría y el disco
  -- tan lleno como hace un minuto. Se apartan del pico de carga.
  hl.exec_cmd("sleep 4 && ~/.config/hypr/scripts/ram-monitor.sh")
  hl.exec_cmd("sleep 4.5 && ~/.config/hypr/scripts/temp-monitor.sh")
  hl.exec_cmd("sleep 4.8 && ~/.config/hypr/scripts/battery-monitor.sh")
  -- Disco: comprobación única (`df`) y sale. Quedarse sin espacio es cosa de
  -- una vez al año — puede esperar unos segundos.
  hl.exec_cmd("sleep 5.5 && ~/.config/hypr/scripts/disk-monitor.sh")

  -- ── t=5..8 · lo caro ───────────────────────────────────────────────────────
  -- Monitor de actualizaciones (SO + drivers GPU). Toca RED y sincroniza una BD
  -- temporal de pacman: lo último que quieres compitiendo con el arranque de la
  -- sesión.
  hl.exec_cmd("sleep 5 && ~/.config/hypr/scripts/updates-monitor.sh")
  -- Healthcheck de arranque: es el más caro de todos (lee el journal entero del
  -- boot dos veces, SMART de cada disco, sensores, ping). Es un DIAGNÓSTICO, no
  -- una alarma en vivo — nadie lo necesita en los primeros segundos. Antes
  -- esperaba 5 s por dentro; ese sleep vive aquí para que el calendario se lea
  -- entero en un sitio y para poder ejecutarlo a mano sin esperas. Además le da
  -- tiempo a systemd a terminar el boot: `systemd-analyze` falla si aún no ha
  -- acabado, y con él se perdía el aviso de arranque lento.
  hl.exec_cmd("sleep 8 && ~/.config/hypr/scripts/boot-healthcheck.sh")

  -- Firmas de ClamAV. **Este es el ÚNICO sitio del sistema que actualiza firmas solo**, y
  -- sustituye al periodo de `clamav-freshclam`: en vez de un servicio que despierta cada N
  -- horas corra o no falta, se mira una vez por sesión si la base falta o pasa de 24 h y
  -- solo entonces se descarga. Con arrancar el escritorio a diario, las firmas entran al
  -- día y se quedan al día toda la sesión — durante ella no queda ni un reloj ni un
  -- proceso vigilando. El script sale en ~4 ms cuando no toca (un `jq` y un `stat`) y **no
  -- notifica nada** en modo `--auto`; si el interruptor está apagado, ni eso hace.
  -- Va detrás del healthcheck porque freshclam baja ~200 MB cuando sí toca, y ese es el
  -- peor compañero posible para los primeros segundos de sesión.
  hl.exec_cmd("sleep 10 && ~/.config/hypr/scripts/actualizar-firmas.sh --auto")

  -- ── t=12 · autolimpieza de disco ──────────────────────────────────────────
  -- **No es un daemon.** Lee un JSON, decide, y o limpia o se muere: en el caso
  -- normal (todavía no toca) son 2,9 ms y UN solo proceso `jq`, y no queda nada
  -- en `ps`. Antes era un bucle que despertaba cada hora forkeando hasta quince
  -- veces solo para responder «aún no»; ver la cabecera del script.
  --
  -- Va el ÚLTIMO, detrás incluso del healthcheck, porque es el único de la lista
  -- que puede ponerse a borrar decenas de miles de ficheros: un `paccache` sobre
  -- 2360 paquetes y un `du` del hogar no deben coincidir con nada del arranque.
  -- Cuando no toca limpiar —lo normal, 23 de cada 24 sesiones con el intervalo
  -- por defecto— el retardo no cuesta nada, porque el script tampoco.
  hl.exec_cmd("sleep 12 && ~/.config/hypr/scripts/limpieza-arranque.sh")

  -- (KWallet retirado) Las credenciales de Spotify viven en texto plano en
  -- ~/.config/gigios/spotify-creds.json — no se arranca ningún ksecretd/KWallet.
end)
