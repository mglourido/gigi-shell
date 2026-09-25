// sd-journal se usa por FFI directa (ver src/journal.rs), sin crate intermedio: son
// ocho funciones y así el build no depende de bindgen ni de una versión concreta de
// un binding. Solo hace falta enlazar libsystemd, que en esta distro siempre está.
fn main() {
    println!("cargo:rustc-link-lib=systemd");
}
