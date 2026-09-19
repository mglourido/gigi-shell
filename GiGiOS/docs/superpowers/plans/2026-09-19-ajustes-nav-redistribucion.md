# Redistribución de la navegación de Ajustes — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganizar la nav de `ajustes/panel/NavegacionAjustes.tsx` en un árbol de
dos niveles (hojas planas + grupos en acordeón) y fundir Accesibilidad, Barra,
Personalización y Espacios de trabajo en dos secciones nuevas, Diseño y
Comportamiento, sin tocar ninguna clave de `preferences.ts` ni ningún fichero de
`~/.config/gigios/`.

**Architecture:** Los ajustes existentes no cambian de estado ni de lógica, solo
de presentación: dos ficheros TSX nuevos combinan tarjetas ya existentes bajo
nuevas cabeceras de sección, `panel/secciones.tsx` pasa de una lista plana de
26 hojas a una lista mixta de hojas y grupos, y `NavegacionAjustes.tsx` aprende
a pintar un grupo como cabecera colapsable + hijos indentados.

**Tech Stack:** AGS v2 (Astal) + TypeScript/JSX sobre GTK4, sin build/lint/test
para este código (ver `ags/CLAUDE.md`: "no build/lint/test step... para
verificar, corre el shell y obsérvalo"). Ningún fichero tocado en este plan es
lógica pura, así que no aplica `node --test`: cada tarea se verifica abriendo
Ajustes con `ags run` y comprobando el árbol a mano, tal como indica la sección
de Testing de la spec.

**Spec:** `docs/superpowers/specs/2026-09-19-ajustes-nav-redistribucion-design.md`

## Global Constraints

- El `.git` de `~/GiGiOS` está vacío. El repo real es un bare repo en
  `~/.dotfiles`, con work-tree `$HOME`. Todo comando git de este plan usa:
  `git --git-dir=$HOME/.dotfiles --work-tree=$HOME <comando>`.
  - Para `add`/`rm`, usa SIEMPRE **rutas absolutas** (`$HOME/GiGiOS/ags/...`).
    Con el cwd en `~/GiGiOS`, una ruta relativa a `add`/`status` se resuelve
    contra el work-tree (`$HOME`) y no contra el cwd, así que
    `GiGiOS/ags/foo` se convierte en `GiGiOS/GiGiOS/ags/foo` — la ruta
    absoluta evita esa duplicación.
  - Para `status`/`log` con pathspec, usa el prefijo mágico `:/` (ej.
    `-- ":/GiGiOS/ags"`) para anclarlo a la raíz del work-tree en vez de al
    cwd. Sin el `:/`, el mismo problema de duplicación aplica.
  - Nunca ejecutes `git` a secas (sin `--git-dir`/`--work-tree`) dentro de
    `~/GiGiOS`: falla porque su `.git` está vacío.
- Ningún ajuste cambia de clave de `preferences.ts` ni de fichero en
  `~/.config/gigios/`: solo cambia qué componente TSX pinta cada tarjeta y
  bajo qué entrada de nav vive. Si un paso de este plan tienta a renombrar una
  clave de estado, es una señal de que algo se ha entendido mal — pregunta
  antes de seguir.
- Editar `ags/estilos/style.scss` no tiene efecto hasta recompilar
  `estilos/out.css` con el paso `sass` de `ags/CLAUDE.md` (sección Styling).
- Verificar en vivo con `ags run ~/.config/ags/app.ts`. No hay test runner
  para JSX/GTK.
- Sigue el estilo de commit de este repo: minúsculas, `ámbito: descripción`
  corta en español, sin prefijos `feat:`/`fix:` (ver `git log` de `ags/`).

---

## Task 1: Textos nuevos en `general.json`

Añade las claves de copy que necesitan las tareas siguientes: los labels de
las dos secciones nuevas y las seis cabeceras de grupo. Es un cambio
puramente aditivo — ninguna clave existente se toca — así que el riesgo de
romper algo ya en pantalla es nulo.

**Files:**
- Modify: `ags/textos/ajustes/general.json`

**Interfaces:**
- Produce las claves `textos.secciones.diseno`, `textos.secciones.comportamiento`
  y `textos.grupos.{general,controles,dispositivos,almacenamiento,seguridad,sistema}`
  que consumen las Tasks 2, 3 y 4.

- [ ] **Step 1: Añadir las claves**

Edita `ags/textos/ajustes/general.json`. El bloque `secciones` gana dos
entradas al final, y el fichero gana un bloque `grupos` nuevo tras `secciones`:

```json
{
  "panel": {
    "titulo": "Ajustes",
    "editarValor": "Editar valor"
  },
  "secciones": {
    "cuenta": "Cuenta",
    "idiomaRegion": "Idioma y región",
    "fechaHora": "Fecha y hora",
    "ubicacion": "Ubicación",
    "accesibilidad": "Accesibilidad",
    "energia": "Energía",
    "juegos": "Juegos",
    "pantalla": "Pantallas",
    "personalizacion": "Personalización",
    "ratonPuntero": "Ratón y puntero",
    "touchpad": "Touchpad",
    "teclado": "Teclado",
    "impresoras": "Impresoras",
    "barra": "Barra",
    "workspaces": "Espacios de trabajo",
    "orion": "Orion",
    "portapapeles": "Portapapeles",
    "appsInicio": "Apps al inicio",
    "almacenamiento": "Almacenamiento",
    "liberarEspacio": "Liberar espacio",
    "notificaciones": "Notificaciones",
    "vigilancia": "Vigilancia del sistema",
    "escaneos": "Antivirus",
    "supervision": "Supervisor",
    "sistema": "Información del sistema",
    "atajos": "Atajos de teclado",
    "diseno": "Diseño",
    "comportamiento": "Comportamiento"
  },
  "grupos": {
    "general": "General",
    "controles": "Controles",
    "dispositivos": "Dispositivos",
    "almacenamiento": "Almacenamiento",
    "seguridad": "Seguridad",
    "sistema": "Sistema"
  }
}
```

Las claves `secciones.accesibilidad`, `secciones.personalizacion`,
`secciones.barra` y `secciones.workspaces` quedan sin usar tras la Task 4 de
este plan — se retiran en su Step 2, junto con el resto de la limpieza de
textos, no en este paso (este paso es solo aditivo).

- [ ] **Step 2: Verificar que el JSON sigue siendo válido**

Run: `node -e "console.log(Object.keys(require('/home/paraguayo33/GiGiOS/ags/textos/ajustes/general.json').secciones).length)"`
Expected: imprime `27` (las 25 claves de antes + `diseno` + `comportamiento`).

- [ ] **Step 3: Confirmar que Ajustes sigue abriendo sin errores**

Run: `ags run ~/.config/ags/app.ts` (o si ya está corriendo, reabre Ajustes
desde Quick Settings). Las 26 secciones de siempre deben seguir apareciendo
igual que antes — este paso todavía no las reorganiza.

- [ ] **Step 4: Commit**

```bash
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add \
  "$HOME/GiGiOS/ags/textos/ajustes/general.json"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "ajustes: textos para diseño, comportamiento y grupos de nav"
```

---

## Task 2: Crear `personalizacion/SeccionDiseno.tsx`

Combina, en una sola sección nueva, todas las tarjetas clasificadas como
"Diseño" en la spec: daltonismo, apariencia del shell, elementos visibles de
la barra, espacios en la barra y la gestión de la bandeja del sistema. El
fichero se crea sin usar todavía — nada lo importa hasta la Task 4 — así que
no puede romper nada que ya funcione; verifícalo revisando que no falte
ningún import.

**Files:**
- Create: `ags/modulos/ajustes/personalizacion/SeccionDiseno.tsx`

**Interfaces:**
- Consume: `textos.secciones.diseno` (Task 1); `AjusteInterruptor`,
  `FilaAjuste`, `TarjetaAjustes`, `TextoInformativo`, `TituloSeccion` de
  `../componentes`; `OpcionDaltonismo` de `../accesibilidad/OpcionDaltonismo`;
  `CapturasMicrofono` de `../barra/CapturasMicrofono`; `SelectorFondoShell` de
  `./SelectorFondoShell`; `knownTrayApps`, `hiddenTrayApps`, `trayOverflowAt`,
  `hideTrayApp`, `showTrayApp`, `forgetTrayApp`, `setTrayOverflowAt`, tipo
  `TrayAppInfo` de `../trayApps`; el resto de accessors de `../preferences`
  listados en el código.
- Produce: `export default function SeccionDiseno(): unknown` — sin props,
  igual que `SeccionAccesibilidad` hoy. Lo consume la Task 4
  (`FABRICAS_SECCION.diseno` en `secciones.tsx`).

- [ ] **Step 1: Crear el fichero**

```tsx
// modulos/ajustes/personalizacion/SeccionDiseno.tsx
import { For } from "ags"
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import CapturasMicrofono from "../barra/CapturasMicrofono"
import OpcionDaltonismo from "../accesibilidad/OpcionDaltonismo"
import SelectorFondoShell from "./SelectorFondoShell"
import {
  AjusteInterruptor, FilaAjuste, TarjetaAjustes,
  TextoInformativo, TituloSeccion,
} from "../componentes"
import {
  acentoAdaptativoEnabled, setAcentoAdaptativoEnabled,
  spotifyBarEnabled, setSpotifyBarEnabled,
  batteryBarEnabled, setBatteryBarEnabled,
  networkBarEnabled, setNetworkBarEnabled,
  micIndicatorEnabled, setMicIndicatorEnabled,
  screencastIndicatorEnabled, setScreencastIndicatorEnabled,
  trayBarEnabled, setTrayBarEnabled,
  notificationBarEnabled, setNotificationBarEnabled,
  lagartoBarraEnabled, setLagartoBarraEnabled,
  workspacesBarEnabled, setWorkspacesBarEnabled,
  wsPreviewEnabled, setWsPreviewEnabled,
  titulosAppsWorkspaceActivos, setTitulosAppsWorkspaceActivos,
} from "../preferences"
import {
  knownTrayApps, hiddenTrayApps, trayOverflowAt,
  hideTrayApp, showTrayApp, forgetTrayApp, setTrayOverflowAt,
  type TrayAppInfo,
} from "../trayApps"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import textosAccesibilidad from "../../../textos/ajustes/accesibilidad.json" with { type: "json" }
import textosPersonalizacion from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import textosApps from "../../../textos/ajustes/apps.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

function FilaAppBandeja({ app }: { app: TrayAppInfo }) {
  const visible = hiddenTrayApps((ocultas: string[]) => !ocultas.includes(app.id))
  return (
    <FilaAjuste titulo={app.title}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        {app.iconName
          ? <image iconName={app.iconName} pixelSize={22} />
          : <label cssClasses={["sp-nav-icon"]} label="󰀻" />}
        <button
          cssClasses={["sp-rule-del"]}
          valign={Gtk.Align.CENTER}
          tooltipText={textosApps.app.quitar}
          onClicked={() => forgetTrayApp(app.id)}
        >
          <label label="󰆴" />
        </button>
        <Interruptor activo={visible} alAlternar={() => visible.get() ? hideTrayApp(app.id) : showTrayApp(app.id)} />
      </box>
    </FilaAjuste>
  )
}

/** Apariencia visual del shell: qué se ve y cómo, nunca cómo se comporta.
 *  Ver la sección "Reparto de ajustes en Diseño / Comportamiento" de la spec. */
export default function SeccionDiseno() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.secciones.diseno} />

      <TarjetaAjustes titulo={textosAccesibilidad.grupos.daltonismo} icono="󰦧">
        <box cssClasses={["dev-row"]}>
          <TextoInformativo
            label={textosAccesibilidad.daltonismo.descripcion}
            wrap
            xalign={0}
            maxWidthChars={72}
          />
        </box>
        <OpcionDaltonismo modo="protanopia" {...textosAccesibilidad.modos.protanopia} />
        <OpcionDaltonismo modo="deuteranopia" {...textosAccesibilidad.modos.deuteranopia} />
        <OpcionDaltonismo modo="tritanopia" {...textosAccesibilidad.modos.tritanopia} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.apariencia} icono="󰏘">
        <SelectorFondoShell />
        <AjusteInterruptor titulo={textosPersonalizacion.apariencia.acento.titulo} informacion={textosPersonalizacion.apariencia.acento.descripcion} activo={acentoAdaptativoEnabled} alAlternar={() => setAcentoAdaptativoEnabled(!acentoAdaptativoEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.elementos} icono="󰕰">
        <AjusteInterruptor titulo={textosPersonalizacion.barra.spotify.titulo} informacion={textosPersonalizacion.barra.spotify.descripcion} activo={spotifyBarEnabled} alAlternar={() => setSpotifyBarEnabled(!spotifyBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.bateria.titulo} informacion={textosPersonalizacion.barra.bateria.descripcion} activo={batteryBarEnabled} alAlternar={() => setBatteryBarEnabled(!batteryBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.red.titulo} informacion={textosPersonalizacion.barra.red.descripcion} activo={networkBarEnabled} alAlternar={() => setNetworkBarEnabled(!networkBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.indicadorMicrofono.titulo} informacion={textosPersonalizacion.barra.indicadorMicrofono.descripcion} activo={micIndicatorEnabled} alAlternar={() => setMicIndicatorEnabled(!micIndicatorEnabled.get())} />
        <box visible={micIndicatorEnabled}><CapturasMicrofono /></box>
        <AjusteInterruptor titulo={textosPersonalizacion.barra.compartirPantalla.titulo} informacion={textosPersonalizacion.barra.compartirPantalla.descripcion} activo={screencastIndicatorEnabled} alAlternar={() => setScreencastIndicatorEnabled(!screencastIndicatorEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.bandeja.titulo} informacion={textosPersonalizacion.barra.bandeja.descripcion} activo={trayBarEnabled} alAlternar={() => setTrayBarEnabled(!trayBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.notificaciones.titulo} informacion={textosPersonalizacion.barra.notificaciones.descripcion} activo={notificationBarEnabled} alAlternar={() => setNotificationBarEnabled(!notificationBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.lagarto.titulo} informacion={textosPersonalizacion.barra.lagarto.descripcion} activo={lagartoBarraEnabled} alAlternar={() => setLagartoBarraEnabled(!lagartoBarraEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.espaciosBarra} icono="󰆾">
        <AjusteInterruptor titulo={textosPersonalizacion.barra.workspaces.titulo} informacion={textosPersonalizacion.barra.workspaces.descripcion} activo={workspacesBarEnabled} alAlternar={() => setWorkspacesBarEnabled(!workspacesBarEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.vistaPrevia.titulo} informacion={textosPersonalizacion.vistaPrevia.descripcion} activo={wsPreviewEnabled} visible={workspacesBarEnabled} alAlternar={() => setWsPreviewEnabled(!wsPreviewEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.barra.workspaces.titulosApps.titulo} informacion={textosPersonalizacion.barra.workspaces.titulosApps.descripcion} activo={titulosAppsWorkspaceActivos} visible={workspacesBarEnabled} alAlternar={() => setTitulosAppsWorkspaceActivos(!titulosAppsWorkspaceActivos.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosApps.seccion.titulo} icono="󰀻" visible={trayBarEnabled}>
        <FilaAjuste titulo={textosApps.agrupacion.titulo} informacion={textosApps.agrupacion.descripcion} visible={trayBarEnabled}>
          <box spacing={6} valign={Gtk.Align.CENTER}>
            <button cssClasses={["sp-step-btn"]} onClicked={() => setTrayOverflowAt(trayOverflowAt.get() - 1)}><label label="−" /></button>
            <label cssClasses={["sp-step-val"]} label={trayOverflowAt((n: number) => formatearTexto(textosApps.agrupacion.cantidad, { cantidad: n }))} />
            <button cssClasses={["sp-step-btn"]} onClicked={() => setTrayOverflowAt(trayOverflowAt.get() + 1)}><label label="+" /></button>
          </box>
        </FilaAjuste>
        <box orientation={Gtk.Orientation.VERTICAL} visible={trayBarEnabled}>
          <box cssClasses={["dev-row"]} visible={knownTrayApps((apps: TrayAppInfo[]) => apps.length === 0)}>
            <TextoInformativo label={textosApps.vacio} halign={Gtk.Align.START} />
          </box>
          <For each={knownTrayApps}>{(app: TrayAppInfo) => <FilaAppBandeja app={app} />}</For>
        </box>
      </TarjetaAjustes>
    </box>
  )
}
```

- [ ] **Step 2: Revisar imports**

Comprueba a mano que cada símbolo importado se usa al menos una vez y que
cada símbolo usado está importado (no hay `tsc` en este proyecto — es una
lectura, no un comando). En particular: `For` (usado en el `<For each=...>`
final), `Interruptor` (usado dentro de `FilaAppBandeja`).

- [ ] **Step 3: Commit**

```bash
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add \
  "$HOME/GiGiOS/ags/modulos/ajustes/personalizacion/SeccionDiseno.tsx"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "ajustes: crear SeccionDiseno (sin usar todavía)"
```

---

## Task 3: Crear `personalizacion/SeccionComportamiento.tsx`

Simétrico a la Task 2, con las tarjetas clasificadas como "Comportamiento":
comportamiento de la barra (autoocultado + aviso de batería), límites de
espacios de trabajo, colocación de ventana, ajustes al iniciar sesión,
indicadores OSD y ventanas. Igual que la Task 2, el fichero no lo importa
nadie todavía.

**Files:**
- Create: `ags/modulos/ajustes/personalizacion/SeccionComportamiento.tsx`

**Interfaces:**
- Consume: `textos.secciones.comportamiento` (Task 1); `AjusteInterruptor`,
  `TarjetaAjustes`, `TextoInformativo`, `TituloAjuste`, `TituloSeccion` de
  `../componentes`; `conectarCambioDeslizador` de
  `../../../utilidades/deslizador`; `InlineEditableValue` de
  `../../../componentes/InlineEditableValue`; `bateriaPresente` de
  `../../../servicios/energia/powerState`; el resto de accessors de
  `../preferences` listados en el código.
- Produce: `export default function SeccionComportamiento(): unknown` — sin
  props. Lo consume la Task 4 (`FABRICAS_SECCION.comportamiento` en
  `secciones.tsx`).

- [ ] **Step 1: Crear el fichero**

```tsx
// modulos/ajustes/personalizacion/SeccionComportamiento.tsx
import { createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { InlineEditableValue } from "../../../componentes/InlineEditableValue"
import {
  AjusteInterruptor, TarjetaAjustes,
  TextoInformativo, TituloAjuste, TituloSeccion,
} from "../componentes"
import {
  barAutoHideEnabled, setBarAutoHideEnabled,
  barraAvisoBateria, setBarraAvisoBateria,
  barraAvisoBateriaUsaUmbralAhorro, setBarraAvisoBateriaUsaUmbralAhorro,
  barraAvisoBateriaPct, setBarraAvisoBateriaPct,
  BARRA_AVISO_BATERIA_MIN, BARRA_AVISO_BATERIA_MAX,
  workspaceAppLimit, setWorkspaceAppLimit,
  WORKSPACE_APP_LIMIT_MIN, WORKSPACE_APP_LIMIT_MAX,
  workspaceVisibleLimit, setWorkspaceVisibleLimit,
  WORKSPACE_VISIBLE_LIMIT_MIN, WORKSPACE_VISIBLE_LIMIT_MAX,
  segundaVentanaAlLado, setSegundaVentanaAlLado,
  startupVolumeMuted, setStartupVolumeMuted,
  startupMicMuted, setStartupMicMuted,
  startupBluetoothOff, setStartupBluetoothOff,
  volumeOsdEnabled, setVolumeOsdEnabled,
  micOsdEnabled, setMicOsdEnabled,
  brightnessOsdEnabled, setBrightnessOsdEnabled,
  anclarVentanasRofi, setAnclarVentanasRofi,
  escanerAppsInicio, setEscanerAppsInicio,
  absorberSuperSinAtajo, setAbsorberSuperSinAtajo,
} from "../preferences"
import { bateriaPresente } from "../../../servicios/energia/powerState"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
import textosPersonalizacion from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

function DeslizadorLimite({ valor, minimo, maximo, alCambiar }: {
  valor: any
  minimo: number
  maximo: number
  alCambiar: (valor: number) => void
}) {
  const ajuste = new Gtk.Adjustment({ lower: minimo, upper: maximo, stepIncrement: 1, pageIncrement: 1 })
  ajuste.value = valor.get()
  const escala = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: ajuste,
    drawValue: false,
    digits: 0,
    hexpand: true,
  })
  escala.cssClasses = ["qs-slider", "brightness"]
  conectarCambioDeslizador(escala, alCambiar)
  // onCleanup, NUNCA connect("destroy"): en GTK4 `destroy` sale de `dispose`, y al
  // desmontar con <With> el widget solo se desparenta —los closures de JS lo siguen
  // referenciando—, así que el handler no llegaba a correr. <With> sí hace
  // scope.dispose(). Mismo patrón que ReproduccionSpotify.tsx.
  onCleanup(valor.subscribe(() => {
    if (ajuste.value !== valor.get()) ajuste.value = valor.get()
  }))
  return escala
}

function LimiteWorkspace({ titulo, descripcion, tooltip, valor, minimo, maximo, alCambiar }: {
  titulo: string
  descripcion: string
  tooltip: string
  valor: any
  minimo: number
  maximo: number
  alCambiar: (valor: number) => void
}) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TituloAjuste label={titulo} hexpand halign={Gtk.Align.START} />
        <InlineEditableValue
          display={valor((limite: number) => `${limite}`)}
          getValue={() => valor.get()}
          onCommit={alCambiar}
          min={minimo}
          max={maximo}
          labelClass="sp-field-value"
          tooltip={tooltip}
          maxLength={1}
        />
      </box>
      {DeslizadorLimite({ valor, minimo, maximo, alCambiar }) as unknown as any}
      <TextoInformativo label={descripcion} halign={Gtk.Align.START} wrap xalign={0} />
    </box>
  )
}

/** Umbral propio del aviso de batería baja: título + valor editable +
 *  deslizador, pero en tanto por ciento y hasta tres cifras — por eso no
 *  reutiliza `LimiteWorkspace`, que fija `maxLength={1}`. */
function UmbralAvisoBateria({ visible }: { visible: any }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]} visible={visible}>
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <TituloAjuste label={textosPersonalizacion.barra.avisoBateria.umbral.titulo} hexpand halign={Gtk.Align.START} />
        <InlineEditableValue
          display={barraAvisoBateriaPct((pct: number) => `${pct} %`)}
          getValue={() => barraAvisoBateriaPct.get()}
          onCommit={setBarraAvisoBateriaPct}
          min={BARRA_AVISO_BATERIA_MIN}
          max={BARRA_AVISO_BATERIA_MAX}
          labelClass="sp-field-value"
          tooltip={textosPersonalizacion.barra.avisoBateria.umbral.tooltip}
          maxLength={3}
        />
      </box>
      {DeslizadorLimite({
        valor: barraAvisoBateriaPct,
        minimo: BARRA_AVISO_BATERIA_MIN,
        maximo: BARRA_AVISO_BATERIA_MAX,
        alCambiar: setBarraAvisoBateriaPct,
      }) as unknown as any}
      <TextoInformativo
        label={formatearTexto(textosPersonalizacion.barra.avisoBateria.umbral.descripcion, {
          minimo: BARRA_AVISO_BATERIA_MIN, maximo: BARRA_AVISO_BATERIA_MAX,
        })}
        halign={Gtk.Align.START} wrap xalign={0}
      />
    </box>
  )
}

/** Comportamiento funcional del shell: qué hace cada cosa, nunca cómo se ve.
 *  Ver la sección "Reparto de ajustes en Diseño / Comportamiento" de la spec. */
export default function SeccionComportamiento() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.secciones.comportamiento} />

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.comportamiento} icono="󰍜">
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.ocultacionAutomatica.titulo}
          informacion={textosPersonalizacion.barra.ocultacionAutomatica.descripcion}
          activo={barAutoHideEnabled}
          alAlternar={() => setBarAutoHideEnabled(!barAutoHideEnabled.get())}
        />
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.avisoBateria.titulo}
          informacion={textosPersonalizacion.barra.avisoBateria.descripcion}
          activo={barraAvisoBateria}
          visible={bateriaPresente}
          sensible={barAutoHideEnabled}
          alAlternar={() => setBarraAvisoBateria(!barraAvisoBateria.get())}
        />
        <AjusteInterruptor
          titulo={textosPersonalizacion.barra.avisoBateria.vinculo.titulo}
          informacion={textosPersonalizacion.barra.avisoBateria.vinculo.descripcion}
          activo={barraAvisoBateriaUsaUmbralAhorro}
          visible={createComputed(
            [bateriaPresente, barraAvisoBateria, barAutoHideEnabled],
            (hayBateria, avisoPuesto, autoOcultar) => hayBateria && avisoPuesto && autoOcultar,
          )}
          alAlternar={() => setBarraAvisoBateriaUsaUmbralAhorro(!barraAvisoBateriaUsaUmbralAhorro.get())}
        />
        <UmbralAvisoBateria
          visible={createComputed(
            [bateriaPresente, barraAvisoBateria, barraAvisoBateriaUsaUmbralAhorro, barAutoHideEnabled],
            (hayBateria, avisoPuesto, vinculado, autoOcultar) =>
              hayBateria && avisoPuesto && !vinculado && autoOcultar,
          )}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.espacios} icono="󰆾">
        <box orientation={Gtk.Orientation.VERTICAL}>
          <LimiteWorkspace
            titulo={textosPersonalizacion.barra.workspaces.limiteApps.titulo}
            descripcion={formatearTexto(textosPersonalizacion.barra.workspaces.limiteApps.descripcion, { minimo: WORKSPACE_APP_LIMIT_MIN, maximo: WORKSPACE_APP_LIMIT_MAX })}
            tooltip={textosPersonalizacion.barra.workspaces.limiteApps.tooltip}
            valor={workspaceAppLimit}
            minimo={WORKSPACE_APP_LIMIT_MIN}
            maximo={WORKSPACE_APP_LIMIT_MAX}
            alCambiar={setWorkspaceAppLimit}
          />
          <LimiteWorkspace
            titulo={textosPersonalizacion.barra.workspaces.limiteVisibles.titulo}
            descripcion={textosPersonalizacion.barra.workspaces.limiteVisibles.descripcion}
            tooltip={textosPersonalizacion.barra.workspaces.limiteVisibles.tooltip}
            valor={workspaceVisibleLimit}
            minimo={WORKSPACE_VISIBLE_LIMIT_MIN}
            maximo={WORKSPACE_VISIBLE_LIMIT_MAX}
            alCambiar={setWorkspaceVisibleLimit}
          />
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.barraEscritorios.colocacion} icono="󰕰">
        <AjusteInterruptor
          titulo={textosPersonalizacion.ventanas.segundaAlLado.titulo}
          informacion={textosPersonalizacion.ventanas.segundaAlLado.descripcion}
          activo={segundaVentanaAlLado}
          alAlternar={() => setSegundaVentanaAlLado(!segundaVentanaAlLado.get())}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.sonidoInicio} icono="󰍃">
        <AjusteInterruptor titulo={textosPersonalizacion.inicioAudio.volumen.titulo} informacion={textosPersonalizacion.inicioAudio.volumen.descripcion} activo={startupVolumeMuted} alAlternar={() => setStartupVolumeMuted(!startupVolumeMuted.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.inicioAudio.microfono.titulo} informacion={textosPersonalizacion.inicioAudio.microfono.descripcion} activo={startupMicMuted} alAlternar={() => setStartupMicMuted(!startupMicMuted.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.inicioConectividad.bluetooth.titulo} informacion={textosPersonalizacion.inicioConectividad.bluetooth.descripcion} activo={startupBluetoothOff} alAlternar={() => setStartupBluetoothOff(!startupBluetoothOff.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.indicadores} icono="󰕾">
        <AjusteInterruptor titulo={textosPersonalizacion.osd.volumen.titulo} informacion={textosPersonalizacion.osd.volumen.descripcion} activo={volumeOsdEnabled} alAlternar={() => setVolumeOsdEnabled(!volumeOsdEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.osd.microfono.titulo} informacion={textosPersonalizacion.osd.microfono.descripcion} activo={micOsdEnabled} alAlternar={() => setMicOsdEnabled(!micOsdEnabled.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.osd.brillo.titulo} informacion={textosPersonalizacion.osd.brillo.descripcion} activo={brightnessOsdEnabled} alAlternar={() => setBrightnessOsdEnabled(!brightnessOsdEnabled.get())} />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textosPersonalizacion.seccionesNuevas.funcionesShell.ventanas} icono="󰖯">
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.anclaje.titulo} informacion={textosPersonalizacion.ventanas.anclaje.descripcion} activo={anclarVentanasRofi} alAlternar={() => setAnclarVentanasRofi(!anclarVentanasRofi.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.escanerInicio.titulo} informacion={textosPersonalizacion.ventanas.escanerInicio.descripcion} activo={escanerAppsInicio} alAlternar={() => setEscanerAppsInicio(!escanerAppsInicio.get())} />
        <AjusteInterruptor titulo={textosPersonalizacion.ventanas.superSordo.titulo} informacion={textosPersonalizacion.ventanas.superSordo.descripcion} activo={absorberSuperSinAtajo} alAlternar={() => setAbsorberSuperSinAtajo(!absorberSuperSinAtajo.get())} />
      </TarjetaAjustes>
    </box>
  )
}
```

- [ ] **Step 2: Revisar imports**

Igual que en la Task 2: cada símbolo importado se usa (`createComputed` y
`onCleanup` dentro de `DeslizadorLimite`/las tarjetas de arriba), y no falta
ninguno.

- [ ] **Step 3: Commit**

```bash
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add \
  "$HOME/GiGiOS/ags/modulos/ajustes/personalizacion/SeccionComportamiento.tsx"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "ajustes: crear SeccionComportamiento (sin usar todavía)"
```

---

## Task 4: Cutover — rewire de la nav y retirada de lo antiguo

Esta es la única tarea que cambia el árbol de navegación en vivo, y se hace
de una vez porque cualquier corte a medias (por ejemplo, borrar
`SeccionBarraEscritorios.tsx` antes de quitar su fábrica de
`secciones.tsx`) deja Ajustes roto entre pasos. Todos los sub-pasos de esta
tarea se hacen antes de volver a lanzar `ags run`.

**Files:**
- Modify: `ags/modulos/ajustes/personalizacion/SeccionFuncionesShell.tsx`
- Modify: `ags/textos/ajustes/personalizacion.json`
- Delete: `ags/modulos/ajustes/accesibilidad/SeccionAccesibilidad.tsx`
- Delete: `ags/modulos/ajustes/barra/SeccionBarraEscritorios.tsx`
- Modify: `ags/modulos/ajustes/panel/secciones.tsx`
- Modify: `ags/modulos/ajustes/panel/NavegacionAjustes.tsx`

**Interfaces:**
- Consume: `SeccionDiseno` (Task 2), `SeccionComportamiento` (Task 3),
  `textos.grupos.*` (Task 1).
- Produce en `secciones.tsx`: `IdSeccion`, `IdGrupo`, `SeccionNavegacion`,
  `GrupoNavegacion`, `ItemNavegacion`, `esGrupo(item): item is GrupoNavegacion`,
  `ITEMS_NAVEGACION: ItemNavegacion[]`, `SECCIONES_POR_ID: Record<IdSeccion, SeccionNavegacion>`,
  `crearContenidoSeccion(id: IdSeccion): unknown`. `NavegacionAjustes.tsx`
  consume los cinco primeros.

- [ ] **Step 1: Trimar `SeccionFuncionesShell.tsx`**

Reemplaza el fichero entero — pierde la rama `vista === "personalizacion"`
(sus tres tarjetas ya viven en `SeccionDiseno`/`SeccionComportamiento`) y el
valor `"personalizacion"` de `VistaFunciones`:

```tsx
import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, TarjetaAjustes, TituloSeccion } from "../componentes"
import LimpiezaPortapapeles from "./LimpiezaPortapapeles"
import {
  orionEnabled, setOrionEnabled,
  orionAppsDefault, setOrionAppsDefault,
  orionRecordarUltimaSeccion, setOrionRecordarUltimaSeccion,
  clipboardHistoryEnabled, setClipboardHistoryEnabled,
  limpiezaPortapapelesAlIniciar, setLimpiezaPortapapelesAlIniciar,
} from "../preferences"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

type VistaFunciones = "orion" | "portapapeles"

export default function SeccionFuncionesShell({ vista }: { vista: VistaFunciones }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.vistasFunciones[vista]} />

      {vista === "orion" && <TarjetaAjustes titulo={textos.seccionesNuevas.funcionesShell.orion} icono="󰆍">
        <AjusteInterruptor titulo={textos.orion.menu.titulo} informacion={textos.orion.menu.descripcion} activo={orionEnabled} alAlternar={() => setOrionEnabled(!orionEnabled.get())} />
        <AjusteInterruptor titulo={textos.orion.paginaInicial.titulo} informacion={textos.orion.paginaInicial.descripcion} activo={orionAppsDefault} visible={orionEnabled} alAlternar={() => setOrionAppsDefault(!orionAppsDefault.get())} />
        <AjusteInterruptor titulo={textos.orion.ultimaSeccion.titulo} informacion={textos.orion.ultimaSeccion.descripcion} activo={orionRecordarUltimaSeccion} visible={orionEnabled} alAlternar={() => setOrionRecordarUltimaSeccion(!orionRecordarUltimaSeccion.get())} />
      </TarjetaAjustes>}

      {vista === "portapapeles" && <TarjetaAjustes titulo={textos.seccionesNuevas.funcionesShell.portapapeles} icono="󰅇">
        <AjusteInterruptor titulo={textos.portapapeles.titulo} informacion={textos.portapapeles.descripcion} activo={clipboardHistoryEnabled} alAlternar={() => setClipboardHistoryEnabled(!clipboardHistoryEnabled.get())} />
        <LimpiezaPortapapeles />
        <AjusteInterruptor
          titulo={textos.portapapeles.limpiezaAutomatica.titulo}
          informacion={textos.portapapeles.limpiezaAutomatica.descripcion}
          activo={limpiezaPortapapelesAlIniciar}
          alAlternar={() => setLimpiezaPortapapelesAlIniciar(!limpiezaPortapapelesAlIniciar.get())}
        />
      </TarjetaAjustes>}
    </box>
  )
}
```

- [ ] **Step 2: Limpiar los textos que quedan muertos**

En `ags/textos/ajustes/personalizacion.json`, quita la clave
`vistasFunciones.personalizacion` (ya no hay esa vista) y el bloque entero
`vistasBarra` (era el título de las vistas `barra`/`workspaces`, que
desaparecen en el Step 3). El resto del fichero no cambia — sus demás claves
las siguen usando `SeccionDiseno.tsx`, `SeccionComportamiento.tsx` y lo que
queda de `SeccionFuncionesShell.tsx`.

Antes:
```json
  "vistasBarra": {
    "barra": "Barra",
    "workspaces": "Espacios de trabajo"
  },
  "vistasFunciones": {
    "personalizacion": "Personalización",
    "orion": "Orion",
    "portapapeles": "Portapapeles"
  },
```

Después:
```json
  "vistasFunciones": {
    "orion": "Orion",
    "portapapeles": "Portapapeles"
  },
```

Y en `ags/textos/ajustes/general.json`, quita del bloque `secciones` las
cuatro claves que dejan de tener destino en la nav tras el Step 4:
`accesibilidad`, `personalizacion`, `barra` y `workspaces`. Las otras 23,
más `diseno` y `comportamiento` (Task 1), se quedan: las usa
`SECCIONES_POR_ID`.

Comprobación rápida de que no queda ningún consumidor de las cuatro:

```bash
grep -rn "secciones.accesibilidad\|secciones.personalizacion\|secciones.barra\|secciones.workspaces" \
  "$HOME/GiGiOS/ags" --include="*.ts" --include="*.tsx"
```
Expected: sin resultados.

- [ ] **Step 3: Borrar los ficheros retirados**

```bash
rm "$HOME/GiGiOS/ags/modulos/ajustes/accesibilidad/SeccionAccesibilidad.tsx"
rm "$HOME/GiGiOS/ags/modulos/ajustes/barra/SeccionBarraEscritorios.tsx"
```

`accesibilidad/OpcionDaltonismo.tsx`, `accesibilidad/daltonismo.ts`,
`barra/CapturasMicrofono.tsx` y `barra/appsBandeja.ts` se quedan donde
están — los sigue usando `SeccionDiseno.tsx`.

- [ ] **Step 4: Rescribir `panel/secciones.tsx`**

```tsx
import { createComputed, type Accessor } from "ags"
import SettingsTabs from "../../notificaciones/settings/SettingsTabs"
import SeccionAtajos from "../atajos/SeccionAtajos"
import SeccionCamara from "../camara/SeccionCamara"
import SeccionCuenta from "../cuenta/SeccionCuenta"
import SeccionAlmacenamiento from "../disco/SeccionAlmacenamiento"
import SeccionAppsInicio from "../inicio/SeccionAppsInicio"
import SeccionDispositivos from "../dispositivos/SeccionDispositivos"
import SeccionEnergia from "../energia/SeccionEnergia"
import SeccionFechaIdioma from "../fecha-idioma/SeccionFechaIdioma"
import SeccionJuegos from "../juegos/SeccionJuegos"
import SeccionPantalla from "../pantalla/SeccionPantalla"
import SeccionComportamiento from "../personalizacion/SeccionComportamiento"
import SeccionDiseno from "../personalizacion/SeccionDiseno"
import SeccionFuncionesShell from "../personalizacion/SeccionFuncionesShell"
import SeccionSeguridad from "../seguridad/SeccionSeguridad"
import SeccionSistema from "../sistema/SeccionSistema"
import { camaras } from "../../../servicios/camara/dispositivos"
import { estadoCamara } from "../../../servicios/camara/persistencia"
import { haySeccionCamara } from "../camara/camaraDatos"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
// El rótulo de Cámara vive con el resto de sus textos y no en `general.json`:
// es una sección nueva y así todo su idioma cae en un solo fichero.
import textosCamara from "../../../textos/ajustes/camara.json" with { type: "json" }

export type IdSeccion =
  | "account" | "language" | "datetime" | "location"
  | "display" | "diseno" | "comportamiento"
  | "mouse" | "touchpad" | "keyboard" | "printers" | "camera"
  | "energy" | "games" | "orion" | "clipboard"
  | "startup"
  | "storage" | "cleanup"
  | "notifications" | "monitoring" | "scans" | "supervision" | "system"
  | "shortcuts"

export type IdGrupo =
  | "general" | "controles" | "dispositivos"
  | "almacenamiento" | "seguridad" | "sistema"

export interface SeccionNavegacion {
  id: IdSeccion
  label: string
  icon: string
  /** Destinos que solo existen en algunas máquinas. Ausente = siempre visible.
   *  Es un accessor y no un booleano porque el hardware entra y sale en
   *  caliente: enchufar una webcam con Ajustes abierto tiene que hacer aparecer
   *  su destino sin reabrir la ventana. */
  visible?: Accessor<boolean>
}

/** Cabecera de acordeón: agrupa hojas de `IdSeccion` ya existentes. No tiene
 *  contenido propio — `crearContenidoSeccion` nunca recibe un `IdGrupo`. */
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

/** Hay cámara enchufada, o ajustes guardados de alguna que lo estuvo.
 *
 *  Lo segundo importa: una webcam USB desenchufada cuyos controles siguen en
 *  `camara.json` tiene que poder OLVIDARSE desde la sección, y si el destino
 *  desapareciera con ella esos ajustes quedarían huérfanos —y se volverían a
 *  imponer al reenchufarla— sin ninguna forma de borrarlos que no fuera editar
 *  el JSON a mano. En un equipo que nunca ha visto una cámara (este sobremesa)
 *  no se cumple ninguna de las dos y el destino no se pinta. */
const hayCamaraConocida = createComputed([camaras, estadoCamara], haySeccionCamara)

/** Metadato de cada hoja, declarado una sola vez y reutilizado tanto suelta
 *  (planas, en `ITEMS_NAVEGACION`) como colgando de un `GrupoNavegacion`
 *  (`NavegacionAjustes` la busca aquí por id para pintar los hijos). */
export const SECCIONES_POR_ID: Record<IdSeccion, SeccionNavegacion> = {
  account: { id: "account", label: textos.secciones.cuenta, icon: "󰀄" },
  language: { id: "language", label: textos.secciones.idiomaRegion, icon: "󰗊" },
  datetime: { id: "datetime", label: textos.secciones.fechaHora, icon: "󰃭" },
  location: { id: "location", label: textos.secciones.ubicacion, icon: "󰍎" },
  display: { id: "display", label: textos.secciones.pantalla, icon: "󰍹" },
  diseno: { id: "diseno", label: textos.secciones.diseno, icon: "󰏘" },
  comportamiento: { id: "comportamiento", label: textos.secciones.comportamiento, icon: "󰍜" },
  mouse: { id: "mouse", label: textos.secciones.ratonPuntero, icon: "󰍽" },
  touchpad: { id: "touchpad", label: textos.secciones.touchpad, icon: "󰟸" },
  keyboard: { id: "keyboard", label: textos.secciones.teclado, icon: "󰌌" },
  printers: { id: "printers", label: textos.secciones.impresoras, icon: "󰐪" },
  camera: { id: "camera", label: textosCamara.seccion.titulo, icon: "󰄀", visible: hayCamaraConocida },
  energy: { id: "energy", label: textos.secciones.energia, icon: "󰁹" },
  games: { id: "games", label: textos.secciones.juegos, icon: "󰊴" },
  orion: { id: "orion", label: textos.secciones.orion, icon: "󰆍" },
  clipboard: { id: "clipboard", label: textos.secciones.portapapeles, icon: "󰅇" },
  startup: { id: "startup", label: textos.secciones.appsInicio, icon: "󰐊" },
  storage: { id: "storage", label: textos.secciones.almacenamiento, icon: "󰋊" },
  cleanup: { id: "cleanup", label: textos.secciones.liberarEspacio, icon: "󰃢" },
  notifications: { id: "notifications", label: textos.secciones.notificaciones, icon: "󰂚" },
  monitoring: { id: "monitoring", label: textos.secciones.vigilancia, icon: "󰒃" },
  scans: { id: "scans", label: textos.secciones.escaneos, icon: "󰇚" },
  supervision: { id: "supervision", label: textos.secciones.supervision, icon: "󰓅" },
  system: { id: "system", label: textos.secciones.sistema, icon: "󰌢" },
  shortcuts: { id: "shortcuts", label: textos.secciones.atajos, icon: "󰘳" },
}

export const ITEMS_NAVEGACION: ItemNavegacion[] = [
  SECCIONES_POR_ID.account,
  { id: "general", label: textos.grupos.general, icon: "󰗊", hijos: ["language", "datetime", "location"] },
  { id: "controles", label: textos.grupos.controles, icon: "󰍽", hijos: ["mouse", "keyboard", "touchpad"] },
  SECCIONES_POR_ID.diseno,
  SECCIONES_POR_ID.comportamiento,
  { id: "dispositivos", label: textos.grupos.dispositivos, icon: "󰍹", hijos: ["display", "printers", "camera"] },
  SECCIONES_POR_ID.energy,
  SECCIONES_POR_ID.games,
  SECCIONES_POR_ID.orion,
  SECCIONES_POR_ID.clipboard,
  SECCIONES_POR_ID.startup,
  { id: "almacenamiento", label: textos.grupos.almacenamiento, icon: "󰋊", hijos: ["storage", "cleanup"] },
  SECCIONES_POR_ID.notifications,
  { id: "seguridad", label: textos.grupos.seguridad, icon: "󰒃", hijos: ["monitoring", "scans"] },
  { id: "sistema", label: textos.grupos.sistema, icon: "󰌢", hijos: ["system", "supervision", "shortcuts"] },
]

const FABRICAS_SECCION: Record<IdSeccion, () => unknown> = {
  account: () => <SeccionCuenta />,
  language: () => <SeccionFechaIdioma vista="idioma" />,
  datetime: () => <SeccionFechaIdioma vista="fecha" />,
  location: () => <SeccionFechaIdioma vista="ubicacion" />,
  display: () => <SeccionPantalla />,
  diseno: () => <SeccionDiseno />,
  comportamiento: () => <SeccionComportamiento />,
  mouse: () => <SeccionDispositivos vista="raton" />,
  touchpad: () => <SeccionDispositivos vista="touchpad" />,
  keyboard: () => <SeccionDispositivos vista="teclado" />,
  printers: () => <SeccionDispositivos vista="impresoras" />,
  camera: () => <SeccionCamara />,
  energy: () => <SeccionEnergia />,
  games: () => <SeccionJuegos />,
  orion: () => <SeccionFuncionesShell vista="orion" />,
  clipboard: () => <SeccionFuncionesShell vista="portapapeles" />,
  startup: () => <SeccionAppsInicio />,
  storage: () => <SeccionAlmacenamiento vista="uso" />,
  cleanup: () => <SeccionAlmacenamiento vista="limpieza" />,
  notifications: () => <SettingsTabs />,
  monitoring: () => <SeccionSeguridad vista="vigilancia" />,
  scans: () => <SeccionSeguridad vista="escaneos" />,
  supervision: () => <SeccionSistema vista="supervision" />,
  system: () => <SeccionSistema vista="informacion" />,
  shortcuts: () => <SeccionAtajos />,
}

export function crearContenidoSeccion(id: IdSeccion): unknown {
  return FABRICAS_SECCION[id]()
}
```

- [ ] **Step 5: Rescribir `panel/NavegacionAjustes.tsx`**

```tsx
import { createState, type Accessor } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { espacioDisponible, seguirGeometriaMonitor } from "../../../utilidades/tamanoLamina"
import {
  ITEMS_NAVEGACION, SECCIONES_POR_ID, esGrupo,
  type IdSeccion, type SeccionNavegacion,
} from "./secciones.tsx"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }

// Lo que rodea a la lista dentro de `.sp-nav`: padding vertical (16+16), el título y el
// espaciado. Se descuenta del alto de pantalla para que el techo de la lista sea el alto
// que de verdad le queda.
const MARCO_NAV = 76

function FilaDestino({
  destino, seccion, seleccionar, indentado,
}: {
  destino: SeccionNavegacion
  seccion: Accessor<IdSeccion>
  seleccionar: (seccion: IdSeccion) => void
  indentado?: boolean
}) {
  const clasesFila = indentado ? ["sp-nav-item", "sp-nav-item-hijo"] : ["sp-nav-item"]
  return (
    <button
      cssClasses={seccion((actual) =>
        actual === destino.id ? [...clasesFila, "active"] : clasesFila)}
      // Destinos que solo existen en algunas máquinas (ver `visible` en
      // `secciones.tsx`). Se ocultan, NO se filtran de la lista: un
      // botón invisible en GTK4 no ocupa sitio ni se puede pulsar, y
      // así el accessor puede encenderlo en caliente —enchufar una
      // webcam con Ajustes abierto— sin reconstruir la nav entera.
      visible={destino.visible ?? true}
      onClicked={() => seleccionar(destino.id)}
      valign={Gtk.Align.CENTER}
      overflow={Gtk.Overflow.VISIBLE}
    >
      <box
        cssClasses={["sp-nav-content"]}
        spacing={10}
        valign={Gtk.Align.CENTER}
        heightRequest={24}
        overflow={Gtk.Overflow.VISIBLE}
      >
        <label
          cssClasses={["sp-nav-icon"]}
          label={destino.icon}
          valign={Gtk.Align.CENTER}
          heightRequest={22}
          overflow={Gtk.Overflow.VISIBLE}
        />
        <label
          cssClasses={["sp-nav-label"]}
          label={destino.label}
          hexpand
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
          heightRequest={22}
          overflow={Gtk.Overflow.VISIBLE}
        />
      </box>
    </button>
  )
}

export default function NavegacionAjustes({
  seccion,
  seleccionar,
  gdkmonitor,
}: {
  seccion: Accessor<IdSeccion>
  seleccionar: (seccion: IdSeccion) => void
  gdkmonitor: Gdk.Monitor
}) {
  let lista: Gtk.ScrolledWindow | undefined
  // El alto del panel lo estira ESTA lista, no la sección abierta: la nav es lo único
  // constante entre secciones, así que el panel deja de cambiar de tamaño al navegar. El
  // techo es lo que quepa en la pantalla; a partir de ahí la lista se desplaza.
  const aplicarTecho = () => {
    lista?.set_max_content_height(Math.max(1, espacioDisponible(gdkmonitor).alto - MARCO_NAV))
  }

  // Snapshot al construir la nav (una vez por ventana/monitor, como `seccion`
  // misma): decide solo qué grupo arranca desplegado, el que contiene la
  // sección activa, para que reabrir Ajustes no la deje escondida detrás de
  // un acordeón cerrado. No se vuelve a leer después.
  const seccionInicial = seccion.get()

  return (
    // `hexpand={false}` EXPLÍCITO, y es obligatorio: en GTK4 el hexpand de un hijo sube
    // por sus ancestros salvo que uno lo fije a la fuerza, y las etiquetas de las entradas
    // lo llevan (es lo que alinea el texto a la izquierda del glifo). Sin esto la nav
    // «expandía» igual que el contenido y se repartía con él todo el ancho sobrante del
    // panel: los botones pasaban de sus ~225 px a más del doble. No se notaba mientras el
    // contenido pedía un mínimo mayor que el panel, porque entonces no sobraba nada que
    // repartir. La nav mide lo que miden sus etiquetas y ahí se queda.
    <box cssClasses={["sp-nav"]} orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand={false}>
      <label cssClasses={["sp-nav-title"]} label={textos.panel.titulo} halign={Gtk.Align.START} />
      {/* La lista vertical va en EXTERNAL, no en NEVER: con NEVER, GTK4 suma la altura
          MÍNIMA de las entradas a lo que pide el panel, así que la lista no
          se desplazaba nunca y encima imponía un alto de panel imposible en pantallas
          normales. Con EXTERNAL sube el NATURAL —acotado por `maxContentHeight`—, que es
          justo lo que se quiere: el panel se estira para enseñar la nav entera mientras
          quepa, y cuando no cabe la lista se desplaza. No dibuja barra. El ancho sí sigue
          en NEVER: la nav debe medir lo que miden sus etiquetas, y es estático. */}
      <Gtk.ScrolledWindow
        cssClasses={["sp-nav-scroll"]}
        $={(self: Gtk.ScrolledWindow) => {
          lista = self
          aplicarTecho()
          seguirGeometriaMonitor(gdkmonitor, aplicarTecho)(self)
        }}
        vexpand
        propagateNaturalHeight
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
          {ITEMS_NAVEGACION.map((item) => {
            if (!esGrupo(item)) {
              return <FilaDestino destino={item} seccion={seccion} seleccionar={seleccionar} />
            }

            const grupo = item
            const [abierto, setAbierto] = createState(grupo.hijos.includes(seccionInicial))

            return (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <button
                  cssClasses={["sp-nav-item", "sp-nav-item-grupo"]}
                  onClicked={() => setAbierto(!abierto.get())}
                  valign={Gtk.Align.CENTER}
                  overflow={Gtk.Overflow.VISIBLE}
                >
                  <box
                    cssClasses={["sp-nav-content"]}
                    spacing={10}
                    valign={Gtk.Align.CENTER}
                    heightRequest={24}
                    overflow={Gtk.Overflow.VISIBLE}
                  >
                    <label cssClasses={["sp-nav-icon"]} label={grupo.icon} valign={Gtk.Align.CENTER} heightRequest={22} overflow={Gtk.Overflow.VISIBLE} />
                    <label cssClasses={["sp-nav-label"]} label={grupo.label} hexpand halign={Gtk.Align.START} valign={Gtk.Align.CENTER} heightRequest={22} overflow={Gtk.Overflow.VISIBLE} />
                    <label cssClasses={["sp-nav-chevron"]} label={abierto((a: boolean) => a ? "▾" : "▸")} valign={Gtk.Align.CENTER} />
                  </box>
                </button>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={abierto}>
                  {grupo.hijos.map((idHijo) => (
                    <FilaDestino
                      destino={SECCIONES_POR_ID[idHijo]}
                      seccion={seccion}
                      seleccionar={seleccionar}
                      indentado
                    />
                  ))}
                </box>
              </box>
            )
          })}
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}
```

- [ ] **Step 6: Verificar en vivo**

Run: `ags run ~/.config/ags/app.ts`, abre Ajustes (engranaje de Quick
Settings). Comprueba:
1. Aparecen 15 filas de primer nivel: Cuenta, General, Controles, Diseño,
   Comportamiento, Dispositivos, Energía, Juegos, Orion, Portapapeles, Apps
   al inicio, Almacenamiento, Notificaciones, Seguridad, Sistema.
2. Los 6 grupos (General, Controles, Dispositivos, Almacenamiento,
   Seguridad, Sistema) arrancan colapsados (▸) y al pulsarlos despliegan
   exactamente los hijos de la tabla de la spec, indentados.
3. Entrar en Diseño: aparecen las 5 tarjetas (Daltonismo, Apariencia,
   Elementos de la barra, Espacios en la barra, Bandeja del sistema) y cada
   interruptor sigue reflejando su valor guardado.
4. Entrar en Comportamiento: aparecen las 6 tarjetas (Comportamiento de la
   barra, Límites de espacios de trabajo, Colocación de ventanas, Al iniciar
   sesión, Indicadores OSD, Ventanas).
5. Orion y Portapapeles siguen funcionando igual que antes.
6. Sin cámara conocida en el equipo, "Cámara" sigue sin aparecer dentro de
   Dispositivos (mismo comportamiento de antes, ahora indentado).

Si algo falta o un interruptor no refleja su valor guardado, revisa el Step 4
u 5 antes de seguir — no continúes a la Task 5 con la nav rota.

- [ ] **Step 7: Commit**

```bash
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add \
  "$HOME/GiGiOS/ags/modulos/ajustes/personalizacion/SeccionFuncionesShell.tsx" \
  "$HOME/GiGiOS/ags/textos/ajustes/personalizacion.json" \
  "$HOME/GiGiOS/ags/textos/ajustes/general.json" \
  "$HOME/GiGiOS/ags/modulos/ajustes/panel/secciones.tsx" \
  "$HOME/GiGiOS/ags/modulos/ajustes/panel/NavegacionAjustes.tsx"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add -u \
  "$HOME/GiGiOS/ags/modulos/ajustes/accesibilidad" \
  "$HOME/GiGiOS/ags/modulos/ajustes/barra"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "ajustes: nav en grupos, Diseño y Comportamiento sustituyen a 4 secciones"
```

(`add -u` recoge los `rm` del Step 3 sin arrastrar ficheros nuevos sin
seguimiento de esos mismos directorios.)

---

## Task 5: Cabecera de grupo y chevron en `style.scss`

Añade el CSS que necesitan las clases nuevas `sp-nav-item-grupo`,
`sp-nav-chevron` y `sp-nav-item-hijo` que ya pinta la Task 4. Sin esto, el
acordeón funciona (abre/cierra) pero el chevron y el indentado no tienen
estilo propio — visualmente indistinguible de una fila normal salvo por el
propio glifo `▾`/`▸`.

**Files:**
- Modify: `ags/estilos/style.scss`
- Modify: `ags/estilos/out.css` (regenerado, no a mano)

**Interfaces:**
- Consume las clases CSS que ya pinta `NavegacionAjustes.tsx` (Task 4):
  `.sp-nav-item-grupo`, `.sp-nav-chevron`, `.sp-nav-item-hijo`.

- [ ] **Step 1: Añadir las reglas**

En `ags/estilos/style.scss`, justo después del bloque `.sp-nav-item { ... }`
(busca `.sp-nav-icon {` para encontrar su cierre), añade:

```scss
.sp-nav-item-grupo {
  font-weight: 600;
}
.sp-nav-chevron {
  font-size: 10px;
  color: rgba($text, 0.35);
  font-family: $font-icon;
}
.sp-nav-item-hijo {
  .sp-nav-content { padding-left: 18px; }
}
```

- [ ] **Step 2: Recompilar `out.css`**

Run (desde `ags/`):
```bash
cd "$HOME/GiGiOS/ags"
sass --no-charset --source-map-urls=absolute estilos/style.scss estilos/out.css
mv estilos/out.css.map ~/.cache/gigios/out.css.map
sed -i "s#sourceMappingURL=out.css.map#sourceMappingURL=file://$HOME/.cache/gigios/out.css.map#" estilos/out.css
```
Expected: `sass` termina sin errores; `estilos/out.css` cambia de tamaño;
`~/.cache/gigios/out.css.map` existe.

- [ ] **Step 3: Verificar en vivo**

Run: `ags run ~/.config/ags/app.ts`. Abre Ajustes: las cabeceras de grupo se
ven en negrita con su chevron a la derecha, y los hijos desplegados quedan
visiblemente indentados respecto a las hojas planas.

- [ ] **Step 4: Commit**

```bash
git --git-dir=$HOME/.dotfiles --work-tree=$HOME add \
  "$HOME/GiGiOS/ags/estilos/style.scss" \
  "$HOME/GiGiOS/ags/estilos/out.css"
git --git-dir=$HOME/.dotfiles --work-tree=$HOME commit -m "ajustes: estilo de cabecera de grupo, chevron e indentado en la nav"
```

---

## Task 6: Verificación final

Repite el checklist completo de la sección Testing de la spec, ya con todo
el árbol montado y con el CSS aplicado. No cambia código — es la pasada de
aceptación.

**Files:** ninguno (solo verificación manual).

- [ ] **Step 1: Recorrido completo**

Run: `ags run ~/.config/ags/app.ts`. Con Ajustes abierto:

1. Las 6 cabeceras de grupo (General, Controles, Dispositivos,
   Almacenamiento, Seguridad, Sistema) arrancan colapsadas; Cuenta, Diseño,
   Comportamiento, Energía, Juegos, Orion, Portapapeles, Apps al inicio y
   Notificaciones son hojas sueltas sin chevron.
2. Cada grupo, al abrirse, muestra exactamente los hijos de la tabla de la
   spec, en el mismo orden.
3. El contenido de cada hijo (Idioma y región, Fecha y hora, Ubicación,
   Ratón y puntero, Teclado, Touchpad, Pantallas, Impresoras, Cámara,
   Almacenamiento, Liberar espacio, Vigilancia del sistema, Antivirus,
   Información del sistema, Supervisor, Atajos de teclado) es idéntico al de
   antes de este plan — ninguno perdió ni ganó ajustes.
4. En Diseño y Comportamiento, cambia un valor de cada tipo de control
   (interruptor, deslizador, selector de color de fondo, campo numérico
   inline) y confirma que persiste: cierra y reabre Ajustes, o revisa
   `~/.config/gigios/preferences.json` si hace falta, y comprueba que el
   valor sigue puesto.
5. Cierra Ajustes con una sección hija activa (por ejemplo, entra en
   Teclado) y reábrelo: el grupo Controles debe aparecer ya desplegado con
   Teclado marcado como activo.
6. Con la ventana en una resolución normal, el scroll de la nav
   (`MARCO_NAV`/`aplicarTecho`) no corta ninguna fila ni deja hueco de más
   por debajo de la última.

- [ ] **Step 2: Reportar hallazgos**

Si algún punto falla, vuelve a la task correspondiente (los datos están en
`secciones.tsx`/`NavegacionAjustes.tsx` si es de estructura, en
`SeccionDiseno.tsx`/`SeccionComportamiento.tsx` si es de contenido) y
corrige antes de dar el plan por terminado. No hace falta commit en este
paso si todo pasa: es solo verificación.
