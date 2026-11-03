// La notificación tal como entra a `ingest()`, venga de donde venga.
//
// Hay dos orígenes: AstalNotifd en vivo (`desdeAstal.ts`) y el fichero que deja el respaldo con AGS
// caído (`pendientes.ts`, escrito por `notif-respaldo/`). La ingesta no sabe de cuál viene: reglas,
// reescritura, deduplicación, tope e historial son el mismo código para los dos. Lo único que los
// separa es `diferida`, que apaga lo que no tiene sentido para algo que llegó hace rato.
//
// Puro (sin `gi://`) para que `pendientes.ts` y sus tests puedan importarlo.

export interface NotifEntrante {
  id: number
  /** `app_name` tal cual; la ingesta pone «Sistema» si viene vacío. */
  appName: string
  appIcon: string
  summary: string
  body: string
  urgency: number
  actions: { id: string; label: string }[]
  /** `expire_timeout` del spec, en ms (0 = no expira). */
  expireTimeout?: number
  image?: string
  /** Hora de llegada, en ms. En vivo es «ahora»; diferida, la que apuntó el respaldo. */
  timestamp: number
  /** Llegó con AGS caído: sin popup y sin sonido (decisión del usuario), ya pasó su momento. */
  diferida: boolean
  /** Un hint suelto, como texto. */
  hint(clave: string): string | undefined
  /** Un hint booleano (`suppress-sound`), tolerando 0/1 y "true". */
  hintBool(clave: string): boolean
  /** Todos los hints escalares como texto, para los marcadores de la reescritura. Puede ser caro
   *  (en vivo desempaqueta el `a{sv}` entero): solo se llama si una regla reescribe. */
  hintsTexto(): Record<string, string>
}
