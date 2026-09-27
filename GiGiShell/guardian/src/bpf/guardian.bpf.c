// Esqueleto mínimo del programa LSM de guardian: por ahora solo comprueba que el
// pipeline de compilación (clang + vmlinux.h vía BTF + libbpf-cargo) funciona de
// punta a punta. La Tarea 2 sustituye el cuerpo por la lógica real de permitir/
// denegar/silenciar según los mapas de protección.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "GPL";

SEC("lsm/file_open")
int BPF_PROG(g_file_open, struct file *file, int ret)
{
	return ret;
}
