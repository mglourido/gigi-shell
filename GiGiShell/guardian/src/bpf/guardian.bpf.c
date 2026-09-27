// Programa BPF LSM de guardian: decide en el kernel, en el momento exacto de la
// llamada al sistema, si un proceso puede leer/modificar/borrar un fichero
// marcado como protegido desde Ajustes.
//
// Por qué el BPF no puede "esperar" y delega en fanotify:
// Un hook LSM corre en el contexto de la syscall del proceso vigilado, con el
// kernel a mitad de una operación y sin permiso para dormir ni para hacer I/O de
// usuario. No hay forma de, desde aquí, mostrarle una notificación al usuario y
// bloquear la syscall hasta que responda. Por eso `g_file_open` nunca deniega una
// apertura por sí solo cuando el proceso no tiene ya un derecho concedido: dejará
// pasar la apertura (devuelve 0) pero registra la petición en el mapa `pendientes`
// y empuja un evento al ring buffer. Es el daemon en userspace, con fanotify
// (que sí puede bloquear esperando la respuesta del usuario) y sus propios
// mapas de permisos, quien de verdad concede o corta el acceso antes de que el
// proceso llegue a leer datos: `file_open` sin derechos es una señal para
// fanotify, no un veredicto. Las demás operaciones (borrar, mover, cambiar
// atributos/xattrs, truncar) sí pueden denegarse aquí mismo porque son atómicas
// y no necesitan una decisión interactiva: si no hay derecho ya concedido,
// `exigir()` corta con -EPERM directamente.
//
// Los structs de claves/valores de los mapas son un espejo BYTE A BYTE de
// src/tipos.rs (Tarea 1): mismo orden de campos, mismo tamaño, mismo padding.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "GPL";

// vmlinux.h no trae estas constantes (son de <linux/errno.h> y <linux/fs.h>,
// no tipos con BTF): se definen a mano con los valores estables de la ABI de
// Linux en x86_64/todas las arquitecturas soportadas por este demonio.
#define EPERM 1
#define EACCES 13
#define FMODE_READ 0x1
#define FMODE_WRITE 0x2

// Máscaras de operación (clave_permiso / pendiente.pedido) — mismos valores que
// LEER/MODIFICAR/BORRAR en src/tipos.rs.
#define OP_LEER 1
#define OP_MODIFICAR 2
#define OP_BORRAR 4

// Categorías de protección (valor_protegido.marcado) — CAT_PERMITIR/CAT_SILENCIO.
#define CAT_PERMITIR 1
#define CAT_SILENCIO 2

// Tipos de evento (evento.tipo) — EV_* de src/tipos.rs.
#define EV_DENEGADO 1
#define EV_SILENCIO 2
#define EV_HEREDADO 3
#define EV_MOVIDO 4
#define EV_BORRADO 5

// ---------------------------------------------------------------------------
// Claves y valores de los mapas: espejo byte a byte de src/tipos.rs.
// ---------------------------------------------------------------------------

// ClaveInodo { dev: u64, ino: u64 } — 16 bytes.
struct clave_inodo {
	__u64 dev;
	__u64 ino;
};

// ValorProtegido { fichero: u32, marcado: u32 } — 8 bytes.
struct valor_protegido {
	__u32 fichero;
	__u32 marcado;
};

// ClavePermiso { fichero: u32, _pad: u32, dev: u64, ino: u64 } — 24 bytes.
struct clave_permiso {
	__u32 fichero;
	__u32 _pad;
	__u64 dev;
	__u64 ino;
};

// ClaveProceso { fichero: u32, tgid: u32 } — 8 bytes.
struct clave_proceso {
	__u32 fichero;
	__u32 tgid;
};

// Pendiente { fichero: u32, pedido: u8, permitido: u8, _pad: [u8; 2] } — 8 bytes.
struct pendiente {
	__u32 fichero;
	__u8 pedido;
	__u8 permitido;
	__u8 _pad[2];
};

// Control { activo: u32, pid_daemon: u32 } — 8 bytes.
struct control {
	__u32 activo;
	__u32 pid_daemon;
};

// Evento { tipo: u32, fichero: u32, tgid: u32, op: u32, dev: u64, ino: u64 } — 32 bytes.
struct evento {
	__u32 tipo;
	__u32 fichero;
	__u32 tgid;
	__u32 op;
	__u64 dev;
	__u64 ino;
};

// ---------------------------------------------------------------------------
// Mapas.
// ---------------------------------------------------------------------------

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct clave_inodo);
	__type(value, struct valor_protegido);
} protegidos SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 65536);
	__type(key, struct clave_permiso);
	__type(value, __u8);
} permisos SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct clave_proceso);
	__type(value, __u8);
} procesos SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 65536);
	__type(key, struct clave_permiso);
	__type(value, __u8);
} categorias SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 8192);
	__type(key, __u32);
	__type(value, struct pendiente);
} pendientes SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct control);
} control SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} eventos SEC(".maps");

// ---------------------------------------------------------------------------
// Lógica común.
// ---------------------------------------------------------------------------

// Identidad del proceso actual: (dev, ino) del ejecutable (mm->exe_file->f_inode)
// y tgid. Devuelve 0 (identidad vacía, tratada como "exento") si el proceso no
// tiene mm (kernel thread) o si es el propio daemon (no se aplica a sí mismo las
// reglas que él mismo administra).
static __always_inline int identidad(struct clave_inodo *id, __u32 *tgid)
{
	struct task_struct *tarea = (struct task_struct *)bpf_get_current_task_btf();
	struct mm_struct *mm;
	struct file *exe;
	struct inode *inodo;
	struct super_block *sb;
	__u32 pid_daemon = 0;
	__u32 idx = 0;
	struct control *ctl;

	ctl = bpf_map_lookup_elem(&control, &idx);
	if (ctl)
		pid_daemon = ctl->pid_daemon;

	*tgid = BPF_CORE_READ(tarea, tgid);
	if (pid_daemon != 0 && *tgid == pid_daemon) {
		id->dev = 0;
		id->ino = 0;
		return 0;
	}

	mm = BPF_CORE_READ(tarea, mm);
	if (!mm) {
		id->dev = 0;
		id->ino = 0;
		return 0;
	}

	exe = BPF_CORE_READ(mm, exe_file);
	if (!exe) {
		id->dev = 0;
		id->ino = 0;
		return 0;
	}

	inodo = BPF_CORE_READ(exe, f_inode);
	if (!inodo) {
		id->dev = 0;
		id->ino = 0;
		return 0;
	}

	sb = BPF_CORE_READ(inodo, i_sb);
	id->dev = sb ? BPF_CORE_READ(sb, s_dev) : 0;
	id->ino = BPF_CORE_READ(inodo, i_ino);

	return 1;
}

// Busca el inodo dado en `protegidos`. NULL si no está protegido.
static __always_inline struct valor_protegido *protegido(struct inode *inodo)
{
	struct clave_inodo clave = {};
	struct super_block *sb;

	if (!inodo)
		return NULL;

	sb = BPF_CORE_READ(inodo, i_sb);
	clave.dev = sb ? BPF_CORE_READ(sb, s_dev) : 0;
	clave.ino = BPF_CORE_READ(inodo, i_ino);

	return bpf_map_lookup_elem(&protegidos, &clave);
}

// Derechos concedidos sobre `fichero` para la identidad `id`/`tgid`: OR del
// permiso por (fichero, exe) y por (fichero, tgid). Ninguno de los dos hereda
// del otro: un permiso por ejecutable vale para cualquier proceso de ese binario,
// uno por proceso vale solo para ese tgid.
static __always_inline __u8 derechos(__u32 fichero, struct clave_inodo *id, __u32 tgid)
{
	struct clave_permiso cp = {};
	struct clave_proceso cpr = {};
	__u8 *v;
	__u8 total = 0;

	cp.fichero = fichero;
	cp.dev = id->dev;
	cp.ino = id->ino;
	v = bpf_map_lookup_elem(&permisos, &cp);
	if (v)
		total |= *v;

	cpr.fichero = fichero;
	cpr.tgid = tgid;
	v = bpf_map_lookup_elem(&procesos, &cpr);
	if (v)
		total |= *v;

	return total;
}

// Emite un evento al ring buffer. Sin comprobación de fallo más allá de no
// desreferenciar NULL: si el ring buffer está lleno, el evento simplemente se
// pierde (no hay nada mejor que hacer desde un hook LSM).
static __always_inline void emitir(__u32 tipo, __u32 fichero, __u32 tgid, __u32 op,
				    struct clave_inodo *id)
{
	struct evento *ev;

	ev = bpf_ringbuf_reserve(&eventos, sizeof(*ev), 0);
	if (!ev)
		return;

	ev->tipo = tipo;
	ev->fichero = fichero;
	ev->tgid = tgid;
	ev->op = op;
	ev->dev = id->dev;
	ev->ino = id->ino;

	bpf_ringbuf_submit(ev, 0);
}

// Exige el derecho `op` sobre `inodo` para operaciones que no pueden esperar a
// que el usuario responda (borrar, mover, cambiar atributos/xattrs, truncar):
// - no protegido, o identidad exenta ⇒ 0 (se permite).
// - protegido pero el programa está desactivado ⇒ -EPERM (fallar cerrado).
// - protegido y con el derecho concedido ⇒ 0.
// - protegido y sin el derecho ⇒ evento EV_DENEGADO y -EPERM.
static __always_inline int exigir(struct inode *inodo, __u32 op)
{
	struct valor_protegido *vp;
	struct clave_inodo id = {};
	__u32 tgid = 0;
	__u32 ctl_idx = 0;
	struct control *ctl;

	vp = protegido(inodo);
	if (!vp)
		return 0;

	if (!identidad(&id, &tgid))
		return 0;

	ctl = bpf_map_lookup_elem(&control, &ctl_idx);
	if (!ctl || !ctl->activo)
		return -EPERM;

	if (derechos(vp->fichero, &id, tgid) & op)
		return 0;

	emitir(EV_DENEGADO, vp->fichero, tgid, op, &id);
	return -EPERM;
}

// ---------------------------------------------------------------------------
// Programas.
// ---------------------------------------------------------------------------

SEC("lsm/file_open")
int BPF_PROG(g_file_open, struct file *file, int ret)
{
	struct inode *inodo;
	struct valor_protegido *vp;
	struct clave_inodo id = {};
	__u32 tgid = 0;
	__u32 ctl_idx = 0;
	struct control *ctl;
	__u32 pedido = 0;
	fmode_t modo;
	__u8 tiene;
	__u8 permitido = 0;
	struct clave_permiso cat_clave = {};
	__u8 *categoria;
	struct pendiente pend = {};

	if (ret != 0)
		return ret;

	inodo = BPF_CORE_READ(file, f_inode);
	vp = protegido(inodo);
	if (!vp)
		return 0;

	if (!identidad(&id, &tgid))
		return 0;

	ctl = bpf_map_lookup_elem(&control, &ctl_idx);
	if (!ctl || !ctl->activo)
		return -EACCES;

	// Pedido a partir de f_mode: qué se pidió leer/escribir. 0 (ni lectura ni
	// escritura, p.ej. abrir solo para stat/ioctl) se deja pasar directamente.
	modo = BPF_CORE_READ(file, f_mode);
	if (modo & FMODE_READ)
		pedido |= OP_LEER;
	if (modo & FMODE_WRITE)
		pedido |= OP_MODIFICAR;

	if (pedido == 0)
		return 0;

	tiene = derechos(vp->fichero, &id, tgid);
	if ((tiene & pedido) == pedido) {
		permitido = 1;
	} else {
		cat_clave.fichero = vp->fichero;
		cat_clave.dev = id.dev;
		cat_clave.ino = id.ino;
		categoria = bpf_map_lookup_elem(&categorias, &cat_clave);

		if (categoria && *categoria == CAT_PERMITIR && pedido == OP_LEER) {
			permitido = 2;
		} else if (categoria && *categoria == CAT_SILENCIO && pedido == OP_LEER) {
			emitir(EV_SILENCIO, vp->fichero, tgid, pedido, &id);
			return -EACCES;
		}

		if (!permitido && vp->marcado == 0) {
			emitir(EV_DENEGADO, vp->fichero, tgid, pedido, &id);
			return -EACCES;
		}
	}

	// La decisión final de si se puede leer el contenido la toma fanotify en
	// userspace: aquí solo se dan pistas (pendiente) y se deja pasar la apertura.
	pend.fichero = vp->fichero;
	pend.pedido = (__u8)pedido;
	pend.permitido = permitido;
	bpf_map_update_elem(&pendientes, &tgid, &pend, BPF_ANY);

	return 0;
}

SEC("lsm/inode_unlink")
int BPF_PROG(g_unlink, struct inode *dir, struct dentry *dentry, int ret)
{
	struct inode *inodo;
	struct valor_protegido *vp;
	int r;

	if (ret != 0)
		return ret;

	inodo = BPF_CORE_READ(dentry, d_inode);
	vp = protegido(inodo);

	r = exigir(inodo, OP_BORRAR);
	if (r != 0)
		return r;

	if (vp) {
		struct clave_inodo id = {};
		__u32 tgid = 0;

		identidad(&id, &tgid);
		emitir(EV_BORRADO, vp->fichero, tgid, OP_BORRAR, &id);
	}

	return 0;
}

SEC("lsm/inode_link")
int BPF_PROG(g_link, struct dentry *old_dentry, struct inode *dir, struct dentry *new_dentry, int ret)
{
	struct inode *origen;

	if (ret != 0)
		return ret;

	origen = BPF_CORE_READ(old_dentry, d_inode);
	return exigir(origen, OP_BORRAR);
}

SEC("lsm/inode_rename")
int BPF_PROG(g_rename, struct inode *old_dir, struct dentry *old_dentry,
	     struct inode *new_dir, struct dentry *new_dentry, unsigned int flags, int ret)
{
	struct inode *origen;
	struct inode *destino;
	struct valor_protegido *vp_origen;
	struct valor_protegido *vp_destino;
	int r;

	if (ret != 0)
		return ret;

	origen = BPF_CORE_READ(old_dentry, d_inode);
	destino = BPF_CORE_READ(new_dentry, d_inode);

	r = exigir(origen, OP_BORRAR);
	if (r != 0)
		return r;

	r = exigir(destino, OP_MODIFICAR);
	if (r != 0)
		return r;

	vp_origen = protegido(origen);
	vp_destino = protegido(destino);

	if (vp_origen) {
		struct clave_inodo id = {};
		__u32 tgid = 0;

		identidad(&id, &tgid);
		emitir(EV_MOVIDO, vp_origen->fichero, tgid, OP_BORRAR, &id);
	} else if (vp_destino && !vp_origen) {
		// El destino ya estaba protegido y el origen no: el fichero que va a
		// ocupar su sitio hereda la protección con el mismo id de fichero,
		// sin marcar (el usuario no lo ha marcado él mismo todavía).
		struct clave_inodo id_origen = {};
		struct super_block *sb;
		struct valor_protegido nuevo = {};
		__u32 tgid = 0;

		sb = BPF_CORE_READ(origen, i_sb);
		id_origen.dev = sb ? BPF_CORE_READ(sb, s_dev) : 0;
		id_origen.ino = BPF_CORE_READ(origen, i_ino);

		nuevo.fichero = vp_destino->fichero;
		nuevo.marcado = 0;
		bpf_map_update_elem(&protegidos, &id_origen, &nuevo, BPF_ANY);

		identidad(&id_origen, &tgid);
		emitir(EV_HEREDADO, vp_destino->fichero, tgid, 0, &id_origen);
	}

	return 0;
}

SEC("lsm/inode_setattr")
int BPF_PROG(g_setattr, struct mnt_idmap *idmap, struct dentry *dentry, struct iattr *attr, int ret)
{
	if (ret != 0)
		return ret;

	return exigir(BPF_CORE_READ(dentry, d_inode), OP_MODIFICAR);
}

SEC("lsm/path_truncate")
int BPF_PROG(g_path_truncate, struct path *path, int ret)
{
	struct dentry *dentry;

	if (ret != 0)
		return ret;

	dentry = BPF_CORE_READ(path, dentry);
	return exigir(BPF_CORE_READ(dentry, d_inode), OP_MODIFICAR);
}

SEC("lsm/file_truncate")
int BPF_PROG(g_file_truncate, struct file *file, int ret)
{
	if (ret != 0)
		return ret;

	return exigir(BPF_CORE_READ(file, f_inode), OP_MODIFICAR);
}

SEC("lsm/inode_setxattr")
int BPF_PROG(g_setxattr, struct mnt_idmap *idmap, struct dentry *dentry, const char *name,
	     const void *value, size_t size, int flags, int ret)
{
	if (ret != 0)
		return ret;

	return exigir(BPF_CORE_READ(dentry, d_inode), OP_MODIFICAR);
}

SEC("lsm/inode_removexattr")
int BPF_PROG(g_removexattr, struct mnt_idmap *idmap, struct dentry *dentry, const char *name, int ret)
{
	if (ret != 0)
		return ret;

	return exigir(BPF_CORE_READ(dentry, d_inode), OP_MODIFICAR);
}
