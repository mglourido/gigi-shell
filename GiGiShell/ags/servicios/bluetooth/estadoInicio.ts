export type EstadoRestauracionBluetooth = {
  accion: boolean | null
  completada: boolean
}

/**
 * @param asentado `true` cuando al adaptador ya se le ha dado tiempo a estabilizarse.
 *
 * BlueZ enciende el controlador él solo en cuanto lo encuentra (`AutoEnable`, activado
 * por defecto en `/etc/bluetooth/main.conf`) y lo hace DESPUÉS de registrar el adaptador.
 * Queda pues una ventana en la que el adaptador ya existe y todavía está apagado: si ahí
 * damos la restauración por terminada solo porque el estado coincide con el objetivo, el
 * power-on de BlueZ llega justo después, nadie lo corrige, y `guardarEstadoSistema` lo
 * adopta como si lo hubiera pedido el usuario — reescribiendo `bluetooth: true` y
 * borrando su "apagado" para siempre. Por eso "coincide" NO basta para cerrar: hace falta
 * además que el adaptador se haya asentado. Mientras no lo esté no se actúa (no se pelea
 * con nada), pero la restauración sigue viva y corrige cualquier encendido que llegue.
 */
export function resolverRestauracionBluetooth(
  objetivo: boolean | null,
  adaptadorDisponible: boolean,
  encendido: boolean,
  asentado: boolean,
): EstadoRestauracionBluetooth {
  if (objetivo === null) return { accion: null, completada: true }
  if (!adaptadorDisponible) return { accion: null, completada: false }
  if (encendido === objetivo) return { accion: null, completada: asentado }
  return { accion: objetivo, completada: false }
}

export type VentanaRestauracionBluetooth = {
  completada: boolean
  asentado: boolean
}

/**
 * Ventana de restauración a reabrir cuando el adaptador cambia de generación.
 *
 * Un dongle USB **no es un adaptador estable**: al volver de una suspensión el kernel lo
 * reenumera (recarga el firmware) y BlueZ lo registra como si acabara de aparecer, así que
 * su `AutoEnable` lo enciende otra vez — exactamente el mismo encendido que
 * `resolverRestauracionBluetooth` corrige en el arranque, solo que a mitad de sesión. Con la
 * restauración ya cerrada nadie lo corregía y `registrarEstadoBluetoothConfirmado` lo adoptaba
 * como decisión del usuario: el "apagado" se reescribía a `true` en `system_state.json` y en la
 * sesión siguiente ya no quedaba nada que restaurar. Reabrir la ventana en cada generación
 * nueva del adaptador es lo que convierte aquella corrección de arranque en una permanente.
 *
 * Sin intención guardada no se reabre nada: no hay objetivo que restaurar y mantener la ventana
 * viva solo retrasaría la adopción de lo que haga el usuario.
 */
export function reabrirVentanaRestauracion(intencion: boolean | null): VentanaRestauracionBluetooth {
  if (intencion === null) return { completada: true, asentado: true }
  return { completada: false, asentado: false }
}

export function valorBluetoothParaGuardar(
  objetivo: boolean | null,
  restauracionCompletada: boolean,
  adaptadorDisponible: boolean,
  encendido: boolean,
): boolean | null {
  if (objetivo !== null && (!restauracionCompletada || !adaptadorDisponible)) return objetivo
  return adaptadorDisponible ? encendido : null
}
