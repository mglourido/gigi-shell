# Repository Guidelines

## Estructura del proyecto y módulos

GiGiShell es un árbol personal de dotfiles para Hyprland/Wayland. Los archivos reales viven aquí y se instalan en ubicaciones XDG mediante enlaces simbólicos. `ags/` contiene el shell AGS v2/Astal en TypeScript/TSX; lee `ags/AGENTS.md` antes de cambiar código del shell. Su código se separa en `modulos/` de interfaz y funcionalidad, `componentes/` compartidos, `estado/`, `servicios/` y `utilidades/`. `hypr/` contiene Hyprland, hyprlock, hypridle, perfiles de GPU y scripts de monitores. `inicializador/` contiene la restauración del estado de arranque. `Wallpapers/` se usa directamente desde los scripts de fondos, y `audio/` (sin symlink también) guarda los sonidos de alarmas y notificaciones — ver `audio/README.md`. `docs/` guarda especificaciones y planes.

## Comandos de compilación, prueba y desarrollo

- `bin/link.sh --check`: verifica que los enlaces XDG apunten a este árbol.
- `bin/link.sh`: crea o repara enlaces simbólicos sin sobrescribir archivos reales.
- `bin/link.sh --force`: hace copia de seguridad de los archivos en conflicto y luego crea los enlaces.
- `ags quit` seguido de `ags run ~/.config/ags/app.ts`: detiene primero cualquier instancia de AGS y después lanza o recarga el shell tras cambios en la interfaz.
- `hyprctl reload`: aplica cambios de configuración de Hyprland sin reiniciar los `exec-once`.
- `hyprctl reload full-reset`: reinicia Hyprland correctamente y vuelve a ejecutar el autostart de `hypr/gigios/autostart.lua`; usarlo cuando haya que actualizar el autostart o reiniciar el compositor.
- `node --test $(rg --files ags -g '*.test.ts')`: ejecuta todas las pruebas TypeScript locales.

## Control de versiones

Antes de terminar un trabajo que añada archivos nuevos, verifica que queden rastreados en el flujo de trabajo del repositorio activo. Este árbol normalmente se gestiona mediante el repositorio bare de dotfiles en `~/.dotfiles`, así que allí hay que preparar los archivos nuevos con el flujo de dotfiles; si alguna vez el árbol fuera un clon normal de git, usa `git add` en las rutas correspondientes. No dejes archivos nuevos sin rastrear cuando deban subirse.
Aplica esto también a los archivos de pruebas cuando formen parte del cambio. No incluyas archivos temporales, cachés de trabajo ni otros artefactos generados que no deban versionarse.

## Estilo de código y convenciones de nombres

Sigue el estilo existente de TypeScript/TSX en `ags/`: widgets funcionales, imports explícitos de `ags/gtk4` y `gi://...`, y módulos locales por funcionalidad. Mantén `ags/estilos/out.css` fuera de ediciones manuales; cambia `ags/estilos/style.scss` en su lugar (su `.map` ya no vive en el repo, se genera en `~/.cache/gigios/`). Los archivos de Hyprland usan nombres descriptivos en minúsculas terminados en `.conf`; los scripts usan nombres en kebab-case y minúsculas terminados en `.sh`.

Usa español de forma consistente en los nombres y la documentación orientados al código en este repositorio: variables, funciones, comentarios y documentación deben mantener el mismo idioma y estilo de nombres, salvo que una API, dependencia o interfaz externa exija otro idioma. Esto mejora la coherencia y la mantenibilidad.

## UX y confirmación

- Antes de hacer cambios, asegúrate de tener claro qué pide el usuario.
- Cualquier decisión que pueda afectar a la experiencia de usuario debe preguntarse al usuario y no asumirse por cuenta propia.
- Si una elección cambia el comportamiento visible, la disposición, el flujo o la interacción, confirma primero la intención en vez de inferirla.

## Planificación y diseño

- Antes de implementar un cambio, piensa el código completo que se va a tocar y sus efectos secundarios. Anticipa incompatibilidades, regresiones y mantenimiento futuro para evitar errores y problemas más adelante.
- No empieces a modificar por impulso: primero revisa el flujo de datos, los puntos de integración y los casos límite que pueda afectar el cambio.
- Como norma general, coloca cada componente en un archivo independiente. Esto reduce lo que hay que leer, facilita que la IA entienda el cambio y evita colisiones cuando varios componentes se tocan a la vez. Solo mantenlo junto si realmente mejora la cohesión del código.

## Calidad de código y límites de recursos

### Reutilización y estructura

- Prefiere actualizaciones guiadas por eventos frente a sondeo, temporizadores o trabajo repetido cuando se pueda obtener el mismo resultado mediante cambios de estado, suscripciones o señales existentes.
- Antes de añadir una función nueva, comprueba si ya existe algo similar. Reutiliza o consolida cuando tenga sentido, pero no fusiones a ciegas si eso hace el camino sensiblemente más pesado en memoria o en tiempo de ejecución.
- Antes de crear un elemento nuevo de interfaz, comprueba si ya existe un componente que lo cubra, o si el mismo elemento sin encapsular aparece en otro sitio y conviene extraerlo a un componente genérico. Prefiere componentes compartidos frente a copias sueltas repetidas para que el mismo patrón de interfaz viva en un solo sitio.
- Al escribir funciones nuevas o modificar las existentes, piensa en la compatibilidad entre distintas máquinas, configuraciones y casos límite antes de dar por cerrado el cambio. El código debe funcionar de forma fiable en todos los entornos donde se espera que se ejecute, no solo en una configuración.

### CSS

- Mantén el CSS en `ags/estilos/style.scss` siempre que sea posible, y procura que el CSS nuevo sea visualmente coherente con el diseño existente salvo que el usuario pida explícitamente otra cosa.
- Al añadir CSS nuevo, primero comprueba si puede compactarse dentro de un bloque existente en vez de crear otro bloque de clase casi idéntico.
- Comprueba también si los estilos pueden agruparse en un elemento padre en lugar de duplicarse en varios hijos cuando eso mejore la mantenibilidad.

### Recursos y mantenimiento

- Trata el uso de memoria, disco y CPU como restricciones de primera clase. La RAM debe mantenerse ligera, hay que evitar leaks, no deben añadirse cachés ni escrituras persistentes sin un beneficio claro, y el trabajo repetido pesado o los bucles costosos deben mantenerse fuera de rutas calientes salvo que no exista una alternativa razonable.
- Prioriza la funcionalidad y el menor consumo de recursos por encima de “código bonito” o micro-optimizaciones que solo mejoran el estilo. Un poco de código extra está bien si no cambia el coste en tiempo de ejecución; no lo están las asignaciones extra, objetos retenidos o decenas de megabytes desperdiciados de RAM.
- Reduce al mínimo el código que pueda bloquear el hilo principal y, por tanto, congelar la interfaz. Mantén cortas las tareas síncronas, evita trabajo pesado en rutas de render o de eventos frecuentes y mueve lo costoso fuera del camino crítico cuando exista una alternativa razonable.
- AGS es parte del escritorio, así que un fallo puede dejarte sin interfaz. Todo error posible debe estar contenido o tratado de forma defensiva para evitar que un problema aislado rompa el shell. Usa `try/catch` cuando haga falta y degrada de forma segura lo que no pueda recuperarse.
- Si aparece un bug recurrente, o uno que pueda reaparecer en futuros cambios, documéntalo para que quede registrado.
- Documenta también decisiones sobre cambios hechos o descartados cuando eso ayude a evitar regresiones o a explicar por qué se eligió una solución concreta.

### Dependencias e instalación

- Evita usar dependencias obsoletas si ya existen alternativas mantenidas y compatibles. Cambiar a una dependencia vigente suele reducir riesgos de mantenimiento, compatibilidad y seguridad.
- Si cambian dependencias, rutas o la estructura de instalación, revisa también `install.sh`, `bin/link.sh` y cualquier otro script o documentación afectada para mantener todo sincronizado.

## Perfiles de máquina

Antes de añadir o cambiar ajustes `laptop`/`desktop` por máquina para cualquier
aplicación, lee `docs/anadir-perfiles-por-equipo.md` y sigue su disposición
compartida y su contrato de selector. Esto también aplica al tocar el
instalador, `bin/preflight.sh`, los archivos generados de perfil activo, las
reglas de ignorado o la documentación de perfiles. Usa las implementaciones
existentes de Kitty y Firefox como casos de referencia; no introduzcas un
mecanismo de perfiles aparte sin documentar por qué el patrón compartido no
puede soportar la aplicación.

## Guías de pruebas

Las pruebas usan el ejecutor nativo de Node y viven junto a los archivos de implementación como `*.test.ts`. Prioriza pruebas para lógica pura sin imports de GTK, especialmente reglas de notificaciones, historial, limpieza, migraciones de ajustes, lógica de visualización y parseo de Spotify. Para cambios de UI, verifica manualmente ejecutando `ags quit` y después `ags run ~/.config/ags/app.ts`.

## Guías de commits y pull requests

Este checkout tiene un `.git` vacío; el historial viene del repositorio bare en `~/.dotfiles`. Los commits recientes son resúmenes cortos en español, normalmente imperativos o descriptivos, como `añadida gestión de cups en los ajustes`. Mantén los commits concisos y acotados. Los pull requests deben describir los cambios visibles para el usuario, listar los comandos ejecutados, anotar la verificación manual en AGS/Hyprland e incluir capturas o grabaciones para los cambios de interfaz.

## Consejos de seguridad y configuración

Los datos de ejecución y los secretos viven fuera del repositorio en `~/.config/gigios/`, incluido `spotify-creds.json`; no copies secretos a este árbol. Trata los perfiles de GPU específicos de máquina y las preferencias del usuario como configuración local salvo que el cambio se quiera compartir de forma intencionada.
- No asumas que todo `config` es temporal. La configuración explícita de AGS que forma parte del código, como `apps_icons`, mapeos internos o recursos estáticos, pertenece al config de GiGiShell. El estado temporal o editable por el usuario desde la UI, como paneles, preferencias cambiables o valores de sesión, va al `~/.config` del usuario/sistema según corresponda.
