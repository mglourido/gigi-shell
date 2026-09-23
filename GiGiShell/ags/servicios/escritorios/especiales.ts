// Escritorios ESPECIALES (el scratchpad de Hyprland): lo puro que necesitan
// tanto el despacho (`operaciones.ts`) como la barra (`modulos/barra/escritorios/`).
//
// Vive en `servicios/` y no bajo `barra/` por el mismo motivo que
// `servicios/ventanas/emergentesX11.ts`: lo consumen dos capas, y meterlo en el
// widget obligaría a `servicios/` a importar hacia arriba.

/** Los especiales son los de id negativo. Hyprland reparte -98, -97… por orden
 *  de aparición, así que el signo es la única parte estable: no se puede casar
 *  contra un -98 literal. */
export function esEscritorioEspecial(id: number): boolean {
  return id < 0
}

// El nombre acaba dentro de un literal de cadena Lua en `hyprctl dispatch`, así
// que se valida en origen igual que `temaCursor` en devices.json: solo nombres
// inocuos. Uno raro devuelve null y quien llama no despacha nada — preferible a
// interpolar comillas en el código que ejecuta el compositor.
const NOMBRE_VALIDO = /^[A-Za-z0-9._+-]+$/

/** El `<algo>` de `special:<algo>`, que es lo que espera `toggle_special`. Null
 *  si el nombre no es de un especial o no es seguro de interpolar. */
export function nombreEspecialEscritorio(nombre: string): string | null {
  if (!nombre.startsWith("special:")) return null
  const propio = nombre.slice("special:".length)
  return NOMBRE_VALIDO.test(propio) ? propio : null
}
