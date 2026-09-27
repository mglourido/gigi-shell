// gigishell-guardian: daemon de protección de archivos (LSM/BPF) de GiGiShell.
//
// Esta tarea (4) solo añade el modo `--depurar` (Tarea 4): protege UN fichero
// a mano y saca por stdout todo lo que pasa por el BPF y por fanotify, para
// que el dueño de la máquina pueda verificar con sudo las asunciones del
// diseño (`pruebas/riesgos.sh`) antes de que exista el daemon de verdad.
// `--tras-parada` es el paso de limpieza que ya tenía `bpf::tras_parada()`
// desde la Tarea 2: desactiva un anclaje huérfano sin reabrir todo el
// esqueleto. El propio modo daemon (sin argumentos) es la Fase 2.
mod arranque;
mod bpf;
mod categorias;
mod depurar;
mod fanotify;
mod historial;
mod motor;
mod politica;
mod proceso;
mod protocolo;
mod tipos;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = ejecutar(&args) {
        eprintln!("gigishell-guardian: {e}");
        std::process::exit(1);
    }
}

fn ejecutar(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        None => Err("modo daemon: Fase 2".to_string()),
        Some("--depurar") => depurar::ejecutar(&args[1..]),
        Some("--tras-parada") => bpf::tras_parada(),
        Some(otro) => Err(format!("opción desconocida: {otro}")),
    }
}
