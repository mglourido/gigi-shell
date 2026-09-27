// gigishell-guardian: escucha de fanotify (FAN_OPEN_PERM) — el mecanismo que sí
// puede BLOQUEAR una apertura mientras espera la respuesta del usuario, cosa que
// un hook LSM en BPF no puede hacer (no tiene permiso para dormir ni para hacer
// I/O de usuario; ver el comentario de cabecera de `guardian.bpf.c`). El BPF deja
// pasar la apertura y anota en `pendientes` qué se pidió; este módulo es el que
// de verdad decide, vía `responder()`, si esos bytes llegan a leerse.
//
// Por qué O_PATH para (des)marcar en vez de abrir el fichero de verdad: un
// `open()` normal sobre un fichero YA protegido dispararía `g_file_open` en el
// propio BPF y, sin derechos concedidos todavía, generaría una petición
// pendiente y un evento — ruido del propio daemon administrando sus marcas, no
// una apertura real de un usuario. `O_PATH` nunca llega a `file_open` del LSM
// (no abre el contenido, solo referencia la ruta), así que administrar marcas
// nunca se confunde con la actividad que se vigila.

use std::ffi::CString;
use std::fs;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};

use crate::tipos::{kdev, ClaveInodo};

/// Tamaño de un `fanotify_event_metadata` tal como lo define esta versión de
/// libc — libc no expone `FAN_EVENT_METADATA_LEN` como constante (es una macro
/// de `<linux/fanotify.h>`, no un símbolo), así que se deriva de `size_of`.
const TAM_METADATO: usize = std::mem::size_of::<libc::fanotify_event_metadata>();

/// Evento de apertura pendiente de respuesta: el `fd` ya abierto por el kernel
/// sobre el fichero que se intenta abrir (hay que cerrarlo o pasarlo a
/// `responder()` en algún momento: fanotify no lo cierra solo) y el `tid` del
/// hilo que hizo el `open` (gracias a `FAN_REPORT_TID` al construir el fd, ver
/// `Fanotify::nuevo`) — es la clave con la que se busca en `pendientes` del BPF.
pub struct EventoApertura {
    pub fd: OwnedFd,
    pub tid: u32,
}

/// Listener de fanotify con permiso de contenido (`FAN_CLASS_CONTENT`): puede
/// denegar/permitir una apertura antes de que el proceso llegue a leer nada.
pub struct Fanotify {
    fd: OwnedFd,
}

impl Fanotify {
    /// Crea el fd de fanotify con las banderas que este demonio necesita:
    /// `FAN_CLASS_CONTENT` (permiso, no solo notificación), `FAN_CLOEXEC` (no
    /// heredarlo si el daemon hace `exec` de algo), `FAN_NONBLOCK` (se
    /// multiplexa con el resto del bucle de eventos por `epoll`, nunca se
    /// bloquea aquí) y `FAN_REPORT_TID` (para poder cruzar el evento con
    /// `pendientes[tid]` del BPF — ver el comentario de cabecera).
    pub fn nuevo() -> io::Result<Self> {
        let flags = libc::FAN_CLASS_CONTENT | libc::FAN_CLOEXEC | libc::FAN_NONBLOCK
            | libc::FAN_REPORT_TID;
        // `event_f_flags`: los fd que fanotify nos entrega para leer el
        // contenido se abren en modo solo lectura; suficiente para que el
        // daemon decida, y evita abrir con permisos que el propio proceso
        // vigilado no pidió.
        let fd = unsafe { libc::fanotify_init(flags, libc::O_RDONLY as u32) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fanotify_init` devuelve un fd nuevo y válido cuando `fd >= 0`.
        Ok(Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
        })
    }

    pub fn fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }

    /// Empieza a pedir permiso (`FAN_OPEN_PERM`) para las aperturas del fichero
    /// referenciado por `opath` (un fd `O_PATH`, ver `abrir_opath`). Se marca
    /// por `/proc/self/fd/N` en vez de por la ruta original porque es lo único
    /// estable frente a symlinks intermedios y a que la ruta original haya
    /// cambiado entre que se abrió `opath` y que se llama aquí — el fd ya
    /// apunta al inodo correcto, cueste lo que cueste resolverlo por ruta ahora.
    pub fn marcar(&self, opath: BorrowedFd<'_>) -> io::Result<()> {
        self.marcar_con(libc::FAN_MARK_ADD, opath)
    }

    /// Deja de pedir permiso para ese fichero (se llama al desproteger).
    pub fn desmarcar(&self, opath: BorrowedFd<'_>) -> io::Result<()> {
        self.marcar_con(libc::FAN_MARK_REMOVE, opath)
    }

    fn marcar_con(&self, accion: libc::c_uint, opath: BorrowedFd<'_>) -> io::Result<()> {
        let ruta = CString::new(format!("/proc/self/fd/{}", opath.as_raw_fd()))
            .expect("una ruta de /proc/self/fd no contiene NUL");
        let ret = unsafe {
            libc::fanotify_mark(
                self.fd.as_raw_fd(),
                accion,
                libc::FAN_OPEN_PERM,
                libc::AT_FDCWD,
                ruta.as_ptr(),
            )
        };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Lee los eventos disponibles ahora mismo (el fd es `FAN_NONBLOCK`: si no
    /// hay ninguno, devuelve un vector vacío en vez de bloquear — el llamador
    /// decide cómo esperar, normalmente con `epoll` sobre `fd()`).
    pub fn leer(&self) -> io::Result<Vec<EventoApertura>> {
        // Un búfer de unos pocos eventos a la vez: fanotify no entrega eventos
        // parciales (cada `read()` devuelve un número entero de estructuras
        // `fanotify_event_metadata`), así que sobra con no acumular de más.
        let mut buf = [0u8; TAM_METADATO * 16];
        let leidos = unsafe {
            libc::read(
                self.fd.as_raw_fd(),
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len(),
            )
        };
        if leidos < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::WouldBlock {
                return Ok(Vec::new());
            }
            return Err(err);
        }

        let mut eventos = Vec::new();
        let mut offset = 0usize;
        let leidos = leidos as usize;
        while offset + TAM_METADATO <= leidos {
            // SAFETY: hay al menos `TAM_METADATO` bytes válidos desde `offset`
            // (comprobado justo arriba) y `fanotify_event_metadata` no tiene
            // invariantes que un patrón de bytes del kernel pueda romper.
            let metadato = unsafe {
                std::ptr::read_unaligned(
                    buf[offset..].as_ptr() as *const libc::fanotify_event_metadata
                )
            };

            // SAFETY: el kernel entrega un fd nuevo y válido por evento; es
            // responsabilidad de quien reciba `EventoApertura` cerrarlo (o
            // pasarlo a `responder()`, que lo consume).
            let fd = unsafe { OwnedFd::from_raw_fd(metadato.fd) };
            eventos.push(EventoApertura {
                fd,
                // Con `FAN_REPORT_TID` puesto en `nuevo()`, este campo — que la
                // API de fanotify sigue llamando `pid` por compatibilidad — es
                // en realidad el TID del hilo que abrió el fichero.
                tid: metadato.pid as u32,
            });

            offset += metadato.event_len as usize;
        }

        Ok(eventos)
    }

    /// Responde a la petición de permiso sobre `fd` (el mismo fd que llegó en
    /// `EventoApertura`, consumido aquí: fanotify espera que se cierre tras
    /// responder, y `OwnedFd` lo hace solo al salir de este método).
    pub fn responder(&self, fd: OwnedFd, permitir: bool) -> io::Result<()> {
        let respuesta = libc::fanotify_response {
            fd: fd.as_raw_fd(),
            response: if permitir { libc::FAN_ALLOW } else { libc::FAN_DENY },
        };
        let ret = unsafe {
            libc::write(
                self.fd.as_raw_fd(),
                &respuesta as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::fanotify_response>(),
            )
        };
        // `fd` se cierra al salir de scope (Drop de OwnedFd) tanto si `write`
        // tuvo éxito como si no: no hay nada más razonable que hacer con un fd
        // de permiso que ya se procesó (o que el kernel ya considera huérfano).
        if ret < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Abre `ruta` como `O_PATH` — sin acceder a su contenido, solo para poder
/// referenciarla (por `/proc/self/fd/N`) o hacerle `fstat`. `O_NOFOLLOW` es a
/// propósito: si `ruta` es un symlink, se quiere vigilar el symlink en sí, no lo
/// que apunte a — seguirlo automáticamente dejaría marcar (o `stat`) un fichero
/// distinto del que Ajustes cree estar protegiendo. `O_CLOEXEC` porque este fd
/// es contabilidad interna, nunca debe sobrevivir a un `exec()`.
pub fn abrir_opath(ruta: &std::path::Path) -> io::Result<OwnedFd> {
    let ruta_c = CString::new(ruta.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "ruta con NUL incrustado"))?;
    let fd = unsafe {
        libc::open(
            ruta_c.as_ptr(),
            libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `open` devuelve un fd nuevo y válido cuando `fd >= 0`.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `(ClaveInodo, nlink)` de un fd ya abierto (típicamente un `O_PATH`, con el
/// que `fstat` sigue funcionando aunque no se haya abierto el contenido). El
/// número de enlaces (`nlink`) se devuelve aparte porque quien marca/protege
/// necesita saberlo para decidir si vale la pena seguir vigilando un fichero
/// que ya no tiene ningún nombre en el árbol (borrado con el fd todavía
/// abierto): no es parte de la identidad del inodo, es una señal para el
/// llamador.
pub fn clave_de_fd(fd: BorrowedFd<'_>) -> io::Result<(ClaveInodo, u64)> {
    let mut st: MaybeUninit<libc::stat> = MaybeUninit::uninit();
    let ret = unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fstat` devolvió éxito, así que `st` está completamente
    // inicializada.
    let st = unsafe { st.assume_init() };
    Ok((
        ClaveInodo {
            dev: kdev(st.st_dev as u64),
            ino: st.st_ino,
        },
        st.st_nlink as u64,
    ))
}

/// `ClaveInodo` de una ruta, abriéndola de paso como `O_PATH` (ver
/// `abrir_opath`) y descartando el fd: para el caso de uso habitual — resolver
/// qué inodo es HOY una ruta que Ajustes acaba de marcar — no hace falta
/// quedarse con el fd, solo con la identidad.
pub fn clave_de_ruta(ruta: &std::path::Path) -> io::Result<ClaveInodo> {
    let fd = abrir_opath(ruta)?;
    let (clave, _nlink) = clave_de_fd(fd.as_fd())?;
    Ok(clave)
}

/// Ruta actual de un fd, vía `/proc/self/fd/N` — la única forma portable de
/// recuperar una ruta a partir de un fd en Linux. Puede no reflejar la ruta por
/// la que se abrió originalmente (renombrados, montajes) ni existir en absoluto
/// (fichero borrado con el fd abierto, un pipe, etc.), de ahí que devuelva
/// `io::Result`: un fallo aquí es informativo, no necesariamente un error de
/// verdad para el llamador.
pub fn ruta_de_fd(fd: BorrowedFd<'_>) -> io::Result<std::path::PathBuf> {
    fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}
