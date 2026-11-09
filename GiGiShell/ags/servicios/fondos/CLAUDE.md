# CLAUDE.md — Fondos

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: planificador de franjas horarias y acento adaptativo.

- `servicios/fondos/planificador.ts` — **el reloj que hace que las franjas horarias de fondos sirvan
  de algo**: duerme hasta el próximo límite y entonces pide `wallpaper.sh --auto`. No decide nada (ni
  qué fondo toca ni cuándo es el próximo límite: las dos cosas se las pregunta a
  `wallpaper-select.py`), y va con el resto de `init*` de fondo del `setTimeout` de 4 s porque lee el
  reloj de pared y no siembra de eventos.
  - **Un solo temporizador, armado exacto y sin sondeo**: entre dos cambios de franja no hay ni un
    despertar. El tiempo que se duerme es el del próximo límite **relevante**, que depende del estado
    — con un grupo puesto solo cuentan **sus** tramos (sus variantes no miran las franjas globales),
    y con un fondo suelto solo las franjas globales. Sin límites relevantes no se arma nada.
  - **Se rearma con el fichero de ESTADO, no solo con el de config**: aplicar un grupo cambia por
    completo qué límites importan, así que `wallpaper.json` se vigila igual que `wallpapers.json`.
  - **⚠️ La suspensión se cubre con `PrepareForSleep` de logind, no troceando el temporizador.**
    `GLib.timeout_add` cuenta sobre el reloj monotónico, que no avanza dormido: una espera de ocho
    horas sonaría ocho horas de *actividad* después (suspendes de día, despiertas de noche). La
    primera versión troceaba a 15 min — 96 despertares diarios para no hacer nada casi ninguno — y la
    señal lo resuelve mejor y sin coste. Si algún día se quita, hay que devolver el troceo.
  - Fail-open hacia "las franjas no cambian el fondo". Detalle completo en `docs/hyprland-modulos.md` § «Franjas horarias y grupos de fondos».
- `servicios/fondos/acento.ts` + `acentoCss.ts` + `acentoCache.ts` + `scripts/acento-fondo.py` —
  **el acento adaptativo**: los tres colores de acento del tema salen del fondo de escritorio. El
  reparto es: el script (Pillow) extrae la paleta, `acentoCss.ts` la valida y la convierte en una
  hoja de una línea que redefine `--acento*`, `acentoCache.ts` decide qué se recuerda y `acento.ts`
  es lo único que toca GTK. Apagarlo es **vaciar la hoja**, con lo que cada `var(--acento…, <color
  de siempre>)` de `out.css` cae en su reserva — mismo mecanismo que `opacidadAhorro.ts`.
  - **En segundo plano no consume NADA, y conviene saber por qué antes de tocarlo**: no hay
    temporizador ni sondeo, solo dos suscripciones (`currentWallpaper`, que se mueve por el
    `Gio.FileMonitor` de `wallpaper.json`, o sea inotify; y la preferencia). Un `Accessor` de
    `createState` **no notifica si el valor no cambia** (`Object.is`), así que reescribir
    `wallpaper.json` con el mismo fondo —el toggle de "aleatorio al iniciar", una franja que vuelve a
    sortear la misma imagen, el `_setCurrentWallpaper` optimista de `applyWallpaper` seguido de la
    escritura de `wallpaper.sh`— **no lanza nada**. Si algún día esto gasta CPU con el escritorio
    quieto, el fallo está en quien llame a `recalcular()`.
  - **La paleta de cada fondo se CACHEA en `~/.cache/gigishell/acento-fondo.json`** (48 entradas, la más
    reciente delante). El extractor cuesta ~150 ms de media y hasta 480 ms con los PNG más grandes de
    la carpeta (medido sobre los 64 fondos reales), y ese coste se pagaba **entero en cada cambio de
    fondo y en cada inicio de sesión**, siempre por las mismas imágenes: con franjas horarias el
    fondo rota entre un puñado fijo. Con caché, acertar es un `stat` y se pinta **síncrono**, sin
    fork y sin un fotograma con el acento anterior.
  - **La clave es un sello, y lleva dentro el mtime del PROPIO script.** Editar `acento-fondo.py`
    invalida la caché entera por construcción; sin eso, tocar los umbrales y seguir viendo los
    colores viejos sería un fallo mudo perfecto. La imagen se sella con tamaño + mtime, igual que la
    caché de miniaturas de `modulos/orion/services/wallpaperThumbs.ts`.
  - **Se cachea también "este fondo no tiene acento"**, que es una respuesta legítima (un fondo en
    blanco y negro, un boceto a lápiz): si no, justo esos fondos serían los únicos que forkearían
    siempre. Lo demás que falla (Pillow ausente, imagen a medio copiar) **no** se cachea, porque es
    del entorno y dejaría el tema de fábrica clavado hasta vaciar la caché a mano. El extractor los
    distingue escribiendo `sin-acento` en **stderr** — `execAsync` entrega stderr pero **no** el
    código de salida, así que la marca no podía ir en el `rc`.
  - **⚠️ El fondo de la barra NO es una constante, y el extractor mide el contraste contra el
    vigente.** Es el tema de Ajustes > Personalización (negro `8,8,12` / grafito `24,24,32` / gris
    `32,32,32`), que se cambia en cualquier momento. `acento.ts` lo pasa en
    `--fondo-barra=#rrggbb` (los RGB salen de `rgbFondoShell()` en `servicios/apariencia/fondoShellVar.ts`,
    única fuente en TS), **se suscribe a `fondoShell`** y recalcula al cambiarlo, y el **sello de la
    caché lo incluye**: sin eso la paleta guardada, corregida contra otro tema, se serviría con un
    contraste que ya no es el real (fallo mudo, sin error). Antes estaba fijo a `8,8,12` en el script:
    con grafito o gris el contraste real quedaba por debajo de 4.5. Un valor mal formado en la opción
    sale con rc 1 y motivo en stderr, no cae al negro. La corrección sube el brillo, o sea que da por
    hecho un fondo **oscuro**: un tema claro nuevo exigiría tratarlo aparte. Si se añade un tema,
    hay que darlo de alta en `fondoShellVar.ts` (y en `_colores.scss`); el script no necesita cambios.
  - **Ajustes avanzados** (Ajustes > Personalización > Diseño, desplegable bajo «Enfatizar»,
    `modulos/ajustes/personalizacion/AcentoAvanzado.tsx`): cada umbral del extractor con un
    deslizador, los tres acentos fijables a mano y «Restablecer valores». **Dos JSON, un dueño
    cada uno**: `ags/config/acento-parametros.json` (versionado) son los valores **de fábrica** con
    rango, paso y grupo, y es la **única** fuente: de ahí salen los valores por defecto del propio
    `acento-fondo.py` y los deslizadores (un parámetro nuevo en ese JSON aparece solo en la UI; le
    falta solo su texto en `textos/ajustes/personalizacion.json`). `~/.config/gigishell/acento.json`
    son los del usuario, que escribe solo `acentoPreferencias.ts`; «Restablecer» copia la fábrica
    encima. Ese JSON de fábrica está en el `KEEP_IN_REPO` de `bin/link.sh`: **sin eso, `link.sh` lo
    migraría a `~/.config/gigishell/`** como si fuera un dato de usuario y el script dejaría de
    arrancar (rc 1 «fallo», el tema de fábrica sin explicación visible).
    - Reglas puras en `acentoAjustes.ts` (hay test): todo valor se acota a rango y paso, una clave
      desconocida se descarta, y los pares mín/máx (`satMin`/`satMax`, brillo del candidato,
      relajado ≤ normal) se fuerzan a `mínimo ≤ máximo` — desordenados no dan error pero vacían el
      rango y **todo** fondo sale sin acento. El script vuelve a acotar contra el mismo JSON y
      trata una clave desconocida o un no-número como fallo (rc 1), no lo ignora.
    - **Los parámetros entran en el sello de la caché** y se pasan **todos**, en orden fijo
      (`--parametros=<json>`): así también un cambio en el JSON de fábrica invalida las paletas
      viejas. Los **acentos fijados a mano NO** entran: se aplican encima (`paletaEfectiva`) y un
      cambio de color acierta en caché, sin `python3`. Con un acento fijado y un fondo sin color, los
      no fijados toman su color de fábrica (`ACENTOS_FABRICA`, que tiene que coincidir con las
      reservas de `acento*()` en `_colores.scss`).
    - En vivo pero con **dos retardos**: 350 ms para recalcular (un deslizador emite un valor por
      píxel y con la caché fría cada uno sería un proceso) y 400 ms para escribir el fichero.
  - **Los colores de la caché se re-normalizan al leer**, no se dan por buenos por venir de "nuestro"
    fichero: acaban concatenados dentro de una hoja de estilo y `~/.cache` es texto que cualquiera
    puede editar. Es la misma frontera de confianza que `normalizarHexAcento` aplica a la salida del
    script (hay test).
  - **La saturación HSV no descarta grises, pero el croma absoluto tampoco basta solo** — y las dos
    mitades están medidas. `#010000` tiene `s = 1.0`, así que filtrar por `s` deja pasar colores cuyo
    tono es ruido de cuantización (era el bug del rojo inventado en `gojo.png`); y el croma es
    absoluto, así que un beige (`#c0b0a7`) o una tinta china sobre crema (`#f0ebd8`) lo pasan de
    sobra mientras la corrección los sube a `s = 0.42` **conservando el tono**, o sea inventando un
    naranja de una foto gris de un gato y un amarillo de un dibujo en blanco y negro. El filtro son
    los **dos** suelos a la vez (croma ≥ 24 y `s` ≥ 0.20, con un segundo intento más laxo para
    paletas apagadas). De regalo arregla el caso simétrico: en una foto con neones, un cielo lavado
    que ocupa media imagen le ganaba el acento principal por cobertura.
  - **El decodificado usa `im.draft()` antes del `convert`**: le pide al decodificador JPEG que
    descomprima ya reducido (escalas 1/2, 1/4, 1/8 del DCT), ~30 % menos por fondo, y en PNG no hace
    nada — así los resultados de esos no cambian ni un dígito. El `convert("RGB")` **va antes del
    `thumbnail`** a propósito: reducir en modo P resamplea índices con NEAREST y cambia los colores
    que se miden.
