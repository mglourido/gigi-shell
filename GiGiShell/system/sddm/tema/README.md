# Tema de SDDM de GiGiShell

El saludador que se ve al arrancar. Es la variante **jake_the_dog** de
[sddm-astronaut-theme](https://github.com/Keyitdev/sddm-astronaut-theme) (GPL-3.0-or-later,
Keyitdev), recortada a lo que esa variante usa de verdad: el `Main.qml`, los `Components/`,
los `Assets/`, el fondo (`Backgrounds/jake_the_dog.{png,mp4}`) y **una sola** fuente
(`Fonts/Thunderman.ttf`, la que pide `Font=` en `theme.conf`). Upstream trae diez fondos,
diez `Themes/*.conf` y once fuentes; traerlos todos serían ~60 MB de ficheros que nada abre.

## Cómo se instala

No se symlinkea. Como todo lo de `system/`, lo copia `install.sh` (paso `sddm`) con `sudo`:

- el tema entero → `/usr/share/sddm/themes/gigishell/`
- `Fonts/*.ttf` → `/usr/share/fonts/gigishell/` + `fc-cache`
- `[Theme] Current=gigishell` en `/etc/sddm.conf.d/zz-gigishell.conf`

**Los ficheros del tema NO pueden vivir bajo `$HOME`.** SDDM arranca antes de que exista
ninguna sesión y su greeter corre como el usuario `sddm`: `/home` puede no estar montado
todavía (LUKS, NFS, `/home` en otro disco) y, aunque lo esté, la home del usuario no es
legible por `sddm` en una instalación con `chmod 700` en el home — el greeter cae a su tema
de fábrica sin decir nada. La fuente tampoco: **el tema no usa `FontLoader`**, pide
`Font="Thunderman"` por nombre y quien la resuelve es fontconfig del sistema. Si no está en
`/usr/share/fonts`, Qt sustituye por la fuente por defecto y el saludador se ve distinto sin
ningún error.

## Dependencias que no dan error al faltar

- **`qt6-multimedia-ffmpeg`** — el fondo es un `.mp4` y quien lo reproduce es `QtMultimedia`.
  Sin el backend de ffmpeg el vídeo no arranca y se queda el `BackgroundPlaceholder`
  (`jake_the_dog.png`), que es un fondo perfectamente válido: parece que el tema "no está
  animado", no que falte un paquete.
- **`qt6-svg`** — los iconos de `Assets/` son SVG (usuario, contraseña, apagar, reiniciar…).
  Sin él los botones salen vacíos.
- **`qt6-virtualkeyboard`** — sólo hace falta si se fija `InputMethod=qtvirtualkeyboard`.
  Ese es el filo: **poner esa clave sin el paquete deja el greeter sin arrancar**, o sea
  pantalla negra al encender. Por eso `install.sh` sólo escribe `InputMethod` si encuentra
  el módulo QML instalado, y si no lo deja vacío (para SDDM, "no fijes ningún método").

## Al actualizar desde upstream

`theme.conf` es la copia de `Themes/jake_the_dog.conf` de upstream; si se retoca un color o
el `HeaderText`, es aquí y no río arriba. `metadata.desktop` sí está modificado a mano
(`ConfigFile=theme.conf`, `Theme-Id=gigishell`, y sin `TranslationsDirectory=translations`:
ese directorio no existe ni en upstream).
