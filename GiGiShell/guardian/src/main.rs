// gigishell-guardian: daemon de protección de archivos (LSM/BPF) de GiGiShell.
// Esta tarea solo deja en pie el crate, el pipeline de compilación BPF y los tipos
// compartidos con el programa C. La Tarea 4 rellena el arranque real (carga del
// programa, mapas, bucle de eventos).
mod bpf;
mod fanotify;
mod proceso;
mod tipos;

fn main() {}
