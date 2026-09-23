export interface DatosDescripcionEscritorio {
  nombreAplicacion?: string | null
  claseAplicacion?: string | null
  claseInicial?: string | null
  titulo?: string | null
}

const SEPARADOR = "(?:[-—–|·:])"
const CLASE_TERMINAL = /(?:^|[.\s_-])(kitty|foot|alacritty|wezterm|ghostty|konsole|terminal|xterm)(?:$|[.\s_-])/i

function unaLinea(valor: string | null | undefined): string {
  return (valor ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function comparable(valor: string): string {
  return valor.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

function escaparExpresionRegular(valor: string): string {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function etiquetaClase(valor: string | null | undefined): string {
  const valorLimpio = unaLinea(valor).replace(/\.desktop$/i, "").replace(/\.exe$/i, "")
  const nombreCorto = valorLimpio.includes(".")
    ? valorLimpio.slice(valorLimpio.lastIndexOf(".") + 1)
    : valorLimpio
  return nombreCorto
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((palabra) => palabra.charAt(0).toLocaleUpperCase() + palabra.slice(1))
    .join(" ")
}

function aliasAplicacion(
  datos: DatosDescripcionEscritorio,
  nombreAplicacion: string,
): string[] {
  const alias = [
    nombreAplicacion,
    etiquetaClase(datos.claseAplicacion),
    etiquetaClase(datos.claseInicial),
  ].map(unaLinea).filter((valor) => valor.length >= 2)

  return [...new Set(alias)].sort((primero, segundo) => segundo.length - primero.length)
}

function quitarDecoracionAplicacion(titulo: string, alias: string[]): string {
  let resultado = titulo

  // Los navegadores y editores suelen publicar "documento - nombre de app".
  // Se elimina únicamente el nombre si está en un extremo y separado, para no
  // estropear títulos que casualmente contienen el nombre de la aplicación.
  for (let pasada = 0; pasada < 2; pasada++) {
    for (const nombre of alias) {
      const escapado = escaparExpresionRegular(nombre)
      resultado = resultado
        .replace(new RegExp(`^${escapado}\\s*${SEPARADOR}\\s*`, "iu"), "")
        .replace(new RegExp(`\\s*${SEPARADOR}\\s*${escapado}$`, "iu"), "")
        .trim()
    }
  }

  return resultado
}

function contextoTerminal(titulo: string, datos: DatosDescripcionEscritorio): string {
  const clases = `${datos.claseAplicacion ?? ""} ${datos.claseInicial ?? ""}`
  if (!CLASE_TERMINAL.test(clases)) return titulo

  // "usuario@equipo:~/proyecto" aporta mucho ruido. El directorio actual es la
  // parte útil y, normalmente, basta con su último componente.
  const coincidencia = /^(?:[^@:\s]+@)?[^:\s]+:\s*(~?(?:\/[^\s]+)+|~)\s*$/.exec(titulo)
  if (!coincidencia) return titulo
  const ruta = coincidencia[1].replace(/\/$/, "")
  if (ruta === "~") return ruta
  return ruta.slice(ruta.lastIndexOf("/") + 1) || ruta
}

function truncar(valor: string, maximo = 44): string {
  const caracteres = Array.from(valor)
  if (caracteres.length <= maximo) return valor

  const corte = caracteres.slice(0, maximo - 1).join("")
  const limitePalabra = corte.lastIndexOf(" ")
  const legible = limitePalabra >= Math.floor(maximo * 0.65)
    ? corte.slice(0, limitePalabra)
    : corte
  return `${legible.trimEnd()}…`
}

/** Tooltip corto para un icono de ventana: aplicación y contexto en líneas separadas. */
export function construirDescripcionEscritorio(datos: DatosDescripcionEscritorio): string {
  const nombreAplicacion = unaLinea(datos.nombreAplicacion)
    || etiquetaClase(datos.claseAplicacion)
    || etiquetaClase(datos.claseInicial)
    || "Aplicación"
  const tituloOriginal = unaLinea(datos.titulo)
  if (!tituloOriginal) return nombreAplicacion

  let contexto = quitarDecoracionAplicacion(
    tituloOriginal,
    aliasAplicacion(datos, nombreAplicacion),
  )
  contexto = contextoTerminal(contexto, datos)

  if (!contexto || comparable(contexto) === comparable(nombreAplicacion)) return nombreAplicacion
  return `${nombreAplicacion}\n${truncar(contexto)}`
}
