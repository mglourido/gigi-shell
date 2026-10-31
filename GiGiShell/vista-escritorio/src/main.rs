//! Vista previa en vivo de un escritorio de Hyprland, incluidos los ocultos.
//!
//! La barra lanza este proceso solo mientras su miniatura está abierta y lo mata al cerrarla:
//! escribe por stdout fotogramas BGRA crudos de `ancho*alto*4` bytes y termina al cerrarse stdin
//! (así no sobrevive a AGS). Ver `ags/modulos/barra/CLAUDE.md`.
//!
//! Códigos de salida: 0 fin normal · 1 error · 2 uso incorrecto · 3 el compositor no ofrece el
//! protocolo (la barra usa entonces su respaldo).

mod captura;
mod protocolo;
mod reducir;

use std::process::ExitCode;

const USO: &str = "uso: gigishell-vista-escritorio --comprobar\n       gigishell-vista-escritorio --escritorio NOMBRE --ancho N --alto N [--intervalo-ms N] [--recorte IZQ,ARR,DER,ABA]";

fn main() -> ExitCode {
    let mut argumentos = std::env::args().skip(1);
    let mut opciones = captura::Opciones {
        escritorio: String::new(),
        ancho: 0,
        alto: 0,
        intervalo_ms: 500,
        recorte: reducir::Recorte::default(),
    };
    let mut comprobar = false;
    while let Some(argumento) = argumentos.next() {
        let mut valor = || argumentos.next().unwrap_or_default();
        match argumento.as_str() {
            "--comprobar" => comprobar = true,
            "--escritorio" => opciones.escritorio = valor(),
            "--ancho" => opciones.ancho = valor().parse().unwrap_or(0),
            "--alto" => opciones.alto = valor().parse().unwrap_or(0),
            "--intervalo-ms" => opciones.intervalo_ms = valor().parse().unwrap_or(0),
            "--recorte" => match reducir::Recorte::desde_texto(&valor()) {
                Some(recorte) => opciones.recorte = recorte,
                None => {
                    eprintln!("{USO}");
                    return ExitCode::from(2);
                }
            },
            _ => {
                eprintln!("{USO}");
                return ExitCode::from(2);
            }
        }
    }
    if !comprobar
        && (opciones.escritorio.is_empty()
            || opciones.ancho == 0
            || opciones.alto == 0
            || opciones.intervalo_ms == 0)
    {
        eprintln!("{USO}");
        return ExitCode::from(2);
    }

    let resultado = if comprobar {
        captura::comprobar()
    } else {
        captura::ejecutar(&opciones)
    };
    match resultado {
        Ok(()) => ExitCode::SUCCESS,
        Err(captura::Fallo::SinProtocolo(falta)) => {
            eprintln!("el compositor no ofrece {falta}");
            ExitCode::from(3)
        }
        Err(captura::Fallo::Otro(mensaje)) => {
            eprintln!("{mensaje}");
            ExitCode::from(1)
        }
    }
}
