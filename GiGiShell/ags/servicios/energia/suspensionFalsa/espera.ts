// servicios/energia/suspensionFalsa/espera.ts
//
// Un `sleep` para el bucle de GLib. No existe `setTimeout` con promesa en este runtime, y
// hacerlo con `GLib.usleep` BLOQUEARÍA el bucle principal: la UI se congelaría y, peor, los
// callbacks de Hyprland tienen timeout de 100 ms (ver el CLAUDE.md raíz). `timeout_add`
// cede el control y resuelve cuando toca.
//
// Lo usan el efector de TLP (esperar a que el helper root suelte el testigo) y el de
// Bluetooth (los reintentos del dongle mientras se reenumera). No es un `utilidades/` porque
// fuera de aquí nadie lo ha pedido todavía; si aparece un tercer consumidor, se sube.
import GLib from "gi://GLib"

export function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolver()
      return GLib.SOURCE_REMOVE
    })
  })
}
