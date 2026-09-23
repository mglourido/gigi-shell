// servicios/dispositivos/printers.ts
//
// Lógica del bloque "Impresoras" de Entrada y periféricos
// (modulos/ajustes/dispositivos/SeccionDispositivos.tsx).
// Gestiona el servicio de impresión CUPS a nivel de systemd — nada que ver con
// la config de Hyprland de devices/service.ts, por eso vive en su propio módulo.
//
// Qué toca y con qué privilegios:
//   · Habilitar/deshabilitar CUPS → systemctl enable/disable --now de las units
//     cups presentes (socket + service). Pide contraseña vía polkit
//     (hyprpolkitagent), igual que cualquier cambio de servicio del sistema.
//   · Estado (instalado/activo/habilitado) → lectura sin privilegios con
//     systemctl is-enabled / is-active y list-unit-files.
//
// El patrón (snapshot + busy + refresh + pkexec bash -c) es el mismo que el de
// modulos/ajustes/fecha-idioma/fechaHora.ts (GeoClue), para no reinventar la rueda.

import { createState } from "ags"
import { execAsync } from "ags/process"
import { withPrivilegedPrompt } from "../../estado/shell"

export interface PrinterStatus {
  available: boolean   // existe la unit cups.service (CUPS instalado)
  enabled: boolean     // arranca automáticamente al iniciar
  active: boolean      // el servicio está corriendo ahora mismo
}

const EMPTY_STATUS: PrinterStatus = { available: false, enabled: false, active: false }

const [printerStatus, _setPrinterStatus] = createState<PrinterStatus>(EMPTY_STATUS)
const [printerBusy, _setPrinterBusy] = createState(false)
export { printerStatus, printerBusy }

// Units candidatas. CUPS usa activación por socket: en la mayoría de sistemas
// existen socket y service; el script solo actúa sobre las que realmente estén.
const CUPS_UNITS = ["cups.socket", "cups.service"]

function sh(script: string): Promise<string> {
  return execAsync(["bash", "-c", script]).then(o => o.trim()).catch(() => "")
}

// Lee el estado real del sistema y rellena el snapshot. Sin privilegios.
// `is-enabled`/`is-active` devuelven código ≠0 cuando una unit está deshabilitada
// o no existe; iteramos unit a unit y forzamos `true` al final para que la salida
// llegue siempre completa (si no, sh() la descartaría por el exit code).
export async function refresh() {
  const units = CUPS_UNITS.join(" ")
  const [unitFiles, enabled, active] = await Promise.all([
    // ¿Existe alguna unit cups instalada?
    sh(`systemctl list-unit-files ${units} 2>/dev/null; true`),
    // Habilitada si CUALQUIERA de las units arranca al inicio.
    sh(`for u in ${units}; do systemctl is-enabled "$u" 2>/dev/null; done; true`),
    // Activa si el servicio o su socket están en marcha.
    sh(`for u in ${units}; do systemctl is-active "$u" 2>/dev/null; done; true`),
  ])
  const available = /cups\.(service|socket)/.test(unitFiles)
  _setPrinterStatus({
    available,
    enabled: available && /(^|\n)\s*enabled/.test(`\n${enabled}`),
    active: available && /(^|\n)\s*active/.test(`\n${active}`),
  })
}

// Igual que en modulos/ajustes/fecha-idioma/fechaHora.ts: lo de dentro pide contraseña por polkit, y
// withPrivilegedPrompt aparta la ventana de Ajustes para que el diálogo se vea.
async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  _setPrinterBusy(true)
  try { return await withPrivilegedPrompt(fn) } finally { _setPrinterBusy(false); await refresh() }
}

// Habilita (arranca + autostart) o deshabilita (detiene + quita autostart) CUPS.
// El script filtra las units realmente presentes y separa enable/disable de
// start/stop: en muchas distros cups.service es «static» (solo se activa por
// cups.socket) y un `enable` combinado abortaría, así que enable/disable se hace
// por unit ignorando fallos y luego se arranca/detiene todo junto.
const PRESENT_UNITS =
  `present=""; for u in ${CUPS_UNITS.join(" ")}; do ` +
  `systemctl list-unit-files "$u" >/dev/null 2>&1 && present="$present $u"; done; ` +
  `[ -z "$present" ] && exit 0`

export function setCupsEnabled(on: boolean) {
  if (!printerStatus.get().available) return Promise.resolve()
  const script = on
    ? `${PRESENT_UNITS}; for u in $present; do systemctl enable "$u" 2>/dev/null || true; done; systemctl start $present`
    : `${PRESENT_UNITS}; systemctl stop $present 2>/dev/null || true; for u in $present; do systemctl disable "$u" 2>/dev/null || true; done`
  return withBusy(() => execAsync(["pkexec", "bash", "-c", script])
    .catch(e => { console.error("[printers] no se pudo cambiar CUPS:", e) }))
}

// Abre el panel de administración web de CUPS. Solo tiene sentido con el
// servicio activo (631 no responde si CUPS está parado).
export function openCupsWeb() {
  execAsync(["xdg-open", "http://localhost:631"])
    .catch(e => { console.error("[printers] no se pudo abrir el panel de CUPS:", e) })
}
