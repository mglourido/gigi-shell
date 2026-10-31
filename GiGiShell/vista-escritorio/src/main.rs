//! Vista previa en vivo de los escritorios de Hyprland, incluidos los ocultos. Dos modos:
//!
//! - `--escritorio NOMBRE`: la miniatura de la barra y la vista grande. Se lanza solo mientras se
//!   ve y escribe por stdout fotogramas BGRA crudos de `ancho*alto*4` bytes, sin cabecera y solo
//!   cuando la imagen cambia. Termina al quedarse sin escritorio. Ver `ags/modulos/barra/CLAUDE.md`.
//! - `--sesiones`: el menú de escritorios. Varias capturas a la vez sobre un conjunto limitado de
//!   búferes. Por stdin, `+CLAVE NOMBRE` y `-CLAVE`, una orden por línea; por stdout, `u32` LE con
//!   la clave seguido del fotograma. Sobrevive a que se quede sin escritorios.
//!
//! En los dos termina al cerrarse stdin (así no sobrevive a AGS).
//!
//! Códigos de salida: 0 fin normal · 1 error · 2 uso incorrecto · 3 el compositor no ofrece el
//! protocolo (la barra usa entonces su respaldo).

mod captura;
mod filtro;
mod planificador;
mod protocolo;
mod reducir;

use std::process::ExitCode;

const USO: &str = "uso: gigishell-vista-escritorio --comprobar\n       gigishell-vista-escritorio --escritorio NOMBRE --ancho N --alto N [--intervalo-ms N] [--recorte IZQ,ARR,DER,ABA]\n       gigishell-vista-escritorio --sesiones --ancho N --alto N --intervalo-ms N [--intervalo-respaldo-ms N] [--recorte IZQ,ARR,DER,ABA] [--buferes N] [--imagen-fija] [--solo-refinado]";

fn main() -> ExitCode {
    let mut argumentos = std::env::args().skip(1);
    let mut opciones = captura::Opciones {
        escritorio: None,
        ancho: 0,
        alto: 0,
        intervalo_ms: 500,
        intervalo_respaldo_ms: None,
        recorte: reducir::Recorte::default(),
        buferes: 1,
        imagen_fija: false,
        solo_refinado: false,
    };
    let mut comprobar = false;
    let mut sesiones = false;
    while let Some(argumento) = argumentos.next() {
        let mut valor = || argumentos.next().unwrap_or_default();
        match argumento.as_str() {
            "--comprobar" => comprobar = true,
            "--sesiones" => sesiones = true,
            "--escritorio" => opciones.escritorio = Some(valor()).filter(|nombre| !nombre.is_empty()),
            "--intervalo-respaldo-ms" => opciones.intervalo_respaldo_ms = valor().parse().ok(),
            "--buferes" => opciones.buferes = valor().parse().unwrap_or(1),
            "--imagen-fija" => opciones.imagen_fija = true,
            "--solo-refinado" => opciones.solo_refinado = true,
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
        // Rechaza tanto no dar ninguno de los dos modos como dar los dos.
        && (opciones.escritorio.is_some() == sesiones
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
