# Repository Guidelines

## Estructura del proyecto y módulos

Este es un shell de escritorio AGS v2/Astal para Hyprland/Wayland, escrito en TypeScript y JSX para GTK4. `app.ts` es el punto de entrada y crea las ventanas de nivel superior por monitor. La estructura separa responsabilidades: `modulos/` agrupa funcionalidades completas de interfaz (`barra/`, `notificaciones/`, `orion/`, `calendario/`, `ajustes/`, `ajustes-rapidos/` y `osd/`); `componentes/` contiene controles visuales compartidos; `estado/` contiene la orquestación global; `servicios/` integra Bluetooth, dispositivos, energía, multimedia, pantalla y Spotify; y `utilidades/` conserva helpers sin dominio propio. Mantén la lógica específica dentro de su módulo y mueve algo a una raíz transversal solo cuando tenga consumidores de varias funcionalidades. El estilo vive en `estilos/` (`style.scss`, la paleta compartida `_colores.scss` y el `out.css` generado), no suelto junto a `app.ts`; `out.css` no debe editarse a mano y su `.map` se genera fuera del repo, en `~/.cache/gigishell/`. Los datos JSON en tiempo de ejecución viven **fuera del repositorio** en `~/.config/gigishell/` (se escriben/leen en ejecución; `bin/link.sh` migra cualquier resto del antiguo directorio `config/` dentro del repo). Los stubs generados de tipos GObject viven en `@girs/` para soporte de editor/tipos.

## Comandos de compilación, prueba y desarrollo

- `ags quit` seguido de `ags run ~/.config/ags/app.ts`: detiene primero cualquier instancia de AGS y después lanza o recarga el shell localmente.
- `hyprctl reload full-reset`: reinicia Hyprland y vuelve a ejecutar el autostart de `hypr/gigishell/autostart.lua`; una recarga normal (`hyprctl reload`) no actualiza el autostart.
- Actualmente no hay archivos `*.test.ts` bajo `ags/`, así que no existe una suite TypeScript ejecutable en este checkout. Si se añade una prueba pura, ejecútala con `node --test ruta/al/archivo.test.ts`.

No hay `package.json`, `tsconfig.json` ni un paso de build del proyecto en este repositorio; AGS se encarga del empaquetado, la transpilación y la carga en tiempo de ejecución.

## Control de versiones

Antes de terminar un trabajo que añada archivos nuevos, verifica que queden rastreados en el flujo de trabajo del repositorio activo. Este árbol normalmente se gestiona mediante el repositorio bare de dotfiles en `~/.dotfiles`, así que allí hay que preparar los archivos nuevos con el flujo de dotfiles; si alguna vez el árbol fuera un clon normal de git, usa `git add` en las rutas correspondientes. No dejes archivos nuevos sin rastrear cuando deban subirse.
Aplica esto también a los archivos de pruebas cuando formen parte del cambio. No incluyas archivos temporales, cachés de trabajo ni otros artefactos generados que no deban versionarse.

## Estilo de código y convenciones de nombres

Sigue el estilo existente de TypeScript/TSX: widgets funcionales, imports explícitos desde `ags/gtk4`, `ags/gtk4/app` y módulos `gi://...`, y archivos de funcionalidad colocados junto a su código. Usa `createState` para el estado reactivo y añade el nuevo estado de visibilidad de paneles a `panelStates` más `closeAllPanels()` en `estado/shell.tsx`. Mantén los prefijos de clases CSS específicos de cada funcionalidad coherentes con el código cercano, como `.notif-*`, `.nb-*` y `.ns-*`.

Las dimensiones CSS de GTK son mínimos, no tamaños fijos. Los hijos de un `Gtk.Box` horizontal usan por defecto `valign=FILL`, así que los botones compactos pueden estirarse hasta la altura del elemento más alto y parecer que el `min-height` o el padding no hacen nada. Pon `valign={Gtk.Align.CENTER}` (o el alineamiento equivalente en el eje cruzado) en los controles compactos antes de cambiar sus dimensiones CSS.

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
- Si durante la implementación de un cambio o una feature pruebas enfoques que luego se descartan porque estaban mal, no funcionaban o quedaron reemplazados por la solución final, borra ese código sobrante antes de terminar. No dejes código muerto, ramas sin uso, utilidades abandonadas ni restos de intentos intermedios en el árbol.

### CSS

- Mantén el CSS en `style.scss` siempre que sea posible, y procura que el CSS nuevo sea visualmente coherente con el diseño existente salvo que el usuario pida explícitamente otra cosa.
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

## Guías de pruebas

Cuando añadas pruebas TypeScript, usa el ejecutor nativo de Node y colócalas junto a la implementación como `*.test.ts`. Prefiere probar módulos de lógica pura sin imports de GTK, especialmente reglas de notificación, historial, limpieza y ajustes.

## Guías de commits y pull requests

El historial de git no está disponible desde este checkout, así que no se puede inferir una convención de commits específica del repositorio. Usa mensajes de commit concisos e imperativos, por ejemplo `añadida limpieza de notificaciones`. Los pull requests deben describir el cambio visible para el usuario, listar las pruebas ejecutadas, anotar la verificación manual en AGS para trabajo de interfaz e incluir capturas o grabaciones para cambios visuales.

## Consejos de seguridad y configuración

Trata el JSON de tiempo de ejecución en `~/.config/gigishell/` como datos de usuario y evita cometer secretos locales o rutas específicas de máquina. Mantén los archivos generados y los stubs del editor fuera de ediciones manuales salvo que regenerarlos sea la tarea explícita.
- No asumas que todo `config` es temporal. La configuración explícita de AGS que forma parte del código, como `apps_icons`, mapeos internos o recursos estáticos, pertenece al config de GiGiShell. El estado temporal o editable por el usuario desde la UI, como paneles, preferencias cambiables o valores de sesión, va al `~/.config` del usuario/sistema según corresponda.
