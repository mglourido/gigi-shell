# Protección de archivos (`gigishell-guardian`) — diseño

Fecha: 2026-09-27 · Estado: diseño aprobado, pendiente de plan de implementación.

## 1. Objetivo

El usuario marca desde Ajustes ficheros concretos (un PDF del banco, un `.env`, un fichero con un
token) como **protegidos**. Un fichero protegido es **intocable**: ningún proceso puede leerlo,
modificarlo, borrarlo, moverlo ni cambiar sus atributos salvo que el usuario lo permita.

- Cuando un proceso intenta **abrirlo**, el proceso queda en espera y el shell pregunta al usuario
  (Permitir siempre / Permitir a este proceso / Denegar).
- Cuando intenta **borrarlo, moverlo o cambiar atributos**, se deniega en el acto y el shell
  ofrece conceder el permiso para el reintento.
- Metadatos visibles sin restricción: `ls`, `stat`, listar en Dolphin — se ve que existe, su tamaño
  y su fecha, no su contenido.
- Coste en reposo prácticamente nulo; **apagado (el valor por defecto) el coste es cero**: ningún
  gancho en el kernel.

### Modelo de amenaza

Protege contra software (con el mismo UID que el usuario, o root sin conocimiento del shell) que
lee o destruye ficheros por ruta: infostealers genéricos de Linux, scripts maliciosos, ransomware
ingenuo. El sistema de permisos del shell es específico de esta máquina; nadie escribirá malware
contra él, así que en lo que es **del shell** (socket, UI) basta con medidas básicas. Lo que viene
**de fuera** lo decide el kernel.

No protege contra:
- root que sepa lo que hace (puede desenganchar el BPF);
- sustitución de un ejecutable autorizado que viva en `$HOME` (mitigado: si su inodo cambia, se
  vuelve a preguntar);
- un intérprete autorizado ejecutando código malicioso (mitigado: a los intérpretes nunca se les
  concede «siempre»);
- lectura de la memoria de un proceso autorizado (`ptrace_scope=1` ya lo dificulta).

## 2. Mecanismo

Dos piezas en el kernel, un daemon root que las gobierna:

| Pieza | Papel |
|---|---|
| **BPF LSM** (`CONFIG_BPF_LSM=y`, `bpf` en `/sys/kernel/security/lsm`) | El guardia. Decide en todos los puntos de control; es lo único que puede impedir un `unlink`/`rename`/`chmod`, y distingue lectura de escritura en `file_open`. No puede esperar al usuario. |
| **fanotify `FAN_OPEN_PERM`** (`CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y`) | El que pregunta. Solo sobre los inodos protegidos; es lo único que puede dejar un `open()` en espera hasta que el usuario conteste. |

Descartados: fanotify solo (no cubre borrar/mover/atributos ni distingue lectura/escritura);
AppArmor (no cargado en este kernel); Landlock (solo restringe al propio proceso).

### Ganchos BPF

| Gancho | Operación | Permiso requerido |
|---|---|---|
| `file_open` | abrir (y `mmap` derivado) | **leer** si `FMODE_READ`, **modificar** si `FMODE_WRITE` (ambos si los dos) |
| `path_truncate`, `inode_setattr`, `inode_setxattr`, `inode_removexattr` | vaciar, `chmod`, `chown`, metadatos | **modificar** |
| `inode_rename` con el protegido como **destino** | guardado atómico de editores | **modificar** (el inodo origen hereda la protección en la misma operación) |
| `inode_rename` con el protegido como **origen** | mover/renombrar | **borrar-mover** |
| `inode_unlink`, `inode_link` | borrar, enlace duro | **borrar-mover** |

Mapas BPF (anclados en `/sys/fs/bpf/gigishell-guardian/`):
- `protegidos`: `(dev, ino)` del fichero → id de fichero.
- `permisos`: `(id fichero, dev, ino del ejecutable)` → máscara leer/modificar/borrar.
- `procesos`: `(id fichero, pid, hora de arranque)` → máscara (permisos «a este proceso»).
- `categorias`: `(id fichero, dev, ino del ejecutable)` → leer permitido / silencio.
- `pendientes`: tid → modo de apertura pedido y si ya estaba permitido (lo lee el daemon al recibir
  el evento de fanotify).
- `control`: `activo` (el daemon vive) / `apagando` (parada limpia).
- `eventos`: ring buffer de denegaciones y de herencias de inodo.

Identidad del ejecutable en BPF: `(dev, ino)` de `current->mm->exe_file`. Procesos sin `mm` (hilos
del kernel) y el propio daemon quedan exentos. **root no tiene excepción.**

### Falla cerrado

- **Caída del daemon**: los programas BPF siguen enganchados (enlaces anclados) y, sin `control =
  activo`, deniegan todo lo protegido. systemd lo reinicia (`Restart=on-failure`); al volver se
  reengancha a los mapas anclados sin perder estado.
- **Parada limpia** (`systemctl stop/disable`): el daemon desengancha BPF, borra los anclajes y
  cierra fanotify. Coste cero y ficheros accesibles.

## 3. Componentes

```
guardian/                               nuevo, hermano de eventd/ (no se symlinkea)
  Cargo.toml                            libbpf-rs, serde_json, libc
  build.rs                              compila src/bpf/guardian.bpf.c con clang (CO-RE, vmlinux.h)
  categorias.json                       definición de categorías (se instala, ver §5)
  src/bpf/guardian.bpf.c                programas LSM
  src/main.rs                           arranque, carga/reenganche BPF, bucle de eventos (epoll)
  src/politica.rs                       política + historial, carga/guardado
  src/fanotify.rs                       grupo de permisos (FAN_OPEN_PERM) y grupo de notificación
                                        de renombrados (FAN_RENAME + DFID_NAME, sobre carpetas)
  src/proceso.rs                        pid → exe, cmdline, script de intérprete, hora de arranque
  src/ipc.rs                            socket con AGS
  instalar.sh                           build release → /usr/local/bin + unidad + categorías
system/guardian/gigishell-guardian.service
ags/servicios/seguridad/guardian.ts     cliente del socket (estado reactivo, preguntas, órdenes)
ags/modulos/ajustes/proteccion/         sección nueva de Ajustes (registrada en panel/secciones.tsx)
ags/modulos/guardian/                   ventana de pregunta (capa OVERLAY)
```

No va dentro de `eventd` porque `eventd` corre como el usuario; mezclar los dos subiría de
privilegios todo `eventd`.

## 4. Política

### Datos en disco (fuera de `~/.config/gigishell/`, a propósito)

La política vive en **`/var/lib/gigishell-guardian/`**, root, modo `600`. Romper la convención
del repo es deliberado: en `~/.config` cualquier proceso del usuario podría añadirse como
permitido. AGS nunca toca estos ficheros: todo pasa por el socket.

`politica.json`:
```json
{
  "version": 1,
  "categorias_por_defecto": { "miniaturas": "silencio", "busqueda": "preguntar",
                              "indexadores": "silencio", "antivirus": "permitir",
                              "copias": "preguntar" },
  "ficheros": [{
    "ruta": "/home/u/Documentos/banco.pdf",
    "dev": 66306, "ino": 1234567,
    "estado": "activo",
    "anadido": "2026-09-27T12:00:00",
    "categorias": { "miniaturas": "silencio", "busqueda": "preguntar",
                    "indexadores": "silencio", "antivirus": "permitir", "copias": "preguntar" },
    "permisos": [{ "programa": "/usr/bin/dolphin",
                   "leer": true, "modificar": false, "borrar": true,
                   "desde": "2026-09-27T12:05:00" }]
  }]
}
```

`historial.jsonl`: una línea por decisión — fecha, ruta, programa, pid, script (si lo hay),
operación, resultado (`permitido`, `automatico`, `categoria`, `denegado`, `silencioso`,
`tiempo_agotado`, `sin_ags`). Tope de 500 entradas por fichero, recortado al arrancar. Separado
de la política para no reescribirla en cada acceso.

Escrituras atómicas (fichero temporal + `rename`) en ambos.

### Identidad de un programa

- Se guarda por **ruta del ejecutable** (`/proc/PID/exe`); el daemon la traduce a `(dev, ino)` para
  el BPF.
- Si el inodo cambia (actualización): ejecutable root-owned bajo `/usr` y no escribible por el
  usuario → se acepta la ruta y se refresca el inodo en silencio; en otro caso (p. ej. en `$HOME`)
  → se vuelve a preguntar, con el aviso «este programa ha cambiado desde que le diste permiso».
- **Intérpretes** (`python*`, `node`, `bash`, `sh`, `zsh`, `fish`, `perl`, `ruby`, `lua*`, `gjs`,
  `bun`, `deno`, `java`): se muestra el script (de `cmdline`) y **nunca** se ofrece «siempre».

### Categorías (accesos habituales)

Por fichero, cada categoría es **Permitir · Preguntar · Bloquear en silencio**. Una categoría solo
puede conceder **leer**; modificar y borrar-mover siempre son por programa.

| Categoría | Programas | Por defecto |
|---|---|---|
| Miniaturas | `kioworker` (thumbnail), `ffmpegthumbnailer`, `gdk-pixbuf-thumbnailer`, `evince-thumbnailer`, `tumblerd`, `totem-video-thumbnailer` | silencio |
| Búsqueda en contenido | `grep`, `rg`, `ag`, `ugrep`, `fzf` | preguntar |
| Indexadores | `baloo_file_extractor`, `localsearch`, `tracker-miner-fs`, `recoll` | silencio |
| Antivirus | `clamscan`, `clamd`, `clamdscan` | permitir |
| Copias de seguridad | `rsync`, `borg`, `restic`, `rclone`, `kopia` | preguntar |

- La lista de programas vive en `guardian/categorias.json` (repo) y se instala root-owned en
  `/usr/local/share/gigishell-guardian/categorias.json`; ampliar una categoría = editar el repo y
  reinstalar.
- Precedencia: permiso explícito del programa > categoría. «Bloquear en silencio» no muestra
  ventana pero sí anota en el historial (`silencioso`).
- Ajustes avisa en Búsqueda: «Permitir grep deja que cualquier script lea este archivo usando grep».
- Los valores por defecto para ficheros nuevos se editan una vez (`categorias_por_defecto`).

### Arranque del daemon

Por cada fichero de la política:
- **Existe** → refresca `(dev, ino)` (si un editor lo reemplazó con el daemon apagado, manda la
  ruta) y lo marca.
- **No existe y su sistema de ficheros (`dev`) no está montado** → `no-disponible`, conserva
  permisos; se reactiva cuando el disco vuelve (el daemon vigila `/proc/self/mountinfo`).
- **No existe con su disco montado** → se quita de la política y se anota en el historial.

### Seguimiento de la ruta

La marca va en el inodo, así que la protección viaja con el fichero. Para mantener la **ruta** de
la política al día, un segundo grupo fanotify de solo notificación (`FAN_RENAME`,
`FAN_REPORT_DFID_NAME_TARGET`) vigila las carpetas que contienen ficheros protegidos. La herencia
del guardado atómico la hace el BPF (evento `heredado` por el ring buffer); el daemon actualiza
`ino` en la política.

## 5. Flujos

### Abrir

1. BPF `file_open`: si el inodo no está en `protegidos` → 0 (camino normal, una búsqueda hash).
2. Protegido y `control ≠ activo` → `-EACCES`.
3. Calcula el modo pedido. Si `permisos`, `procesos` o `categorias` lo cubren → anota en
   `pendientes[tid] = permitido` y devuelve 0. Si la categoría es silencio (y no hay permiso
   explícito) → `-EACCES` + evento `silencioso`. En otro caso → `pendientes[tid] = modo` y 0.
4. fanotify entrega el evento (con `FAN_REPORT_TID`). El daemon lee `pendientes[tid]`:
   - `permitido` → ALLOW inmediato, historial `automatico`/`categoria`.
   - modo → envía `pregunta` a AGS y espera **hasta 30 s**; sin respuesta → DENY
     (`tiempo_agotado`). Sin AGS conectado → DENY (`sin_ags`) y se acumula para el `resumen`.
5. Peticiones del mismo programa sobre el mismo fichero mientras hay una pregunta abierta se
   agrupan y se resuelven con la misma respuesta.

Orden asumido: el hook LSM corre **antes** que `fsnotify_open_perm` dentro de
`security_file_open`. Es el primer riesgo a verificar (§8).

### Borrar, mover, atributos

BPF deniega (`-EPERM`) si falta el permiso y emite `denegado` por el ring buffer. El daemon lo
reenvía a AGS agrupando repeticiones de `(programa, fichero, operación)` en ventanas de 10 s. Si
el usuario concede, se escribe en `permisos` y el reintento pasa.

### Respuestas

- **Siempre**: añade el permiso concreto pedido (leer / modificar / borrar-mover) al programa para
  ese fichero. No disponible para intérpretes.
- **Permitir a este proceso**: entrada en `procesos` con `(pid, hora de arranque)`; caduca cuando
  el proceso muere (el daemon purga al detectar su salida con `pidfd`).
- **Denegar**: solo esta vez.

## 6. UI

### Ajustes > Protección de archivos (sección nueva)

- **Interruptor «Proteger archivos»**, **apagado por defecto**. Encender: `pkexec systemctl enable
  --now gigishell-guardian`; apagar: `pkexec systemctl disable --now …`. Ambos piden contraseña
  (sin NOPASSWD, a propósito: apagarlo sin contraseña sería la forma más fácil de saltárselo).
  Estado leído sin root con `systemctl is-active/is-enabled` — no hay JSON de estado aparte.
- La fila sale **apagada con el motivo escrito** si no se puede usar: no instalado; kernel sin BPF
  LSM; caído («los archivos están bloqueados hasta que vuelva», botón *Reiniciar*).
- Resumen: «N archivos protegidos · M accesos denegados esta semana».
- **Valores por defecto para archivos nuevos** (las categorías).
- **Proteger archivo…** (`Gtk.FileDialog`, selección múltiple).
- Con el servicio apagado, la lista sale en gris: «Activa la protección para gestionar tus
  archivos».
- Fila por fichero: icono, nombre, carpeta, estado (activo / no disponible), «N programas con
  permiso». Desplegada:
  - **Accesos habituales**: las cinco categorías con su selector de tres estados.
  - **Permisos**: programa (icono y nombre del `.desktop` si lo hay) con casillas *Leer · Modificar
    · Borrar/mover* y ✕. **Dar permiso a un programa…** (buscador sobre `servicios/aplicaciones` o
    ejecutable a mano).
  - **Historial**: últimos 50, filtro *Todos / Denegados*; desde una entrada se concede o se revoca.
  - **Dejar de proteger** (con confirmación).

### Ventana de pregunta

No usa el sistema de notificaciones (No molestar la silenciaría con un proceso colgado 30 s).
Ventana propia en capa **OVERLAY**, arriba al centro, visible también sobre pantalla completa.

```
┌─────────────────────────────────────────────────────┐
│ 🛡  evince quiere LEER                        [27 s] │
│     banco.pdf — ~/Documentos                        │
│     /usr/bin/evince · PID 48211                     │
│                                                     │
│  [Denegar]   [Permitir a este proceso]   [Siempre]  │
└─────────────────────────────────────────────────────┘
```

- Intérprete: línea `script: …` y sin *Siempre*.
- Destructiva (ya denegada): en rojo, «rm intentó BORRAR .env — denegado», botones *Vale* y
  *Permitir siempre a rm*.
- **No toma el foco del teclado**, sin botón por defecto, botones activos tras 0,6 s.
- Máximo 3 visibles; el resto en cola. Cuenta atrás a 0 → deniega.
- Al conectar AGS, si hay `resumen`, una ventana única: «Mientras el shell no estaba, se denegaron
  N accesos» con enlace a la sección.

## 7. Protocolo del socket

- `/run/gigishell-guardian.sock`, creado por root, **propiedad del UID del usuario**, modo `600`
  (el UID se configura en la unidad al instalar).
- Al aceptar, `SO_PEERCRED`: UID del usuario y `/proc/PID/exe` = el `gjs` de AGS; si no, se cierra.
- **Un solo cliente a la vez**; mientras AGS esté conectado, cualquier otra conexión se rechaza.
- JSON por líneas. Reconexión automática en ambos lados.

| AGS → daemon | daemon → AGS |
|---|---|
| `estado` · `lista` · `historial {ruta, limite}` | `pregunta {id, ruta, programa, pid, operacion, script?, interprete, caduca}` |
| `proteger {ruta}` · `desproteger {ruta}` | `denegado {ruta, programa, operacion, veces}` |
| `permiso {ruta, programa, leer, modificar, borrar}` | `cambio` |
| `categoria {ruta?, nombre, valor}` (sin `ruta` = por defecto) | `resumen {denegados: [...]}` |
| `responder {id, decision: siempre\|proceso\|denegar}` | `error {op, motivo}` |

## 8. Riesgos a verificar primero (primeras tareas del plan)

1. **Orden LSM → fanotify** en `security_file_open` en el kernel 7.2 instalado: que `pendientes`
   esté escrito cuando llega el evento de fanotify.
2. **Reenganche tras caída**: enlaces BPF anclados sobreviven al proceso y un daemon nuevo retoma
   mapas y enlaces.
3. **Herencia en guardado atómico** con nvim y VSCode (y `sed -i`): el inodo nuevo queda protegido
   sin ventana de exposición.
4. **Interbloqueos**: ni el daemon ni AGS (ni la cadena que dibuja la ventana) abren nunca un
   fichero protegido; el daemon está exento en el BPF y AGS no los toca.
5. **Rendimiento de `file_open`** en todo el sistema con el BPF cargado (medir una compilación o un
   `find / -type f -exec cat` antes/después).

## 9. Instalación e integración

- `install.sh`: paso nuevo `guardian` — `guardian/instalar.sh` (build release, binario a
  `/usr/local/bin/gigishell-guardian`, categorías a `/usr/local/share/gigishell-guardian/`,
  unidad a `/etc/systemd/system/`). **Instala pero no habilita.**
- `bin/preflight.sh`: avisa si `bpf` no está en `/sys/kernel/security/lsm` o falta
  `CONFIG_FANOTIFY_ACCESS_PERMISSIONS`.
- Documentación: sección nueva en `docs/hyprland-modulos.md` (o doc propio enlazado desde
  `CLAUDE.md`, lista de `system/`) con las trampas medidas durante la implementación.

## 10. Fuera de alcance (v1)

- Proteger carpetas enteras.
- Distinguir lectura/escritura en la ventana de fanotify más allá del modo de apertura.
- Sincronizar la política entre equipos.
