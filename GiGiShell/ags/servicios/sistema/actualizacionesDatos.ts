export interface PaqueteActualizable { name: string; from: string; to: string }
export interface DatosActualizaciones {
  system: number
  kernel: PaqueteActualizable[]
  gpu: PaqueteActualizable[]
  updateCmd: string
  systemSample: string[]
}

export const ACTUALIZACIONES_VACIAS: DatosActualizaciones = {
  system: 0,
  kernel: [],
  gpu: [],
  updateCmd: "",
  systemSample: [],
}

export function interpretarActualizaciones(contenido: string): DatosActualizaciones {
  try {
    const datos = JSON.parse(contenido)
    const paquetes = (valor: unknown): PaqueteActualizable[] => Array.isArray(valor)
      ? valor.filter((paquete: any) => paquete && typeof paquete.name === "string")
        .map((paquete: any) => ({
          name: paquete.name,
          from: typeof paquete.from === "string" ? paquete.from : "",
          to: typeof paquete.to === "string" ? paquete.to : "",
        }))
      : []
    return {
      system: typeof datos.system === "number" && datos.system >= 0 ? datos.system : 0,
      kernel: paquetes(datos.kernel),
      gpu: paquetes(datos.gpu),
      updateCmd: typeof datos.updateCmd === "string" ? datos.updateCmd : "",
      systemSample: Array.isArray(datos.systemSample)
        ? datos.systemSample.filter((nombre: unknown) => typeof nombre === "string")
        : [],
    }
  } catch (_) {
    return ACTUALIZACIONES_VACIAS
  }
}
