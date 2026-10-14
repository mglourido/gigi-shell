import assert from "node:assert/strict"
import { test } from "node:test"
import { actualizarColorBanda, COLORES_ONDA_RGB } from "./coloresOnda.ts"

test("conserva el color al subir, al bajar y al pasar del pico a la bajada", () => {
  const banda = { color: 3, bajando: false }
  for (const [anterior, siguiente] of [[0, 0.2], [0.2, 0.8], [0.8, 0.5], [0.5, 0.1]]) {
    actualizarColorBanda(banda, anterior, siguiente)
    assert.equal(banda.color, 3)
  }
})

test("cambia una sola vez al pasar de bajar a subir, incluso tras una meseta", () => {
  const banda = { color: 0, bajando: false }
  actualizarColorBanda(banda, 0.8, 0.2)
  actualizarColorBanda(banda, 0.2, 0.2)
  assert.equal(banda.color, 0)
  actualizarColorBanda(banda, 0.2, 0.4)
  assert.equal(banda.color, 1)
  actualizarColorBanda(banda, 0.4, 0.4)
  actualizarColorBanda(banda, 0.4, 0.9)
  assert.equal(banda.color, 1)
})

test("cada barra cambia por separado", () => {
  const primera = { color: 2, bajando: true }
  const segunda = { color: 2, bajando: true }
  actualizarColorBanda(primera, 0.1, 0.5)
  actualizarColorBanda(segunda, 0.5, 0.1)
  assert.equal(primera.color, 3)
  assert.equal(segunda.color, 2)
})

test("recorre toda la paleta y vuelve al primer color sin salir de sus límites", () => {
  const banda = { color: 0, bajando: false }
  const visitados = new Set([banda.color])
  for (let valle = 0; valle < COLORES_ONDA_RGB.length; valle++) {
    actualizarColorBanda(banda, 1, 0)
    actualizarColorBanda(banda, 0, 1)
    visitados.add(banda.color)
  }
  assert.equal(visitados.size, COLORES_ONDA_RGB.length)
  assert.equal(banda.color, 0)
  assert.equal(new Set(COLORES_ONDA_RGB.map((color) => color.join(","))).size, COLORES_ONDA_RGB.length)
  for (const color of COLORES_ONDA_RGB) {
    for (const canal of color) assert.ok(Number.isFinite(canal) && canal >= 0 && canal <= 1)
  }
})
