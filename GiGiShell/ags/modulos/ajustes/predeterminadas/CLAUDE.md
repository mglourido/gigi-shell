# CLAUDE.md — Ajustes > Apps predeterminadas

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../../CLAUDE.md)). Aquí: navegador, PDF, carpetas, terminal….

- `modulos/ajustes/predeterminadas/SeccionAppsPredeterminadas.tsx` + `servicios/aplicaciones/appsPredeterminadas.ts` —
  **Ajustes > Apps predeterminadas**: navegador, correo, carpetas, PDF, imágenes, vídeo, música,
  texto, comprimidos y terminal.
  - **Los tipos de archivo van por `Gio.AppInfo.set_as_default_for_type()`**, que escribe en
    `~/.config/mimeapps.list` — el fichero LOCAL que pisa la base de `/etc/xdg/mimeapps.list` del
    repo (ver "Bases de escritorio" en `bin/link.sh`). Editar `~/GiGiShell/mimeapps.list` sigue
    siendo cambiar la base de todas las instalaciones; esta sección es la elección del usuario en
    esta máquina. Lo leen xdg-open (en Hyprland corre en modo `generic` → `xdg-mime query default`),
    GTK, KDE, Electron y los navegadores, así que las llamadas a `xdg-open` de la shell ya lo siguen.
  - **Una categoría son varios MIME y solo se fija en los que la app declara abrir** (el primero
    de la lista es el representante: de él salen las candidatas y la app actual). Forzarla en un
    tipo que no anuncia dejaría ese formato con una app que falla al abrirlo, sin error.
  - **Los `.desktop` ocultos solo entran como ayudante de una app visible con el mismo nombre**:
    Okular anuncia el PDF únicamente en `okularApplication_pdf.desktop` (`NoDisplay`), pero aceptar
    todos los ocultos colaba «kitty URL Launcher» como gestor de carpetas.
  - **La lista desplegada de cada fila ES el «Abrir con» de Dolphin** (Default + Added − Removed +
    los `.desktop` que declaran el tipo), y se edita: la papelera llama a `remove_supports_type`
    (→ `[Removed Associations]`) y el buscador a `add_supports_type` con cualquier app instalada
    (→ `[Added Associations]`, y la saca de Removed si estaba), ambos sobre **todos** los MIME de la
    categoría. La app por defecto no se puede quitar. Tras cada cambio se lanza `kbuildsycoca6`
    (agrupado a 1,5 s) como seguro para que la caché de KService no enseñe la lista vieja.
  - **«Todos los tipos de archivo»** cubre lo que no está en una categoría: `buscarTiposArchivo()`
    indexa los `globs2` de shared-mime-info (GIO no expone las extensiones de un tipo) la primera
    vez que se busca (~120 ms, medido; luego ~0,1 ms) y cada resultado es la MISMA fila, sobre una
    categoría de un solo MIME (`categoriaDeTipo`). Máximo 15 filas, con `id` por MIME.
  - **VS Code no declara los tipos de código**: `visual-studio-code-bin` instala
    `com.microsoft.VSCode.desktop` con `MimeType=application/x-code-workspace` y nada más, y las
    líneas `code.desktop` de la base apuntan a un lanzador que ya no existe (todo caía en Kate,
    micro o Firefox). Por eso no sale como candidata en Código: se añade desde el buscador de la
    fila (→ Added Associations para todos los MIME) y a partir de ahí ya se puede elegir por defecto.
  - **El terminal no es un tipo MIME**: se guarda en `~/.config/gigishell/apps-predeterminadas.json`
    (lo lee `hypr/scripts/abrir-terminal.sh` en cada SUPER+Q, sin reload), en el `kdeglobals` del
    usuario con `kwriteconfig6` (Dolphin, «Abrir terminal») y en `~/.config/xdg-terminals.list`.
    `actualTerminal()` mira primero la memoria porque el JSON se escribe asíncrono. Ojo al comprobarlo:
    **KConfig no escribe un valor igual al heredado de `/etc/xdg`**, así que elegir kitty (lo que
    trae la base) no crea `~/.config/kdeglobals` — no es un fallo.
  - SUPER+E y la apertura de un USB (`usb-open.sh`) pasan por `gio open`, o sea por la app de
    `inode/directory`; Dolphin queda de reserva. `utilidades/abrirTerminal.ts` **no** sigue el
    terminal elegido a propósito: necesita la bandera de «mantener abierta» de cada terminal.
