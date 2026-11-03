# Cómo añadir piezas al motor de reglas de notificaciones

Una regla tiene tres clases de pieza, y cada una vive en **un registro**. Ningún otro fichero las
nombra una a una: el motor, la validación, el saneado, el resumen y el editor recorren el registro.

| Pieza | Qué es | Registro |
|---|---|---|
| **Efecto** | qué le hace la regla a la notificación (descartar, duración del popup, sonido…) | `rules/efectos/` (un fichero por efecto + `index.ts`) |
| **Condición** | cuándo se retira sola (`battery-resolved`…) | `rules/condiciones/` (un fichero por condición + `index.ts`) |
| **Campo de coincidencia** | en qué notificación se aplica (app, título, cuerpo, aviso, origen) | `rules/coincidencias.ts` |

Los **avisos del sistema** (las ~125 notificaciones de `hypr/scripts/`) no son piezas del motor:
son datos, en `ags/config/avisos-sistema.json`. Para eso, mira `catalogoSistema.ts`.

## Un efecto nuevo

Ejemplo: «Fijar en el panel» (la notificación no se borra al pulsar «Limpiar todo»).

1. **Su tipo**, en `EffectSpec` (`rules/types.ts`): `fijada?: boolean`. Si va a la meta
   (`destino: "meta"`), añádelo también a `NotifMeta`.
2. **Su fichero**, `rules/efectos/fijada.ts`:

   ```ts
   import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
   import { definirEfecto } from "./tipos.ts"

   export default definirEfecto({
     clave: "fijada",
     valor: "booleano",        // cómo se sanea al cargar de disco
     destino: "meta",          // se guarda con la notificación
     porDefecto: false,
     resumen: (v) => (v ? textos.resumen.efectos.fijada : null),
     editor: { tipo: "interruptor", fila: "acciones", etiqueta: textos.editor.acciones.fijada },
   })
   ```

3. **Una línea en `rules/efectos/index.ts`**, en la posición en que quieras verlo en el editor y en el
   resumen.
4. **Sus textos** en `textos/ajustes/notificaciones.json`: los que nombre el descriptor.
5. **El código que lo aplica**, donde se use: aquí, `clearAllNotifications()` respetaría
   `meta.fijada`. Es lo único que el registro no puede hacer por ti.

Con eso el efecto ya se combina entre reglas, se valida, se sanea, sale en el resumen y tiene su
control en el editor. `efectos.test.ts` falla si falta un texto, si una fila de interruptores queda
partida, o si una predefinida o el catálogo de avisos usan un efecto que no existe.

### Qué decidir en el descriptor

- **`destino`**: `meta` si alguien lo lee **después** de ingerir (popup, panel, limpieza; se
  persiste); `resultado` si solo lo consume la ingesta **una vez** (`suppress`, `soundFile`);
  `motor` si sirve para calcular otra cosa dentro de `engine.ts` (`lifetime`, `ttlMs`, `dedupKey`).
  Un efecto `motor` nuevo sí exige tocar `evaluate()`.
- **`combinar`**: `prioridad` (por defecto: gana la regla más prioritaria que lo fije), `union`
  (listas: se juntan) o `por-campo` (objetos con subcampos independientes, como `rewrite`).
- **`sanear`**: qué valores ADMITE, para lo que llega de disco (un enum desconocido, una duración
  ≤ 0, un color que no es hex). Devuelve el valor limpio o `undefined` para descartarlo; el tipo
  básico ya lo comprueba `valor`. Lo aplica `sanearEfectos()` (`estado/saneado.ts`) en las cuatro
  puertas de entrada **y** en las tres de escritura de los almacenes, así que un efecto nuevo queda
  cubierto sin tocar el saneado. Descarta, no corrige: un valor inventado haría algo que nadie
  escribió. Si un dato con otro tipo llega al editor, revienta un `Gtk.Entry` (`text=` exige
  cadena), y si llega al motor, se pierde la notificación entera.
- **`validar`**: el mensaje que explica el error al guardar desde el editor. No sustituye a
  `sanear`: este protege la carga; aquel, la experiencia de quien edita.
- **`editor`**: el `tipo` de control. Los que existen son `interruptor`, `duracion`, `opciones`,
  `color`, `ruta-audio`, `condiciones` y `reescritura`. Ubicación: `seccion` (encabezado antes),
  `avanzado` (dentro del plegable) y `visibleSi` (p. ej. «Expira tras» solo con ciclo temporal).

### Un tipo de control nuevo

Si ninguno de los siete sirve, añade la variante a `ControlEditor` (`tipos.ts`) y su `case` en
`settings/controlesEfecto.tsx`. Una vez; los efectos siguientes de ese tipo ya no lo tocan.

**Trampa de gnim**, medida al escribir los controles: dentro de los `children` que reenvía un
componente (como `CampoEditor`), un hijo `null` o `false` **revienta** (`right-hand side of 'in'
should be an object`), y un array de más de un nivel también (`it's a Array`). gnim solo salta los
hijos falsos en el **primer nivel** de una llamada JSX; los que llegan dentro de un array pasan por
`append()`, que no los filtra. `CampoEditor` aplana y filtra los suyos; un componente nuevo que
reenvíe `children` tiene que hacer lo mismo.

## Una condición nueva

1. Su fichero en `rules/condiciones/` con `definirCondicion({ id, etiqueta, resumen, vigilar })`.
   `vigilar` recibe los servicios **inyectados**: no importes `gi://` en el descriptor, o deja de
   poder probarse con Node.
2. Una línea en `rules/condiciones/index.ts` (el orden es el de los botones del editor).
3. Sus textos.
4. Si necesita un servicio que aún no existe, añádelo a `ServiciosCondicion` (`tipos.ts`) y a su
   implementación real en `rules/conditions.ts`, el único fichero del motor con `gi://`.

Sin `etiqueta`, la condición funciona pero no se ofrece en el editor (como `update-applied`).

## Un campo de coincidencia nuevo

Ejemplo: la urgencia.

1. El campo en `MatchSpec` y en `NotifInput` (`rules/types.ts`).
2. Rellenarlo en `procesamiento/ingesta.ts`, al construir el `NotifInput`.
3. Su entrada en `COINCIDENCIAS` (`rules/coincidencias.ts`). El saneado de `match` y la guarda
   de expresiones regulares (`rules/regexSegura.ts`) lo cubren solos. Campos: `sujeto` (qué texto compara),
   `resumen`, `etiquetaValidacion` y, si se edita a mano, `editor.titulo`.
4. Sus textos.
