// gigishell-guardian: cargador del programa BPF LSM — abre el objeto, ancla cada
// mapa en bpffs, engancha los nueve programas y expone las operaciones que el
// resto del daemon usa para gobernar los mapas (marcar/desmarcar ficheros,
// conceder permisos, leer eventos del ring buffer).
//
// Por qué se ancla TODO en /sys/fs/bpf (bpffs) y no se deja como memoria del
// proceso: un panic de este daemon (panic = "abort" en Cargo.toml, ver el
// comentario de ese fichero) no puede dejar temporalmente sin guardia un fichero
// protegido mientras systemd lo reinicia. Con los mapas y los enlaces anclados en
// bpffs, el programa LSM sigue vivo y denegando en el kernel aunque el proceso
// userspace esté caído entre el crash y el `Restart=on-failure`; el nuevo proceso
// simplemente reabre lo que ya estaba (`set_pin_path` + comprobación de pin
// existente en `cargar()`), en vez de recrear los mapas vacíos y dejar una
// ventana sin protección.
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::mem::MaybeUninit;
use std::path::{Path, PathBuf};

use libbpf_rs::skel::{OpenSkel, SkelBuilder};
use libbpf_rs::{Error as ErrorBpf, ErrorKind, MapCore, MapFlags, MapHandle, OpenObject};
use libbpf_rs::{Link, RingBuffer, RingBufferBuilder};

use crate::tipos::{
    como_bytes, desde_bytes, ClaveInodo, ClavePermiso, ClaveProceso, Control, Pendiente,
    ValorProtegido,
};

// El esqueleto lo genera libbpf-cargo a partir de src/bpf/guardian.bpf.c (build.rs);
// `include!` lo trae tal cual, con su propio módulo `imp` reexportado.
#[allow(dead_code, non_snake_case, non_camel_case_types, clippy::all)]
mod skel {
    include!(concat!(env!("OUT_DIR"), "/guardian.skel.rs"));
}
use skel::{GuardianSkel, GuardianSkelBuilder};

/// Raíz de bpffs donde se anclan mapas y enlaces de guardian. Un mapa vive en
/// `RAIZ/<nombre-del-mapa>`, un enlace en `RAIZ/enlaces/<programa>_<pid>_<nanos>`.
pub const RAIZ: &str = "/sys/fs/bpf/gigishell-guardian";

/// Nombres de los nueve programas LSM, en el mismo orden en que
/// `guardian.bpf.c` los declara — solo se usa para poder listarlos/depurarlos;
/// `enganchar_programas!` de más abajo referencia cada campo por su nombre real.
const PROGRAMAS: &[&str] = &[
    "g_file_open",
    "g_unlink",
    "g_link",
    "g_rename",
    "g_setattr",
    "g_path_truncate",
    "g_file_truncate",
    "g_setxattr",
    "g_removexattr",
];

/// Error del cargador: envuelve tanto fallos de libbpf (mapas, programas,
/// enlaces) como de E/S normal y corriente (crear/borrar el directorio de
/// anclajes bajo bpffs). Sin una dependencia de manejo de errores en el crate,
/// un enum pequeño con `From` basta para poder usar `?` en ambos mundos.
#[derive(Debug)]
pub enum Error {
    Bpf(ErrorBpf),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Bpf(e) => write!(f, "libbpf: {e}"),
            Error::Io(e) => write!(f, "E/S: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<ErrorBpf> for Error {
    fn from(e: ErrorBpf) -> Self {
        Error::Bpf(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Resultado<T> = std::result::Result<T, Error>;

/// Borra una clave si existe; una clave ya ausente no es un fallo (los `0 ⇒
/// borrar` de este módulo son idempotentes: el llamador no tiene por qué saber
/// si ya se había borrado antes).
fn borrar(mapa: &impl MapCore, clave: &[u8]) -> Resultado<()> {
    match mapa.delete(clave) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Cargador BPF anclado: mantiene vivo el objeto cargado (mapas + programas) y
/// los enlaces de los nueve hooks LSM mientras el daemon corre.
pub struct Bpf {
    skel: GuardianSkel<'static>,
    // Los `Link` de los nueve hooks. Se guardan aquí (y no se sueltan tras
    // engancharlos) porque un `Link` sin anclar en bpffs SÍ desengancha el
    // programa al destruirse (ver el comentario de `parar_limpio`): mientras el
    // daemon vive, mantener el valor no es necesario para que el hook siga
    // activo (el anclaje ya lo garantiza), pero si `parar_limpio` quiere
    // desenganchar de verdad necesita este mismo `Link`, no uno reabierto.
    enlaces: Vec<Link>,
}

impl Bpf {
    /// Abre (o reabre) el objeto BPF, ancla sus mapas y engancha los nueve
    /// programas LSM.
    ///
    /// Orden deliberado para no dejar nunca un instante sin guardia tras una
    /// caída: primero se enganchan y anclan los enlaces NUEVOS, y solo DESPUÉS
    /// se borran los anclajes VIEJOS que hubiera en `RAIZ/enlaces/`. Si el
    /// proceso se cayera entre medias quedarían enlaces duplicados (viejo +
    /// nuevo) enganchados al mismo hook — inofensivo, dos programas idénticos
    /// deniegan lo mismo dos veces — en vez del hueco inverso (viejo borrado,
    /// nuevo aún sin enganchar) en el que una apertura pasaría sin que nada la
    /// vigile.
    pub fn cargar() -> Resultado<Self> {
        let dir_enlaces = PathBuf::from(RAIZ).join("enlaces");
        fs::create_dir_all(&dir_enlaces)?;

        // Enlaces que ya hubiera de un arranque anterior (crash, reinstalación):
        // se listan ANTES de enganchar los nuevos para poder borrarlos después,
        // no antes.
        let enlaces_viejos: Vec<PathBuf> = fs::read_dir(&dir_enlaces)?
            .filter_map(|entrada| entrada.ok())
            .map(|entrada| entrada.path())
            .collect();

        // `Box::leak` le da a `OpenObject` vida `'static`: el esqueleto pide un
        // `&'obj mut MaybeUninit<OpenObject>` con el que ata todos los tipos que
        // devuelve a esa misma vida, y `Bpf` necesita quedarse con `GuardianSkel`
        // más allá de esta función. No hay fuga real de memoria en la práctica:
        // vive exactamente lo que vive el proceso, igual que el propio programa
        // BPF cargado.
        let objeto_abierto: &'static mut MaybeUninit<OpenObject> =
            Box::leak(Box::new(MaybeUninit::uninit()));

        let builder = GuardianSkelBuilder::default();
        let mut skel_abierto = builder.open(objeto_abierto)?;

        // Anclar cada mapa ANTES de `load()`: si ya existe un anclaje de una
        // carga anterior, libbpf reutiliza ese mapa (y su contenido) en vez de
        // crear uno vacío — así el conjunto de ficheros protegidos (y sus
        // permisos) sobrevive a un reinicio del daemon y el BPF sigue
        // denegando entretanto. Lo que NO sobrevive son las marcas de
        // fanotify: ver `desmarcar_todo` justo después de `load()`.
        for mut mapa in skel_abierto.open_object_mut().maps_mut() {
            let nombre = mapa
                .name()
                .to_str()
                .ok_or_else(|| {
                    Error::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "nombre de mapa no UTF-8",
                    ))
                })?
                .to_string();
            if nombre.is_empty() {
                // El objeto BPF puede traer mapas internos sin nombre (p.ej.
                // `.rodata`/`.bss` de variables globales); no se anclan.
                continue;
            }
            mapa.set_pin_path(Path::new(RAIZ).join(&nombre))?;
        }

        // Un `load()` que falla (p.ej. un mapa anclado de una versión anterior
        // de `guardian.bpf.c` con otro tamaño de clave/valor, incompatible con
        // el que se acaba de compilar) deja los mapas VIEJOS tal cual estaban,
        // anclados en `RAIZ`: si ya había un guardián corriendo desde una
        // carga anterior, sus programas y reglas SIGUEN vivos en el kernel y
        // denegando exactamente igual que antes de este intento — solo este
        // proceso nuevo no ha conseguido arrancar. Por eso el error lo dice
        // explícitamente en vez de limitarse a propagar el de libbpf, y por
        // qué esta función NUNCA borra `RAIZ` por su cuenta ante un fallo de
        // carga: hacerlo automáticamente tiraría esa guardia todavía vigente
        // sin que nadie lo haya decidido. Recuperar de un anclaje realmente
        // incompatible es una decisión manual: `sudo rm -r
        // /sys/fs/bpf/gigishell-guardian` y reiniciar el daemon (recreará los
        // mapas desde cero).
        let skel = skel_abierto.load().map_err(|e| {
            eprintln!(
                "gigishell-guardian: fallo cargando el objeto BPF ({e}). Si ya había un guardián \
                 anclado en {RAIZ}, sigue denegando con las reglas de su última carga: este \
                 proceso nuevo simplemente no ha arrancado. Si el anclaje es de verdad \
                 incompatible (p.ej. tras cambiar el layout de un mapa), la recuperación es \
                 manual: `sudo rm -r {RAIZ}` y reiniciar el daemon."
            );
            Error::Bpf(e)
        })?;

        // Las marcas de fanotify NO sobreviven al proceso que las puso (mueren
        // con su fd), pero los mapas anclados sí: tras una caída `protegidos`
        // seguiría diciendo `marcado = 1` para inodos que ya no tiene marcados
        // nadie. `g_file_open` dejaría pasar la apertura a la espera de una
        // respuesta de fanotify que nunca llega — falla ABIERTO, sin error. Se
        // desmarca todo ANTES de nada más, para que el BPF (los programas
        // viejos, todavía enganchados, comparten estos mismos mapas) deniegue
        // hasta que el nuevo proceso vuelva a marcar cada fichero. Las
        // peticiones pendientes de antes tampoco valen: eran para aperturas
        // que ya se resolvieron sin nadie.
        desmarcar_todo(&skel)?;

        let pid = std::process::id();
        // Sufijo único por carga, no solo el pid: si el daemon se cae y el pid
        // se recicla (normal en un sistema con reinicios frecuentes) antes de
        // que se retiren los anclajes viejos, un segundo `<prog>.<pid>` con el
        // MISMO pid colisionaría con el que dejó el proceso anterior (`pin()`
        // sobre una ruta ya anclada falla con EEXIST) y el daemon no podría
        // arrancar — justo el escenario que este anclaje está pensado para
        // sobrevivir. Los nanosegundos desde epoch bastan para no repetirse
        // entre dos arranques del mismo proceso.
        let sufijo = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut enlaces = Vec::with_capacity(PROGRAMAS.len());
        for nombre in PROGRAMAS {
            let enlace_nuevo = enganchar_programa(&skel, nombre)?;
            let mut enlace_nuevo = enlace_nuevo;
            // Separado por `_`: bpffs rechaza con EPERM cualquier nombre con `.`.
            enlace_nuevo.pin(dir_enlaces.join(format!("{nombre}_{pid}_{sufijo}")))?;
            enlaces.push(enlace_nuevo);
        }

        // Solo ahora, con los nueve programas nuevos ya enganchados Y anclados,
        // se retiran los anclajes de la carga anterior.
        for viejo in enlaces_viejos {
            let _ = fs::remove_file(viejo);
        }

        Ok(Bpf { skel, enlaces })
    }

    /// Activa/desactiva el programa (`Control.activo`) y dice quién es el
    /// daemon (`Control.pid_daemon`), que es lo que `identidad()` en el BPF usa
    /// para no aplicarse las reglas a sí mismo.
    pub fn control(&self, activo: bool) -> Resultado<()> {
        let clave = 0u32;
        let valor = Control {
            activo: activo as u32,
            pid_daemon: std::process::id(),
        };
        self.skel
            .maps
            .control
            .update(como_bytes(&clave), como_bytes(&valor), MapFlags::ANY)?;
        Ok(())
    }

    /// Marca `clave` (dev, ino) como protegida bajo el id interno `fichero`.
    /// `marcado` NO es la categoría de acceso silencioso (esa vive aparte, en
    /// el mapa `categorias` — ver `categoria()`); aquí solo dice si el inodo
    /// tiene ya una marca de fanotify puesta (`tipos::MARCADO`, ≠0) o si
    /// todavía no la tiene (0, p.ej. el inodo recién heredado de un guardado
    /// atómico antes de que el daemon vuelva a marcarlo — ver `EV_HEREDADO`
    /// en `guardian.bpf.c`): con `marcado == 0` el LSM deniega directamente
    /// en `file_open` en vez de generar una petición pendiente, porque sin
    /// marca de fanotify nadie va a responder a esa petición jamás.
    pub fn proteger(&self, clave: ClaveInodo, fichero: u32, marcado: u32) -> Resultado<()> {
        let valor = ValorProtegido { fichero, marcado };
        self.skel
            .maps
            .protegidos
            .update(como_bytes(&clave), como_bytes(&valor), MapFlags::ANY)?;
        Ok(())
    }

    /// Retira la protección de `clave`. No borra los permisos/categorías
    /// concedidos sobre el `fichero` al que apuntaba: eso es cosa de
    /// `limpiar_fichero`, que el llamador invoca aparte cuando de verdad quiere
    /// olvidar ese id (des-proteger temporalmente y volver a proteger el mismo
    /// fichero no debería perder los permisos ya concedidos).
    pub fn desproteger(&self, clave: ClaveInodo) -> Resultado<()> {
        borrar(&self.skel.maps.protegidos, como_bytes(&clave))
    }

    /// Permiso concedido a un EJECUTABLE (`exe`, identificado por su propio
    /// inodo) sobre `fichero`: vale para cualquier proceso de ese binario.
    /// `mascara == 0` borra la entrada en vez de dejar un permiso vacío.
    pub fn permiso(&self, fichero: u32, exe: ClaveInodo, mascara: u32) -> Resultado<()> {
        let clave = ClavePermiso {
            fichero,
            _pad: 0,
            dev: exe.dev,
            ino: exe.ino,
        };
        let clave_bytes = como_bytes(&clave);
        if mascara == 0 {
            return borrar(&self.skel.maps.permisos, clave_bytes);
        }
        self.skel
            .maps
            .permisos
            .update(clave_bytes, &[mascara as u8], MapFlags::ANY)?;
        Ok(())
    }

    /// Permiso concedido a un PROCESO concreto (`tgid`) sobre `fichero`: es el
    /// que usa el bucle de fanotify cuando el usuario responde "permitir" a una
    /// apertura puntual. A diferencia de `permiso()`, aquí SÍ se hace OR con lo
    /// que ya hubiera — conceder LEER no debe borrar un MODIFICAR concedido
    /// antes al mismo proceso — salvo que `mascara == 0`, que es la señal
    /// explícita de "olvida lo que hubiera", no un OR con la máscara vacía (que
    /// sería un no-op y dejaría el permiso viejo intacto).
    pub fn permiso_proceso(&self, fichero: u32, tgid: u32, mascara: u32) -> Resultado<()> {
        let clave = ClaveProceso { fichero, tgid };
        let clave_bytes = como_bytes(&clave);
        if mascara == 0 {
            return borrar(&self.skel.maps.procesos, clave_bytes);
        }
        let previo = self
            .skel
            .maps
            .procesos
            .lookup(clave_bytes, MapFlags::ANY)?
            .and_then(|v| v.first().copied())
            .unwrap_or(0u8);
        let nuevo = previo | (mascara as u8);
        self.skel
            .maps
            .procesos
            .update(clave_bytes, &[nuevo], MapFlags::ANY)?;
        Ok(())
    }

    /// Categoría de acceso silencioso/automático (`CAT_PERMITIR`/`CAT_SILENCIO`)
    /// para (fichero, ejecutable). `modo == 0` borra la entrada.
    pub fn categoria(&self, fichero: u32, exe: ClaveInodo, modo: u32) -> Resultado<()> {
        let clave = ClavePermiso {
            fichero,
            _pad: 0,
            dev: exe.dev,
            ino: exe.ino,
        };
        let clave_bytes = como_bytes(&clave);
        if modo == 0 {
            return borrar(&self.skel.maps.categorias, clave_bytes);
        }
        self.skel
            .maps
            .categorias
            .update(clave_bytes, &[modo as u8], MapFlags::ANY)?;
        Ok(())
    }

    /// Olvida por completo el id `fichero`: todos los permisos por ejecutable y
    /// por proceso, todas las categorías y toda petición pendiente que lo
    /// referencien. Se usa cuando Ajustes borra la protección de un fichero
    /// (no solo la desmarca temporalmente): sin esto, un id reciclado para otro
    /// fichero heredaría permisos que no le corresponden.
    pub fn limpiar_fichero(&self, fichero: u32) -> Resultado<()> {
        for mapa in [&self.skel.maps.permisos, &self.skel.maps.categorias] {
            let claves: Vec<Vec<u8>> = mapa.keys().collect();
            for clave in claves {
                if let Some(cp) = desde_bytes::<ClavePermiso>(&clave) {
                    if cp.fichero == fichero {
                        borrar(mapa, &clave)?;
                    }
                }
            }
        }

        let claves: Vec<Vec<u8>> = self.skel.maps.procesos.keys().collect();
        for clave in claves {
            if let Some(cpr) = desde_bytes::<ClaveProceso>(&clave) {
                if cpr.fichero == fichero {
                    borrar(&self.skel.maps.procesos, &clave)?;
                }
            }
        }

        let claves: Vec<Vec<u8>> = self.skel.maps.pendientes.keys().collect();
        for clave in claves {
            if let Some(valor) = self.skel.maps.pendientes.lookup(&clave, MapFlags::ANY)? {
                if let Some(pend) = desde_bytes::<Pendiente>(&valor) {
                    if pend.fichero == fichero {
                        borrar(&self.skel.maps.pendientes, &clave)?;
                    }
                }
            }
        }

        Ok(())
    }

    /// Purga del mapa `protegidos` cualquier inodo que ya no esté en `vivos`:
    /// la lista autoritativa la mantiene Ajustes en su propio JSON (fuera de
    /// este crate), y esto es lo que sincroniza el mapa BPF con ella tras un
    /// arranque en el que la lista pudo cambiar mientras el daemon no corría
    /// (mapa anclado y reutilizado, ver `cargar()`).
    pub fn retener(&self, vivos: &HashSet<ClaveInodo>) -> Resultado<()> {
        let claves: Vec<Vec<u8>> = self.skel.maps.protegidos.keys().collect();
        for clave_bytes in claves {
            if let Some(clave) = desde_bytes::<ClaveInodo>(&clave_bytes) {
                if !vivos.contains(&clave) {
                    borrar(&self.skel.maps.protegidos, &clave_bytes)?;
                }
            }
        }
        Ok(())
    }

    /// Entrada de `protegidos` para `clave`, si la hay. Es lo que dice a qué
    /// id de fichero corresponde el fd de un evento de fanotify.
    pub fn protegido(&self, clave: ClaveInodo) -> Option<ValorProtegido> {
        let bytes = self
            .skel
            .maps
            .protegidos
            .lookup(como_bytes(&clave), MapFlags::ANY)
            .ok()??;
        desde_bytes::<ValorProtegido>(&bytes)
    }

    /// Lee y borra (atómicamente) la petición pendiente del hilo `tid` — clave
    /// por TID y no por TGID, ver el comentario junto a `pend.fichero` en
    /// `guardian.bpf.c`: es la que fanotify puede casar de verdad con su propio
    /// evento (que también viene indexado por TID gracias a `FAN_REPORT_TID`).
    pub fn pendiente(&self, tid: u32) -> Option<Pendiente> {
        let clave = tid;
        let bytes = self
            .skel
            .maps
            .pendientes
            .lookup_and_delete(como_bytes(&clave))
            .ok()??;
        desde_bytes::<Pendiente>(&bytes)
    }

    /// Ring buffer de eventos (`EV_*`) que el BPF empuja para que el daemon los
    /// procese (notificar, auditar…). `cola` se invoca una vez por evento
    /// crudo; que reciba bytes y no un `Evento` ya montado es deliberado — así
    /// este módulo no decide qué hacer con un evento corto o corrupto, que es
    /// cosa del llamador (`desde_bytes` en `tipos.rs` ya sabe rechazarlo).
    pub fn anillo<'a, F>(&'a self, cola: F) -> Resultado<RingBuffer<'a>>
    where
        F: FnMut(&[u8]) -> i32 + 'a,
    {
        let mut constructor = RingBufferBuilder::new();
        constructor.add(&self.skel.maps.eventos, cola)?;
        Ok(constructor.build()?)
    }

    /// Detiene la protección de forma deliberada (a diferencia de un crash, que
    /// la deja intacta): desancla y suelta los nueve enlaces —lo que sí los
    /// desengancha de verdad, ver el comentario de `enlaces` más arriba— y borra
    /// toda la raíz de bpffs, mapas incluidos. Consume `self` porque no tiene
    /// sentido seguir usando el resto de métodos sobre un objeto ya desmontado.
    pub fn parar_limpio(mut self) -> Resultado<()> {
        for mut enlace in self.enlaces.drain(..) {
            // Sin desanclar primero, soltar `enlace` no desengancharía nada: el
            // anclaje en bpffs es en sí mismo una referencia que mantiene vivo
            // el hook aunque se cierre el descriptor de este proceso (es la
            // mitad de la persistencia que aprovecha `cargar()` tras un crash).
            let _ = enlace.unpin();
        }
        fs::remove_dir_all(RAIZ)?;
        Ok(())
    }
}

/// Pone `marcado = 0` en toda entrada de `protegidos` y vacía `pendientes`
/// (ver la llamada en `Bpf::cargar`). Conserva el id de fichero: los permisos
/// y categorías ya concedidos siguen valiendo cuando se vuelva a marcar.
fn desmarcar_todo(skel: &GuardianSkel<'_>) -> Resultado<()> {
    let protegidos = &skel.maps.protegidos;
    let claves: Vec<Vec<u8>> = protegidos.keys().collect();
    for clave in claves {
        let Some(bytes) = protegidos.lookup(&clave, MapFlags::ANY)? else {
            continue;
        };
        let Some(mut valor) = desde_bytes::<ValorProtegido>(&bytes) else {
            continue;
        };
        if valor.marcado != 0 {
            valor.marcado = 0;
            protegidos.update(&clave, como_bytes(&valor), MapFlags::EXIST)
                .or_else(|e| if e.kind() == ErrorKind::NotFound { Ok(()) } else { Err(e) })?;
        }
    }

    let pendientes = &skel.maps.pendientes;
    let claves: Vec<Vec<u8>> = pendientes.keys().collect();
    for clave in claves {
        borrar(pendientes, &clave)?;
    }
    Ok(())
}

/// Engancha por nombre uno de los nueve programas LSM del esqueleto ya cargado.
/// Una función aparte (en vez de repetir el `match` en `cargar()`) porque
/// `GuardianProgs` no es iterable: sus nueve campos son de tipos con el mismo
/// nombre de tipo pero vidas propias generadas una a una por el macro de
/// libbpf-cargo, así que hay que nombrarlos.
fn enganchar_programa(skel: &GuardianSkel<'_>, nombre: &str) -> Resultado<Link> {
    let enlace = match nombre {
        "g_file_open" => skel.progs.g_file_open.attach_lsm(),
        "g_unlink" => skel.progs.g_unlink.attach_lsm(),
        "g_link" => skel.progs.g_link.attach_lsm(),
        "g_rename" => skel.progs.g_rename.attach_lsm(),
        "g_setattr" => skel.progs.g_setattr.attach_lsm(),
        "g_path_truncate" => skel.progs.g_path_truncate.attach_lsm(),
        "g_file_truncate" => skel.progs.g_file_truncate.attach_lsm(),
        "g_setxattr" => skel.progs.g_setxattr.attach_lsm(),
        "g_removexattr" => skel.progs.g_removexattr.attach_lsm(),
        _ => unreachable!("PROGRAMAS solo lista los nueve nombres de arriba"),
    }?;
    Ok(enlace)
}

/// Deja el programa BPF ya anclado (posiblemente huérfano, sin daemon vivo)
/// como inactivo, sin necesidad de reabrir todo el esqueleto: solo se toca el
/// mapa `control`, por su ruta anclada. Es lo que usa, por ejemplo, un
/// `systemctl stop` que quiere dejar de denegar accesos sin desmontar los
/// programas (a diferencia de `Bpf::parar_limpio`, que sí los desmonta). Un
/// `RAIZ/control` ausente (nunca se cargó, o ya se hizo `parar_limpio`) no es un
/// error: no hay nada que desactivar, y se devuelve `Ok(())`.
///
/// Cualquier OTRO fallo (el anclaje existe pero no se puede abrir, o la
/// escritura del mapa falla) SÍ se propaga: tragárselo en silencio, como hacía
/// antes, dejaría `Control.activo` en 1 con el proceso userspace ya muerto —
/// exactamente el escenario de "falla abierto" que este mismo comentario dice
/// evitar (`exigir()`/`g_file_open` en `guardian.bpf.c` niegan cuando
/// `!ctl->activo`, pero nunca llegan a ver `activo=0` si esta función no pudo
/// escribirlo y nadie se entera).
pub fn tras_parada() -> Result<(), String> {
    let ruta = Path::new(RAIZ).join("control");
    if !ruta.exists() {
        return Ok(());
    }
    let mapa = MapHandle::from_pinned_path(&ruta)
        .map_err(|e| format!("abriendo el mapa control anclado en {}: {e}", ruta.display()))?;
    let clave = 0u32;
    let valor = Control {
        activo: 0,
        pid_daemon: 0,
    };
    mapa.update(como_bytes(&clave), como_bytes(&valor), MapFlags::ANY)
        .map_err(|e| format!("desactivando el control anclado en {}: {e}", ruta.display()))?;
    Ok(())
}
