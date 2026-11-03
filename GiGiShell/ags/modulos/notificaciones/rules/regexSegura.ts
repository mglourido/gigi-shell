// modulos/notificaciones/rules/regexSegura.ts
// Expresiones regulares de las reglas, sin poder congelar el escritorio. Puro, con test.
//
// EL RIESGO. Una regla `op: "regex"` la escribe el usuario y se evalúa contra CADA notificación,
// en el hilo principal de AGS. El motor de JavaScript hace backtracking, y JavaScript no permite
// poner un tiempo máximo a una expresión regular: un cuantificador dentro de otro, como `(a+)+$`,
// cuesta un tiempo EXPONENCIAL con la longitud del texto. Medido con Node: 24 caracteres = 180 ms,
// 26 = 730 ms; cada carácter más lo duplica, y con el hilo principal parado no se pinta nada.
//
// LA DEFENSA, en tres capas:
//   1. `esRegexPeligrosa()` detecta el patrón clásico (cuantificador anidado). La validación no
//      deja guardar una así, y `regexSegura()` se niega a compilarla si ya está en disco.
//   2. El texto contra el que se evalúa se acota a `MAXIMO_SUJETO_REGEX`: los patrones lentos
//      pero no exponenciales (`.*a.*b.*c`, polinómicos) tienen techo.
//   3. Cada expresión se compila UNA vez (caché acotada), no en cada notificación.
// La detección es una heurística: no cubre todos los casos teóricos (alternativas solapadas como
// `(a|a)*`), pero sí los que se escriben en la práctica.

export const MAXIMO_SUJETO_REGEX = 2000
const MAXIMO_CACHE = 200

/** ¿Tiene un grupo con un cuantificador dentro que a su vez está cuantificado? `(a+)+`, `(x*)*`,
 *  `(a+){2,}`, `(?:\w+\s?)*`. Ignora lo escapado y lo que va entre corchetes. */
export function esRegexPeligrosa(patron: string): boolean {
  // Pila de grupos abiertos: ¿contiene ya algún cuantificador de repetición?
  const pila: boolean[] = []
  let cerradoConCuantificador = false // el último grupo cerrado llevaba cuantificador dentro
  for (let i = 0; i < patron.length; i++) {
    const c = patron[i]
    if (c === "\\") { i++; cerradoConCuantificador = false; continue }
    if (c === "[") {
      // Saltar la clase de caracteres entera: dentro, `+` y `*` son literales.
      i++
      if (patron[i] === "^") i++
      if (patron[i] === "]") i++
      while (i < patron.length && patron[i] !== "]") { if (patron[i] === "\\") i++; i++ }
      cerradoConCuantificador = false
      continue
    }
    if (c === "(") { pila.push(false); cerradoConCuantificador = false; continue }
    if (c === ")") {
      cerradoConCuantificador = pila.pop() ?? false
      // Un grupo que contiene repetición hace que el grupo de fuera también la contenga.
      if (cerradoConCuantificador && pila.length) pila[pila.length - 1] = true
      continue
    }
    const repite = c === "+" || c === "*" || (c === "{" && /^\{\d*,\d*\}|^\{\d{2,}\}/.test(patron.slice(i)))
    if (repite) {
      if (cerradoConCuantificador) return true
      if (pila.length) pila[pila.length - 1] = true
    }
    cerradoConCuantificador = false
  }
  return false
}

const cache = new Map<string, RegExp | null>()

/** La expresión compilada, o `null` si no compila o es peligrosa (y entonces no casa). */
export function regexSegura(patron: string, sinMayusculas: boolean): RegExp | null {
  const clave = `${sinMayusculas ? "i" : "-"}${patron}`
  const guardada = cache.get(clave)
  if (guardada !== undefined) return guardada
  let compilada: RegExp | null = null
  if (!esRegexPeligrosa(patron)) {
    try { compilada = new RegExp(patron, sinMayusculas ? "i" : "") } catch { compilada = null }
  }
  if (cache.size >= MAXIMO_CACHE) cache.clear()
  cache.set(clave, compilada)
  return compilada
}
