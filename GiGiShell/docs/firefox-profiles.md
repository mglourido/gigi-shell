# Perfiles de rendimiento de Firefox

Firefox comparte las preferencias de privacidad y de interfaz, pero separa los
límites de procesos, cachés, precarga y actividad en segundo plano según la
máquina:

```text
~/.config/firefox/
├── base.js
├── profiles/
│   ├── laptop.js
│   └── desktop.js
├── active-profile.js -> profiles/desktop.js
└── user.js                         # generado: base + perfil activo

~/.config/mozilla/firefox/<perfil-predeterminado>/user.js
    -> ~/.config/firefox/user.js
```

`base.js` y los dos archivos de `profiles/` están versionados. El selector y el
`user.js` compuesto son locales y están ignorados por Git, por lo que dos
equipos pueden compartir la misma rama sin cambiarse el perfil entre sí.

## Por qué hacía falta el selector

El antiguo `~/.config/firefox/user.js` no se aplicaba. Firefox no busca un
`user.js` genérico en esa carpeta: solo lee el que está dentro del perfil de
usuario activo. El nombre de ese perfil tiene un prefijo aleatorio y no debe
escribirse en el repositorio.

`bin/firefox-profile.sh` localiza primero el perfil predeterminado de la
instalación en `installs.ini`, usa como alternativa el perfil marcado con
`Default=1` en `profiles.ini` y crea un perfil inicial si Firefox todavía no se
ha abierto. En Firefox 147 o posterior busca instalaciones nuevas en
`$XDG_CONFIG_HOME/mozilla/firefox`; también admite la ruta histórica
`~/.mozilla/firefox` para versiones ESR antiguas.

Si ya había un `user.js` real en el perfil, el selector lo conserva como
`user.js.pre-gigios` antes de crear el enlace.

## Elegir el perfil

Durante una instalación, `FIREFOX_PROFILE` acepta `auto`, `laptop` o `desktop`.
`auto` ignora baterías de periféricos y elige `laptop` solo cuando encuentra una
batería del sistema.

```sh
curl -fsSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh \
  | FIREFOX_PROFILE=desktop bash
```

Para cambiarlo después:

```sh
~/GiGiShell/bin/firefox-profile.sh desktop
~/GiGiShell/bin/firefox-profile.sh laptop
~/GiGiShell/bin/firefox-profile.sh auto
~/GiGiShell/bin/firefox-profile.sh status
```

Firefox lee `user.js` al arrancar. Después de cambiar de perfil hay que cerrar
todas las ventanas y procesos de Firefox y volver a abrirlo; recargar una
pestaña no basta.

## Diferencias

| Ajuste | `laptop` | `desktop` |
| --- | ---: | ---: |
| procesos de contenido no aislado | 4 | 6 |
| procesos aislados por origen | 2 | 3 |
| procesos precargados | no | sí |
| caché de memoria | 64 MiB | 128 MiB |
| caché de imágenes | 32 MiB | 64 MiB |
| descargar pestañas con poca memoria | sí | sí; elegible tras 15 min inactiva |
| historial en memoria | 2 visores | 4 visores |
| guardar sesión activa | cada 60 s | cada 30 s |
| precarga de páginas y DNS | no | sí |
| conexiones especulativas | 0 | 10 |
| precargar nueva pestaña | no | sí |
| capturar miniaturas | no | sí |
| desplazamiento suave | no | sí |

El perfil de sobremesa está dimensionado para el i5-12400F y 16 GiB de RAM de
esta máquina. Limita los procesos incluso por debajo de los valores actuales de
Firefox y solo duplica las cachés explícitas del portátil: 192 MiB entre caché
general e imágenes frente a 96 MiB. Esos valores son límites, no memoria
reservada al arrancar. La respuesta adicional procede sobre todo de conservar
la precarga, las conexiones especulativas moderadas y el desplazamiento suave.

## Ajustes comunes y seguridad

- Se eliminan contenido patrocinado, sugerencias remotas y telemetría sin
  desactivar funciones de seguridad.
- Safe Browsing, OCSP, WebRTC, lector, sensores y actualizaciones conservan el
  comportamiento seguro y compatible de Firefox.
- WebRender, Canvas y la decodificación de vídeo se dejan en detección
  automática. No se ignoran listas de bloqueo de drivers ni se fuerza VA-API;
  el perfil GPU de Hyprland ya aporta las variables específicas de NVIDIA.
- Se restauran a 900 y 6 los límites de conexiones que el archivo antiguo
  elevaba a 1200/1800 y 10 sin una ventaja demostrable.
- `hypr/envs/firefox.conf` sigue aportando Wayland y EGL. Es complementario a
  `user.js`, no un sustituto.

No edites el `user.js` generado: el selector lo reemplaza. Las preferencias
personales no gestionadas aquí siguen viviendo en `prefs.js`. Firefox gestiona
y reescribe ese archivo; no debe versionarse ni editarse mientras el navegador
está abierto.

## Verificación

```sh
~/GiGiShell/bin/firefox-profile.sh status
~/GiGiShell/bin/preflight.sh --installed
```

En `about:support`, **Directorio del perfil** debe coincidir con el que muestra
el selector. La sección **Gráficos** permite comprobar WebRender y la sección
**Multimedia** si Firefox habilitó decodificación por hardware para el driver
actual. El preflight valida los dos perfiles, rechaza sintaxis inválida y
confirma que el `user.js` del perfil real apunta al archivo compuesto.
