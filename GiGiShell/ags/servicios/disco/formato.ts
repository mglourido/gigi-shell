// servicios/disco/formato.ts — presentación de tamaños y porcentajes. Puro, sin GTK.
//
// Vive aparte del catálogo porque lo consumen las dos mitades de la sección (el desglose y el
// resultado de una limpieza) y porque es lo único aquí que tiene sentido probar exhaustivamente.
//
// UNIDADES BINARIAS (GiB, no GB), y es una decisión de coherencia, no de purismo: Ajustes >
// Sistema ya enseña la RAM y los discos en GiB, y `df`/`lsblk`/`pacman -Qi` —las tres fuentes de
// esta sección— también son binarias. Mezclar bases haría que el mismo disco saliera como 931 GiB
// en una pantalla y 1,0 TB en la de al lado.

const UNIDADES = ["B", "KiB", "MiB", "GiB", "TiB"] as const

/** Decimal con coma: la UI está en español, igual que `informacion.ts`. */
function decimal(valor: number, digitos: number): string {
  return valor.toFixed(digitos).replace(".", ",").replace(/,0+$/, "")
}

/**
 * Bytes legibles. `null` (no medible) y 0 (medido y vacío) se distinguen a propósito: una carpeta
 * que no se ha podido leer no es una carpeta vacía, y pintarlas igual haría creer que ya está
 * limpio lo que quizá son 40 GB sin permisos.
 */
export function formatearBytes(bytes: number | null | undefined, desconocido = "—"): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return desconocido
  if (bytes < 0) return desconocido
  if (bytes === 0) return "0 B"

  let valor = bytes
  let i = 0
  while (valor >= 1024 && i < UNIDADES.length - 1) {
    valor /= 1024
    i++
  }
  // Un dígito basta a partir de MiB; por debajo, los decimales sobran (no existe "512,3 B").
  return `${decimal(valor, i <= 1 ? 0 : 1)} ${UNIDADES[i]}`
}

/** Fracción 0..1 para una barra de progreso, acotada. Un `total` de 0 da 0, no NaN ni Infinity. */
export function fraccionUso(usado: number, total: number): number {
  if (!Number.isFinite(usado) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, usado / total))
}

/**
 * Severidad de un disco por su porcentaje de uso. Solo tres escalones: la barra cambia de color y
 * más de tres tonos no comunican nada.
 *
 * OJO: esto NO coincide con `hypr/scripts/disk-monitor.sh`, que avisa por **espacio libre
 * absoluto** (menos de 5 GB) y no por porcentaje, y es correcto que no coincidan: 10 % libre son
 * 100 GB en un disco de 1 TB (nada urgente) y 5 GB en uno de 50 (urgente). El color es una pista
 * de lectura del reparto; la notificación es la alarma. Si algún día se quieren alinear, lo que
 * hay que cambiar es esta función para que reciba también los bytes libres, no los umbrales del
 * script.
 */
export function severidadUso(porcentaje: number): "ok" | "aviso" | "critico" {
  if (porcentaje >= 90) return "critico"
  if (porcentaje >= 75) return "aviso"
  return "ok"
}

/** Fecha corta a partir del epoch en segundos del sondeo. Vacío si no hay sondeo. */
export function formatearFecha(epoch: number | null | undefined): string {
  if (!epoch || !Number.isFinite(epoch)) return ""
  const d = new Date(epoch * 1000)
  const dosDigitos = (n: number) => String(n).padStart(2, "0")
  return `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)}/${d.getFullYear()} ${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`
}
