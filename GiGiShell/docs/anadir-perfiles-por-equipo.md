# Añadir perfiles `laptop` y `desktop` a otra aplicación

Esta guía describe el patrón usado por Kitty y Firefox para añadir en el futuro
otra aplicación cuya configuración deba variar según el equipo. El objetivo es
compartir una sola rama de dotfiles y mantener la elección de cada máquina como
estado local, sin versionar rutas aleatorias, datos de runtime ni secretos.

## 1. Separar lo común de lo dependiente del hardware

Antes de crear archivos, clasifica cada ajuste:

- **Común:** tema, fuente, atajos, privacidad, seguridad y comportamiento que
  debe ser idéntico en todos los equipos.
- **Laptop:** límites de memoria, menos procesos, menos historial, reducción de
  precarga o de actividad en segundo plano.
- **Desktop:** menor latencia, cachés moderadamente mayores, animaciones o
  precarga que aporten respuesta sin desperdiciar recursos.
- **Local:** rutas de dispositivos, nombres de monitores, identificadores de
  perfiles, credenciales y estado generado. Esto no se versiona.

No copies una configuración completa y cambies valores al azar. Primero revisa
qué opciones siguen existiendo en la versión instalada y cuáles son sus valores
predeterminados. Un perfil de sobremesa tampoco debe interpretar «rápido» como
«sin límites»: hay que dimensionarlo según la RAM y CPU reales.

## 2. Elegir cómo consume configuración la aplicación

Hay dos modelos principales.

### Inclusión nativa: patrón Kitty

Si la aplicación admite `include`, conserva una base común y selecciona solo el
fragmento variable:

```text
~/.config/aplicacion/
├── config.conf
├── base.conf
├── profiles/
│   ├── laptop.conf
│   └── desktop.conf
└── active-profile.conf -> profiles/desktop.conf
```

`config.conf` carga la base y después el selector local. Este es el modelo más
sencillo porque la propia aplicación compone la configuración.

### Archivo único: patrón Firefox

Si la aplicación solo lee un archivo completo, el selector debe generarlo de
forma atómica a partir de la base y el perfil:

```text
~/.config/aplicacion/
├── base.conf
├── profiles/
│   ├── laptop.conf
│   └── desktop.conf
├── active-profile.conf -> profiles/desktop.conf
└── config.conf                         # generado: base + perfil
```

Si además la ruta final contiene un identificador aleatorio, como el perfil de
Firefox, el selector debe descubrirla desde los metadatos oficiales de la
aplicación y enlazar allí el archivo generado. Nunca se versiona ese nombre.

## 3. Archivos que deben viajar en Git

Versiona únicamente:

```text
.config/aplicacion/base.conf
.config/aplicacion/profiles/laptop.conf
.config/aplicacion/profiles/desktop.conf
GiGiShell/bin/aplicacion-profile.sh
GiGiShell/docs/aplicacion-profiles.md
```

Añade a `~/.gitignore` el selector y cualquier archivo compuesto:

```gitignore
.config/aplicacion/active-profile.conf
.config/aplicacion/config.conf
```

Si `config.conf` es una fuente real y no un archivo generado, no debe ignorarse.
Los archivos declarativos deben quedar con permiso `0644` y el selector con
`0755`.

## 4. Contrato del selector

Usa `GiGiShell/bin/<aplicacion>-profile.sh` y mantén la misma interfaz:

```sh
<aplicacion>-profile.sh auto
<aplicacion>-profile.sh laptop
<aplicacion>-profile.sh desktop
<aplicacion>-profile.sh status
```

El selector debe:

1. Ejecutarse con `set -euo pipefail`.
2. Validar que existen la base y ambos perfiles antes de modificar nada.
3. Rechazar valores desconocidos y archivos locales que no sean symlinks.
4. Detectar una batería del sistema para `auto`.
5. Ignorar baterías de periféricos cuyo `scope` sea `Device`.
6. Crear primero un archivo o symlink temporal y activarlo con `mv`, evitando
   dejar una configuración a medias.
7. Validar la configuración efectiva con la propia aplicación cuando exista un
   comando de validación fiable.
8. Respaldar una configuración personal previa antes de sustituirla.
9. Indicar si hace falta recargar, reiniciar la aplicación o volver a iniciar
   sesión.
10. Hacer que `status` compruebe tanto el perfil elegido como el destino que la
    aplicación está usando realmente.

Puedes reutilizar la detección de batería de
`GiGiShell/bin/kitty-profile.sh` o `GiGiShell/bin/firefox-profile.sh`. No uses solo la
existencia de `/sys/class/power_supply/*`, porque ratones y mandos también
aparecen allí.

## 5. Integrarlo en `install.sh`

Añade una variable independiente; no reutilices `KITTY_PROFILE` para otras
aplicaciones:

```sh
APP_PROFILE="${APP_PROFILE:-auto}"

case "$APP_PROFILE" in
  auto|laptop|desktop) ;;
  *) die "APP_PROFILE debe ser auto, laptop o desktop" ;;
esac
```

Después del checkout —y después de `bin/link.sh` si la ruta depende de sus
symlinks— ejecuta el selector:

```sh
APP_SELECTOR="$HOME/GiGiShell/bin/app-profile.sh"
[[ -x "$APP_SELECTOR" ]] || die "Falta $APP_SELECTOR"
"$APP_SELECTOR" "$APP_PROFILE" \
  || die "No se pudo activar el perfil de la aplicación"
```

Incluye también el paquete de la aplicación en la lista de dependencias y
menciona la variable en la ayuda, ejemplos y resumen final del instalador.

## 6. Ampliar `bin/preflight.sh`

El preflight debe comprobar como mínimo:

- presencia y permisos del selector;
- sintaxis del script con `bash -n`;
- existencia de la base y los dos perfiles;
- valores representativos de cada perfil, no solo que el archivo exista;
- ausencia de opciones inseguras o específicas de una GPU en la base portable;
- selector local válido;
- archivo efectivo o enlace final correcto;
- comando de la aplicación instalado en `--installed`.

No valides únicamente el perfil activo. Un error en `laptop` debe detectarse
aunque la máquina actual use `desktop`.

## 7. Documentar la aplicación

Crea `GiGiShell/docs/<aplicacion>-profiles.md` con:

- árbol de archivos y explicación de qué se versiona;
- forma exacta en que la aplicación encuentra su configuración;
- comandos para cambiar y consultar el perfil;
- tabla comparativa de valores;
- razón de cada diferencia importante;
- efecto sobre memoria, CPU, batería y latencia;
- instrucciones de recarga o reinicio;
- diagnóstico desde la propia aplicación;
- limitaciones conocidas.

Enlaza la guía desde `GiGiShell/README.md` y, si afecta a una instalación nueva,
desde `GiGiShell/docs/SETUP.md`.

## 8. Pruebas obligatorias

Antes de darlo por terminado:

```sh
bash -n GiGiShell/bin/app-profile.sh GiGiShell/install.sh GiGiShell/bin/preflight.sh
GiGiShell/bin/app-profile.sh laptop
GiGiShell/bin/app-profile.sh status
GiGiShell/bin/app-profile.sh desktop
GiGiShell/bin/app-profile.sh status
GiGiShell/bin/preflight.sh --installed
git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" diff --cached --check
```

Además, haz una prueba con un `HOME` temporal o con archivos extraídos desde el
índice de Git. Debe cubrir:

- instalación sin configuración previa;
- cambio en ambos sentidos;
- selección `auto`;
- respaldo de un archivo previo;
- permisos `0644/0755`;
- rechazo de un perfil inválido;
- funcionamiento usando solo los archivos que realmente están añadidos al
  índice, no archivos sin seguimiento del equipo actual.

## 9. Lista final de revisión

- [ ] La configuración común no contiene valores exclusivos de una máquina.
- [ ] `laptop` y `desktop` administran las mismas opciones variables.
- [ ] Cambiar de perfil revierte todos los valores del perfil anterior.
- [ ] Los selectores y archivos generados están ignorados por Git.
- [ ] No se versionan secretos, cachés, historial ni identificadores aleatorios.
- [ ] El instalador acepta `auto|laptop|desktop` y falla claramente ante otro valor.
- [ ] El preflight valida los dos perfiles y el destino efectivo.
- [ ] La instalación aislada desde el índice funciona.
- [ ] Los archivos necesarios están añadidos al repositorio bare de dotfiles.
- [ ] La documentación explica cómo recargar y diagnosticar la aplicación.

Como referencias completas, consulta [Kitty](kitty-profiles.md) para inclusión
nativa y [Firefox](firefox-profiles.md) para composición y descubrimiento de
una ruta dinámica.
