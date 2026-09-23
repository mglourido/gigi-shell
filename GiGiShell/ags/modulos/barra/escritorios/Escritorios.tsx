import Gdk from "gi://Gdk"
import { createState, For, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import { workspaceVisibleLimit, wsPreviewEnabled } from "../../ajustes/preferences"
import { wsPreviewSuspended } from "../../../servicios/energia/powerState"
import {
  obtenerHyprland,
  suscribirDatosEscritorios,
} from "../../../servicios/escritorios/controlador"
import {
  desplazarEscritorios,
  enfocarEscritorio,
  intercambiarEscritorios,
} from "../../../servicios/escritorios/operaciones"
import type { EstadoVisibilidadBarra } from "../../../estado/visibilidadBarra"
import {
  ordenarClientesEscritorio,
  recordarEscritorioReciente,
  seleccionarEscritoriosRecientes,
} from "./orden"
import BotonEscritorio, {
  type InteraccionesBotonEscritorio,
} from "./BotonEscritorio"
import {
  crearCapturadorEscritorios,
  rutaVistaPreviaEscritorio,
} from "./capturas"
import { obtenerIconosClientesEscritorio } from "./iconos"
import { sonEscritoriosEquivalentes } from "./modelo"
import { esEscritorioEspecial } from "../../../servicios/escritorios/especiales"
import type {
  ClienteEscritorio,
  EscritorioVisible,
  IconoClienteEscritorio,
} from "./modelo"
import { crearGestorVistaPreviaEscritorios } from "./gestorVistaPrevia"
import { esVentanaEmergenteX11 } from "../../../servicios/ventanas/emergentesX11"

export interface InteraccionEscritorios {
  cambiarArrastre: (activo: boolean) => void
  cambiarVistaPrevia: (activa: boolean) => void
  adquirirTeclado: () => void
  liberarTeclado: () => void
}

const INTERACCION_NULA: InteraccionEscritorios = {
  cambiarArrastre: () => {},
  cambiarVistaPrevia: () => {},
  adquirirTeclado: () => {},
  liberarTeclado: () => {},
}

const vistaPreviaActiva = () => wsPreviewEnabled.get() && !wsPreviewSuspended.get()

/** Identidad estable para el caso "este escritorio no tiene clientes": un literal
 *  nuevo por evaluación haría que el accessor derivado emitiera un array distinto
 *  cada vez sin que nada hubiera cambiado. */
const SIN_CLIENTES: IconoClienteEscritorio[] = []

/** Escritorios de una barra concreta. Todo el estado visual pertenece al monitor. */
export default function Escritorios(
  monitorGdk: Gdk.Monitor,
  visibilidad: EstadoVisibilidadBarra,
  interaccion: InteraccionEscritorios = INTERACCION_NULA,
) {
  const hyprland = obtenerHyprland()
  const nombreSalida = monitorGdk.get_connector() ?? ""
  const geometria = monitorGdk.get_geometry()
  const obtenerMonitorHyprland = () => {
    if (nombreSalida) return hyprland.get_monitor_by_name(nombreSalida)
    // En ciertos backends/versiones GDK no expone connector. La posición lógica
    // sigue identificando la misma salida que Hyprland sin mezclar monitores.
    return hyprland.get_monitors().find((monitor) =>
      monitor.x === geometria.x && monitor.y === geometria.y
    ) ?? null
  }
  const obtenerIdEscritorioActivo = () =>
    obtenerMonitorHyprland()?.activeWorkspace?.id ?? -1

  let idsEscritoriosRecientes = recordarEscritorioReciente([], obtenerIdEscritorioActivo())
  let ultimoIdEscritorioActivo = obtenerIdEscritorioActivo()
  // Igualdad por CONTENIDO, no por identidad de array. `actualizar()` corre ante
  // cualquier señal de escritorios —incluida `notify::focused-client`, que con
  // `follow_mouse = 1` salta cada vez que el puntero cruza de una ventana a otra— y
  // devuelve siempre objetos nuevos. Con el `Object.is` de fábrica, ese cruce del
  // ratón publicaba una lista "nueva" y reconstruía todos los botones de todas las
  // barras. El foco vive en `idEnfocado`/`direccionEnfocada`, que sí son suyos.
  const [escritorios, fijarEscritorios] =
    createState<EscritorioVisible[]>([], { equals: sonEscritoriosEquivalentes })
  const [escritoriosRenderizados, fijarEscritoriosRenderizados] =
    createState<EscritorioVisible[]>([], { equals: sonEscritoriosEquivalentes })
  const [idEnfocado, fijarIdEnfocado] = createState(ultimoIdEscritorioActivo)
  const [direccionEnfocada, fijarDireccionEnfocada] = createState("")

  /** Clientes de un escritorio como accessor vivo. `<For>` está indexado por id, así
   *  que `BotonEscritorio` se construye UNA vez por escritorio y su prop `escritorio`
   *  ya no vuelve a llegar: todo lo que cambie durante su vida tiene que entrar por
   *  aquí. Solo emite cuando la lista publicada cambia de verdad (ver `equals`). */
  const clientesDeEscritorio = (idEscritorio: number) =>
    escritoriosRenderizados((lista) =>
      lista.find((escritorio) => escritorio.id === idEscritorio)?.clientes ?? SIN_CLIENTES,
    )

  // Sin connector se mantiene la lista por geometría, pero grim queda desactivado:
  // no se puede seleccionar con seguridad una salida mediante `-o`.
  const capturador = crearCapturadorEscritorios(
    nombreSalida,
    obtenerIdEscritorioActivo,
    vistaPreviaActiva,
  )
  const vistaPrevia = crearGestorVistaPreviaEscritorios(
    monitorGdk,
    interaccion.cambiarVistaPrevia,
  )
  const interaccionesBoton: InteraccionesBotonEscritorio = {
    cambiarArrastre: interaccion.cambiarArrastre,
    adquirirTeclado: interaccion.adquirirTeclado,
    liberarTeclado: interaccion.liberarTeclado,
  }

  const actualizar = () => {
    const monitor = obtenerMonitorHyprland()
    if (!monitor) {
      capturador.conservarEscritorios(new Set())
      fijarEscritorios([])
      if (visibilidad.visible.get()) fijarEscritoriosRenderizados([])
      fijarIdEnfocado(-1)
      fijarDireccionEnfocada("")
      return
    }

    const idActivo = monitor.activeWorkspace?.id ?? -1
    if (idActivo !== ultimoIdEscritorioActivo) {
      ultimoIdEscritorioActivo = idActivo
      capturador.solicitar(idActivo)
    }
    idsEscritoriosRecientes = recordarEscritorioReciente(idsEscritoriosRecientes, idActivo)
    fijarIdEnfocado(idActivo)

    const clienteEnfocado = hyprland.focusedClient
    fijarDireccionEnfocada(
      clienteEnfocado?.monitor?.id === monitor.id ? clienteEnfocado.address : "",
    )

    const escritoriosLocales = hyprland.get_workspaces()
      .filter((escritorio) => escritorio.monitor?.id === monitor.id)
      .sort((primero, segundo) => primero.id - segundo.id)
    const idsLocales = new Set(escritoriosLocales.map((escritorio) => escritorio.id))
    capturador.conservarEscritorios(idsLocales)
    const clientesPorEscritorio = new Map<number, ClienteEscritorio[]>()

    for (const cliente of hyprland.get_clients() as ClienteEscritorio[]) {
      const idEscritorio = cliente.workspace?.id ?? cliente.get_workspace?.()?.id
      if (typeof idEscritorio !== "number" || !idsLocales.has(idEscritorio)) continue
      // Los menús y tooltips de una app X11 llegan como clientes con la clase de
      // su padre (un desplegable de Steam = otro `class: "steam"`), así que sin
      // esto la barra pintaba un icono duplicado mientras el menú estaba abierto.
      // El filtro va aquí y no en `iconos.ts` porque también decide si un
      // escritorio "tiene clientes", o sea si se muestra.
      if (esVentanaEmergenteX11(cliente)) continue
      const clientes = clientesPorEscritorio.get(idEscritorio) ?? []
      clientes.push(cliente)
      clientesPorEscritorio.set(idEscritorio, clientes)
    }

    const candidatos = escritoriosLocales.map((escritorio) => {
      const clientes = clientesPorEscritorio.get(escritorio.id) ?? []
      // El nombre solo se usa para los ESPECIALES, que se abren por nombre y no
      // por id (ver `enfocarEscritorio`). Para los normales es el id en texto.
      const nombre = escritorio.name ?? String(escritorio.id)
      return {
        id: escritorio.id,
        nombre,
        // Astal 0.1 todavía traduce Workspace.focus() al dispatcher legacy
        // `workspace N`, inválido cuando Hyprland carga configuración Lua.
        enfocar: () => {
          void enfocarEscritorio(escritorio.id, nombre).catch((error) => {
            console.error(`No se pudo enfocar el escritorio ${escritorio.id}`, error)
          })
        },
        tieneClientes: clientes.length > 0,
        clientes: obtenerIconosClientesEscritorio(ordenarClientesEscritorio(clientes)),
      }
    })
    const siguientes = seleccionarEscritoriosRecientes(
      candidatos.filter((escritorio) => escritorio.tieneClientes || escritorio.id === idActivo),
      idsEscritoriosRecientes,
      idActivo,
      workspaceVisibleLimit.get(),
    ).map(({ id, nombre, enfocar, clientes }) => ({ id, nombre, enfocar, clientes }))

    fijarEscritorios(siguientes)
    // `escritorios.get()` y no `siguientes`: si el contenido no cambió, el state
    // conserva el array anterior y ambos quedan en la misma identidad.
    if (visibilidad.visible.get()) fijarEscritoriosRenderizados(escritorios.get())
  }

  const mostrarEstadoOptimista = (siguientes: EscritorioVisible[]) => {
    fijarEscritorios(siguientes)
    fijarEscritoriosRenderizados(siguientes)
  }

  const intercambiarVisualmente = (primerId: number, segundoId: number) => {
    const siguientes = [...escritorios.get()]
    const primerIndice = siguientes.findIndex((escritorio) => escritorio.id === primerId)
    const segundoIndice = siguientes.findIndex((escritorio) => escritorio.id === segundoId)
    if (primerIndice < 0 || segundoIndice < 0) return
    ;[siguientes[primerIndice], siguientes[segundoIndice]] =
      [siguientes[segundoIndice], siguientes[primerIndice]]
    mostrarEstadoOptimista(siguientes)
  }

  const desplazarVisualmente = (idOrigen: number, idDestino: number) => {
    const siguientes = [...escritorios.get()]
    const indiceOrigen = siguientes.findIndex((escritorio) => escritorio.id === idOrigen)
    const indiceDestino = siguientes.findIndex((escritorio) => escritorio.id === idDestino)
    if (indiceOrigen < 0 || indiceDestino < 0 || indiceOrigen === indiceDestino) return
    const [origen] = siguientes.splice(indiceOrigen, 1)
    siguientes.splice(indiceDestino, 0, origen)
    mostrarEstadoOptimista(siguientes)
  }

  // Reordenar, intercambiar y renumerar mueven VENTANAS entre escritorios
  // numerados (ver `servicios/escritorios/plan.ts`). Un especial no tiene sitio en
  // ese orden —no es una posición, es un cajón— y arrastrarlo habría vaciado el
  // scratchpad dentro de un escritorio normal. Se ignora en las tres entradas, que
  // son las tres formas de llegar: arrastrar, CTRL+arrastrar y teclear un número.
  const involucraEspecial = (primerId: number, segundoId: number) =>
    esEscritorioEspecial(primerId) || esEscritorioEspecial(segundoId)

  const intercambiar = (primerId: number, segundoId: number) => {
    if (involucraEspecial(primerId, segundoId)) return
    intercambiarVisualmente(primerId, segundoId)
    void intercambiarEscritorios(primerId, segundoId, obtenerIdEscritorioActivo())
  }

  const desplazar = (idOrigen: number, idDestino: number) => {
    if (involucraEspecial(idOrigen, idDestino)) return
    const idsOrdenados = escritorios.get().map((escritorio) => escritorio.id)
    desplazarVisualmente(idOrigen, idDestino)
    void desplazarEscritorios(idOrigen, idDestino, idsOrdenados, obtenerIdEscritorioActivo())
  }

  const renumerar = (idOrigen: number, idDestino: number) => {
    if (idOrigen === idDestino || involucraEspecial(idOrigen, idDestino)) return
    const monitor = obtenerMonitorHyprland()
    if (!monitor) return
    const ocupado = hyprland.get_workspaces().find((escritorio) => escritorio.id === idDestino)
    if (ocupado && ocupado.monitor?.id !== monitor.id) return
    if (ocupado) intercambiarVisualmente(idOrigen, idDestino)
    void intercambiarEscritorios(idOrigen, idDestino, obtenerIdEscritorioActivo())
  }

  const dejarDatos = suscribirDatosEscritorios(actualizar)
  const dejarLimite = workspaceVisibleLimit.subscribe(actualizar)
  const dejarVisibilidad = visibilidad.visible.subscribe(() => {
    if (visibilidad.visible.get()) fijarEscritoriosRenderizados(escritorios.get())
  })
  const alCambiarPreferenciaVistaPrevia = () => {
    if (!vistaPreviaActiva()) vistaPrevia.cerrar()
    else capturador.solicitar(obtenerIdEscritorioActivo())
  }
  const dejarVistaPrevia = wsPreviewEnabled.subscribe(alCambiarPreferenciaVistaPrevia)
  const dejarSuspension = wsPreviewSuspended.subscribe(alCambiarPreferenciaVistaPrevia)
  const capturaInicial = setTimeout(
    () => capturador.solicitar(obtenerIdEscritorioActivo(), 0),
    800,
  )

  onCleanup(() => {
    dejarDatos()
    dejarLimite()
    dejarVisibilidad()
    dejarVistaPrevia()
    dejarSuspension()
    clearTimeout(capturaInicial)
    capturador.eliminar()
    vistaPrevia.eliminar()
    interaccion.cambiarArrastre(false)
    interaccion.cambiarVistaPrevia(false)
  })

  const overlay = new Gtk.Overlay()
  overlay.set_child(
    <box cssClasses={["Workspaces"]} spacing={2}>
      {/* Indexado por id: sin `id` el <For> compara por identidad de objeto, y como
          cada pasada de `actualizar()` devuelve objetos nuevos, abrir una ventana
          reconstruía TODOS los botones (con sus gestos, arrastres y ranuras de
          icono) en vez del que cambió. `enfocar` se captura en la primera
          construcción y no se refresca: solo depende del id, que es la clave. */}
      <For each={escritoriosRenderizados} id={(escritorio) => escritorio.id}>
        {(escritorio) => (
          <BotonEscritorio
            escritorio={escritorio}
            clientes={clientesDeEscritorio(escritorio.id)}
            overlay={overlay}
            idEnfocado={idEnfocado}
            direccionEnfocada={direccionEnfocada}
            vistaPrevia={vistaPrevia}
            vistaPreviaActiva={vistaPreviaActiva}
            rutaVistaPrevia={(idEscritorio) =>
              rutaVistaPreviaEscritorio(nombreSalida, idEscritorio)
            }
            interacciones={interaccionesBoton}
            alIntercambiar={intercambiar}
            alDesplazar={desplazar}
            alRenumerar={renumerar}
            obtenerEscritorios={() => escritorios.get()}
          />
        )}
      </For>
    </box>,
  )
  return overlay
}
