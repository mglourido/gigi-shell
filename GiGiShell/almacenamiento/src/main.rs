//! gigishell-almacenamiento — análisis y limpieza de disco de Ajustes > Almacenamiento.
//!
//!   gigishell-almacenamiento analizar [discos|categorias|apps|todo]
//!   gigishell-almacenamiento limpiar <accion>…
//!   gigishell-almacenamiento limpiar --listar
//!   gigishell-almacenamiento limpiar --validar-ruta <ruta>
//!   gigishell-almacenamiento limpiar --validar-protegida <ruta>
//!
//! Lo lanzan `hypr/scripts/analizar-almacenamiento.sh` y `limpiar-almacenamiento.sh` con `exec`
//! cuando está instalado en `~/.local/bin`; sin él, esos scripts usan su implementación bash.
//! La parte de root sigue siendo `system/limpieza/gigishell-limpieza.sh` (sudoers NOPASSWD): un
//! binario de usuario no debe ganar privilegios, solo pedir al helper lo que ya tiene permitido.

mod analizar;
mod disco;
mod limpiar;
mod medir;
mod pacman;
mod plan;
mod rutas;
#[cfg(test)]
mod pruebas;

use std::time::{Duration, Instant};

fn uso() -> ! {
    eprintln!("uso: gigishell-almacenamiento analizar [discos|categorias|apps|todo] | limpiar <accion>…|--listar|--validar-ruta R|--validar-protegida R");
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ent = rutas::Entorno::real();
    let prefs = rutas::Preferencias::leer(&ent);
    // Un plazo global para el análisis, como el `timeout` que envolvía cada `du`: un disco de red
    // colgado no puede dejar la sección en «Analizando…» para siempre. Lo que no llega sale `null`.
    let segundos = std::env::var("GIGISHELL_DU_TIMEOUT").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
    let plazo = Some(Instant::now() + Duration::from_secs(segundos));

    match args.first().map(String::as_str) {
        Some("analizar") => {
            let ctx = plan::Contexto::new(ent, prefs, plazo);
            let v = match args.get(1).map(String::as_str).unwrap_or("todo") {
                "discos" => analizar::discos(),
                "categorias" => analizar::categorias(&ctx),
                "apps" => analizar::apps(&ctx),
                "todo" => analizar::todo(&ctx),
                _ => uso(),
            };
            println!("{v}");
        }
        Some("limpiar") => {
            let resto = &args[1..];
            match resto.first().map(String::as_str) {
                None => uso(),
                Some("--listar") => plan::ACCIONES.iter().for_each(|a| println!("{a}")),
                Some(m @ ("--validar-ruta" | "--validar-protegida")) => {
                    let ctx = plan::Contexto::new(ent, prefs, None);
                    std::process::exit(limpiar::validar(m, resto.get(1).map(String::as_str).unwrap_or(""), &ctx));
                }
                Some(_) => {
                    let ctx = plan::Contexto::new(ent, prefs, None);
                    println!("{}", limpiar::limpiar(resto, &ctx));
                }
            }
        }
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => uso(),
    }
}
