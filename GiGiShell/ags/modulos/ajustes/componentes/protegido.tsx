import TextoInformativo from "./TextoInformativo"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }

/**
 * Construye un trozo de Ajustes (una sección o una tarjeta) y, si lanza al construirse,
 * pinta un aviso en su lugar en vez de dejar que la excepción suba.
 *
 * Por qué hace falta (issue #338): una sola tarjeta que lanzaba al construirse —un
 * `execAsync` a un binario ausente lanza SÍNCRONO, ver `servicios/energia/hibernacion.ts`—
 * se llevaba por delante la sección entera, y como la sección elegida sobrevive entre
 * aperturas, Ajustes volvía a abrirse en ella y seguía roto.
 *
 * Se pasa una FÁBRICA y no un elemento: en JSX `<Tarjeta />` se evalúa como argumento antes
 * de entrar aquí, así que un `<Protegido><Tarjeta /></Protegido>` no atraparía nada.
 * Solo cubre la construcción; lo que falle luego en un efecto reactivo ya lo contiene el
 * propio efecto.
 */
export default function protegido(nombre: string, fabrica: () => any, clasesContenedor?: string[]): any {
  try {
    return fabrica()
  } catch (e) {
    console.error(`[ajustes] «${nombre}» no se pudo construir:`, e)
    const aviso = <TextoInformativo label={textos.panel.noCargado} cssClasses={["sp-field-hint-warn"]} />
    // Una sección entera necesita el contenedor con el relleno de sección; una tarjeta no.
    return clasesContenedor ? <box cssClasses={clasesContenedor}>{aviso}</box> : aviso
  }
}
