import { obtenerEntradaEscritorio } from "../../../servicios/aplicaciones/entradasEscritorio"
import { obtenerGlifoAplicacion } from "../../../servicios/aplicaciones/glifos"
import {
  obtenerIconoGenericoAplicacion,
  obtenerIconoOriginalAplicacion,
  obtenerNombreIconoAplicacion,
} from "../../../servicios/aplicaciones/iconos"
import { esClienteJuego } from "../../../servicios/juegos/evidencia"
import { describirJuego, GLIFO_JUEGO } from "../../../servicios/juegos/iconos"
import { construirDescripcionEscritorio } from "./descripcion"
import type { ClienteEscritorio, IconoClienteEscritorio } from "./modelo"

function construirDescripcion(cliente: ClienteEscritorio): string {
  const claseAplicacion = cliente.class ?? ""
  const nombreEntrada = obtenerEntradaEscritorio(cliente)?.nombre ?? ""
  const nombreAplicacion = nombreEntrada
    || (esClienteJuego(cliente) ? describirJuego(cliente).nombre : "")
  return construirDescripcionEscritorio({
    nombreAplicacion,
    claseAplicacion,
    claseInicial: cliente.initialClass ?? cliente.initial_class,
    titulo: cliente.title,
  })
}

export function obtenerIconosClientesEscritorio(
  clientes: readonly ClienteEscritorio[],
): IconoClienteEscritorio[] {
  return clientes
    .filter((cliente) => !!cliente.class)
    .map((cliente) => {
      const claseAplicacion = cliente.class ?? ""
      const comunes = {
        direccion: cliente.address,
        claseAplicacion,
        // Función, no cadena: el tooltip es el único dato de la lista que nadie ve
        // hasta que el puntero se para encima, y el más caro de armar (regex sobre
        // el título, entrada .desktop y, si no la hay, detección de juego, que lee
        // /proc). Aplazarlo lo saca del camino de `actualizar()`, que corre ante
        // cualquier señal de Hyprland —incluido cruzar el ratón entre ventanas con
        // `follow_mouse`— y para TODOS los clientes del monitor. Al leer el cliente
        // vivo, además, el título que sale es el del momento del hover.
        descripcion: () => construirDescripcion(cliente),
      }
      const glifo = obtenerGlifoAplicacion(
        claseAplicacion,
        cliente.initialClass ?? cliente.initial_class,
      )
      if (glifo) return { ...comunes, icono: glifo, iconoGio: null, esGlifo: true }

      const iconoOriginal = obtenerIconoOriginalAplicacion(cliente)
      if (iconoOriginal) {
        return {
          ...comunes,
          icono: iconoOriginal.to_string() ?? claseAplicacion,
          iconoGio: iconoOriginal,
          esGlifo: false,
        }
      }

      const nombreIcono = obtenerNombreIconoAplicacion(cliente)
      if (nombreIcono) {
        return { ...comunes, icono: nombreIcono, iconoGio: null, esGlifo: false }
      }
      if (esClienteJuego(cliente)) {
        return { ...comunes, icono: GLIFO_JUEGO, iconoGio: null, esGlifo: true }
      }
      return {
        ...comunes,
        icono: obtenerIconoGenericoAplicacion(cliente),
        iconoGio: null,
        esGlifo: false,
      }
    })
}
