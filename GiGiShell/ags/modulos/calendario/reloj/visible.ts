/**
 * Fuente de visibilidad que consumen los widgets del reloj.
 *
 * Es la forma mínima de un estado de `ags` (`createState`), no el tipo completo, para que los
 * componentes puedan probarse o reutilizarse con cualquier cosa que sepa decir «ahora se ve» y
 * avisar cuando cambie. Los ticks de presentación —cronómetro, cuenta atrás, reloj— cuelgan de
 * esto: con el panel cerrado no debe quedar ni un temporizador de repintado vivo.
 */
export interface Visible {
  get(): boolean
  subscribe(callback: () => void): unknown
}
