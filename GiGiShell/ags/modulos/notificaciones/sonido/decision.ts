// ¿Debe sonar esta notificación? Lógica pura, sin GTK ni procesos.
//
// **La decisión vive fuera del calendario a propósito.** Las alarmas y el temporizador no
// reproducen nada por su cuenta: emiten una notificación normal con los campos de sonido estándar y
// el subsistema de notificaciones decide. Así el No molestar, las reglas del usuario y el silencio
// por app se aplican a las alarmas sin escribir una línea más, y cualquier función futura que quiera
// sonar hereda el mismo contrato en vez de inventarse el suyo.
//
// Los tres campos son los del spec de escritorio de freedesktop, que AstalNotifd ya expone como
// hints: `sound-name` (nombre del tema de sonidos, p. ej. `alarm-clock-elapsed`), `sound-file`
// (ruta absoluta) y `suppress-sound` (el emisor pide explícitamente silencio).

export interface EntradaSonido {
  /** Hint `sound-name`. */
  soundName?: string
  /** Hint `sound-file`, ruta absoluta. */
  soundFile?: string
  /** Hint `suppress-sound`: quien la envía pide que no suene. */
  suppressSound?: boolean
  /** Ruta del audio fijado por el usuario en una regla (`EffectSpec.soundFile`). No viene de la
   *  notificación: viene de la configuración, y por eso puede dar sonido a una que no lo pedía. */
  sonidoRegla?: string
  /** No molestar activo en el daemon. */
  noMolestar: boolean
  /**
   * El silencio vigente lo gobierna la **suspensión falsa**, no el usuario.
   *
   * Lo calcula `silencioDeSuspensionFalsa()` (`servicios/energia/suspensionFalsa/dnd.ts`) y es
   * la pieza que evita el peor fallo de esa función: el DND que se enciende al entrar dejaría
   * **las alarmas mudas**, porque aquí abajo No molestar calla el sonido y una crítica no se lo
   * salta. Un despertador que no suena porque el equipo estaba en suspensión falsa no da ningún
   * error: solo un usuario que se queda dormido.
   *
   * Con esta marca el DND sigue tapando los popups igual, pero el sonido pasa a decidirlo los
   * dos ajustes de abajo. Falso —el caso normal, y también el DND **manual** del usuario, que
   * no cambia de comportamiento en absoluto— deja la lógica de siempre intacta.
   */
  dndSuspensionFalsa?: boolean
  /** Ajuste `sfSilenciarNotificaciones` (por defecto **sí**). Solo pinta con
   *  `dndSuspensionFalsa`. Ausente = se calla, que es su valor de fábrica. */
  sfSilenciarNotificaciones?: boolean
  /** Ajuste `sfSilenciarReloj` (por defecto **no**). Solo pinta con `dndSuspensionFalsa`.
   *  Ausente = **suena**: el defecto y el fallback apuntan los dos hacia el mismo lado, que es
   *  el único en el que equivocarse no cuesta una alarma perdida. */
  sfSilenciarReloj?: boolean
  /** Hint `x-gigishell-source` de la notificación. Lo único que hace falta de él aquí es
   *  reconocer las alertas del reloj (`alarm`); ver `esAlertaReloj`. */
  origen?: string
  /** `meta.muteAudio`, calculado por el motor de reglas. */
  muteAudio: boolean
  /** Urgencia D-Bus: 0 baja, 1 normal, 2 crítica. */
  urgencia?: number
}

export type MotivoSilencio =
  | "sin-sonido"
  | "suppress-sound"
  | "no-molestar"
  | "suspension-falsa"
  | "regla"

/**
 * Expande un `~` inicial. Una ruta la teclea una persona en el editor de reglas o en el
 * formulario de alarmas, y ahí `~/Música/aviso.ogg` es lo natural de escribir; sin expandirlo
 * el reproductor buscaría un directorio llamado `~` y fallaría **en silencio**, que es el peor
 * modo de fallo posible para esta función.
 */
export function expandirRuta(ruta: string, home: string): string {
  if (ruta === "~") return home
  return ruta.startsWith("~/") ? home + ruta.slice(1) : ruta
}

/** ¿Es una ruta de fichero y no el nombre de un sonido del tema? Se decide por la forma, que es
 *  lo único que hay: los nombres de tema (`bell`, `alarm-clock-elapsed`) no llevan barras. */
export function esRuta(valor: string): boolean {
  return valor.startsWith("/") || valor.startsWith("~/")
}

export type DecisionSonido =
  | { reproducir: true; tipo: "archivo"; recurso: string }
  | { reproducir: true; tipo: "tema"; recurso: string }
  | { reproducir: false; motivo: MotivoSilencio }

/**
 * Decide si suena y con qué.
 *
 * El orden de las guardas importa y no es arbitrario:
 *
 * 1. **Nadie ha pedido sonido → silencio.** Es la puerta más importante: sin ella, activar el audio
 *    convertiría en sonora *toda* notificación del sistema, cuando la intención es que solo suenen
 *    las que lo piden. No hay sonido por defecto.
 * 2. **`suppress-sound` gana a todo lo demás.** Lo pone quien emite, que es quien sabe si ya ha
 *    sonado por otro canal (típico de los reproductores de música).
 * 3. **No molestar**, la **suspensión falsa** y después las **reglas** (`muteAudio`). Las tres
 *    silencian; se distinguen solo para poder explicarlo en las pruebas y en los logs.
 *
 * Una crítica **no** se salta el No molestar. Aquí sí sería tentador —«esto es importante»— pero el
 * usuario que activa No molestar está pidiendo silencio, y la notificación sigue viéndose.
 *
 * La **suspensión falsa** es la única excepción a esa regla, y no lo es por urgencia sino por
 * autoría: ese DND no lo ha pedido el usuario, lo pone la función al entrar. Ver
 * `dndSuspensionFalsa`.
 */
export function decidirSonido(entrada: EntradaSonido): DecisionSonido {
  const personalizado = entrada.sonidoRegla?.trim()
  const archivo = entrada.soundFile?.trim()
  const tema = entrada.soundName?.trim()
  if (!personalizado && !archivo && !tema) return { reproducir: false, motivo: "sin-sonido" }

  // `suppress-sound` lo pone el emisor porque ya ha sonado por su cuenta; un sonido puesto a mano
  // en una regla es una orden posterior y más específica del usuario sobre *esa* notificación, así
  // que le gana. El No molestar y el silencio por regla, no: los dos son «quiero silencio», y el
  // segundo convive con este campo en la misma pantalla (fijar ambos es contradictorio y manda el
  // que calla).
  if (entrada.suppressSound && !personalizado) return { reproducir: false, motivo: "suppress-sound" }

  // El DND MANUAL primero, y sin matices: quien lo enciende pide silencio y lo tiene, alarmas
  // incluidas. `dndSuspensionFalsa` ya viene a false cuando el DND vigente es del usuario (lo
  // decide `silencioDeSuspensionFalsa()`, que es quien sabe quién lo encendió), así que aquí no
  // hay que volver a distinguirlo.
  if (entrada.noMolestar && !entrada.dndSuspensionFalsa) {
    return { reproducir: false, motivo: "no-molestar" }
  }

  // Suspensión falsa: manda el ajuste, no el DND. Y se comprueba aunque `noMolestar` sea false,
  // porque los dos ajustes de silencio son independientes de él — se puede querer el audio
  // callado sin tapar los popups, y con el ajuste de DND apagado esta rama es la única que
  // queda.
  if (entrada.dndSuspensionFalsa) {
    const callar = esAlertaReloj(entrada)
      // Alarma / temporizador / cronómetro: SUENAN salvo que se pida lo contrario a propósito.
      // El `=== true` no es paranoia de estilo: un campo ausente tiene que caer del lado del
      // despertador que suena, nunca del que se queda mudo sin decir nada.
      ? entrada.sfSilenciarReloj === true
      // Notificación normal: se calla salvo que se pida lo contrario. Aquí el valor de fábrica
      // es el silencio, así que el fallback lo acompaña.
      : entrada.sfSilenciarNotificaciones !== false
    if (callar) return { reproducir: false, motivo: "suspension-falsa" }
  }

  if (entrada.muteAudio) return { reproducir: false, motivo: "regla" }

  // Lo que fija el usuario manda sobre lo que pida la notificación: es el único punto del sistema
  // donde se puede cambiar el sonido de un aviso ajeno.
  if (personalizado) return { reproducir: true, tipo: "archivo", recurso: personalizado }

  // El fichero manda sobre el nombre de tema: es más específico y no depende de que el tema de
  // sonidos instalado tenga esa entrada.
  if (archivo) return { reproducir: true, tipo: "archivo", recurso: archivo }
  return { reproducir: true, tipo: "tema", recurso: tema! }
}

/** Nombre de tema estándar para las alertas del reloj. Existe en el tema freedesktop. */
export const SONIDO_ALARMA = "alarm-clock-elapsed"

/** Nombre de tema para el fin del temporizador. */
export const SONIDO_TEMPORIZADOR = "complete"

/** Valor del hint `x-gigishell-source` con el que el reloj emite sus alertas (`estadoReloj.ts`).
 *  No es `system` a propósito: eso activaría el skin dunst de los avisos de `hypr/scripts`. */
export const ORIGEN_RELOJ = "alarm"

/**
 * ¿Es esta notificación una alerta del reloj (alarma, temporizador o cronómetro)?
 *
 * Se reconoce por lo que el reloj YA emite —el hint de origen y los dos nombres de tema— y no
 * por un canal nuevo: inventarse uno obligaría a mantener dos formas de decir lo mismo, y la
 * que se olvidara de actualizar dejaría una alerta sin reconocer, o sea muda durante la
 * suspensión falsa. Se miran las dos señales porque **ninguna basta sola**: una alarma con
 * sonido personalizado no lleva `SONIDO_ALARMA` (viaja como `sound-file`), y un aviso ajeno
 * podría pedir `alarm-clock-elapsed` sin venir del reloj — y en ese caso tratarlo como alerta
 * es lo correcto de todos modos: lo que se está preguntando es «¿esto es un despertador?».
 */
export function esAlertaReloj(entrada: Pick<EntradaSonido, "origen" | "soundName">): boolean {
  if (entrada.origen?.trim() === ORIGEN_RELOJ) return true
  const tema = entrada.soundName?.trim()
  return tema === SONIDO_ALARMA || tema === SONIDO_TEMPORIZADOR
}

/**
 * Comando de reproducción como **array de argumentos**, nunca una cadena para `sh -c`.
 *
 * El nombre del sonido y la ruta pueden venir de una notificación ajena —cualquier proceso de la
 * sesión puede mandar hints—, así que pasar por un shell convertiría un `sound-file` malicioso en
 * ejecución de comandos. Con argv no hay nada que interpretar.
 *
 * `null` = no hay reproductor utilizable.
 */
export function comandoReproduccion(
  decision: DecisionSonido,
  disponible: (programa: string) => boolean,
): string[] | null {
  if (!decision.reproducir) return null

  if (decision.tipo === "tema") {
    // Solo canberra entiende nombres de tema: resuelve el `.oga` según el tema instalado y el
    // idioma. Sin él, un `sound-name` no se puede reproducir — y eso es correcto, no un fallo que
    // haya que suplir adivinando rutas.
    return disponible("canberra-gtk-play") ? ["canberra-gtk-play", "-i", decision.recurso] : null
  }

  for (const programa of ["canberra-gtk-play", "pw-play", "paplay"]) {
    if (!disponible(programa)) continue
    return programa === "canberra-gtk-play"
      ? ["canberra-gtk-play", "-f", decision.recurso]
      : [programa, decision.recurso]
  }
  return null
}

// ── Biblioteca de audio propia (`~/GiGiShell/audio`) ────────────────────────────────────────────
//
// Un `sound-name` solo lo sabe resolver `canberra-gtk-play` contra el **tema de sonidos
// instalado**, así que sin `sound-theme-freedesktop` en el sistema las alarmas y el temporizador
// —que piden `alarm-clock-elapsed` y `complete`— se quedaban mudos **sin un solo error**: canberra
// no encuentra la entrada, sale 0 y no suena nada. La carpeta `audio/` del repo lleva esos audios
// dentro, y aquí se resuelve un nombre de tema contra ella ANTES de delegar en canberra. Sigue
// habiendo delegación: lo que no esté en la carpeta (un `sound-name` de una app cualquiera) va al
// tema como siempre.

/** Extensiones que se prueban para un nombre de tema, en orden de preferencia. */
export const EXTENSIONES_AUDIO = ["oga", "ogg", "wav", "mp3"] as const

/**
 * ¿Es un nombre de tema que se puede convertir en nombre de fichero sin peligro?
 *
 * **Esto es una guarda de seguridad, no una validación cosmética.** El `sound-name` llega por
 * D-Bus desde cualquier proceso de la sesión, y se va a concatenar a un directorio: sin filtrar,
 * un `../../.ssh/id_ed25519` se convertiría en una ruta fuera de la carpeta que el reproductor
 * pasaría a `paplay`. Se admite solo el alfabeto de los nombres del spec (letras, dígitos, `-`,
 * `_`, `.`), y ningún punto inicial —que además descarta `..` de un plumazo.
 */
export function nombreTemaSeguro(nombre: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(nombre)
}

/** Rutas candidatas para un nombre de tema dentro de `dir`, en orden. Vacío si el nombre no es
 *  seguro: no se inventa una ruta a partir de algo que no se puede usar como nombre de fichero. */
export function candidatosTema(nombre: string, dir: string): string[] {
  const limpio = nombre.trim()
  if (!nombreTemaSeguro(limpio)) return []
  return EXTENSIONES_AUDIO.map((ext) => `${dir}/${limpio}.${ext}`)
}
