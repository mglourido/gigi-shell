// gigishell-guardian: el protocolo del socket con AGS — JSON por líneas. Las
// órdenes de AGS llevan la etiqueta `op`; los avisos del daemon, `ev`.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::historial::Entrada;
use crate::motor::{Decision, Pregunta};
use crate::politica::{Fichero, ModoCategoria};
use crate::tipos::{BORRAR, LEER, MODIFICAR};

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Orden {
    Estado,
    Lista,
    Historial { ruta: String, limite: usize },
    Proteger { ruta: String },
    Desproteger { ruta: String },
    Permiso { ruta: String, programa: String, leer: bool, modificar: bool, borrar: bool },
    /// «Permitir siempre» desde el aviso de una operación ya denegada.
    Conceder { ruta: String, programa: String, operacion: String },
    /// Sin `ruta`: cambia el valor por defecto para ficheros nuevos.
    Categoria {
        #[serde(default)]
        ruta: Option<String>,
        nombre: String,
        valor: ModoCategoria,
    },
    Responder { id: u64, decision: Decision },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Aviso {
    Estado { ficheros: usize, denegados_semana: usize },
    Lista {
        ficheros: Vec<Fichero>,
        categorias_por_defecto: BTreeMap<String, ModoCategoria>,
        categorias: BTreeMap<String, Vec<String>>,
    },
    Historial { ruta: String, entradas: Vec<Entrada> },
    Pregunta(Pregunta),
    Cerrar { id: u64 },
    Denegado { ruta: String, programa: String, operacion: String, interprete: bool },
    /// Algo de la política cambió: AGS vuelve a pedir `lista`.
    Cambio,
    Resumen { denegados: Vec<Entrada> },
    Error { op: String, motivo: String },
}

pub fn parsear(linea: &str) -> Result<Orden, String> {
    serde_json::from_str(linea).map_err(|e| format!("orden no válida: {e}"))
}

pub fn serializar(aviso: &Aviso) -> String {
    let mut s = serde_json::to_string(aviso).expect("un Aviso siempre se puede serializar");
    s.push('\n');
    s
}

/// Máscara de una operación por su nombre (el de `motor::nombre_operacion`).
/// «abrir» es lo que se pregunta cuando no se sabe qué se pidió: leer y
/// modificar. Un nombre desconocido da 0 (nada que conceder).
pub fn mascara_de(operacion: &str) -> u8 {
    (match operacion {
        "leer" => LEER,
        "modificar" => MODIFICAR,
        "leer y modificar" | "abrir" => LEER | MODIFICAR,
        "borrar" => BORRAR,
        _ => 0,
    }) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_lista_responder_y_categoria_sin_ruta() {
        assert_eq!(parsear(r#"{"op":"lista"}"#).unwrap(), Orden::Lista);
        assert_eq!(
            parsear(r#"{"op":"responder","id":7,"decision":"proceso"}"#).unwrap(),
            Orden::Responder { id: 7, decision: Decision::Proceso }
        );
        assert_eq!(
            parsear(r#"{"op":"categoria","nombre":"busqueda","valor":"silencio"}"#).unwrap(),
            Orden::Categoria {
                ruta: None,
                nombre: "busqueda".into(),
                valor: ModoCategoria::Silencio
            }
        );
    }

    #[test]
    fn orden_desconocida_es_error() {
        assert!(parsear(r#"{"op":"formatear_disco"}"#).is_err());
        assert!(parsear("no es json").is_err());
    }

    #[test]
    fn serializa_cerrar_y_pregunta_en_plano() {
        assert_eq!(serializar(&Aviso::Cerrar { id: 3 }), "{\"ev\":\"cerrar\",\"id\":3}\n");
        let p = Pregunta {
            id: 1,
            ruta: "/a".into(),
            programa: "/usr/bin/cat".into(),
            pid: 2,
            operacion: "leer".into(),
            script: None,
            interprete: false,
            cambiado: false,
            caduca: 9,
        };
        let s = serializar(&Aviso::Pregunta(p));
        assert!(s.starts_with("{\"ev\":\"pregunta\",\"id\":1,"), "{s}");
        assert!(!s.contains("script"));
    }

    #[test]
    fn mascaras_por_nombre() {
        assert_eq!(mascara_de("leer"), 1);
        assert_eq!(mascara_de("modificar"), 2);
        assert_eq!(mascara_de("leer y modificar"), 3);
        assert_eq!(mascara_de("abrir"), 3);
        assert_eq!(mascara_de("borrar"), 4);
        assert_eq!(mascara_de("otra"), 0);
    }
}
