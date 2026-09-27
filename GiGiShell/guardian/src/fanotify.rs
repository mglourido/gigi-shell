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

use crate::tipos::ClaveInodo;

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

            // Cada registro se valida ANTES de tocar `metadato.fd`: un
            // `event_len` corto o cero dejaría el bucle girando para siempre
            // sobre el mismo `offset` (nunca avanza), y una versión de
            // metadato distinta de la que este código entiende significaría
            // que el resto de campos (incluido dónde empieza el siguiente
            // registro) no se puede interpretar con esta struct.
            if metadato.vers != libc::FANOTIFY_METADATA_VERSION {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "fanotify_event_metadata.vers={} (esperado {})",
                        metadato.vers,
                        libc::FANOTIFY_METADATA_VERSION
                    ),
                ));
            }
            if (metadato.event_len as usize) < TAM_METADATO
                || offset + metadato.event_len as usize > leidos
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "fanotify_event_metadata.event_len={} fuera de rango (offset={offset}, leidos={leidos})",
                        metadato.event_len
                    ),
                ));
            }

            // `fd == FAN_NOFD` (-1): no hay fd de verdad que envolver — ocurre
            // en eventos sin permiso asociado, p.ej. `FAN_Q_OVERFLOW` cuando la
            // cola de fanotify se desborda. Envolver -1 en `OwnedFd` sería UB
            // (su nicho de `Option` asume que nunca vale -1), así que este
            // evento se descarta explícitamente en vez de tratarlo como una
            // apertura — no hay nada que responder ni ningún fichero al que
            // atribuirlo.
            if metadato.fd == libc::FAN_NOFD {
                eprintln!(
                    "gigishell-guardian: evento fanotify sin fd (mask={:#x}, posible desborde de cola FAN_Q_OVERFLOW) descartado",
                    metadato.mask
                );
                offset += metadato.event_len as usize;
                continue;
            }

            // SAFETY: el kernel entrega un fd nuevo y válido por evento (ya se
            // descartó el caso `FAN_NOFD` arriba); es responsabilidad de quien
            // reciba `EventoApertura` cerrarlo (o pasarlo a `responder()`, que
            // lo consume).
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
            let err = io::Error::last_os_error();
            // Sin este aviso, un fallo aquí es invisible: el proceso que pidió
            // abrir el fichero se queda colgado en el `open()` (fanotify nunca
            // recibió respuesta) sin ningún mensaje que explique por qué. No es
            // recuperable desde aquí (el fd de permiso ya se cerró), pero al
            // menos queda constancia en el log del daemon.
            eprintln!("gigishell-guardian: fallo respondiendo a fanotify: {err}");
            return Err(err);
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
/// que `statx` sigue funcionando aunque no se haya abierto el contenido). El
/// número de enlaces (`nlink`) se devuelve aparte porque quien marca/protege
/// necesita saberlo para decidir si vale la pena seguir vigilando un fichero
/// que ya no tiene ningún nombre en el árbol (borrado con el fd todavía
/// abierto): no es parte de la identidad del inodo, es una señal para el
/// llamador.
///
/// POR QUÉ `statx` + `/proc/self/mountinfo` Y NUNCA `fstat().st_dev`: medido
/// en esta misma máquina, en btrfs `st_dev` es el dev ANÓNIMO del subvolumen
/// (cada subvolumen monta como si fuera un filesystem propio), no el dev del
/// superbloque real que el kernel usa puertas adentro — `inode->i_sb->s_dev`,
/// que es lo que lee `guardian.bpf.c` en `protegido()`/`identidad()` vía
/// `BPF_CORE_READ(sb, s_dev)`. Un fichero protegido bajo `/home` en esta
/// máquina (btrfs) construido con `st_dev` NUNCA habría coincidido con lo que
/// ve el BPF: ni la clave de `protegidos` ni la de `permisos`/`categorias`
/// (esta última con el inodo del EJECUTABLE, que también puede estar en btrfs)
/// habrían casado jamás, en silencio — R1/R2 solo colaron en la verificación
/// porque el directorio de pruebas caía en tmpfs, donde por casualidad
/// `st_dev` sí coincide con el dev del superbloque. `statx(..., STATX_MNT_ID)`
/// da el ID de MONTAJE (`stx_mnt_id`), y solo resolviendo ese id contra
/// `/proc/self/mountinfo` (campo 1 = id de montaje, campo 3 = `major:minor`
/// del superbloque de ESE montaje) se obtiene el mismo `dev` que ve el kernel.
/// Si esa resolución falla, es un error — jamás se cae de vuelta a `st_dev`,
/// que sería exactamente el fallo silencioso que esto corrige.
pub fn clave_de_fd(fd: BorrowedFd<'_>) -> io::Result<(ClaveInodo, u64)> {
    let st = statx_por_fd(fd)?;
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")?;
    let dev = dev_de_montaje(&mountinfo, st.stx_mnt_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "el id de montaje {} (statx) no aparece en /proc/self/mountinfo",
                st.stx_mnt_id
            ),
        )
    })?;
    Ok((
        ClaveInodo {
            dev,
            ino: st.stx_ino,
        },
        st.stx_nlink as u64,
    ))
}

/// `statx` sobre un fd ya abierto, con `AT_EMPTY_PATH` (la ruta pasada es
/// vacía: se refiere al fd en sí, no a algo resuelto desde él — funciona sobre
/// un `O_PATH` exactamente igual que `fstat`) pidiendo lo básico más
/// `STATX_MNT_ID` (el dato que `fstat` no puede dar).
fn statx_por_fd(fd: BorrowedFd<'_>) -> io::Result<libc::statx> {
    let vacia = CString::new("").expect("una cadena vacía no contiene NUL");
    let mut buf: MaybeUninit<libc::statx> = MaybeUninit::zeroed();
    let ret = unsafe {
        libc::statx(
            fd.as_raw_fd(),
            vacia.as_ptr(),
            libc::AT_EMPTY_PATH,
            libc::STATX_BASIC_STATS | libc::STATX_MNT_ID,
            buf.as_mut_ptr(),
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `statx` devolvió éxito, así que `buf` está completamente
    // inicializada (los campos pedidos en la máscara, y el kernel escribe la
    // struct entera de todos modos).
    Ok(unsafe { buf.assume_init() })
}

/// Busca en el contenido de `/proc/self/mountinfo` (o de `/proc/<pid>/mountinfo`
/// de cualquier proceso: el formato es el mismo) el montaje cuyo id (campo 1)
/// es `mnt_id`, y devuelve el `dev` del superbloque de ESE montaje — campo 3,
/// `major:minor` en decimal — ya combinado como `(major << 20) | minor`, el
/// mismo formato "dev_t nuevo" que usa el kernel puertas adentro (ver
/// `tipos::kdev`, que hace la misma combinación partiendo de un `dev_t`
/// empaquetado en vez de un `major:minor` ya separado). Función pura (sin E/S)
/// para poder probarla con líneas de ejemplo sin necesitar `/proc` de verdad.
/// `None` si `mnt_id` no aparece — el llamador decide qué hacer con eso, nunca
/// cae de vuelta a otra fuente de `dev`.
fn dev_de_montaje(mountinfo: &str, mnt_id: u64) -> Option<u64> {
    for linea in mountinfo.lines() {
        let mut campos = linea.split_whitespace();
        let id = campos.next()?.parse::<u64>().ok()?;
        if id != mnt_id {
            continue;
        }
        // Campo 2 (id del padre) se salta; campo 3 es `major:minor`. La
        // posición de ambos es fija pese a que el número de "campos
        // opcionales" entre el 6 y el separador `-` varíe de una línea a
        // otra (ver `man 5 proc_pid_mountinfo`): están ANTES de esa parte
        // variable, así que un `split_whitespace` normal sin buscar el `-`
        // basta.
        let _padre = campos.next()?;
        let major_minor = campos.next()?;
        let (major, minor) = major_minor.split_once(':')?;
        let major: u64 = major.parse().ok()?;
        let minor: u64 = minor.parse().ok()?;
        return Some((major << 20) | minor);
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    // Dos líneas realistas de `/proc/self/mountinfo` (formato de `man 5
    // proc_pid_mountinfo`): un `tmpfs` (sin campos opcionales extra más allá
    // de `shared:11`) y un `btrfs` con subvolumen (`subvolid=256,subvol=/@`),
    // que es justo el caso que causó el bug de R3 — el dev de ESTE montaje
    // (0:35) es el que tiene que salir, nunca el dev anónimo que `stat()`
    // reporta para el subvolumen.
    const MOUNTINFO_EJEMPLO: &str = "\
25 30 0:23 / /run rw,nosuid,nodev,noexec,relatime shared:11 - tmpfs tmpfs rw,size=3272672k,nr_inodes=819200,mode=755,inode64
36 25 0:35 / / rw,relatime shared:1 - btrfs /dev/mapper/luks-abcdef rw,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/@
";

    #[test]
    fn dev_de_montaje_encuentra_el_id_que_existe() {
        // major=0, minor=35 -> (0 << 20) | 35 == 35.
        assert_eq!(dev_de_montaje(MOUNTINFO_EJEMPLO, 36), Some(35));
        // El otro montaje de la muestra, para no probar solo el último campo.
        assert_eq!(dev_de_montaje(MOUNTINFO_EJEMPLO, 25), Some(23));
    }

    #[test]
    fn dev_de_montaje_ausente_es_none() {
        assert_eq!(dev_de_montaje(MOUNTINFO_EJEMPLO, 999), None);
    }

    /// Integra `clave_de_ruta` con un fichero y un `/proc/self/mountinfo`
    /// REALES (no las líneas de muestra de arriba): comprueba que la tubería
    /// completa (statx del fd -> mnt_id -> `dev_de_montaje` sobre el
    /// mountinfo real de este proceso) da el mismo `dev` que recalcularla a
    /// mano con las mismas dos piezas — es decir, que `clave_de_fd` no se
    /// desvía de esa vía hacia `st_dev` en ningún punto intermedio.
    ///
    /// NO afirma que ese `dev` sea distinto del de `fstat().st_dev`: en esta
    /// máquina $HOME es btrfs y, medido, SÍ lo es (el bug de R3 que motivó
    /// este cambio era justo eso), pero en un filesystem sin subvolúmenes
    /// (ext4, tmpfs…) `st_dev` y el dev de mountinfo suelen coincidir, y
    /// afirmar la diferencia rompería el test ahí. Lo único que se garantiza
    /// en cualquier filesystem es que la vía usada es mountinfo, no `st_dev`.
    #[test]
    fn clave_de_ruta_usa_el_dev_del_superbloque_via_mountinfo() {
        let home = std::env::var("HOME").expect("HOME debe estar definido para este test");
        let archivo = tempfile::Builder::new()
            .prefix("guardian-mountinfo-")
            .tempfile_in(&home)
            .expect("crear un fichero temporal dentro de HOME");

        let clave = clave_de_ruta(archivo.path()).expect("clave_de_ruta sobre un fichero real");

        let fd = abrir_opath(archivo.path()).expect("O_PATH del mismo fichero");
        let st = statx_por_fd(fd.as_fd()).expect("statx del mismo fichero");
        let mountinfo =
            fs::read_to_string("/proc/self/mountinfo").expect("leer /proc/self/mountinfo");
        let dev_esperado = dev_de_montaje(&mountinfo, st.stx_mnt_id)
            .expect("el mount id del propio fichero tiene que aparecer en su mountinfo");

        assert_eq!(clave.dev, dev_esperado);
    }
}
