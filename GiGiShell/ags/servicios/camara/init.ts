// servicios/camara/init.ts
//
// Arranque del servicio de cámara: enumerar, y reponer en el aparato los
// controles que el usuario guardó.
//
// Va en el `setTimeout(…, 4000)` de `app.ts` con el resto de `init*` (ver la
// sección "Architecture" del CLAUDE.md de ags): no se ve, y no depende de
// ningún evento ocurrido mientras espera — SIEMBRA de lo vivo, preguntándole a
// udev qué cámaras hay, así que a los 4 s ve exactamente lo mismo (o más) que
// habría visto a t=0. El coste de retrasarlo es que el tile de QuickSettings y
// el indicador de la barra aparecen unos segundos después de la barra; a cambio
// no compite con la construcción de ventanas, que es lo que se ve.
import { camaras, inicializarCamaras } from "./dispositivos.ts"
import { restaurarControles } from "./persistencia.ts"
import { refrescarBloqueo } from "./bloqueo.ts"

export function inicializarCamara() {
  inicializarCamaras()

  // Estado del killswitch. Se lee UNA vez al arrancar y después solo tras pulsarlo: es la
  // presencia de un fichero en /etc que no cambia solo. Si alguien lo quita desde un TTY, el
  // panel se entera al siguiente inicio de sesión — es la escotilla de emergencia documentada
  // en el helper, no una vía de uso normal.
  void refrescarBloqueo()

  // Reponer al arrancar Y en cada hotplug, que es justo cuando hace falta: los
  // controles V4L2 viven en el driver, no en la cámara, así que desenchufarla y
  // volverla a enchufar los devuelve a los de fábrica sin avisar de nada. Ver
  // la cabecera de `persistencia.ts`.
  //
  // Se suscribe a la LISTA y no a un evento de udev propio para no tener dos
  // vigilantes del mismo hecho: `camaras` ya solo cambia en `add`/`remove`.
  let conocidas = new Set<string>()
  const reponer = () => {
    const actuales = camaras.get()
    const nuevas = actuales.filter((c) => !conocidas.has(c.clave))
    conocidas = new Set(actuales.map((c) => c.clave))
    // SOLO las que acaban de aparecer. Reponer todas en cada cambio pisaría los
    // sliders que el usuario tenga abiertos en otra cámara en ese momento:
    // enchufar una webcam USB devolvería la integrada a sus valores guardados a
    // mitad de un arrastre, sin que nada explicara el salto.
    for (const camara of nuevas) void restaurarControles(camara)
  }
  reponer()
  camaras.subscribe(reponer)
}
