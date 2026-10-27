# CLAUDE.md — SDDM (plantilla y tema)

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../../CLAUDE.md)).

`system/sddm/zz-gigishell.conf.in` es una de las dos piezas de `system/` que **no se copian tal cual**
(la otra es `system/guardian/gigishell-guardian.service`, a la que `guardian/instalar.sh` le pone el
UID del usuario): es una plantilla que `install.sh` (paso `sddm`) materializa en `/etc/sddm.conf.d/zz-gigishell.conf`
sustituyendo lo que es de cada máquina — el usuario del autologin, el `.desktop` de la sesión, el
tema (sólo si existe en el equipo) y el método de entrada. Junto a ella, `system/sddm/tema/` es el
**tema del saludador** (la variante `jake_the_dog` de sddm-astronaut-theme, recortada a lo que esa
variante usa de verdad): el mismo paso lo copia a `/usr/share/sddm/themes/gigishell` y su fuente a
`/usr/share/fonts/gigishell`. **Ver `system/sddm/tema/README.md`** — explica por qué el tema no puede
vivir bajo `$HOME` (el greeter corre como el usuario `sddm`, antes de que `/home` esté montado) y
por qué la fuente va aparte (el tema no usa `FontLoader`: pide `Font="Thunderman"` por nombre y la
resuelve fontconfig; sin instalar, Qt sustituye en silencio y el saludador se ve distinto sin dar
ningún error). Cuatro trampas que ya costaron su tiempo:

- **Activar SDDM es crear un SYMLINK**: `systemctl enable sddm.service` deja
  `/etc/systemd/system/display-manager.service -> /usr/lib/systemd/system/sddm.service` (la unidad
  declara `Alias=display-manager.service`). Sin ese enlace **no hay ningún error**: el equipo
  arranca hasta un TTY con todo el escritorio bien instalado y nada que lo lance. Por eso el paso
  comprueba el enlace después de activar, en vez de fiarse del código de salida, y `preflight.sh` lo
  da como ERROR.
- **`/etc/sddm.conf` gana sobre TODO `/etc/sddm.conf.d/`**, pese al nombre (`man 5 sddm.conf`). Si
  define una clave que también fijamos, manda la suya y editar el drop-in no se nota. El instalador
  compara las claves y avisa; no toca ese fichero, que es de la distribución.
- El prefijo **`zz-`** no es decorativo, y el que había antes (`99-`) **estaba mal**: `conf.d` se
  lee en orden alfabético y gana **el último**, pero los dígitos van *antes* que las letras. Con los
  restos de HyDE de esta máquina (`the_hyde_project.conf`, que fija `[Theme] Current=Candy`), un
  `99-gigios.conf` se leía **primero** y quedaba pisado entero — tema y autologin incluidos — sin un
  solo error: el saludador salía con el aspecto de HyDE y parecía que el paso `sddm` no se hubiera
  ejecutado. El instalador retira el fichero con el nombre viejo, y `preflight.sh` avisa de
  cualquier drop-in que ordene después del nuestro y fije una de nuestras claves.
- **El autologin lo conmuta también Ajustes > Cuenta > Inicio de sesión**, sobre esa misma clave
  (`[Autologin] User=`) de ese mismo fichero — no hay copia del dato en `~/.config/gigishell/`:
  `ags/modulos/ajustes/cuenta/autologin.ts` lee y escribe el drop-in (por `pkexec`) y surte efecto
  en el siguiente arranque. Dos consecuencias: el paso `sddm` **respeta lo que haya** cuando
  `SDDM_AUTOLOGIN` no se pasa (si no, reinstalar desharía la decisión del usuario sin decir nada), y
  la fila sale **apagada con el motivo escrito** cuando cambiarla no serviría de nada — sin drop-in
  nuestro, sin `hyprland.desktop` (sin `Session=` SDDM ignora el autologin y enseña el saludador) o
  con `/etc/sddm.conf` u otro drop-in posterior fijando `User`. Renombrar el usuario desde esa misma
  pantalla **arrastra el autologin** al nombre nuevo, en la misma escalada de privilegios: si no, la
  clave queda apuntando a un usuario que ya no existe y el autologin deja de funcionar sin error.
- **`InputMethod=qtvirtualkeyboard` sin `qt6-virtualkeyboard` no degrada, ROMPE**: el greeter no
  llega a dibujarse y el equipo arranca a una pantalla negra, sin mensaje. Por eso es un campo de la
  plantilla y no una línea fija: el instalador sólo lo escribe si encuentra el módulo QML instalado.
