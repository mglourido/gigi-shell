// Compila el programa BPF de guardian.bpf.c y genera el esqueleto (guardian.skel.rs)
// que src/main.rs incluirá con `include!`. Espejo del pipeline estándar de libbpf-cargo,
// como hacen eventd/build.rs con systemd pero para BPF: no hay bindgen ni crate
// intermedio, el propio libbpf-cargo invoca a clang y genera el Rust.
use std::env;
use std::path::PathBuf;
use std::process::Command;

use libbpf_cargo::SkeletonBuilder;

const SRC: &str = "src/bpf/guardian.bpf.c";

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR no definido por cargo"));
    let vmlinux_h = out_dir.join("vmlinux.h");
    let skel = out_dir.join("guardian.skel.rs");

    // vmlinux.h se genera una sola vez por build (cacheado en OUT_DIR): describe los
    // tipos internos del kernel EN EJECUCIÓN vía BTF, así que no puede versionarse — un
    // vmlinux.h de otra máquina/kernel dejaría de reflejar los offsets reales.
    if !vmlinux_h.exists() {
        let salida = Command::new("bpftool")
            .args(["btf", "dump", "file", "/sys/kernel/btf/vmlinux", "format", "c"])
            .output()
            .expect("no se pudo ejecutar bpftool (¿está instalado y en $PATH?)");

        if !salida.status.success() {
            panic!(
                "bpftool btf dump falló: {}",
                String::from_utf8_lossy(&salida.stderr)
            );
        }

        std::fs::write(&vmlinux_h, salida.stdout)
            .unwrap_or_else(|e| panic!("no se pudo escribir {}: {e}", vmlinux_h.display()));
    }

    SkeletonBuilder::new()
        .source(SRC)
        .clang_args([format!("-I{}", out_dir.display())])
        .build_and_generate(&skel)
        .unwrap_or_else(|e| panic!("fallo compilando/generando el esqueleto BPF: {e}"));

    println!("cargo:rerun-if-changed={SRC}");
    println!("cargo:rerun-if-env-changed=OUT_DIR");
}
