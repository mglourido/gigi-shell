/** Cuándo se abre, se fija y se cierra la vista de escritorios. Puro: los temporizadores y la
 * ventana viven en `estado.ts`. */
export type EstadoCierre = "cerrado" | "sostenido" | "esperandoTab" | "fijado" | "fijadoUnToque"
export type EventoCierre = "tab" | "soltarTab" | "soltarSuper" | "expira" | "cerrar"
export type AccionCierre = "abrir" | "cerrar" | "armar" | "cancelar"

export interface PasoCierre {
  estado: EstadoCierre
  acciones: AccionCierre[]
}

const CERRADO: PasoCierre = { estado: "cerrado", acciones: ["cerrar"] }

/** Entre los dos toques de Tab la tecla está suelta: por eso soltarla no cierra al instante, sino
 * que arma un plazo. */
export function transicion(estado: EstadoCierre, evento: EventoCierre): PasoCierre {
  if (estado === "cerrado") {
    return evento === "tab" ? { estado: "sostenido", acciones: ["abrir"] } : { estado, acciones: [] }
  }
  if (evento === "cerrar") {
    return estado === "esperandoTab" || estado === "fijadoUnToque"
      ? { estado: "cerrado", acciones: ["cancelar", "cerrar"] }
      : CERRADO
  }
  switch (estado) {
    case "sostenido":
      if (evento === "soltarSuper") return CERRADO
      if (evento === "soltarTab") return { estado: "esperandoTab", acciones: ["armar"] }
      break
    case "esperandoTab":
      if (evento === "tab") return { estado: "fijado", acciones: ["cancelar"] }
      if (evento === "expira") return CERRADO
      if (evento === "soltarSuper") return { estado: "cerrado", acciones: ["cancelar", "cerrar"] }
      break
    case "fijado":
      if (evento === "tab") return { estado: "fijadoUnToque", acciones: ["armar"] }
      break
    case "fijadoUnToque":
      if (evento === "tab") return { estado: "cerrado", acciones: ["cancelar", "cerrar"] }
      if (evento === "expira") return { estado: "fijado", acciones: [] }
      break
  }
  return { estado, acciones: [] }
}
