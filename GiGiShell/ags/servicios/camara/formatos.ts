// servicios/camara/formatos.ts — la E/S de `formatosDatos.ts`.
import { execAsync } from "ags/process"
import { parsearFormatos, type Formato } from "./formatosDatos.ts"

export * from "./formatosDatos.ts"

/** Formatos soportados por un nodo. `[]` ante cualquier fallo: la ficha
 *  simplemente no se pinta, que es preferible a un error por una cámara que se
 *  ha desenchufado mientras se miraba. */
export async function leerFormatos(nodo: string): Promise<Formato[]> {
  try {
    return parsearFormatos(await execAsync(["v4l2-ctl", "-d", nodo, "--list-formats-ext"]))
  } catch (e) {
    console.error("[camara] list-formats-ext:", e)
    return []
  }
}
