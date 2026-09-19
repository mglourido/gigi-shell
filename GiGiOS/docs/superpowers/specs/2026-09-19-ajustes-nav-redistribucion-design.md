# Redistribución de la navegación de Ajustes (AGS)

Fecha: 2026-09-19

## Contexto

La nav de `ajustes/panel/NavegacionAjustes.tsx` es una lista plana de 26 secciones,
sin agrupar. El usuario quiere reorganizarla en un árbol de dos niveles: algunos
destinos siguen siendo hojas planas (como hoy), y otros se agrupan bajo una
cabecera de acordeón que despliega sus hijos. Además, cuatro secciones existentes
(Accesibilidad, Barra, Personalización, Espacios de trabajo) desaparecen como
entradas propias: sus ajustes individuales se reparten entre dos secciones nuevas,
**Diseño** y **Comportamiento**, según si el ajuste cambia el aspecto visual o el
funcionamiento.

Esto NO mueve ni renombra ninguna clave de `preferences.ts` ni ningún fichero de
`~/.config/gigios/`: es una reorganización de presentación (qué componente pinta
qué tarjeta y bajo qué entrada de nav), no de persistencia.

## Árbol de navegación final

Planas (sin hijos):

- Cuenta
- Diseño (nueva)
- Comportamiento (nueva)
- Energía
- Juegos
- Orion
- Portapapeles
- Apps al inicio
- Notificaciones

Acordeón (cabecera + hijos):

- **General** → Idioma y región, Fecha y hora, Ubicación
- **Controles** → Ratón y puntero, Teclado, Touchpad
- **Dispositivos** → Pantallas, Impresoras, Cámara
- **Almacenamiento** → Almacenamiento, Liberar espacio
- **Seguridad** → Vigilancia del sistema, Antivirus
- **Sistema** → Información del sistema, Supervisor, Atajos de teclado

Retiradas como entrada propia (su contenido se reparte en Diseño/Comportamiento):
Accesibilidad, Barra, Personalización, Espacios de trabajo.

## Reparto de ajustes en Diseño / Comportamiento

**Diseño** (apariencia visual):

- Daltonismo: protanopia, deuteranopia, tritanopia (de `accesibilidad/`)
- Apariencia: color de fondo del shell, acento adaptativo
- Elementos de la barra: Spotify, batería, red, indicador de micrófono (+ lista
  de apps con captura), compartir pantalla, bandeja, notificaciones, lagarto
- Espacios en la barra: mostrar selector de workspaces, vista previa, títulos
  de apps al pasar el ratón
- Bandeja del sistema: agrupación por cantidad, apps ocultas/visibles

**Comportamiento** (funcional):

- Barra: ocultación automática, aviso de batería baja (+ vínculo a umbral de
  ahorro, + umbral propio en %)
- Espacios de trabajo: límite de apps por workspace, límite de workspaces
  visibles, segunda ventana al lado
- Al iniciar sesión: silenciar volumen, silenciar micrófono, bluetooth apagado
- Indicadores OSD: volumen, micrófono, brillo
- Ventanas: anclaje al escritorio de lanzamiento, escáner de apps al iniciar
  sesión, Super sordo sin atajo

Ningún ajuste cambia de comportamiento ni de clave persistida: solo cambia qué
componente lo pinta y bajo qué entrada de nav vive.

## Modelo de datos (`panel/secciones.tsx`)

```ts
export type IdSeccion =
  | "account" | "language" | "datetime" | "location"
  | "display" | "diseno" | "comportamiento"
  | "mouse" | "touchpad" | "keyboard" | "printers" | "camera"
  | "energy" | "games" | "orion" | "clipboard"
  | "startup"
  | "storage" | "cleanup"
  | "notifications" | "monitoring" | "scans" | "supervision" | "system"
  | "shortcuts"
// Retirados: "accessibility", "personalization", "bar", "workspaces"

export type IdGrupo =
  | "general" | "controles" | "dispositivos"
  | "almacenamiento" | "seguridad" | "sistema"

export interface GrupoNavegacion {
  id: IdGrupo
  label: string
  icon: string
  hijos: IdSeccion[]
}

export type ItemNavegacion = SeccionNavegacion | GrupoNavegacion

export function esGrupo(item: ItemNavegacion): item is GrupoNavegacion {
  return "hijos" in item
}
```

`SECCIONES_NAVEGACION` (hoy `SeccionNavegacion[]`) pasa a llamarse
`ITEMS_NAVEGACION: ItemNavegacion[]`, mezclando hojas y grupos en el orden final
de aparición. `FABRICAS_SECCION` pierde las 4 fábricas retiradas y gana
`diseno`/`comportamiento`. El resto de ids conserva su fábrica actual sin tocar
— solo cambia su posición dentro de `ITEMS_NAVEGACION` (ahora colgando de un
grupo en vez de sueltos).

`SeccionNavegacion.visible` (el caso de `camera`) no cambia: sigue ocultando
solo esa fila. Ningún grupo depende hoy de que TODOS sus hijos estén ocultos a
la vez, así que no hace falta lógica para ocultar la cabecera de un grupo
entero — se deja fuera a propósito (YAGNI) y se anota aquí por si un futuro
grupo llega a necesitarlo.

## `NavegacionAjustes.tsx`

Itera `ITEMS_NAVEGACION`. Para una hoja, pinta el botón igual que hoy. Para un
grupo:

- Pinta una fila-cabecera (icono + label + chevron) que alterna un
  `createState<boolean>` local al componente, uno por grupo — vive per-monitor
  igual que `seccion`, sin estado compartido entre pantallas.
- Si está abierto, pinta sus `hijos` debajo con el mismo botón de hoja de
  siempre, con una clase CSS extra de indentado.
- Estado inicial: abierto si `seccion.get()` (la sección activa al construir la
  ventana) está entre sus `hijos`; cerrado en cualquier otro caso. Así reabrir
  Ajustes con una sección hija activa no la deja escondida detrás de un
  acordeón cerrado.

## Ficheros

Nuevos, en `ajustes/personalizacion/`:

- `SeccionDiseno.tsx` — combina las tarjetas de Diseño listadas arriba.
- `SeccionComportamiento.tsx` — combina las tarjetas de Comportamiento.

Ambos importan directamente de `../preferences`, `../accesibilidad/OpcionDaltonismo`,
`../barra/CapturasMicrofono`, `../trayApps` y `./SelectorFondoShell`, igual que
hacían los ficheros que se retiran. Los helpers privados de
`SeccionBarraEscritorios.tsx` (`DeslizadorLimite`, `LimiteWorkspace`,
`UmbralAvisoBateria`, `FilaAppBandeja`) se mudan al fichero nuevo que los use.

Retirados:

- `accesibilidad/SeccionAccesibilidad.tsx`
- `barra/SeccionBarraEscritorios.tsx`

Sin cambios de contenido, solo pierden una rama de `vista`:

- `personalizacion/SeccionFuncionesShell.tsx` pierde la rama
  `vista === "personalizacion"` (sus tarjetas se van a Diseño/Comportamiento);
  conserva intactas `orion` y `portapapeles`. `VistaFunciones` pierde
  `"personalizacion"` de su unión de tipos.

Sin cambios: `barra/CapturasMicrofono.tsx`, `barra/appsBandeja.ts`,
`accesibilidad/OpcionDaltonismo.tsx`, `accesibilidad/daltonismo.ts` — se quedan
donde están, solo cambia quién los importa.

## Textos

`textos/ajustes/general.json`: nuevas claves `secciones.diseno`,
`secciones.comportamiento`, y un bloque `grupos.{general,controles,
dispositivos,almacenamiento,seguridad,sistema}` para las cabeceras de
acordeón.

El resto de copy (títulos y descripciones de cada tarjeta) se reutiliza tal
cual desde `personalizacion.json` y `accesibilidad.json` — ningún texto se
duplica ni se traduce de nuevo, solo cambia qué componente lo importa.
`personalizacion.json` pierde la clave `vistasFunciones.personalizacion` (ya
no hay esa vista) y las claves `vistasBarra`/`seccionesNuevas.barraEscritorios`
quedan huérfanas de su título de sección pero sus sub-claves (`comportamiento`,
`elementos`, `espaciosBarra`, `espacios`, `colocacion`) se siguen usando como
títulos de tarjeta dentro de los dos ficheros nuevos.

## Estilos

`estilos/style.scss`, junto a las reglas `.sp-nav-*` existentes:

- Clase para la fila-cabecera de grupo: mismo alto que `.sp-nav-item`, con un
  glifo de chevron que rota al abrir/cerrar.
- Regla de indentado para los hijos de un grupo abierto (padding-left extra
  sobre `.sp-nav-content`).

Recompilar con el paso `sass` documentado en `ags/CLAUDE.md` (editar
`style.scss` no tiene efecto hasta regenerar `out.css`).

## Testing

No hay test runner para JSX/GTK — se verifica en vivo:

1. `ags run ~/.config/ags/app.ts`.
2. Abrir Ajustes: comprobar que las 6 cabeceras de grupo aparecen colapsadas,
   y que Cuenta/Diseño/Comportamiento/... siguen siendo hojas sueltas.
3. Abrir cada grupo, comprobar que sus hijos son los de la tabla de arriba y
   que su contenido no cambió respecto a antes.
4. Entrar en Diseño y Comportamiento, comprobar que las tarjetas listadas
   arriba aparecen y que tocar cada control seguía escribiendo el mismo valor
   de `preferences.ts` que antes (comparar con `~/.config/gigios/preferences.json`
   si hace falta).
5. Cerrar Ajustes con una sección hija activa (p. ej. Teclado) y reabrir:
   comprobar que su grupo (Controles) aparece ya abierto.
6. Comprobar que el scroll y el alto de la nav (`MARCO_NAV`/`aplicarTecho` en
   `NavegacionAjustes.tsx`) siguen funcionando con las filas de cabecera
   añadidas — no debe cortarse ni desbordar en una pantalla normal.
