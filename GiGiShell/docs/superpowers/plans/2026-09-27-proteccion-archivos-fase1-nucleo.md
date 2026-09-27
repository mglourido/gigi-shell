# Protección de archivos — Fase 1: núcleo en el kernel y verificación de riesgos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tener el guardia BPF LSM + fanotify funcionando sobre UN fichero desde un modo `--depurar`, y comprobar en el kernel real los riesgos del spec (§8) antes de construir nada más.

**Architecture:** Crate Rust `guardian/` hermano de `eventd/`. Programa BPF en C (CO-RE) compilado a un esqueleto con `libbpf-cargo`; el binario lo carga, ancla mapas y enlaces en `/sys/fs/bpf/gigishell-guardian/` y atiende fanotify `FAN_OPEN_PERM`.

**Tech Stack:** Rust 2021, `libbpf-rs`/`libbpf-cargo` 0.25, `libc` 0.2.189, clang 22, `bpftool`.

**Spec:** `docs/superpowers/specs/2026-09-27-proteccion-archivos-design.md`

**Fases siguientes:** Fase 2 (`…-fase2-daemon.md`: política, motor, socket, servicio) y Fase 3 (`…-fase3-ags.md`: servicio AGS, ventana, Ajustes). **No empezar la Fase 2 si esta termina con algún riesgo en FALLO.**

## Global Constraints

- Kernel 7.2 CachyOS: `bpf` en `/sys/kernel/security/lsm`, `CONFIG_BPF_LSM=y`, `CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y`.
- Permisos: `leer` = 1, `modificar` = 2, `borrar` (borrar-mover) = 4. Categoría: permitir = 1, silencio = 2.
- Falla cerrado: daemon caído ⇒ lo protegido se deniega. Parada limpia ⇒ ningún gancho.
- Git: `~/GiGiShell/.git` está vacío. Cada commit es `git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" add <rutas> && … commit -m "<msg>"`, terminando el mensaje con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Los pasos **(root)** los ejecuta el usuario; el agente se los pide con `! sudo …`.

## Decisiones tomadas al planificar (desviaciones del spec)

1. `ExecStopPost=gigishell-guardian --tras-parada` pone `control.activo = 0` en el mapa anclado tras una caída; sin ello el BPF anclado dejaría pasar aperturas a un fanotify muerto (fallaría abierto).
2. Seguimiento de ruta con un fd `O_PATH` por fichero (no dispara `file_open` ni fanotify): `readlink /proc/self/fd/N` da la ruta tras mover y `st_nlink == 0` indica borrado. Sustituye al segundo grupo fanotify del spec.
3. «Permitir a este proceso» se indexa por TGID y se revoca con `pidfd` al morir el proceso.
4. Fechas en epoch (segundos). Cada fichero lleva `id: u32` (clave de los mapas BPF).
5. `kioworker` fuera de «Miniaturas» (es el mismo binario que copia/mueve en Dolphin).
6. `dev_t`: el kernel usa `(major << 20) | minor`, distinto de la codificación de `stat`; el daemon convierte siempre (`kdev`).

## Datos verificados en esta máquina

- Firmas LSM (BTF): `file_open(file)`, `inode_unlink(dir, dentry)`, `inode_link(old_dentry, dir, new_dentry)`, `inode_rename(old_dir, old_dentry, new_dir, new_dentry)`, `inode_setattr(idmap, dentry, attr)`, `path_truncate(path)`, `file_truncate(file)`, `inode_setxattr(idmap, dentry, name, value, size, flags)`, `inode_removexattr(idmap, dentry, name)`. En un programa LSM el último argumento es el retorno del LSM previo.
- `libc` 0.2.189 exporta `fanotify_init`, `fanotify_mark`, `fanotify_event_metadata`, `FAN_REPORT_TID`.

## Estructura de ficheros de esta fase

```
guardian/Cargo.toml, guardian/build.rs, guardian/.gitignore
guardian/src/main.rs          despacho: --depurar, --tras-parada
guardian/src/tipos.rs         constantes y structs #[repr(C)] espejo del C, kdev(), (de)serialización a bytes
guardian/src/bpf/guardian.bpf.c
guardian/src/bpf.rs           carga, anclaje, relevo y acceso a mapas
guardian/src/fanotify.rs      grupo FAN_OPEN_PERM + utilidades O_PATH
guardian/src/proceso.rs       /proc: exe, cmdline, tgid (lo mínimo para --depurar; la Fase 2 lo amplía)
guardian/src/depurar.rs
guardian/pruebas/riesgos.sh
```

---

### Task 1: Crate, compilación BPF y tipos

**Files:** Create `guardian/Cargo.toml`, `guardian/build.rs`, `guardian/.gitignore`, `guardian/src/main.rs`, `guardian/src/tipos.rs`, `guardian/src/bpf/guardian.bpf.c` (esqueleto con un `lsm/file_open` que devuelve `ret`).

**Interfaces (produce):** constantes `LEER, MODIFICAR, BORRAR, CAT_PERMITIR, CAT_SILENCIO, EV_DENEGADO=1, EV_SILENCIO=2, EV_HEREDADO=3, EV_MOVIDO=4, EV_BORRADO=5`; structs `ClaveInodo{dev,ino: u64}` (16 B), `ValorProtegido{fichero,marcado: u32}` (8), `ClavePermiso{fichero,_pad: u32, dev,ino: u64}` (24), `ClaveProceso{fichero,tgid: u32}` (8), `Pendiente{fichero: u32, pedido,permitido: u8, _pad:[u8;2]}` (8), `Control{activo,pid_daemon: u32}` (8), `Evento{tipo,fichero,tgid,op: u32, dev,ino: u64}` (32); `kdev(u64)->u64`, `como_bytes`, `desde_bytes`.

- [ ] **Step 1:** `Cargo.toml` con dependencias `libbpf-rs = "0.25"`, `libc = "0.2"`, `serde` (derive), `serde_json`; build-dep `libbpf-cargo = "0.25"`; dev-dep `tempfile = "3"`; perfil release igual que `eventd/Cargo.toml` pero `panic = "abort"` justificado (un pánico ⇒ reinicio, y mientras tanto el BPF deniega).
- [ ] **Step 2:** `build.rs`: si falta `$OUT_DIR/vmlinux.h`, generarlo con `bpftool btf dump file /sys/kernel/btf/vmlinux format c`; `SkeletonBuilder::new().source("src/bpf/guardian.bpf.c").clang_args(["-I$OUT_DIR"]).build_and_generate("$OUT_DIR/guardian.skel.rs")`; `rerun-if-changed` del `.c`.
- [ ] **Step 3: tests primero** en `tipos.rs`: (a) `size_of` de cada struct igual a los tamaños de arriba; (b) `kdev(libc::makedev(259,3)) == (259<<20)|3` y otro caso con menor > 255; (c) ida y vuelta `como_bytes`/`desde_bytes` de un `Evento`, y `desde_bytes` con slice corto ⇒ `None`.
- [ ] **Step 4:** `cargo test` ⇒ FAIL de compilación (tipos ausentes). Si falla la compilación **del BPF**, es el toolchain: resolver antes de seguir.
- [ ] **Step 5:** implementar `tipos.rs` (structs `#[repr(C)]` con `Clone, Copy, Debug, Default, PartialEq`; `ClaveInodo` además `Eq, Hash`). Comentario de cabecera: espejo byte a byte del C.
- [ ] **Step 6:** `cargo test` ⇒ PASS.
- [ ] **Step 7:** commit `guardian: crate, compilación BPF y tipos`.

### Task 2: Programas BPF

**Files:** Modify `guardian/src/bpf/guardian.bpf.c`.

**Mapas:** `protegidos` HASH `clave_inodo→valor_protegido` (4096); `permisos` HASH `clave_permiso→u8` (65536); `procesos` HASH `clave_proceso→u8` (4096); `categorias` HASH `clave_permiso→u8` (65536); `pendientes` LRU_HASH `u32 tid→pendiente` (8192); `control` ARRAY[1]; `eventos` RINGBUF 256 KiB.

**Lógica común:**
- `identidad()`: proceso actual → `(dev, ino)` de `mm->exe_file->f_inode` y `tgid`. Exento (devuelve 0) si no tiene `mm` o si `tgid == control.pid_daemon`.
- `protegido(inode)`: rellena la clave (`i_sb->s_dev`, `i_ino`) y busca en `protegidos`.
- `derechos(fichero, id)` = OR de `permisos[fichero,exe]` y `procesos[fichero,tgid]`.
- `exigir(inode, op)` para operaciones que no pueden esperar: no protegido o exento ⇒ 0; `!control.activo` ⇒ `-EPERM`; con el derecho ⇒ 0; si no ⇒ evento `EV_DENEGADO` y `-EPERM`.

**Programas:**
- `file_open`: si protegido y no exento: `!activo` ⇒ `-EACCES`. Pedido desde `f_mode` (`FMODE_READ`⇒leer, `FMODE_WRITE`⇒modificar; 0 ⇒ permitir). Con derechos completos ⇒ `pendiente.permitido = 1`. Si no: categoría permitir y pedido solo-leer ⇒ `permitido = 2`; categoría silencio y solo-leer ⇒ `EV_SILENCIO` + `-EACCES`. Si sigue sin permiso y `marcado == 0` ⇒ `EV_DENEGADO` + `-EACCES`. Escribe `pendientes[tid]` y devuelve 0 (fanotify decide).
- `inode_unlink`: `exigir(borrar)`; si pasa y era protegido ⇒ `EV_BORRADO`.
- `inode_link`: `exigir(borrar)` sobre el origen.
- `inode_rename`: `exigir(borrar)` sobre el origen y `exigir(modificar)` sobre el destino. Origen protegido ⇒ `EV_MOVIDO`. Destino protegido y origen no ⇒ añadir el inodo origen a `protegidos` con el mismo `fichero` y `marcado = 0`, y `EV_HEREDADO` con su `(dev, ino)`.
- `inode_setattr`, `path_truncate`, `file_truncate`, `inode_setxattr`, `inode_removexattr`: `exigir(modificar)`.
- Todos: si `ret != 0` devolverlo sin más.

- [ ] **Step 1:** escribir el programa según lo anterior (comentario de cabecera explicando por qué el BPF no puede esperar y delega en fanotify).
- [ ] **Step 2:** `cargo build` ⇒ compila. Si falta un tipo en `vmlinux.h` (p. ej. `struct mnt_idmap`), comprobarlo con `grep` en el `vmlinux.h` generado.
- [ ] **Step 3:** `cargo test` ⇒ PASS.
- [ ] **Step 4:** commit `guardian: programas BPF LSM`.

### Task 3: Cargador BPF y fanotify

**Files:** Create `guardian/src/bpf.rs`, `guardian/src/fanotify.rs`, `guardian/src/proceso.rs` (mínimo).

**Interfaces (produce):**
- `bpf.rs`: `RAIZ = "/sys/fs/bpf/gigishell-guardian"`; `Bpf::cargar()`; `control(activo)` (escribe también `pid_daemon = getpid()`); `proteger(clave, fichero, marcado)`; `desproteger(clave)`; `permiso(fichero, exe, mascara)` (0 ⇒ borrar); `permiso_proceso(fichero, tgid, mascara)` (OR con lo previo; 0 ⇒ borrar); `categoria(fichero, exe, modo)` (0 ⇒ borrar); `limpiar_fichero(fichero)`; `retener(&HashSet<ClaveInodo>)`; `pendiente(tid) -> Option<Pendiente>` (lookup-and-delete); `anillo(cola) -> RingBuffer`; `parar_limpio(self)`; libre `tras_parada()`.
- `fanotify.rs`: `Fanotify::nuevo()` (`FAN_CLASS_CONTENT|FAN_CLOEXEC|FAN_NONBLOCK|FAN_REPORT_TID`), `fd()`, `marcar(opath)`, `desmarcar(opath)` (ambos por `/proc/self/fd/N` con `FAN_OPEN_PERM`), `leer() -> Vec<EventoApertura{fd: OwnedFd, tid}>`, `responder(fd, permitir)`; utilidades `abrir_opath(ruta)` (`O_PATH|O_CLOEXEC|O_NOFOLLOW`), `clave_de_fd(fd) -> (ClaveInodo, nlink)`, `clave_de_ruta(ruta)`, `ruta_de_fd(fd)`.
- `proceso.rs` (mínimo): `InfoProceso{tgid, exe, cmdline}`, `leer(tgid)`, `tgid_de(tid)`.

**Comportamiento obligatorio de `Bpf::cargar`:**
1. Cada mapa con `set_pin_path(RAIZ/<nombre>)` antes de `load()` (reutiliza los anclados tras una caída).
2. Listar enlaces viejos en `RAIZ/enlaces/`, enganchar los nueve programas con `attach_lsm()` y anclar cada enlace como `RAIZ/enlaces/<prog>.<pid>`, y **solo después** borrar los anclajes viejos. Así nunca hay un instante sin guardia.
3. `parar_limpio`: borrar anclajes de enlaces, soltar enlaces y `remove_dir_all(RAIZ)`.
4. `tras_parada`: si existe `RAIZ/control`, abrirlo con `MapHandle::from_pinned_path` y escribir `activo = 0`.

- [ ] **Step 1: tests primero** en `proceso.rs`: `leer(getpid())` devuelve un exe no vacío y `tgid_de(getpid()) == getpid()`.
- [ ] **Step 2:** `cargo test` ⇒ FAIL.
- [ ] **Step 3:** implementar los tres módulos. Si algún nombre de la API de libbpf-rs 0.25 difiere, consultar `cargo doc -p libbpf-rs` y adaptar sin cambiar las interfaces de arriba.
- [ ] **Step 4:** `cargo build && cargo test` ⇒ PASS.
- [ ] **Step 5:** commit `guardian: cargador BPF anclado y fanotify`.

### Task 4: Modo `--depurar` y verificación de riesgos — PUNTO DE CONTROL

**Files:** Create `guardian/src/depurar.rs`, `guardian/pruebas/riesgos.sh`; Modify `guardian/src/main.rs`.

**`--depurar <fichero> [--auto permitir|denegar] [--conceder <exe>:<mascara>]…`:**
- Carga BPF, crea fanotify, abre `O_PATH` del fichero, lo marca, lo mete en `protegidos` con `fichero = 1, marcado = 1`, aplica las concesiones, `control(true)`.
- Imprime líneas parseables: `LISTO …`, `APERTURA tid= exe= pendiente=Some((pedido, permitido))|None`, `RESPUESTA permitir|denegar`, `EVENTO tipo= op= tgid= dev= ino=`, `HEREDADO_MARCADO …`, `PARADO`.
- Con `pendiente.permitido != 0` responde permitir; si no, usa `--auto` o pregunta por terminal.
- Ante `EV_HEREDADO`: esperar 100 ms, abrir `O_PATH` de la ruta, marcarla y `proteger(clave_nueva, 1, true)` (lo que hará el daemon).
- SIGINT/SIGTERM por `signalfd` ⇒ `parar_limpio()`.
- `main.rs`: `--depurar`, `--tras-parada`; sin argumentos ⇒ error «modo daemon: Fase 2».

**`pruebas/riesgos.sh`** (se ejecuta con `sudo` desde `guardian/`; trabaja en un `mktemp -d` del usuario llamante, usa `sudo -u "$SUDO_USER"` para actuar como él). Casos y criterio:

| Caso | Acción como usuario | Pasa si |
|---|---|---|
| Lectura denegada | `cat` con `--auto denegar` | falla |
| **R1** orden LSM→fanotify | la misma | el log tiene `pendiente=Some((1, 0))` |
| **R1** escritura | `echo x >>` | `pendiente=Some((2, 0))` |
| Borrar / mover / chmod / truncate / ln | `rm`, `mv`, `chmod`, `truncate -s0`, `ln` | fallan y hay `EVENTO tipo=1 op=4` |
| `ls -l` | — | funciona |
| **R2** caída | `kill -9` al depurador, luego `--tras-parada`, luego `cat` | `cat` falla (falla cerrado) |
| **R2** reenganche | arrancar otra vez | sale `LISTO` |
| **R2** parada limpia | SIGTERM | `cat` funciona y no existe `/sys/fs/bpf/gigishell-guardian` |
| **R3** guardado atómico | `--conceder <python3 real>:3`; `python3` escribe `.tmp` y hace `os.replace` | inodo cambia, `EVENTO tipo=3`, `HEREDADO_MARCADO`, y un `cat` posterior falla |
| **R5** coste | `find /usr/share -name '*.desktop' -exec cat {} +` sin y con guardia | solo informativo (`INFO`) |

El script imprime `OK`/`FALLO` por caso y termina con `---- fallos: N` (código de salida N).

- [ ] **Step 1:** implementar `depurar.rs` y actualizar `main.rs`.
- [ ] **Step 2:** escribir `pruebas/riesgos.sh` según la tabla.
- [ ] **Step 3:** `cargo build --release` ⇒ compila.
- [ ] **Step 4 (root):** pedir `! sudo bash ~/GiGiShell/guardian/pruebas/riesgos.sh`. Esperado: `---- fallos: 0`.
- [ ] **Step 5: decidir.**
  - Todo OK ⇒ la Fase 2 puede empezar.
  - Falla R1 ⇒ el sistema sigue siendo seguro, pero la ventana dirá «abrir» en vez de leer/modificar. **Parar y consultar al usuario.**
  - Falla R2 o R3 ⇒ fallo de seguridad del diseño. **Parar y consultar.**
  - Anotar los resultados (incluido R5) en una sección «Resultados» al final de este documento.
- [ ] **Step 6:** commit `guardian: modo --depurar y verificación de riesgos`.

El riesgo 4 (interbloqueos) se cubre por diseño en la Fase 2: el daemon solo abre ficheros protegidos con `O_PATH` y está exento en el BPF por `pid_daemon`.

## Resultados

**2026-09-27, kernel 7.2 CachyOS.** `sudo bash pruebas/riesgos.sh` en la ejecución #3: `---- fallos:
0` — los 15 casos en OK, incluidos los dos que solo se pudieron medir en hardware real:

- Lectura denegada + **R1** (orden LSM → fanotify): `pendiente=Some((1, 0))` en lectura,
  `pendiente=Some((2, 0))` en escritura — la petición queda pendiente ANTES de que nadie
  responda, en los dos sentidos.
- Borrar/mover/chmod/truncate/ln: las cinco deniegan, con `EVENTO tipo=1 op=4` (EV_DENEGADO,
  BORRAR) en el log.
- `ls -l`: funciona sin verse afectado (no abre el contenido).
- **R2**: caída (`kill -9` + `--tras-parada` deja fallo cerrado), reenganche (`LISTO` reutilizando
  el anclaje) y parada limpia (`PARADO` en el log, `cat` vuelve a funcionar,
  `/sys/fs/bpf/gigishell-guardian` desaparece) — las tres, OK.
- **R3** (guardado atómico): `os.replace` de python3 sobre el fichero protegido hereda la
  protección al inodo nuevo (`EVENTO tipo=3`, `HEREDADO_MARCADO`, inodo distinto), y un `cat`
  corriente sin la concesión de python3 sigue denegado sobre ese inodo heredado.
- **btrfs**: un fichero protegido bajo el `$HOME` real del usuario (no bajo el `mktemp -d` de
  tmpfs de los demás casos) se protege igual — `cat` deniega y `pendiente=Some((1, 0))`.
- **R5** (informativo, no cuenta para el resultado): ejecución #3, `find /usr/share -name
  '*.desktop' -exec cat {} +` **sin guardián**: 0,093 s (la mitad "con guardián" no llegó a
  medirse en esa ejecución por el bug de `riesgos.sh` descrito abajo). En la ejecución #2, con las
  dos mitades medidas: **con guardián** 0,093 s frente a **sin guardián** 0,095 s — sin
  diferencia perceptible por tener el LSM enganchado sobre ficheros que no son el protegido.

Dos fallos que solo aparecieron en hardware real (nunca en la revisión de código, y el propio
diseño ya los identificaba como riesgo a verificar) obligaron a corregir código antes de que estos
15 casos pasaran:

1. **bpffs rechaza `.` en nombres de anclaje (EPERM).** Los enlaces de los nueve programas LSM se
   anclaban como `<prog>.<pid>.<sufijo>`; bpffs no admite el punto como parte del nombre del
   fichero anclado y `pin()` fallaba con `EPERM` sin más explicación. Corregido a
   `<prog>_<pid>_<sufijo>`.
2. **btrfs: `stat()`/`fstat().st_dev` no es el `dev` del superbloque.** En un filesystem con
   subvolúmenes (btrfs), `st_dev` es un `dev` ANÓNIMO por subvolumen — no el
   `inode->i_sb->s_dev` que lee `guardian.bpf.c`. Una `ClaveInodo` construida con `st_dev` para un
   fichero (o para el ejecutable de una concesión `--conceder`) bajo un subvolumen NUNCA
   coincidía con lo que ve el BPF; medido con python3.14 en esta máquina: `stat()` daba `0:36`, el
   superbloque real era `0:35`. `R1`/`R2` habían colado porque el directorio de pruebas
   (`mktemp -d` a secas) caía en tmpfs, donde por casualidad `st_dev` sí coincide. Corregido: el
   `dev` de toda `ClaveInodo` sale ahora de `statx(STATX_MNT_ID)` → `stx_mnt_id` → buscar ese id de
   montaje en `/proc/self/mountinfo` (campo 1) → campo 3 (`major:minor`) → `(major << 20) | minor`
   — nunca de `st_dev`. El caso "btrfs" de la tabla de arriba es la prueba añadida para que esto no
   se vuelva a colar sin que ningún caso lo note.

**Regla para la Fase 2: toda `ClaveInodo` sale de `fanotify::clave_de_fd`/`clave_de_ruta`; nunca de
`st_dev`/`metadata().dev()`.**
