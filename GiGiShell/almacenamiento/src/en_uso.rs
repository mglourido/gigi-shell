//! Guarda de «algo está usando esto ahora mismo».
//!
//! Hay acciones que borran lo que un proceso en marcha está usando, y ninguna lo comprueba por sí
//! misma:
//!
//! - **`cacheAur`**: yay/paru compilan dentro de `~/.cache/{yay,paru/clone}/<pkg>`. Un paquete que
//!   se compila por PRIMERA vez aún no está instalado, así que el planificador ve su clon entero
//!   como resto y lo borra a mitad de compilación; en una actualización caen `src/`, `pkg/` y el
//!   `.pkg.tar` recién construido, que todavía no es la versión instalada.
//! - **`huerfanos`**: yay instala las dependencias de compilación `--asdeps`, así que mientras
//!   compila son huérfanas para pacman — y entre dos llamadas a pacman nadie tiene `db.lck`.
//! - **`cachePaquetes`/`cachePaquetesTotal`**: el helper ya se niega con `db.lck`, pero lo dice
//!   como `error`; aquí sale como lo que es, «ahora no».
//! - **`cacheDesarrollo`**: un `cargo build` o un `npm install` en marcha lee esas cachés.
//!
//! La comprobación es leer `/proc/*/comm` una vez por acción vigilada: sin forks y sin coste
//! cuando la acción no está en la lista. `comm` es el nombre del ejecutable (o del script, si se
//! lanzó por shebang: `/usr/bin/npm` da `npm`), recortado a 15 bytes — todos los de abajo caben.
//! No ve un `python -m pip` (su `comm` es `python`): cubrirlo obligaría a leer `cmdline` de cada
//! proceso, y es el caso raro.

use std::fs;

const PAQUETERIA: &[&str] = &["pacman", "makepkg", "yay", "paru"];
const DESARROLLO: &[&str] = &["cargo", "npm", "npx", "pip", "pip3", "go", "makepkg", "yay", "paru"];

/// Qué procesos impiden la acción `id`. Vacío = la acción no se vigila.
pub fn bloqueantes(id: &str) -> &'static [&'static str] {
    match id {
        "cacheAur" | "huerfanos" | "cachePaquetes" | "cachePaquetesTotal" => PAQUETERIA,
        "cacheDesarrollo" => DESARROLLO,
        _ => &[],
    }
}

/// El primero de `nombres` que aparece entre los `comm` dados.
fn primero<'a>(comms: impl Iterator<Item = String>, nombres: &[&'a str]) -> Option<&'a str> {
    for c in comms {
        if let Some(n) = nombres.iter().find(|n| **n == c.trim_end()) {
            return Some(n);
        }
    }
    None
}

/// Si algún proceso en marcha impide la acción `id`, su nombre.
pub fn ocupada_por(id: &str) -> Option<&'static str> {
    let nombres = bloqueantes(id);
    if nombres.is_empty() {
        return None;
    }
    let comms = fs::read_dir("/proc").ok()?.filter_map(|e| {
        let e = e.ok()?;
        // Solo directorios numéricos (PID); `/proc/self` y compañía no son procesos aparte.
        e.file_name().to_str()?.bytes().all(|b| b.is_ascii_digit()).then_some(())?;
        fs::read_to_string(e.path().join("comm")).ok()
    });
    primero(comms, nombres)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> impl Iterator<Item = String> {
        xs.iter().map(|s| format!("{s}\n")).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn detecta_por_nombre_exacto() {
        assert_eq!(primero(v(&["systemd", "yay", "kitty"]), bloqueantes("cacheAur")), Some("yay"));
        assert_eq!(primero(v(&["cargo"]), bloqueantes("cacheDesarrollo")), Some("cargo"));
        // `cargo` no estorba a la caché de AUR, ni un prefijo cuenta como coincidencia.
        assert_eq!(primero(v(&["cargo", "yayo", "pacman-key"]), bloqueantes("cacheAur")), None);
    }

    #[test]
    fn acciones_no_vigiladas() {
        assert!(bloqueantes("miniaturas").is_empty());
        assert_eq!(ocupada_por("miniaturas"), None);
    }
}
