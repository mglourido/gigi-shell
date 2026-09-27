// Tipos compartidos entre el programa BPF (guardian.bpf.c) y el userspace.
//
// ESPEJO BYTE A BYTE DEL C: estas structs son las claves/valores de los mapas BPF
// (BPF_MAP_TYPE_HASH y similares) tal como los declara/declarará guardian.bpf.c
// (Tarea 2). El kernel y userspace comparten memoria a través del mapa sin pasar
// por (de)serialización: si un campo, su orden o su tamaño no coincide EXACTAMENTE
// con el lado C, el mapa se lee/escribe con basura sin que nada avise — de ahí
// `#[repr(C)]` en todas y el test de `size_of` de más abajo, que es lo único que
// detecta un desajuste antes de llegar al kernel.
//
// Constantes de bits de operación (máscara de `ClavePermiso`/`Pendiente.pedido`):
pub const LEER: u32 = 1;
pub const MODIFICAR: u32 = 2;
pub const BORRAR: u32 = 4;

// Categoría de acceso silencioso/automático, mapa `categorias` (clave por
// fichero+ejecutable) — NO tiene relación con `ValorProtegido.marcado` pese al
// nombre parecido, ver `MARCADO` justo debajo.
pub const CAT_PERMITIR: u32 = 1;
pub const CAT_SILENCIO: u32 = 2;

// `ValorProtegido.marcado`: ≠0 quiere decir que el inodo YA tiene puesta una
// marca de fanotify (`FAN_MARK_ADD`) y las aperturas sin derechos generan una
// petición pendiente que el daemon puede responder; 0 es el estado transitorio
// de un inodo recién heredado (guardado atómico, `EV_HEREDADO`) que el LSM
// deniega directamente porque, sin marca de fanotify, ninguna petición
// pendiente que generara llegaría a tener respuesta.
pub const MARCADO: u32 = 1;

// Tipos de evento que el BPF empuja al ring buffer / perf buffer para que el
// daemon los procese (notificar, pedir permiso al usuario, registrar auditoría…).
pub const EV_DENEGADO: u32 = 1;
pub const EV_SILENCIO: u32 = 2;
pub const EV_HEREDADO: u32 = 3;
pub const EV_MOVIDO: u32 = 4;
pub const EV_BORRADO: u32 = 5;

/// Clave por inodo: identifica un fichero por `(dispositivo, número de inodo)`,
/// que es estable frente a renombrados pero no frente a `dev`/`ino` reciclados
/// tras borrar y recrear (fuera del alcance de esta tarea).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ClaveInodo {
    pub dev: u64,
    pub ino: u64,
}

/// Valor asociado a un fichero marcado como protegido: el id interno con el que
/// se lo referencia desde otros mapas (`fichero`) y la categoría de protección
/// (`marcado`: `CAT_PERMITIR`/`CAT_SILENCIO`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ValorProtegido {
    pub fichero: u32,
    pub marcado: u32,
}

/// Clave de permiso por (fichero, proceso, inodo): un permiso concedido lo es
/// para un `tgid` concreto sobre un `(dev, ino)` concreto, no para el fichero en
/// abstracto — así un proceso no hereda el permiso de otro ni sobre un inodo que
/// ya no es el mismo fichero. `_pad` alinea `dev`/`ino` (u64) a 8 bytes, como haría
/// el compilador C con esta misma disposición de campos.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ClavePermiso {
    pub fichero: u32,
    pub _pad: u32,
    pub dev: u64,
    pub ino: u64,
}

/// Clave de proceso: un fichero visto desde un `tgid` concreto (para heredar o no
/// el permiso a hilos/hijos según corresponda).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ClaveProceso {
    pub fichero: u32,
    pub tgid: u32,
}

/// Petición pendiente de que el daemon la resuelva: qué operación se pidió
/// (`pedido`, máscara de LEER/MODIFICAR/BORRAR) y si ya se concedió (`permitido`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pendiente {
    pub fichero: u32,
    pub pedido: u8,
    pub permitido: u8,
    pub _pad: [u8; 2],
}

/// Interruptor global del programa BPF y PID del daemon que lo controla (para que
/// el propio daemon pueda distinguirse de cualquier otro proceso al aplicar las
/// reglas, p.ej. no denegarse operaciones a sí mismo).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Control {
    pub activo: u32,
    pub pid_daemon: u32,
}

/// Evento que el BPF notifica a userspace: tipo (`EV_*`), fichero afectado,
/// proceso (`tgid`), operación (`op`, máscara LEER/MODIFICAR/BORRAR) e inodo
/// (`dev`/`ino`) sobre el que ocurrió.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Evento {
    pub tipo: u32,
    pub fichero: u32,
    pub tgid: u32,
    pub op: u32,
    pub dev: u64,
    pub ino: u64,
}

/// Combina major/minor de un `dev_t` de libc en el `dev_t` "nuevo" que usa el
/// kernel puertas adentro (BPF, `/proc`, etc.): `(major << 20) | minor`. El
/// `dev_t` clásico de glibc empaqueta el major en un byte y no distingue majors
/// por encima de 255 del todo bien entre plataformas; este formato sí, y es el
/// que hay que reproducir a mano porque `libc::major`/`libc::minor` deshacen el
/// empaquetado de GLIBC, no el del kernel.
///
/// NO USAR sobre `stat()/fstat().st_dev` para construir un `ClaveInodo`: en
/// btrfs (con subvolúmenes) `st_dev` es el dev ANÓNIMO del subvolumen, no el
/// del superbloque real que ve `guardian.bpf.c` — la vía correcta es
/// `fanotify::clave_de_fd`/`clave_de_ruta`, que resuelven el dev por
/// `statx(STATX_MNT_ID)` + `/proc/self/mountinfo`. Esta función queda como
/// utilidad de propósito general para convertir un `dev_t` YA empaquetado (no
/// hace falta para el `major:minor` de mountinfo, que llega ya separado).
pub fn kdev(dev: u64) -> u64 {
    let major = unsafe { libc::major(dev) } as u64;
    let minor = unsafe { libc::minor(dev) } as u64;
    (major << 20) | minor
}

/// Vista de una struct `#[repr(C)]` como bytes, para escribirla tal cual en un
/// mapa BPF (los mapas no saben de tipos Rust, solo de bytes).
pub fn como_bytes<T: Copy>(valor: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts(valor as *const T as *const u8, std::mem::size_of::<T>()) }
}

/// Reconstruye una struct `#[repr(C)]` desde un slice de bytes leído de un mapa
/// BPF. `None` si el slice no mide exactamente `size_of::<T>()` — un slice corto
/// (p.ej. de un mapa mal dimensionado) no se rellena con basura, se rechaza.
pub fn desde_bytes<T: Copy>(bytes: &[u8]) -> Option<T> {
    if bytes.len() != std::mem::size_of::<T>() {
        return None;
    }
    // SAFETY: el tamaño ya se comprobó arriba; T es `Copy` y `#[repr(C)]` en todos
    // los usos de esta función, así que cualquier patrón de bytes de ese tamaño es
    // una instancia válida (no hay punteros, ni invariantes que un byte arbitrario
    // pueda romper).
    Some(unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const T) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::size_of;

    #[test]
    fn tamanos_espejan_al_c() {
        assert_eq!(size_of::<ClaveInodo>(), 16);
        assert_eq!(size_of::<ValorProtegido>(), 8);
        assert_eq!(size_of::<ClavePermiso>(), 24);
        assert_eq!(size_of::<ClaveProceso>(), 8);
        assert_eq!(size_of::<Pendiente>(), 8);
        assert_eq!(size_of::<Control>(), 8);
        assert_eq!(size_of::<Evento>(), 32);
    }

    #[test]
    fn kdev_combina_major_y_minor() {
        // major=259 (> 255, no cabe en el byte alto del dev_t clásico) y minor=3:
        // el formato que usa el kernel para BPF (dev_t "nuevo") es (major << 20) | minor.
        assert_eq!(kdev(libc::makedev(259, 3)), (259u64 << 20) | 3u64);
        // minor grande (> 255) también debe sobrevivir sin truncarse.
        assert_eq!(kdev(libc::makedev(8, 300)), (8u64 << 20) | 300u64);
    }

    #[test]
    fn evento_ida_y_vuelta_por_bytes() {
        let original = Evento {
            tipo: EV_DENEGADO,
            fichero: 42,
            tgid: 1234,
            op: MODIFICAR,
            dev: 259,
            ino: 998877,
        };

        let bytes = como_bytes(&original);
        assert_eq!(bytes.len(), size_of::<Evento>());

        let reconstruido: Evento = desde_bytes(bytes).expect("slice del tamaño exacto");
        assert_eq!(reconstruido, original);
    }

    #[test]
    fn desde_bytes_con_slice_corto_es_none() {
        let corto = [0u8; 4];
        let resultado: Option<Evento> = desde_bytes(&corto);
        assert!(resultado.is_none());
    }
}
