//! Escáner de Descargas: port de `monitor_downloads` de oom-monitor.sh. Los porqués
//! de cada decisión (barrido con find en vez de inotify recursivo, memo por
//! mtime|tamaño + hash de CONTENIDO, un solo clamscan por lote, pausas, rc == 2 que
//! no marca nada…) están documentados en el bash; aquí solo lo que cambia:
//!
//! - inotify es solo el DESPERTADOR, igual que antes, pero con watches propios
//!   (recursivos, se reponen en cada barrido) en vez de relanzar `inotifywait -r`.
//! - El hash (XXH64, idéntico a `xxh64sum`) se calcula en proceso, en un hilo con
//!   prioridad `nice 19` + E/S idle creado para cada lote. Un hilo aparte y no este:
//!   la prioridad se hereda, y el botón «Lanzar aislado» lanza la app del usuario
//!   desde aquí — no puede salir con prioridad idle.
//! - `clamscan` sigue siendo un proceso (`nice -n 19 ionice -c 3` si existen).
//! - **Las rutas son BYTES (`PathBuf`), nunca texto.** Un nombre que no es UTF-8 (un
//!   `.zip` de Windows extraído sin `-O`, un torrent en Latin-1) convertido a `String`
//!   pasa a llevar U+FFFD y deja de existir: no se hasheaba, no se avisaba y ClamAV no
//!   lo veía NUNCA, en silencio. Solo se pasa a texto lo que se enseña en un aviso.
//! - Con `--simular` no se escribe ningún estado en disco (índice, hashes): así puede
//!   correr junto al bash sin pisarle el índice.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use crate::notif::{aviso_con_boton, formatear, log, notificar, recortar, Grupo, Salida};
use crate::sistema::{en_path, home, Config};

const DELAY: Duration = Duration::from_secs(60);
const SETTLE: u64 = 15;
const DEBOUNCE: Duration = Duration::from_secs(3);
const DEBOUNCE_TOPE: Duration = Duration::from_secs(30);
const RED_SEGURIDAD: Duration = Duration::from_secs(300);
const CLAM_TOPE: u64 = 2_147_483_647;
const GIB: f64 = 1_073_741_824.0;
const CAP_LISTA: usize = 300;

// ── Utilidades puras (con tests) ──────────────────────────────────────────────

fn termina_en_ci(p: &Path, sufijos: &[&str]) -> bool {
    let b = p.as_os_str().as_bytes().to_ascii_lowercase();
    sufijos.iter().any(|s| b.ends_with(s.as_bytes()))
}

pub fn es_temporal(p: &Path) -> bool {
    termina_en_ci(p, &[
        ".part", ".crdownload", ".download", ".opdownload", ".partial", ".tmp", ".temp", ".aria2",
        ".!qb", ".!ut", ".bc!", ".crswap",
    ])
}

/// `${f%.*}`: quita desde el ÚLTIMO punto de la ruta entera.
pub fn sin_extension(p: &Path) -> PathBuf {
    let b = p.as_os_str().as_bytes();
    let corte = b.iter().rposition(|&c| c == b'.').unwrap_or(b.len());
    PathBuf::from(OsString::from_vec(b[..corte].to_vec()))
}

pub fn extension_lanzable(p: &Path) -> bool {
    termina_en_ci(p, &[".appimage", ".run", ".sh", ".bin", ".exe", ".msi", ".deb", ".rpm", ".desktop"])
}

fn c_ruta(p: &Path) -> std::ffi::CString {
    std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap_or_default()
}

/// ¿Podrías ejecutarlo? Bit de ejecución, tipo de instalador conocido o binario ELF.
fn es_lanzable(ruta: &Path) -> bool {
    if !ruta.is_file() {
        return false;
    }
    if unsafe { libc::access(c_ruta(ruta).as_ptr(), libc::X_OK) } == 0 || extension_lanzable(ruta) {
        return true;
    }
    let mut cab = [0u8; 4];
    fs::File::open(ruta).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut cab)).is_ok() && cab == *b"\x7fELF"
}

/// Línea de clamscan `"/ruta: Firma FOUND"` → `"/ruta: Firma"`.
pub fn deteccion(linea: &str) -> Option<String> {
    let l = linea.strip_suffix(" FOUND")?;
    let (f, firma) = (l.split(": ").next()?, l.rsplit(": ").next()?);
    Some(format!("{f}: {firma}"))
}

/// Ajustes del escáner que se releen en cada barrido (aplican sin reiniciar).
#[derive(Debug, PartialEq)]
pub struct AjustesDl {
    pub pausa_ahorro: bool,
    pub pausa_bateria: bool,
    pub pausa_juego: bool,
    pub max_bytes: u64,
}

pub fn ajustes_de(v: &serde_json::Value) -> AjustesDl {
    let b = |k: &str, def: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(def);
    let gb = v
        .get("dlMaxScanGB")
        .and_then(|x| x.as_f64().or_else(|| x.as_str()?.parse().ok()))
        .filter(|g| *g >= 0.0)
        .unwrap_or(1.0);
    let bytes = (gb * GIB) as u64;
    AjustesDl {
        pausa_ahorro: b("dlPauseInPowerSave", false),
        pausa_bateria: b("dlPauseOnBattery", false),
        // Activada por defecto: `false` explícito la apaga (el `// true` de jq no servía).
        pausa_juego: b("dlPauseWhileGaming", true),
        max_bytes: if bytes < 1 { GIB as u64 } else { bytes },
    }
}

/// Umbral del modo ahorro. El bash casaba `"thresholdPct": <dígitos>` con una regex:
/// un decimal se quedaba en su parte entera y una cadena no casaba (→ 15).
pub fn umbral_de(v: &serde_json::Value) -> u64 {
    v.get("thresholdPct").and_then(|x| x.as_f64()).filter(|x| *x >= 0.0).map(|x| x as u64).unwrap_or(15)
}

/// ¿Cuenta como batería DEL SISTEMA? `scope=Device` es un periférico (el ratón); un
/// `type` distinto de Battery es el cargador. Sin `type`, o vacío, cuenta (BAT0 de
/// portátil sin esos atributos), igual que en el bash.
pub fn es_bateria_del_sistema(scope: Option<&str>, tipo: Option<&str>) -> bool {
    scope != Some("Device") && tipo.is_none_or(|t| t.is_empty() || t == "Battery")
}

/// Avisos de malware del lote: misma deduplicación, recorte a 300 caracteres y tope de
/// entradas que la agrupación del bash (`notif_encolar`).
pub fn items_malware(detecciones: &[String]) -> (Vec<(String, usize)>, usize) {
    let mut items: Vec<(String, usize)> = vec![];
    for d in detecciones {
        let t = recortar(d);
        if let Some(i) = items.iter().position(|(x, _)| *x == t) {
            items[i].1 += 1;
        } else if items.len() < CAP_LISTA {
            items.push((t, 1));
        }
    }
    (items, detecciones.len())
}

// ── Energía y juego, leídos en vivo (sin depender de AGS salvo el flag) ────────

fn baterias_del_sistema() -> Vec<PathBuf> {
    let Ok(d) = fs::read_dir("/sys/class/power_supply") else { return vec![] };
    let mut v: Vec<PathBuf> = d
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let leer = |f: &str| fs::read_to_string(p.join(f)).map(|s| s.trim().to_string()).ok();
            es_bateria_del_sistema(leer("scope").as_deref(), leer("type").as_deref())
        })
        .collect();
    v.sort();
    v
}

fn con_bateria() -> bool {
    baterias_del_sistema()
        .iter()
        .any(|p| fs::read_to_string(p.join("status")).is_ok_and(|s| s.trim() == "Discharging"))
}

fn porcentaje_bateria() -> u64 {
    baterias_del_sistema()
        .iter()
        .find_map(|p| fs::read_to_string(p.join("capacity")).ok()?.trim().parse().ok())
        .unwrap_or(100)
}

fn leer_json(p: &Path) -> serde_json::Value {
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null)
}

/// ¿Debe pausarse AHORA el escaneo automático? Fail-open. OJO: aquí «jugando» es el
/// `gaming` a secas, sin la gracia de foco de la puerta de los sondeos — es lo que
/// hacía `_dl_paused` y tiene su propio interruptor en la UI.
fn pausado(a: &AjustesDl) -> bool {
    let h = home();
    if a.pausa_juego
        && leer_json(&h.join(".config/gigishell/runtime-state.json")).get("gaming") == Some(&serde_json::Value::Bool(true))
    {
        return true;
    }
    if (a.pausa_bateria || a.pausa_ahorro) && con_bateria() {
        if a.pausa_bateria {
            return true;
        }
        return porcentaje_bateria() <= umbral_de(&leer_json(&h.join(".config/power-save/config.json")));
    }
    false
}

// ── Estado persistente ────────────────────────────────────────────────────────

struct Escaner {
    salida: Salida,
    /// false con `--simular`: nada de estado en disco.
    persistir: bool,
    dir: PathBuf,
    clam: Vec<String>,
    prioridad_baja: Vec<String>,
    idx: HashMap<PathBuf, String>,
    analizados: HashSet<String>,
    avisados: HashMap<PathBuf, String>,
    sembrado: bool,
    avisado_motor: bool,
    idx_file: PathBuf,
    hash_file: PathBuf,
    lista_file: PathBuf,
    cfg: Config,
}

fn carpeta_descargas(home: &Path) -> Option<PathBuf> {
    // Locale-aware (aquí es ~/Descargas). xdg-user-dir devuelve $HOME si no está
    // configurada, y eso cuenta como vacío.
    let xdg = Command::new("xdg-user-dir")
        .arg("DOWNLOAD")
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|o| {
            let mut b = o.stdout;
            while b.last().is_some_and(|c| c.is_ascii_whitespace()) {
                b.pop();
            }
            PathBuf::from(OsString::from_vec(b))
        })
        .filter(|d| !d.as_os_str().is_empty() && d != home && d.is_dir());
    xdg.or_else(|| ["Downloads", "Descargas"].iter().map(|c| home.join(c)).find(|d| d.is_dir()))
}

fn segundos_epoch() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn firma(p: &Path) -> Option<String> {
    let m = fs::symlink_metadata(p).ok()?;
    Some(format!("{}|{}", m.mtime(), m.size()))
}

/// `find DIR -type f -printf '%T@|%s|%p'`: ficheros regulares, sin seguir enlaces.
/// Devuelve también los directorios, para reponer los watches. ITERATIVO a propósito:
/// con recursión, un árbol absurdamente profundo desbordaría la pila del hilo y
/// (con `panic = "abort"`) se llevaría el proceso entero.
fn recorrer(raiz: &Path, ficheros: &mut Vec<(PathBuf, String)>, dirs: &mut Vec<PathBuf>) {
    let mut pila = vec![raiz.to_path_buf()];
    while let Some(dir) = pila.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        dirs.push(dir);
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue }; // DirEntry::metadata no sigue enlaces
            if m.is_dir() {
                pila.push(e.path());
            } else if m.is_file() {
                ficheros.push((e.path(), format!("{}|{}", m.mtime(), m.size())));
            }
        }
    }
}

/// Hashea en un hilo de prioridad mínima (CPU nice 19 + E/S idle).
fn hashear_en_segundo_plano(rutas: Vec<PathBuf>) -> HashMap<PathBuf, String> {
    let trabajo = move || {
        unsafe {
            let tid = libc::gettid() as libc::id_t;
            libc::setpriority(libc::PRIO_PROCESS, tid, 19);
            // IOPRIO_WHO_PROCESS = 1, IOPRIO_CLASS_IDLE = 3 << 13
            libc::syscall(libc::SYS_ioprio_set, 1, tid, 3 << 13);
        }
        rutas
            .into_iter()
            .filter_map(|r| {
                let h = crate::xxh64::fichero(&r)?;
                Some((r, h))
            })
            .collect()
    };
    match std::thread::Builder::new().spawn(trabajo) {
        Ok(h) => h.join().unwrap_or_default(),
        // Sin hilo no hay hash: el lote se analiza entero, que es lo seguro.
        Err(_) => HashMap::new(),
    }
}

fn ruta_bytes(p: &Path) -> &[u8] {
    p.as_os_str().as_bytes()
}

impl Escaner {
    fn nuevo(salida: Salida, dir: PathBuf) -> Self {
        let h = home();
        let persistir = salida == Salida::Real;
        let cache = h.join(".cache/gigishell");
        if persistir {
            let _ = fs::create_dir_all(&cache);
            let _ = fs::remove_file(cache.join("download-seen")); // estado viejo (ruta|tamaño)
        }
        // clamscan (standalone) antes que clamdscan (necesita clamd corriendo). Sin los
        // --max-* clamscan SALTA y da por limpio lo > 100 MB.
        let clam: Vec<String> = if en_path("clamscan") {
            ["clamscan", "--no-summary", "--max-filesize=2147483647", "--max-scansize=2147483647"]
                .map(String::from)
                .to_vec()
        } else if en_path("clamdscan") {
            ["clamdscan", "--fdpass", "--no-summary"].map(String::from).to_vec()
        } else {
            vec![]
        };
        // Solo si existen, como en el bash: sin `nice` o `ionice` el spawn fallaría y el
        // lote no se analizaría nunca.
        let mut prioridad_baja = vec![];
        if en_path("nice") {
            prioridad_baja.extend(["nice", "-n", "19"].map(String::from));
        }
        if en_path("ionice") {
            prioridad_baja.extend(["ionice", "-c", "3"].map(String::from));
        }
        // La lista del lote NO va a /tmp con un nombre predecible: otro usuario podría
        // crearla antes y, con `protected_regular`, no se podría escribir nunca — el
        // escáner dejaría de analizar sin decir nada. $XDG_RUNTIME_DIR es 0700 y nuestro.
        let privado = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or(cache.clone());
        let idx_file = cache.join("download-index");
        let hash_file = cache.join("download-hashes");
        let mut idx = HashMap::new();
        let sembrado = idx_file.exists();
        // mtime|tamaño|ruta — la ruta puede llevar '|' (y bytes no UTF-8): todo lo que
        // sigue al 2º '|' es la ruta, tal cual.
        for l in fs::read(&idx_file).unwrap_or_default().split(|&b| b == b'\n') {
            let mut p = l.splitn(3, |&b| b == b'|');
            if let (Some(m), Some(s), Some(f)) = (p.next(), p.next(), p.next()) {
                if !f.is_empty() {
                    let sig = format!("{}|{}", String::from_utf8_lossy(m), String::from_utf8_lossy(s));
                    idx.insert(PathBuf::from(OsString::from_vec(f.to_vec())), sig);
                }
            }
        }
        let analizados = fs::read_to_string(&hash_file)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect();
        Escaner {
            salida,
            persistir,
            dir,
            clam,
            prioridad_baja,
            idx,
            analizados,
            avisados: HashMap::new(),
            sembrado,
            avisado_motor: false,
            idx_file,
            hash_file,
            lista_file: privado.join(format!("gigishell-eventd-lote.{}", std::process::id())),
            cfg: Config::new(h.join(".config/gigishell/security.json")),
        }
    }

    /// Un barrido completo. Devuelve los directorios vistos (para los watches).
    fn barrer(&mut self) -> Vec<PathBuf> {
        self.cfg.recargar(Instant::now());
        let mut dirs = vec![];
        if !self.cfg.activo("downloadScan") {
            return dirs;
        }
        let ajustes = ajustes_de(&leer_json(&home().join(".config/gigishell/security.json")));
        // Techo real = min(tope del usuario, lo máximo que clamscan escanea).
        let clam_max = ajustes.max_bytes.min(CLAM_TOPE);
        if pausado(&ajustes) {
            return dirs; // difiere TODO: nada se marca, se recoge al reanudar
        }

        // ── Fase A.1: rutas + temporales (y su nombre base) ─────────────────────
        let mut todos = vec![];
        recorrer(&self.dir, &mut todos, &mut dirs);
        let bases_temp: HashSet<PathBuf> =
            todos.iter().filter(|(f, _)| es_temporal(f)).map(|(f, _)| sin_extension(f)).collect();
        // Lo que cuenta como "presente" para podar el índice es lo que el bash metía en
        // `_now`: ni los temporales ni el final cuyo temporal sigue ahí.
        let considerados: Vec<&(PathBuf, String)> =
            todos.iter().filter(|(f, _)| !es_temporal(f) && !bases_temp.contains(f)).collect();
        let presentes: HashSet<&PathBuf> = considerados.iter().map(|(f, _)| f).collect();
        let ahora = segundos_epoch();
        let mut cambiado = false;

        // ── Fase A.2: clasificar ───────────────────────────────────────────────
        let mut a_hashear = vec![];
        let mut grandes = vec![];
        let mut ejecutables = vec![];
        for (f, sig) in &considerados {
            let (mtime, sz) = sig
                .split_once('|')
                .map(|(m, s)| (m.parse::<u64>().unwrap_or(0), s.parse::<u64>().unwrap_or(0)))
                .unwrap_or((0, 0));
            if ahora.saturating_sub(mtime) < SETTLE || self.idx.get(f) == Some(sig) {
                continue; // aún escribiéndose, o sin cambios
            }
            let lanzable = || self.sembrado && es_lanzable(f);
            if !self.clam.is_empty() && sz > 0 && sz < clam_max {
                a_hashear.push(f.clone());
            } else if !self.clam.is_empty() && sz >= clam_max {
                self.idx.insert(f.clone(), sig.clone());
                cambiado = true;
                if self.sembrado {
                    grandes.push((f.clone(), sz));
                }
                if lanzable() {
                    ejecutables.push(f.clone());
                }
            } else {
                self.idx.insert(f.clone(), sig.clone());
                cambiado = true;
                if lanzable() {
                    ejecutables.push(f.clone());
                }
            }
        }
        let firmas: HashMap<&PathBuf, &String> = considerados.iter().map(|(f, s)| (f, s)).collect();
        let hashes = hashear_en_segundo_plano(a_hashear.clone());
        let mut lote = vec![];
        for f in a_hashear {
            let sig = firmas.get(&f).map(|s| s.to_string()).unwrap_or_default();
            if hashes.get(&f).is_some_and(|h| self.analizados.contains(h)) {
                self.idx.insert(f, sig); // contenido ya analizado: marcar y saltar
                cambiado = true;
                continue;
            }
            // Un aviso por fichero y proceso: con el motor roto no se marca idx y sin
            // este freno el mismo .exe avisaría en cada barrido.
            if self.sembrado && es_lanzable(&f) && self.avisados.get(&f) != Some(&sig) {
                self.avisados.insert(f.clone(), sig);
                ejecutables.push(f.clone());
            }
            lote.push(f);
        }

        // Podar lo que ya no existe (o que vuelve a tener su temporal al lado).
        let antes = self.idx.len();
        self.idx.retain(|f, _| presentes.contains(f));
        cambiado |= self.idx.len() != antes;

        self.avisar_grandes(&grandes);
        self.avisar_ejecutables(&ejecutables);

        // ── Fase B: UN clamscan por lote, interrumpible ─────────────────────────
        let lote: Vec<PathBuf> = lote.into_iter().filter(|f| f.is_file()).collect();
        if !lote.is_empty() {
            let (marcar, detecciones) = self.analizar(&lote, &ajustes);
            if !detecciones.is_empty() {
                let g = Grupo {
                    evento: "descargas.malware",
                    urgencia: "critical",
                    tmo_ms: 0,
                    titulo: "Malware detectado en Descargas",
                    plural: "amenazas detectadas en Descargas",
                    prefijo: "",
                    sufijo: " — NO lo ejecutes.",
                };
                let (items, total) = items_malware(&detecciones);
                let (t, c) = formatear(&g, &items, total);
                notificar(self.salida, g.evento, g.urgencia, &t, &c, g.tmo_ms);
            }
            if marcar {
                let mut nuevos = String::new();
                for f in &lote {
                    let Some(sig) = firma(f) else { continue };
                    self.idx.insert(f.clone(), sig);
                    cambiado = true;
                    if let Some(h) = hashes.get(f) {
                        if self.analizados.insert(h.clone()) {
                            nuevos.push_str(h);
                            nuevos.push('\n');
                        }
                    }
                }
                if !nuevos.is_empty() && self.persistir {
                    let _ = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&self.hash_file)
                        .and_then(|mut f| f.write_all(nuevos.as_bytes()));
                }
            }
        }

        if cambiado {
            self.guardar_indice();
        }
        self.valvula_hashes();
        self.sembrado = true;
        dirs
    }

    /// Analiza el lote. Devuelve (se puede marcar como analizado, detecciones).
    fn analizar(&mut self, lote: &[PathBuf], ajustes: &AjustesDl) -> (bool, Vec<String>) {
        let mut lista = Vec::new();
        for f in lote {
            lista.extend_from_slice(ruta_bytes(f));
            lista.push(b'\n');
        }
        if let Err(e) = fs::write(&self.lista_file, &lista) {
            log(&format!("descargas: no se pudo escribir la lista del lote: {e}"));
            return (false, vec![]);
        }
        let mut argv: Vec<&str> = self.prioridad_baja.iter().map(String::as_str).collect();
        argv.extend(self.clam.iter().map(String::as_str));
        let mut c = Command::new(argv[0]);
        c.args(&argv[1..]);
        let mut arg_lista = OsString::from("--file-list=");
        arg_lista.push(self.lista_file.as_os_str());
        c.arg(arg_lista);
        let hijo = c.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).spawn();
        let Ok(mut hijo) = hijo else {
            let _ = fs::remove_file(&self.lista_file);
            log("descargas: no se pudo lanzar el antivirus; el lote queda sin marcar");
            return (false, vec![]);
        };
        // La salida se lee en otro hilo: un lote con muchas detecciones llenaría la
        // tubería y clamscan se quedaría bloqueado escribiendo.
        let mut stdout = hijo.stdout.take().unwrap();
        let leer = move || {
            let mut s = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stdout, &mut s);
            String::from_utf8_lossy(&s).into_owned()
        };
        let lector = std::thread::Builder::new().spawn(leer);
        let mut cortado = false;
        let estado = loop {
            match hijo.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) => {
                    if pausado(ajustes) {
                        let _ = hijo.kill();
                        cortado = true;
                        break hijo.wait().ok();
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                Err(_) => break None,
            }
        };
        let salida = match lector {
            Ok(h) => h.join().unwrap_or_default(),
            Err(_) => String::new(),
        };
        let _ = fs::remove_file(&self.lista_file);
        let rc = estado.and_then(|s| s.code());
        // SOLO 0 (limpio) y 1 (encontrado) son "el motor analizó". Un 2 es "sin firmas";
        // morir por una señal (el OOM se lleva a clamscan: ClamAV 1.x ronda 1 GB) o un
        // 126/127 (desinstalado a mitad de sesión) tampoco analizó nada, y marcarlo lo
        // daría por limpio PARA SIEMPRE, porque el memo va por hash de contenido.
        let motor_ok = matches!(rc, Some(0) | Some(1));
        if !cortado {
            if rc == Some(2) {
                if !self.avisado_motor {
                    self.avisado_motor = true;
                    self.avisar_sin_firmas();
                }
            } else if !motor_ok {
                log(&format!("descargas: el antivirus terminó sin analizar (código {rc:?}); se reintentará"));
            }
        }
        // Se avisa de lo detectado aunque se cortara: lo ya escaneado cuenta.
        let det = salida.lines().filter_map(deteccion).collect();
        (!cortado && motor_ok, det)
    }

    fn avisar_sin_firmas(&self) {
        // El barrido NUNCA actualiza firmas por su cuenta: solo avisa, con botón.
        let script = home().join(".config/hypr/scripts/actualizar-firmas.sh");
        if es_ejecutable(&script) {
            let salida = self.salida;
            let _ = std::thread::Builder::new().spawn(move || {
                if aviso_con_boton(salida, "antivirus.sin-firmas", "critical", "Antivirus sin base de firmas",
                    "ClamAV no puede analizar las descargas. Hasta que se actualicen las firmas NO se dan por analizadas.",
                    60000, "update", "Actualizar firmas", Some(Duration::from_secs(120)))
                {
                    let _ = Command::new(&script).status();
                }
            });
        } else {
            notificar(self.salida, "antivirus.sin-firmas", "critical", "Antivirus sin base de firmas",
                "ClamAV no puede analizar las descargas. Ejecuta 'sudo freshclam'. Hasta entonces NO se dan por analizadas.", 0);
        }
    }

    fn avisar_grandes(&self, grandes: &[(PathBuf, u64)]) {
        // Botón por fichero hasta 4; más, resumen (descomprimir un juego suelta muchos).
        if grandes.len() > 4 {
            notificar(self.salida, "descargas.archivo-grande", "normal",
                &format!("{} archivos grandes sin analizar", grandes.len()),
                "Superan el tope de auto-análisis. Escanéalos desde Ajustes › Seguridad.", 15000);
            return;
        }
        let scan = home().join(".config/hypr/scripts/scan-file.sh");
        for (f, sz) in grandes {
            let nombre = nombre_de(f);
            let mb = sz / 1_048_576;
            if es_ejecutable(&scan) {
                let (salida, f, scan) = (self.salida, f.clone(), scan.clone());
                let cuerpo = format!("{nombre} ({mb} MB) supera el tope de auto-análisis. Escanéalo aquí o en Ajustes › Seguridad.");
                let _ = std::thread::Builder::new().spawn(move || {
                    if aviso_con_boton(salida, "descargas.archivo-grande", "normal", "Archivo grande sin analizar",
                        &cuerpo, 45000, "scan", "Escanear igualmente", None)
                    {
                        let _ = Command::new(&scan).arg(&f).status();
                    }
                });
            } else {
                notificar(self.salida, "descargas.archivo-grande", "normal", "Archivo grande sin analizar",
                    &format!("{nombre} ({mb} MB) — escanéalo desde Ajustes › Seguridad."), 12000);
            }
        }
    }

    fn avisar_ejecutables(&self, ejecutables: &[PathBuf]) {
        if ejecutables.len() > 4 {
            let carpeta = ejecutables[0]
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            notificar(self.salida, "descargas.ejecutable-nuevo", "normal",
                &format!("{} ejecutables nuevos en Descargas", ejecutables.len()),
                &format!("En {carpeta}/ y otros. Revísalos antes de ejecutarlos (juego, instalador o crack)."), 15000);
            return;
        }
        let aislado = home().join(".config/hypr/scripts/run-untrusted.sh");
        for f in ejecutables {
            let cuerpo = format!("{} — verifícalo antes de lanzarlo.", nombre_de(f));
            if self.cfg.activo("sandboxLaunch") && es_ejecutable(&aislado) {
                let (salida, f, aislado) = (self.salida, f.clone(), aislado.clone());
                let _ = std::thread::Builder::new().spawn(move || {
                    if aviso_con_boton(salida, "descargas.ejecutable-nuevo", "normal", "Ejecutable nuevo en Descargas",
                        &cuerpo, 45000, "launch", "Lanzar aislado", None)
                    {
                        let _ = Command::new(&aislado).arg(&f).status();
                    }
                });
            } else {
                notificar(self.salida, "descargas.ejecutable-nuevo", "normal", "Ejecutable nuevo en Descargas", &cuerpo, 12000);
            }
        }
    }

    fn guardar_indice(&self) {
        if !self.persistir {
            return;
        }
        let mut s: Vec<u8> = Vec::new();
        for (f, sig) in &self.idx {
            s.extend_from_slice(sig.as_bytes());
            s.push(b'|');
            s.extend_from_slice(ruta_bytes(f));
            s.push(b'\n');
        }
        let tmp = self.idx_file.with_extension("tmp");
        if fs::write(&tmp, s).is_ok() {
            let _ = fs::rename(&tmp, &self.idx_file);
        }
    }

    /// download-hashes es append-only (~17 B/entrada): pasados 10 MB se quedan las
    /// 100 últimas. Tope duro, no rutina.
    fn valvula_hashes(&mut self) {
        if !self.persistir || fs::metadata(&self.hash_file).map(|m| m.len()).unwrap_or(0) <= 10 * 1024 * 1024 {
            return;
        }
        let todo = fs::read_to_string(&self.hash_file).unwrap_or_default();
        let lineas: Vec<&str> = todo.lines().filter(|l| !l.is_empty()).collect();
        let ultimas = &lineas[lineas.len().saturating_sub(100)..];
        let tmp = self.hash_file.with_extension("tmp");
        if fs::write(&tmp, ultimas.join("\n") + "\n").is_ok() && fs::rename(&tmp, &self.hash_file).is_ok() {
            self.analizados = ultimas.iter().map(|s| s.to_string()).collect();
        }
    }
}

fn nombre_de(f: &Path) -> String {
    f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn es_ejecutable(p: &Path) -> bool {
    p.is_file() && unsafe { libc::access(c_ruta(p).as_ptr(), libc::X_OK) } == 0
}

// ── Bucle: inotify como despertador ───────────────────────────────────────────

struct Despertador {
    fd: i32,
}

impl Despertador {
    fn nuevo() -> Option<Self> {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        (fd >= 0).then_some(Despertador { fd })
    }

    /// Añadir un watch a un directorio ya vigilado devuelve el mismo: reponer todos
    /// en cada barrido cubre las subcarpetas creadas después (el punto ciego de
    /// `inotifywait -r`, que obligó a barrer con find).
    fn vigilar(&self, dirs: &[PathBuf]) {
        let m = libc::IN_CREATE | libc::IN_CLOSE_WRITE | libc::IN_MOVED_TO | libc::IN_MOVED_FROM | libc::IN_DELETE;
        for d in dirs {
            unsafe { libc::inotify_add_watch(self.fd, c_ruta(d).as_ptr(), m) };
        }
    }

    /// Espera hasta `plazo`; true si hubo eventos (y los vacía).
    fn esperar(&self, plazo: Duration) -> bool {
        let mut pfd = libc::pollfd { fd: self.fd, events: libc::POLLIN, revents: 0 };
        let r = unsafe { libc::poll(&mut pfd, 1, plazo.as_millis().min(i32::MAX as u128) as i32) };
        if r <= 0 {
            return false;
        }
        let mut buf = [0u8; 16 * 1024];
        while unsafe { libc::read(self.fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
        true
    }
}

pub fn correr(salida: Salida) {
    // El más caro del arranque (hash + ClamAV de lo nuevo): nada se descarga en el
    // primer minuto de sesión y `find` lo ve igual después.
    std::thread::sleep(DELAY);
    let Some(dir) = carpeta_descargas(&home()) else { return };
    let mut e = Escaner::nuevo(salida, dir.clone());
    let despertador = Despertador::nuevo();
    let dirs = e.barrer();
    let Some(d) = despertador else {
        // Sin inotify: sondeo clásico de 30 s.
        loop {
            std::thread::sleep(Duration::from_secs(30));
            e.barrer();
        }
    };
    // La raíz SIEMPRE: un barrido en pausa (juego, batería) o con el escáner apagado no
    // recorre nada y devuelve la lista vacía; sin esto, lo que se descargara al salir de
    // la pausa esperaría a la red de seguridad (hasta 5 min) en vez de ~3 s.
    d.vigilar(std::slice::from_ref(&dir));
    d.vigilar(&dirs);
    loop {
        if d.esperar(RED_SEGURIDAD) {
            // Debounce: extraer un juego son miles de eventos. Calma de 3 s, tope 30 s
            // (una descarga larga escribe sin parar).
            let t0 = Instant::now();
            while d.esperar(DEBOUNCE) && t0.elapsed() < DEBOUNCE_TOPE {}
        }
        let dirs = e.barrer();
        d.vigilar(std::slice::from_ref(&dir));
        d.vigilar(&dirs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn temporales() {
        assert!(es_temporal(&p("/d/juego.zip.PART")));
        assert!(es_temporal(&p("/d/x.crdownload")));
        assert!(es_temporal(&p("/d/peli.mkv.!qB")));
        assert!(!es_temporal(&p("/d/x.zip")));
        assert_eq!(sin_extension(&p("/d/juego.zip.part")), p("/d/juego.zip"));
    }

    #[test]
    fn rutas_no_utf8_sobreviven() {
        // "Instalaci\xf3n.exe" en Latin-1: no es UTF-8 válido.
        let dir = std::env::temp_dir().join(format!("eventd-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut nombre = b"Instalaci".to_vec();
        nombre.extend_from_slice(b"\xf3n.exe");
        let f = dir.join(OsString::from_vec(nombre));
        fs::write(&f, b"MZ").unwrap();
        let (mut fs_, mut ds) = (vec![], vec![]);
        recorrer(&dir, &mut fs_, &mut ds);
        assert_eq!(fs_.len(), 1);
        assert!(fs_[0].0.is_file(), "la ruta recorrida tiene que seguir existiendo");
        assert!(es_lanzable(&fs_[0].0));
        assert!(crate::xxh64::fichero(&fs_[0].0).is_some());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lanzables_por_extension() {
        assert!(extension_lanzable(&p("/d/Setup.EXE")));
        assert!(extension_lanzable(&p("/d/app.AppImage")));
        assert!(!extension_lanzable(&p("/d/foto.png")));
    }

    #[test]
    fn lineas_de_clamscan() {
        assert_eq!(
            deteccion("/home/u/Descargas/eicar.com: Win.Test.EICAR_HDB-1 FOUND").as_deref(),
            Some("/home/u/Descargas/eicar.com: Win.Test.EICAR_HDB-1")
        );
        assert_eq!(deteccion("/home/u/Descargas/a.txt: OK"), None);
    }

    #[test]
    fn ajustes() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        let a = ajustes_de(&v("{}"));
        assert_eq!(a, AjustesDl { pausa_ahorro: false, pausa_bateria: false, pausa_juego: true, max_bytes: GIB as u64 });
        let a = ajustes_de(&v(r#"{"dlPauseWhileGaming": false, "dlMaxScanGB": 2.5, "dlPauseOnBattery": true}"#));
        assert!(!a.pausa_juego && a.pausa_bateria);
        assert_eq!(a.max_bytes, (2.5 * GIB) as u64);
        // Basura → valores por defecto (juego activada).
        assert!(ajustes_de(&v(r#"{"dlPauseWhileGaming": "no"}"#)).pausa_juego);
        assert_eq!(ajustes_de(&v(r#"{"dlMaxScanGB": 0}"#)).max_bytes, GIB as u64);
    }

    #[test]
    fn umbral_como_el_bash() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        assert_eq!(umbral_de(&v(r#"{"thresholdPct": 20}"#)), 20);
        assert_eq!(umbral_de(&v(r#"{"thresholdPct": 12.9}"#)), 12);
        assert_eq!(umbral_de(&v(r#"{"thresholdPct": "20"}"#)), 15);
        assert_eq!(umbral_de(&v("{}")), 15);
    }

    #[test]
    fn baterias() {
        assert!(es_bateria_del_sistema(None, None));
        assert!(es_bateria_del_sistema(None, Some("")));
        assert!(es_bateria_del_sistema(Some("System"), Some("Battery")));
        assert!(!es_bateria_del_sistema(Some("Device"), Some("Battery")));
        assert!(!es_bateria_del_sistema(None, Some("Mains")));
    }

    #[test]
    fn malware_recortado_y_con_tope() {
        let larga = "x".repeat(400);
        let (items, total) = items_malware(&[larga.clone(), larga]);
        assert_eq!(total, 2);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0.chars().count(), 300);
        assert_eq!(items[0].1, 2);
        let muchas: Vec<String> = (0..400).map(|i| format!("f{i}: Sig")).collect();
        let (items, total) = items_malware(&muchas);
        assert_eq!((items.len(), total), (300, 400));
    }
}
