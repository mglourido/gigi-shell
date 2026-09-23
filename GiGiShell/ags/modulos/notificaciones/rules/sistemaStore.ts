// modulos/notificaciones/rules/sistemaStore.ts
// Configuración POR AVISO del sistema. Vive en su propio fichero,
// `~/.config/gigios/notif-sistema.json`, separado de `notif-rules.json` a propósito.
//
// POR QUÉ UN FICHERO APARTE. `notif-rules.json` guarda reglas: objetos con `match`, `effects`,
// `priority` y `stopOnMatch`, pensados para que el usuario cace notificaciones de apps por
// texto. Los avisos del sistema no necesitan nada de eso — su `match` es siempre el mismo
// (`event equals <id>`) y ya está fijado por el catálogo — así que meterlos ahí habría
// obligado a repetir cien veces el mismo `match` y habría enterrado las cuatro reglas
// personales del usuario entre cien entradas generadas. El formato de aquí es, por eso, lo
// mínimo: un mapa `id → efectos`.
//
//     {
//       "version": 1,
//       "eventos": {
//         "wifi.reconectado":  { "suppress": true },
//         "kernel.oom":        { "color": "#f38ba8" },
//         "usb.conectado":     { "dontShow": true }
//       }
//     }
//
// UNA ENTRADA REEMPLAZA LOS DEFAULTS DEL CATÁLOGO, no se fusiona con ellos. Es la decisión
// que hace el fichero legible a mano: lo que se lee en `eventos` es EXACTAMENTE lo que se
// aplica, sin tener que ir a buscar qué trae el catálogo por debajo ni recordar en qué orden
// gana cada capa. Fusionar habría necesitado además un valor centinela para "quítame este
// campo" —`lifetime` es una cadena: omitirla y anularla no se distinguen en un merge—, o sea
// un `null` con significado especial en un fichero que se quería obvio. El precio es que un
// aviso personalizado se queda anclado a los defaults del día en que se tocó; se paga a
// gusto, y "Restaurar" lo devuelve al catálogo actual de un clic.
//
// Un aviso que no aparezca en `eventos` usa los efectos del catálogo tal cual.
//
// `suppress: true` es la forma de decir "este aviso no lo quiero": ni popup, ni panel, ni
// sonido. `dontShow: true` es el intermedio (se guarda en el panel, sin popup). Son los dos
// efectos que hacen falta para que "editable por separado" signifique algo, pero el resto de
// `EffectSpec` funciona igual aquí que en una regla.
import { createState } from "ags"
import GLib from "gi://GLib"
import type { EffectSpec, NotifRule } from "./types.ts"
import { CATALOGO_SISTEMA, eventoSistema } from "./catalogoSistema.ts"
import { cargarJson, crearGuardadoJsonProgramado } from "../estado/persistencia.ts"

const SISTEMA_PATH = `${GLib.get_user_config_dir()}/gigios/notif-sistema.json`

/** Prioridad de las reglas generadas desde el catálogo. Por encima de las builtin (10..50) y
 *  de la prioridad por defecto de una regla de usuario (100), porque apuntar a UN aviso
 *  concreto es más específico que cualquier `contains` — pero por debajo del techo, para que
 *  una regla de usuario con prioridad alta siga pudiendo imponerse a propósito. */
export const PRIORIDAD_SISTEMA = 150

export interface ArchivoSistema {
  version: number
  eventos: Record<string, EffectSpec>
}

const VERSION_ACTUAL = 1

const cargado = cargarJson<Partial<ArchivoSistema>>(SISTEMA_PATH, {}, "sistema")
const inicial: ArchivoSistema = {
  version: typeof cargado.version === "number" ? cargado.version : VERSION_ACTUAL,
  eventos: cargado.eventos && typeof cargado.eventos === "object" ? cargado.eventos : {},
}

export const [archivoSistema, setArchivoSistema] = createState<ArchivoSistema>(inicial)

const programarGuardado = crearGuardadoJsonProgramado(
  SISTEMA_PATH,
  "sistema",
  800,
  () => archivoSistema.get(),
)

/** Efectos finales de un aviso: los del usuario si los hay, y si no los del catálogo. */
export function efectosEvento(id: string, archivo = archivoSistema.get()): EffectSpec {
  return archivo.eventos[id] ?? eventoSistema(id)?.efectos ?? {}
}

/** ¿Ha tocado el usuario este aviso? Lo usa la UI para ofrecer "restaurar". */
export function eventoPersonalizado(id: string, archivo = archivoSistema.get()): boolean {
  return Object.prototype.hasOwnProperty.call(archivo.eventos, id)
}

/** UN aviso del catálogo envuelto como la regla que se genera para él. Es lo que come
 *  `RuleEditor`: reconoce el `source: "system"`, esconde el bloque «Cuándo aplica» —su `match`
 *  lo fija el catálogo— y al guardar manda solo los efectos a `notif-sistema.json`.
 *  `undefined` si el id no está en el catálogo (un aviso que aún no se ha dado de alta). */
export function reglaDeEvento(id: string, archivo = archivoSistema.get()): NotifRule | undefined {
  const e = eventoSistema(id)
  if (!e) return undefined
  return {
    id: `sistema.${e.id}`,
    name: e.nombre,
    enabled: true,
    priority: PRIORIDAD_SISTEMA,
    source: "system",
    match: { event: { op: "equals", value: e.id } },
    effects: efectosEvento(e.id, archivo),
  }
}

/** El catálogo como reglas, listas para `compileRules`. Se generan siempre las ~100: una
 *  entrada del catálogo sin efectos también tiene que estar, porque es la que hace que el
 *  aviso NO caiga en "Detectadas" — el historial solo indexa lo que no casa con ninguna
 *  regla, y un aviso del sistema ya se gestiona desde su propia pestaña. */
export function reglasSistema(archivo = archivoSistema.get()): NotifRule[] {
  return CATALOGO_SISTEMA.map(e => reglaDeEvento(e.id, archivo)!)
}

function guardar(archivo: ArchivoSistema): void {
  setArchivoSistema(archivo)
  programarGuardado()
}

/** Quita lo que no dice nada: `undefined`, los booleanos en `false` (que con semántica de
 *  reemplazo son exactamente lo mismo que la clave ausente) y las listas vacías. Sin esto,
 *  silenciar y volver a activar un aviso dejaría un `{"suppress": false}` en el fichero — una
 *  entrada que no cambia nada pero que lo marca como «modificado» para siempre. */
function normalizar(efectos: EffectSpec): EffectSpec {
  const out: Record<string, unknown> = {}
  // Las claves se ordenan porque la comparación de más abajo es por `JSON.stringify`, que sí
  // distingue el orden: el borrador del editor construye el objeto en el orden en que el usuario
  // tocó los campos, y sin ordenar no coincidiría nunca con el del catálogo.
  for (const k of Object.keys(efectos).sort()) {
    const v = (efectos as Record<string, unknown>)[k]
    if (v === undefined || v === false) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out as EffectSpec
}

/** Fija los efectos de un aviso: se guardan enteros, tal cual quedan (ver la cabecera). Si el
 *  resultado coincide con lo que trae el catálogo, se borra la entrada en vez de escribir una
 *  copia — así «modificado» sigue significando algo y el fichero solo contiene decisiones. */
export function fijarEfectosEvento(id: string, efectos: EffectSpec): void {
  const limpios = normalizar(efectos)
  if (JSON.stringify(limpios) === JSON.stringify(normalizar(eventoSistema(id)?.efectos ?? {}))) {
    restaurarEvento(id)
    return
  }
  const a = archivoSistema.get()
  guardar({ ...a, eventos: { ...a.eventos, [id]: limpios } })
}

/** Devuelve el aviso a los valores de fábrica (borra su entrada del fichero). */
export function restaurarEvento(id: string): void {
  const a = archivoSistema.get()
  if (!Object.prototype.hasOwnProperty.call(a.eventos, id)) return
  const { [id]: _, ...resto } = a.eventos
  guardar({ ...a, eventos: resto })
}

/** Atajo del interruptor de la lista: silenciar = descartar por completo. */
export function alternarSilencio(id: string): void {
  const actual = efectosEvento(id)
  fijarEfectosEvento(id, { ...actual, suppress: !actual.suppress })
}
