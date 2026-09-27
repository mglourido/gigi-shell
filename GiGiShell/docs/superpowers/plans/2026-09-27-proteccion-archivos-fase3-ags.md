# Protección de archivos — Fase 3: AGS (servicio, ventana de pregunta y Ajustes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La parte visible: cliente del socket, ventana OVERLAY que pregunta y sección **Ajustes > Protección de archivos** con interruptor, archivos, categorías, permisos e historial.

**Architecture:** `servicios/seguridad/guardian.ts` expone estado reactivo (gnim `createState`) y órdenes; `modulos/guardian/VentanaGuardian.tsx` pinta preguntas y avisos; `modulos/ajustes/proteccion/` pinta la sección con los componentes compartidos de `modulos/ajustes/componentes/`.

**Tech Stack:** AGS v2 / Astal, TypeScript + JSX GTK4, SCSS. No hay tests automáticos en `ags/` (ver `ags/CLAUDE.md` > Running): se verifica ejecutando el shell.

**Spec:** `docs/superpowers/specs/2026-09-27-proteccion-archivos-design.md` §6–7 · **Requiere:** Fase 2 terminada e instalada (servicio parado).

## Global Constraints

- **Leer `ags/CLAUDE.md` antes de tocar nada** (idiomas de JSX/GTK4, `onCleanup` y no `connect("destroy")`, estilos).
- Protocolo del socket: el de `guardian/src/protocolo.rs` (JSON por líneas; órdenes con `op`, avisos con `ev`).
- Encender, apagar y reiniciar: `pkexec systemctl enable --now | disable --now | restart gigishell-guardian.service`. Nunca sudoers NOPASSWD.
- Estado del servicio: binario ausente ⇒ «no-instalado»; sin `bpf` en `/sys/kernel/security/lsm` ⇒ «sin-bpf»; `systemctl is-active` = active/activating ⇒ «activo», failed ⇒ «caido», resto ⇒ «apagado».
- Un único temporizador de reconexión (3 s), que solo existe con el servicio activo y el socket sin conectar.
- Ventana: capa OVERLAY, **sin foco de teclado**, sin botón por defecto, botones activos tras 0,6 s, máximo 3 tarjetas visibles, cuenta atrás hasta `caduca`.
- Intérpretes: sin botón «Siempre» ni «Permitir siempre»; en «Dar permiso a un programa…», aviso explícito.
- Aviso fijo en la categoría Búsqueda: «Permitir grep deja que cualquier script lea este archivo usando grep».
- Textos en `ags/textos/ajustes/proteccion.json`; rótulo de sección en `ags/textos/ajustes/general.json` (`secciones.proteccionArchivos`).
- Git: como en las fases anteriores.

## Estructura de ficheros de esta fase

```
ags/servicios/seguridad/guardian.ts
ags/modulos/guardian/VentanaGuardian.tsx
ags/modulos/ajustes/proteccion/SeccionProteccion.tsx
ags/modulos/ajustes/proteccion/FicheroProtegido.tsx
ags/textos/ajustes/proteccion.json
ags/estilos/_guardian.scss
Modificar: ags/app.ts, ags/estilos/style.scss (@use 'guardian'),
           ags/modulos/ajustes/panel/secciones.tsx, ags/textos/ajustes/general.json
```

---

### Task 1: Servicio `guardian.ts`

**Interfaces (produce):**
- Tipos: `EstadoServicio`, `ModoCategoria`, `DecisionPregunta = "siempre"|"proceso"|"denegar"`, `Permiso`, `Fichero`, `Pregunta`, `Denegado` (+ `clave` local para descartarlo), `EntradaHistorial`.
- Estado: `estadoServicio`, `conectado`, `ficheros`, `categoriasPorDefecto`, `programasCategoria`, `preguntas`, `denegados`, `resumen`, `denegadosSemana`, `ultimoError`.
- Funciones: `initGuardian`, `refrescarEstado`, `activar`, `desactivar`, `reiniciar`, `responder(id, d)`, `proteger(ruta)`, `desproteger(ruta)`, `fijarPermiso(ruta, prog, l, m, b)`, `conceder(ruta, prog, op)`, `fijarCategoria(ruta|null, nombre, valor)`, `pedirHistorial(ruta, limite, cb)`, `descartarDenegado(clave)`, `descartarResumen()`, `esInterprete(exe)` (espejo de `proceso::es_interprete`).

**Conexión:** `Gio.SocketClient.connect_async` a `Gio.UnixSocketAddress`; lectura con `Gio.DataInputStream.read_line_async` en bucle; escritura con `write_all`. Al conectar ⇒ pedir `estado` y `lista`. Al perder la conexión ⇒ limpiar `preguntas` y `refrescarEstado()`. Aviso `cambio` ⇒ volver a pedir `lista` y `estado`.

Cabecera del fichero: por qué AGS no toca la política (root, `/var/lib`), por qué el encendido pide contraseña y cuál es el único temporizador.

- [ ] **Step 1:** implementar. **Step 2:** `initGuardian()` en `app.ts` junto a los otros `init*`.
- [ ] **Step 3:** arrancar el shell con el servicio **parado** ⇒ ningún error `[guardian]` y ningún intento de conexión.
- [ ] **Step 4 (root):** `! sudo systemctl start gigishell-guardian`; en la consola de AGS (o un `console.log` temporal) se ve `conectado = true`. Parar el servicio ⇒ `conectado = false` y no quedan temporizadores (sin reintentos en el log). Quitar el log temporal.
- [ ] **Step 5:** commit `ags: cliente del daemon de protección de archivos`.

### Task 2: Ventana de pregunta

**Contenido de una tarjeta de pregunta:** 🛡 + nombre del programa + «quiere» + operación en mayúsculas + cuenta atrás; debajo, nombre del archivo — carpeta (con `~`); `exe · PID`; si hay script, línea `script: …`; si `cambiado`, el aviso «Este programa ha cambiado desde que le diste permiso»; botones *Denegar* · *Permitir a este proceso* · *Siempre* (este último oculto para intérpretes).

**Tarjeta de denegado** (roja): «X intentó BORRAR O MOVER archivo — denegado», botones *Vale* (descartar) y *Permitir siempre a X* (oculto para intérpretes; llama a `conceder` y descarta).

**Tarjeta de resumen:** «Mientras el shell no estaba, se denegaron N accesos…», botón *Vale*.

**Ventana:** `name="guardian"`, `layer=OVERLAY`, anclada arriba y centrada, `keymode` NONE, visible si hay alguna tarjeta; solo en el monitor principal (el primero de `app.get_monitors()`). Las listas con `<For each id>` usando `id`/`clave` como identidad para no reconstruir las tarjetas. El contador de la cuenta atrás se crea por tarjeta y se detiene en `onCleanup`.

- [ ] **Step 1:** crear `proteccion.json` con el bloque `ventana` (textos de arriba y el mapa de operaciones: leer ⇒ LEER, modificar ⇒ MODIFICAR, «leer y modificar», borrar ⇒ BORRAR O MOVER, abrir ⇒ ABRIR).
- [ ] **Step 2:** `VentanaGuardian.tsx` + montaje en `app.ts`.
- [ ] **Step 3:** `_guardian.scss` (tarjeta, variante `.denegado` en rojo con la paleta de `_colores.scss`, botones) y `@use 'guardian';` en `style.scss`.
- [ ] **Step 4:** comprobar solo que el shell arranca sin errores. La prueba visual necesita proteger un archivo, y eso solo puede pedirlo AGS (el daemon rechaza cualquier otro cliente del socket), así que se hace en la verificación de extremo a extremo de la Task 3.
- [ ] **Step 5:** commit `ags: ventana de pregunta de protección de archivos`.

### Task 3: Sección Ajustes > Protección de archivos

**Registro:** id `"proteccion"` en `IdSeccion`; entrada en `SECCIONES_POR_ID` con `textos.secciones.proteccionArchivos` e icono `󰌾`; añadida a los `hijos` del grupo `seguridad` (tras `scans`); fábrica `() => <SeccionProteccion />`.

**`SeccionProteccion.tsx`:**
1. Tarjeta **Estado**: `AjusteInterruptor` «Proteger archivos» (activo = `estadoServicio === "activo"`; alternar ⇒ `activar`/`desactivar`), insensible y con el motivo escrito en `no-instalado` («Instálalo con bash ~/GiGiShell/guardian/instalar.sh»), `sin-bpf` («El kernel no tiene BPF LSM») y `caido` («Se ha caído: los archivos están bloqueados hasta que vuelva» + botón *Reiniciar*). Línea de resumen: «N archivos protegidos · M accesos denegados esta semana». `ultimoError`, si lo hay, como `TextoInformativo`.
2. Tarjeta **Valores por defecto para archivos nuevos**: las cinco categorías, cada una con un selector de tres estados (Permitir / Preguntar / Bloquear en silencio) ⇒ `fijarCategoria(null, …)`.
3. Tarjeta **Archivos protegidos**: botón *Proteger archivo…* (`Gtk.FileDialog.open_multiple` ⇒ `proteger` por cada ruta). Lista `<For each={ficheros} id={f => f.id}>` de `FicheroProtegido`. Sin conexión: en gris con «Activa la protección para gestionar tus archivos».
4. `refrescarEstado()` al montar la sección (no hay sondeo).

**`FicheroProtegido.tsx`** (fila desplegable): icono, nombre, carpeta, estado (activo / no disponible) y «N programas con permiso». Al desplegarse:
- **Accesos habituales:** las cinco categorías con su selector ⇒ `fijarCategoria(ruta, …)`, más el aviso fijo en Búsqueda.
- **Permisos:** por programa, nombre (del `.desktop` si `AstalApps` lo encuentra por ejecutable; si no, el nombre del binario) con tres casillas *Leer · Modificar · Borrar/mover* ⇒ `fijarPermiso`, y ✕ ⇒ `fijarPermiso` con todo a falso. *Dar permiso a un programa…*: buscador sobre las apps instaladas (el mismo servicio que usa `servicios/aplicaciones`) o `Gtk.FileDialog` para un ejecutable; si `esInterprete`, confirmar con el aviso de intérpretes.
- **Historial:** `pedirHistorial(ruta, 50)` al desplegar; filtro *Todos / Denegados*; cada entrada con fecha (`GLib.DateTime.new_from_unix_local`), programa, operación y resultado; en una denegada, *Permitir siempre* (salvo intérprete) ⇒ `conceder`; en una permitida por permiso guardado, *Revocar* ⇒ `fijarPermiso` a falso.
- *Dejar de proteger*: confirmación en línea (segundo clic) ⇒ `desproteger`.

- [ ] **Step 1:** textos: `secciones.proteccionArchivos = "Protección de archivos"` en `general.json`; bloque `seccion` en `proteccion.json` con todos los rótulos anteriores (estados, motivos, categorías: Miniaturas, Búsqueda en contenido, Indexadores, Antivirus, Copias de seguridad; modos; historial; resultados legibles para cada `Resultado`).
- [ ] **Step 2:** registrar la sección en `panel/secciones.tsx`.
- [ ] **Step 3:** `SeccionProteccion.tsx`.
- [ ] **Step 4:** `FicheroProtegido.tsx` + estilos en `_guardian.scss`.
- [ ] **Step 5: verificación de extremo a extremo** (el agente guía y el usuario hace clic):
  1. Servicio parado ⇒ la sección muestra el interruptor apagado y la lista en gris.
  2. Encender ⇒ pide contraseña ⇒ activo y conectado.
  3. Proteger `~/prueba-guardian.env` (crearlo antes).
  4. `cat ~/prueba-guardian.env` en una terminal ⇒ aparece la ventana «cat quiere LEER», con los botones inactivos 0,6 s ⇒ *Denegar* ⇒ `cat` falla con «Permiso denegado».
  5. Repetir y no contestar ⇒ a los 30 s se deniega sola y la tarjeta desaparece.
  6. `rm ~/prueba-guardian.env` ⇒ tarjeta roja «rm intentó BORRAR O MOVER» y el archivo sigue ahí.
  7. `python3 -c "open('/home/$USER/prueba-guardian.env').read()"` ⇒ ventana con `script: -c …` y sin *Siempre*.
  8. Abrir el archivo con un editor gráfico ⇒ *Siempre* ⇒ se abre; guardar un cambio ⇒ sigue protegido (un `cat` posterior vuelve a preguntar).
  9. El historial del archivo muestra todo lo anterior; revocar el permiso del editor ⇒ desaparece de Permisos.
  10. Poner Miniaturas en Permitir y comprobar que no pregunta al generar la miniatura (si hay un generador instalado de la lista).
  11. Mover el archivo con Dolphin tras darle *Borrar/mover* ⇒ la ruta de la lista se actualiza.
  12. Cerrar el shell con una pregunta abierta ⇒ el proceso recibe la denegación; al volver a abrirlo aparece el resumen.
  13. Apagar desde Ajustes ⇒ pide contraseña, `cat` funciona sin preguntar y `/sys/fs/bpf/gigishell-guardian` no existe.
- [ ] **Step 6:** commit `ags: sección Protección de archivos`.

### Task 4: Documentación

- [ ] **Step 1:** sección nueva en `docs/hyprland-modulos.md` «Protección de archivos (`guardian/` + `system/guardian/`)»: qué es, por qué BPF LSM + fanotify, caída vs parada, dónde vive la política y por qué no en `~/.config`, el paso de parada tras una caída (`--tras-parada`), por qué `kioworker` no está en Miniaturas, el guardado atómico y la herencia, y los resultados de la verificación de riesgos de la Fase 1.
- [ ] **Step 2:** `CLAUDE.md`: añadir `guardian/` a los directorios de apoyo (una frase + enlace) y mencionar `system/guardian/` en la lista de `system/`.
- [ ] **Step 3:** commit `docs: protección de archivos`.
