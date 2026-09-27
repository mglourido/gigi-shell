# Protección de archivos — Fase 2: política, motor, socket y servicio

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir el núcleo de la Fase 1 en un daemon systemd completo: política persistente, categorías, historial, decisiones con tiempo de espera, socket con AGS, instalador y preflight.

**Architecture:** La lógica de decisión es una máquina de estados pura (`motor.rs`) que recibe hechos y devuelve efectos; `daemon.rs` solo cablea kernel, disco y socket con un bucle `epoll`. Todo lo puro lleva tests unitarios; lo que toca el kernel se prueba a mano como root.

**Tech Stack:** el de la Fase 1 + `serde`/`serde_json`.

**Spec:** `docs/superpowers/specs/2026-09-27-proteccion-archivos-design.md` · **Requiere:** Fase 1 terminada con `fallos: 0` (`…-fase1-nucleo.md`, incluidas sus «Decisiones tomadas al planificar», que siguen vigentes).

## Global Constraints

- Política e historial en `/var/lib/gigishell-guardian/{politica.json,historial.jsonl}`, root, modo 600, escritura atómica (temporal + rename). Nunca en `~/.config/gigishell/`.
- Categorías en `guardian/categorias.json` → instalado en `/usr/local/share/gigishell-guardian/categorias.json`.
- Socket `/run/gigishell-guardian.sock`: propiedad del UID del usuario, modo 600, **un solo cliente**, peer válido = UID del usuario + exe `/usr/bin/gjs-console` + un argumento que termina en `/ags.js`.
- Espera de una pregunta: 30 s ⇒ denegar. Agrupación de denegaciones iguales: 10 s. Historial: 500 entradas por fichero.
- Intérpretes (`python*`, `node`, `nodejs`, `bash`, `sh`, `dash`, `zsh`, `fish`, `perl`, `ruby`, `lua*`, `luajit`, `gjs`, `gjs-console`, `bun`, `deno`, `java`, `php`, quitando dígitos y puntos finales del nombre): nunca «siempre».
- Solo se pueden proteger ficheros regulares (no enlaces simbólicos) cuyo dueño sea el usuario.
- El servicio se instala **sin habilitar**.
- Git y pasos root: como en la Fase 1.
- Toda `ClaveInodo` sale de `fanotify::clave_de_fd`/`clave_de_ruta`; nunca de `st_dev`/
  `metadata().dev()` a mano — medido en la Fase 1: en btrfs (subvolúmenes) `stat()` da el `dev`
  ANÓNIMO del subvolumen, no el `inode->i_sb->s_dev` que ve el BPF; la vía correcta resuelve el
  `dev` por `statx(STATX_MNT_ID)` + `/proc/self/mountinfo`.

## Estructura de ficheros de esta fase

```
guardian/categorias.json
guardian/src/politica.rs     modelo de politica.json
guardian/src/categorias.rs   carga de categorias.json
guardian/src/proceso.rs      (ampliar) intérpretes, script, exe confiable
guardian/src/historial.rs
guardian/src/motor.rs
guardian/src/protocolo.rs
guardian/src/arranque.rs     reconciliación con el disco
guardian/src/ipc.rs
guardian/src/daemon.rs
guardian/instalar.sh
system/guardian/gigishell-guardian.service
Modificar: guardian/src/main.rs, install.sh, bin/preflight.sh
```

---

### Task 1: Política y categorías

**Interfaces (produce):**
- `ModoCategoria { Permitir, Preguntar, Silencio }` (serde lowercase); `Estado { Activo, NoDisponible }` (serde kebab-case).
- `Permiso { programa, leer, modificar, borrar, desde: u64 }` + `mascara() -> u8`.
- `Fichero { id: u32, ruta, dev, ino, estado, anadido: u64, categorias: BTreeMap<String,ModoCategoria>, permisos: Vec<Permiso> }` + `modo_categoria(nombre, defecto)` (propia → defecto → Preguntar).
- `Politica { version, categorias_por_defecto, ficheros }`: `nueva`, `cargar(&Path) -> Result<_, String>`, `guardar(&Path)`, `por_id`, `por_id_mut`, `por_ruta`, `por_clave(dev, ino)`, `proteger(ruta, dev, ino, ahora) -> id` (idempotente por ruta; copia las categorías por defecto), `desproteger(ruta) -> Option<Fichero>`, `conceder(id, programa, mascara, ahora)` (OR), `fijar_permiso(id, programa, l, m, b, ahora)` (exacto; todo falso ⇒ quitar), `permiso_de(id, programa) -> u8`.
- `categorias_fabrica()`: antivirus=permitir, busqueda=preguntar, copias=preguntar, indexadores=silencio, miniaturas=silencio.
- `Categorias::desde_json`, `cargar`, `mapa() -> &BTreeMap<String, Vec<String>>`.

**Regla clave:** `cargar` con fichero ausente ⇒ política vacía; **corrupto ⇒ error** (arrancar vacío dejaría todo desprotegido sin avisar; mejor no arrancar y que el BPF anclado siga denegando).

**Tests (escribir primero):** ids distintos, idempotencia y categorías copiadas; `por_clave`; conceder acumula, fijar sustituye y vacío borra; guardar+cargar ida y vuelta con modo 600 (tempdir); ausente ⇒ nueva, corrupto ⇒ `Err`; `modo_categoria` cae al defecto; `categorias.json` del repo (`include_str!`) tiene exactamente las claves de `categorias_fabrica()` y solo rutas absolutas.

- [ ] **Step 1:** comprobar qué rutas de ejecutables existen aquí (`readlink -f "$(command -v X)"` para ffmpegthumbnailer, gdk-pixbuf-thumbnailer, evince-thumbnailer, tumblerd, totem-video-thumbnailer, grep, rg, ag, ugrep, fzf, baloo_file_extractor, localsearch, tracker-miner-fs-3, recollindex, clamscan, clamd, clamdscan, rsync, borg, restic, rclone, kopia; y `ls /usr/lib/tumbler-1 /usr/lib/localsearch-3`). Escribir `categorias.json` con las rutas de Arch como **candidatas** (el daemon ignora las inexistentes). Sin `kioworker`.
- [ ] **Step 2:** tests ⇒ FAIL; **Step 3:** implementar; **Step 4:** PASS; **Step 5:** commit `guardian: política y categorías`.

### Task 2: Procesos e historial

**Interfaces (produce):**
- `proceso.rs` (añadir): `es_interprete(exe) -> bool`; `script(cmdline) -> Option<String>` (primer argumento que no empieza por `-`; para `-c`/`-e`/`--eval`/`-m` devuelve «opción + siguiente», máx. 160 caracteres); `exe_confiable(&Path) -> bool` (bajo `/usr/`, dueño root y sin escritura de grupo/otros, él y su carpeta).
- `historial.rs`: `Resultado { Permitido, Automatico, Categoria, Denegado, Silencioso, TiempoAgotado, SinAgs, Retirado }` (snake_case); `Entrada { fecha, ruta, programa, pid, script: Option (omitido si None), operacion, resultado }`; `Historial::new(PathBuf)`, `anadir` (append, 600), `leer(ruta, limite)` (reciente primero), `recortar(max)`, `contar_denegados_desde(t)` (cuenta Denegado, TiempoAgotado y SinAgs); `recortar_entradas(Vec, max)` pura.

**Tests:** intérpretes con versión (`python3.14`, `lua5.4`) sí, `evince` no; `script` en los cuatro casos (fichero, `-c`, `-m`, sin argumentos); `exe_confiable("/usr/bin/ls")` sí y un fichero del tempdir no; recorte por fichero conservando lo reciente; en disco: añadir, leer con límite, contar, recortar; `tiempo_agotado` en snake_case y sin clave `script` si es None.

- [ ] **Steps:** tests ⇒ FAIL ⇒ implementar ⇒ PASS ⇒ commit `guardian: procesos e historial`.

### Task 3: Motor de decisiones y protocolo

**Interfaces (produce):**
- `motor.rs`: `Decision { Siempre, Proceso, Denegar }`; `Pregunta { id, ruta, programa, pid, operacion, script?, interprete, cambiado, caduca }`; `Apertura { fd, fichero, ruta, proceso, pendiente: Option<Pendiente>, confiable }`; `Efecto { Responder{fd,permitir}, EnviarPregunta, CerrarPregunta{id}, EnviarDenegado{ruta,programa,operacion,interprete}, Conceder{fichero,programa,mascara}, ConcederProceso{fichero,tgid,mascara}, RefrescarPrograma{fichero,programa}, Historial(Entrada) }`; `nombre_operacion(u8)` (1 leer, 2 modificar, 3 «leer y modificar», 4 borrar, resto «abrir»); `Motor::{new, cliente_conectado, apertura(a, permiso_ruta, ahora), responder(id, d, ahora), vencer(ahora), proximo_vencimiento, denegacion(fichero, ruta, proceso?, op, silencioso, ahora), tomar_resumen}`.
- `protocolo.rs`: `Orden` (tag `op`): estado, lista, historial{ruta,limite}, proteger{ruta}, desproteger{ruta}, permiso{ruta,programa,leer,modificar,borrar}, conceder{ruta,programa,operacion}, categoria{ruta?,nombre,valor}, responder{id,decision}. `Aviso` (tag `ev`): estado{ficheros,denegados_semana}, lista{ficheros,categorias_por_defecto,categorias}, historial{ruta,entradas}, pregunta(…), cerrar{id}, denegado{ruta,programa,operacion,interprete}, cambio, resumen{denegados}, error{op,motivo}. `parsear`, `serializar` (con `\n`), `mascara_de(operacion)`.

**Reglas del motor (cada una con su test):**
1. `pendiente.permitido` 1/2 ⇒ permitir al momento + historial Automatico/Categoria.
2. Sin pendiente ⇒ se pregunta por «abrir» con pedido leer+modificar.
3. `permiso_ruta` cubre lo pedido (el inodo del programa cambió): exe confiable ⇒ permitir + `RefrescarPrograma`; no confiable ⇒ preguntar con `cambiado = true`.
4. Sin cliente ⇒ denegar + historial SinAgs + guardado para `tomar_resumen` (que vacía).
5. Misma (fichero, pid, pedido) con pregunta abierta ⇒ se agrupa (sin efectos nuevos) y la respuesta alcanza a todos los fd.
6. `Siempre` ⇒ `Conceder` con lo pedido; a un intérprete se degrada a `Proceso`; `Proceso` ⇒ `ConcederProceso`.
7. `vencer` a los 30 s ⇒ denegar + `CerrarPregunta` + TiempoAgotado.
8. `cliente_conectado(false)` ⇒ deniega todo lo abierto.
9. `denegacion`: igual (fichero, programa, op, silencioso) dentro de 10 s ⇒ nada; silenciosa ⇒ solo historial; sin cliente ⇒ historial + resumen; si no ⇒ historial + `EnviarDenegado`.

**Tests de protocolo:** parsear `lista`, `responder` con `proceso`, `categoria` sin ruta; orden desconocida ⇒ error; `serializar(Cerrar{id:3}) == "{\"ev\":\"cerrar\",\"id\":3}\n"`; una pregunta serializa con `"ev":"pregunta"` en plano; `mascara_de`.

- [ ] **Steps:** tests ⇒ FAIL ⇒ implementar ⇒ PASS ⇒ commit `guardian: motor y protocolo`.

### Task 4: Reconciliación al arrancar

**Interfaces:** `Situacion { Existe(ClaveInodo), Ausente { disco_montado } }`; `reconciliar(&mut Politica, sondear, ahora) -> Vec<Entrada>` (existe ⇒ refresca dev/ino y pasa a Activo; ausente sin disco ⇒ NoDisponible y conserva; ausente con disco ⇒ se retira y se devuelve entrada Retirado); `devs_montados(mountinfo) -> HashSet<u64>` (campo 3 `major:minor` ⇒ codificación del kernel; sigue leyendo `mountinfo` directamente, sin cambios — ya da devs de superbloque); `sondear_real(f, montados)` (la `ClaveInodo` de `Existe` sale de `fanotify::clave_de_ruta`, NUNCA de `stat()`/`kdev()` a mano — ver la regla de Global Constraints y los Resultados de la Fase 1: en btrfs `stat()` da el `dev` anónimo del subvolumen, no el del superbloque que ve el BPF).

**Tests:** los tres casos en una sola política; un NoDisponible que reaparece vuelve a Activo; parseo de dos líneas reales de `mountinfo`.

- [ ] **Steps:** tests ⇒ FAIL ⇒ implementar ⇒ PASS ⇒ commit `guardian: reconciliación al arrancar`.

### Task 5: Socket

**Interfaces:** `peer_valido(uid_peer, uid, exe, cmdline) -> bool`; `Servidor::{nuevo(ruta, uid) (bind con umask 177 + chown al uid + validación activa), nuevo_sin_validar (tests), fd_escucha, fd_cliente, hay_cliente, aceptar() -> bool, leer() -> Option<Vec<String>> (None = desconectado; líneas partidas se reensamblan; buffer > 1 MiB ⇒ cortar), enviar(&Aviso) -> bool}`.

**Tests:** `peer_valido` acepta el AGS real (`gjs\0-m\0/run/user/1000/ags.js`) y rechaza otro UID, otro exe u otro script; con `nuevo_sin_validar` en un tempdir: el segundo cliente se rechaza, una línea partida en dos escrituras llega entera, cerrar el cliente ⇒ `None` y `hay_cliente() == false`.

- [ ] **Steps:** tests ⇒ FAIL ⇒ implementar ⇒ PASS ⇒ commit `guardian: socket con AGS`.

### Task 6: Daemon

**Files:** Create `guardian/src/daemon.rs`; Modify `guardian/src/main.rs` (sin argumentos ⇒ `daemon::ejecutar(GUARDIAN_UID)`; falta la variable ⇒ error claro).

**Arranque, en este orden:** crear `/var/lib/gigishell-guardian`; cargar política (corrupta ⇒ salir con error); recortar historial; cargar categorías; reconciliar con `mountinfo` y guardar; `Bpf::cargar()` con `control(false)` (lo protegido se deniega mientras se prepara); fanotify; socket; para cada fichero activo: `O_PATH`, marcar, `proteger(marcado=1)`, limpiar y recargar sus permisos y categorías; `retener` las claves válidas; `control(true)`.

**Bucle `epoll`** con fanotify, anillo BPF, socket (escucha y cliente), `/proc/self/mountinfo` (`EPOLLPRI`), `signalfd` (SIGTERM/SIGINT) y los `pidfd` de los permisos «a este proceso». El tiempo de espera es el menor entre el próximo vencimiento del motor y la revisión diferida.

**Manejadores:**
- **fanotify:** `fanotify::clave_de_fd` del fd ⇒ fichero de la política (nunca `fstat`/`st_dev` a mano: en btrfs no da el `dev` del superbloque, ver Global Constraints); tid ⇒ tgid ⇒ `InfoProceso`; `bpf.pendiente(tid)`. Si no hay fichero o el proceso ya no existe ⇒ denegar. Si no ⇒ `motor.apertura(…, politica.permiso_de(id, exe), …)`, guardando el `OwnedFd` hasta responder.
- **anillo:** `DENEGADO`/`SILENCIO` ⇒ `motor.denegacion`. `HEREDADO` ⇒ apuntar la herencia y programar una revisión a 200 ms. `MOVIDO`/`BORRADO` ⇒ programar una revisión. El evento BPF llega **antes** de que la operación termine; por eso se revisa con retraso.
- **revisión:** herencias: si el `O_PATH` de la ruta ya es el inodo nuevo, marcarlo, `proteger(marcado=1)`, quitar la clave vieja y actualizar la política; si no, reintentar hasta 2 s y después registrar el fallo (el inodo sigue con `marcado=0`: falla cerrado). Después, para cada `O_PATH`: `nlink == 0` e inodo igual al de la política ⇒ retirar el fichero (historial Retirado); ruta distinta ⇒ actualizarla. Si hubo cambios ⇒ guardar y `Aviso::Cambio`.
- **montajes:** reconciliar solo los NoDisponible; los que vuelven se activan.
- **socket:** al aceptar ⇒ `cliente_conectado(true)` y enviar `Resumen` si hay; al desconectar ⇒ `cliente_conectado(false)`; cada línea ⇒ `orden()`.
- **órdenes:** `proteger` (fichero regular, del usuario, no repetido; si falla el marcado se deshace); `desproteger` (desmarcar, quitar del BPF, limpiar); `permiso` y `conceder` (este último rechaza intérpretes con `Aviso::Error`); `categoria` (sin ruta ⇒ valores por defecto; con ruta ⇒ reaplicar en BPF); `responder`; `estado` (denegados de los últimos 7 días); `lista`; `historial`. Toda modificación ⇒ guardar + `Aviso::Cambio`.
- **efectos:** `Responder` ⇒ responder a fanotify y soltar el fd; `ConcederProceso` ⇒ `bpf.permiso_proceso` + `pidfd_open` (si falla, el proceso ya murió ⇒ quitar el permiso) + registrar en epoll; pidfd listo ⇒ quitar el permiso; `Conceder`/`RefrescarPrograma` ⇒ política + `bpf.permiso` resolviendo el `(dev, ino)` del exe por su ruta.
- **señal:** `cliente_conectado(false)` (deniega lo pendiente), borrar el socket, `parar_limpio()`. `bpf` va en un `Option<Bpf>` para poder moverlo aquí.

**Regla anti-interbloqueo (comentario de cabecera):** este proceso solo abre ficheros protegidos con `O_PATH`.

- [ ] **Step 1:** implementar. **Step 2:** `cargo build --release && cargo test` ⇒ PASS sin avisos de código muerto.
- [ ] **Step 3 (root), prueba manual:** `! sudo GUARDIAN_UID=$(id -u) ~/GiGiShell/guardian/target/release/gigishell-guardian`; en otra terminal `socat - UNIX-CONNECT:/run/gigishell-guardian.sock` ⇒ el daemon registra «conexión rechazada … socat». Ctrl+C ⇒ termina y `/sys/fs/bpf/gigishell-guardian` desaparece.
- [ ] **Step 4:** commit `guardian: daemon`.

### Task 7: Unidad, instalador y preflight

- [ ] **Step 1:** `system/guardian/gigishell-guardian.service`: `Type=simple`, `Environment=GUARDIAN_UID=__UID__`, `ExecStart=/usr/local/bin/gigishell-guardian`, `ExecStopPost=/usr/local/bin/gigishell-guardian --tras-parada`, `Restart=on-failure`, `RestartSec=1`, `StateDirectory=gigishell-guardian`, `StateDirectoryMode=0700`, `WantedBy=multi-user.target`. Cabecera: no se symlinkea, viene desactivada, y la diferencia entre caída y parada.
- [ ] **Step 2:** `guardian/instalar.sh` (patrón de `eventd/instalar.sh`): comprueba cargo/clang/bpftool y `bpf` en lsm; `cargo test --release` y después build; instala el binario (755), `categorias.json` (644) y la unidad con `__UID__` sustituido; `daemon-reload`; si el servicio **ya estaba activo**, `restart`; **nunca `enable`**. `--quitar` ⇒ `disable --now`, borrar lo instalado y conservar `/var/lib`.
- [ ] **Step 3:** `install.sh`: bloque `GUARDIAN_ESTADO` justo después del de eventd (`sin-bpf` / `sin-herramientas` / `listo` / `fallido`) y su línea en el resumen final («instalada y APAGADA; se enciende en Ajustes > Protección de archivos»).
- [ ] **Step 4:** `bin/preflight.sh`, tras eventd: warn si falta `bpf` en lsm, si no está instalado o si el binario es más viejo que `guardian/src` o `categorias.json`; ok con el estado de `systemctl is-active`.
- [ ] **Step 5:** `bash -n` de los tres scripts.
- [ ] **Step 6 (root):** `! bash ~/GiGiShell/guardian/instalar.sh` ⇒ `systemctl is-enabled` = disabled, `is-active` = inactive; el preflight muestra la línea ok.
- [ ] **Step 7 (root), prueba de extremo a extremo sin AGS:** `! sudo systemctl start gigishell-guardian`; `systemctl status` activo; `! sudo kill -9 $(systemctl show -p MainPID --value gigishell-guardian)` ⇒ se reinicia solo (journal). `! sudo systemctl stop gigishell-guardian` ⇒ desaparece `/sys/fs/bpf/gigishell-guardian`. Dejarlo **parado**.
- [ ] **Step 8:** commit `guardian: unidad systemd, instalador y preflight`.
