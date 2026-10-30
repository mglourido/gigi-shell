// modulos/cuenta-atras/puente.ts
//
// Puente para lo que corre fuera de AGS (Lua de Hyprland, bash), que no puede importar
// mostrarCuentaAtras: traduce el request a esa misma función y no tiene lógica del menú.
//
//   ags request cuenta-atras <accion> <segundos> id=<id> ayuda="<texto>" cancelar="<comando>"
//   ags request cuenta-atras-cerrar id=<id>
//
// Con reserva, por hypr/scripts/pedir-ags.sh. Se registran en ags/puentes.ts.
//
// Son `clave=valor` y no `--clave valor` porque `ags request` rechaza las banderas que no
// conoce («unknown flag»). El comando de cancelar lo ejecuta AGS con `sh -c`: no da ningún
// privilegio nuevo, porque el request solo lo puede mandar el mismo usuario.
import { execAsync } from "ags/process"
import { cerrarCuentaAtras, mostrarCuentaAtras } from "./CuentaAtras"

function leerOpciones(args: string[]): Map<string, string> {
  const opciones = new Map<string, string>()
  for (const arg of args) {
    const corte = arg.indexOf("=")
    if (corte > 0) opciones.set(arg.slice(0, corte), arg.slice(corte + 1))
  }
  return opciones
}

/** Atiende `cuenta-atras`. Devuelve la respuesta del request. */
export function abrirDesdeFuera(args: string[]): string {
  const [accion = "", segundos] = args
  const opciones = leerOpciones(args.slice(2))
  const id = opciones.get("id")
  const ayuda = opciones.get("ayuda")
  const comando = opciones.get("cancelar")
  if (!id || !ayuda || !comando) return "error: faltan id, ayuda o cancelar"
  const abierta = mostrarCuentaAtras({
    accion,
    segundos: Number(segundos),
    id,
    ayuda,
    cancelar: () => execAsync(["sh", "-c", comando]),
  })
  return abierta ? "ok" : "error: acción o segundos no válidos"
}

/** Atiende `cuenta-atras-cerrar`. Devuelve la respuesta del request. */
export function cerrarDesdeFuera(args: string[]): string {
  const id = leerOpciones(args).get("id")
  if (!id) return "error: falta id"
  cerrarCuentaAtras(id)
  return "ok"
}
