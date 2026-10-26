//! Emisión de avisos: equivalente de `notificar` (lib/notif.sh) y de la agrupación en
//! ráfaga (lib/notif-agrupar.sh). Los dos contratos se conservan palabra por palabra
//! —mismo hint `x-gigishell-source:system`, mismo `x-gigishell-event:<id>`, mismos
//! títulos y cuerpos— porque AGS (catálogo y motor de reglas) depende de ellos.
//!
//! Se sigue llamando a `notify-send` en vez de hablar D-Bus: un aviso es raro, el fork
//! no importa, y así el hint se construye exactamente igual que en los scripts.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Dónde acaba un aviso. `Simulado` imprime en stdout en vez de notificar: sirve para
/// correr el daemon EN PARALELO con el bash y comparar sin duplicar avisos.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Salida {
    Real,
    Simulado,
}

/// Escribe en stderr SIN poder abortar el proceso. `eprintln!`/`println!` hacen panic
/// si la escritura falla (stderr/stdout cerrados o una tubería rota, p. ej. al lanzar el
/// script desde un terminal que ya se cerró), y con `panic = "abort"` eso se llevaría
/// los seis monitores por delante por una línea de diagnóstico.
pub fn log(msg: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "gigishell-eventd: {msg}");
}

fn imprimir(linea: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{linea}");
}

/// Lanza un hilo sin poder abortar: `thread::spawn` hace panic si el sistema no deja
/// crear el hilo. Aquí eso solo cuesta la tarea (y queda dicho), no el proceso.
pub fn hilo<F: FnOnce() + Send + 'static>(nombre: &str, f: F) {
    if let Err(e) = std::thread::Builder::new().name(nombre.into()).spawn(f) {
        log(&format!("no se pudo crear el hilo {nombre}: {e}"));
    }
}

/// Recorte de notif_encolar: las líneas del kernel son larguísimas, 300 caracteres.
pub fn recortar(texto: &str) -> String {
    if texto.chars().count() > 300 {
        texto.chars().take(299).chain(['…']).collect()
    } else {
        texto.to_string()
    }
}

pub fn id_valido(id: &str) -> bool {
    // ^[a-z0-9]+([.-][a-z0-9]+)*$
    !id.is_empty()
        && id.split(['.', '-']).all(|t| {
            !t.is_empty() && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Mismo mapa de remitentes que `hypr/scripts/lib/notif.sh`. Las excepciones van
/// antes de su familia; no se asignan cadenas ni se consultan archivos al notificar.
fn seudonimo(evento: &str) -> &'static str {
    match evento {
        "kernel.oom" => "Memoria",
        "archivos.actualizacion" => "Sistema",
        "kernel.modulo-sin-firmar" => "Seguridad",
        _ => match evento.split('.').next().unwrap_or("") {
            "bateria" => "Batería",
            "ram" => "Memoria",
            "sistema" | "actualizaciones" | "app" | "servicio" => "Sistema",
            "sudo" | "ssh" | "seguridad" | "archivos" | "monitor" => "Seguridad",
            "antivirus" | "analisis" | "descargas" | "aislado" => "Antivirus",
            "disco" | "limpieza" => "Mantenimiento",
            "temperatura" | "cpu" | "gpu" | "hardware" | "kernel" => "Hardware",
            "arranque" => "Arranque",
            "usb" => "USB",
            "wifi" => "Red",
            "bluetooth" => "Bluetooth",
            "camara" => "Privacidad",
            "gestos" => "Gestos",
            "energia" => "Energía",
            "juegos" => "Juegos",
            "grabacion" | "emojis" | "desinstalar" => "Escritorio",
            _ => "GiGiShell",
        },
    }
}

pub fn notificar(salida: Salida, evento: &str, urgencia: &str, titulo: &str, cuerpo: &str, tmo_ms: i64) {
    notificar_ext(salida, evento, urgencia, titulo, cuerpo, tmo_ms, None, None);
}

/// `notificar` con las dos piezas del aviso inmediato: `reemplaza` (`notify-send -r`)
/// sustituye la tarjeta de ese id en vez de apilar otra —AGS retira el popup y la
/// entrada con el mismo id—, y `id` (`-p`) recibe el id de la que se emite. El id
/// llega desde el hilo que recoge a notify-send, así que nunca bloquea el bucle.
#[allow(clippy::too_many_arguments)]
pub fn notificar_ext(
    salida: Salida,
    evento: &str,
    urgencia: &str,
    titulo: &str,
    cuerpo: &str,
    tmo_ms: i64,
    reemplaza: Option<u32>,
    id: Option<Arc<OnceLock<u32>>>,
) {
    if salida == Salida::Simulado {
        let r = reemplaza.map(|r| format!(" [reemplaza {r}]")).unwrap_or_default();
        imprimir(&format!("[{evento}] ({urgencia}, {tmo_ms} ms){r} {titulo} — {}", cuerpo.replace('\n', " ⏎ ")));
        if let Some(id) = id {
            let _ = id.set(1);
        }
        return;
    }
    let mut cmd = Command::new("notify-send");
    cmd.args(["-a", seudonimo(evento)]);
    cmd.arg("-h").arg("string:x-gigishell-source:system");
    if id_valido(evento) {
        cmd.arg("-h").arg(format!("string:x-gigishell-event:{evento}"));
    } else {
        log(&format!("notificar: id de evento inválido: {evento:?} (se emite sin identidad)"));
    }
    if let Some(r) = reemplaza {
        cmd.arg("-r").arg(r.to_string());
    }
    if id.is_some() {
        cmd.arg("-p");
    }
    cmd.args(["-u", urgencia, titulo, cuerpo, "-t", &tmo_ms.to_string()])
        .stdin(Stdio::null())
        .stdout(if id.is_some() { Stdio::piped() } else { Stdio::null() });
    // Se recoge en un hilo aparte para no dejar zombis y no bloquear el bucle del
    // journal si el demonio de notificaciones tarda en contestar.
    match cmd.spawn() {
        Ok(hijo) => hilo("notify-send", move || {
            let Ok(salida) = hijo.wait_with_output() else { return };
            if let Some(id) = id {
                if let Ok(n) = String::from_utf8_lossy(&salida.stdout).trim().parse() {
                    let _ = id.set(n);
                }
            }
        }),
        Err(e) => log(&format!("notify-send: {e}")),
    }
}

/// Aviso con UN botón (`notify-send --wait -A`), como los de las descargas y el de
/// «sin firmas». BLOQUEA hasta el clic o el cierre, así que se llama siempre desde un
/// hilo propio. Devuelve true si se pulsó el botón. Con `techo`, pasado ese tiempo se
/// mata la espera (lo que hacía el vigilante de `firmas_aviso_con_boton`).
#[allow(clippy::too_many_arguments)]
pub fn aviso_con_boton(
    salida: Salida,
    evento: &str,
    urgencia: &str,
    titulo: &str,
    cuerpo: &str,
    tmo_ms: i64,
    accion: &str,
    etiqueta: &str,
    techo: Option<Duration>,
) -> bool {
    if salida == Salida::Simulado {
        imprimir(&format!("[{evento}] ({urgencia}, {tmo_ms} ms, botón «{etiqueta}») {titulo} — {cuerpo}"));
        return false;
    }
    let mut cmd = Command::new("notify-send");
    cmd.args(["-h", "string:x-gigishell-source:system"]);
    if id_valido(evento) {
        cmd.arg("-h").arg(format!("string:x-gigishell-event:{evento}"));
    }
    cmd.args(["-a", seudonimo(evento), "--wait", "-t", &tmo_ms.to_string()])
        .arg("-A")
        .arg(format!("{accion}={etiqueta}"))
        .args(["-u", urgencia, titulo, cuerpo])
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let Ok(mut hijo) = cmd.spawn() else { return false };
    let inicio = Instant::now();
    loop {
        match hijo.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if techo.is_some_and(|t| inicio.elapsed() >= t) => {
                let _ = hijo.kill();
                let _ = hijo.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(_) => return false,
        }
    }
    let mut out = String::new();
    if let Some(mut s) = hijo.stdout.take() {
        use std::io::Read;
        let _ = s.read_to_string(&mut out);
    }
    out.trim() == accion
}

// ── Agrupación ────────────────────────────────────────────────────────────────

pub const CALMA: Duration = Duration::from_secs(4);
pub const TOPE: Duration = Duration::from_secs(20);
const LISTA: usize = 8;
const CAP: usize = 300;

pub struct Grupo {
    pub evento: &'static str,
    pub urgencia: &'static str,
    pub tmo_ms: i64,
    pub titulo: &'static str,
    pub plural: &'static str,
    pub prefijo: &'static str,
    pub sufijo: &'static str,
}

#[derive(Default)]
struct Cola {
    items: Vec<(String, usize)>,
    indice: HashMap<String, usize>,
    total: usize,
    abierta: Option<Instant>,
    ultimo: Option<Instant>,
    /// Id de la tarjeta que ya salió al abrirse la ventana (categorías inmediatas).
    aviso: Option<Arc<OnceLock<u32>>>,
}

/// A diferencia del bash, cada categoría lleva SU PROPIA ventana: una ráfaga de GPU
/// ya no retrasa el aviso de un `sudo` fallido que llegue en medio.
pub struct Agrupador {
    orden: Vec<&'static str>,
    grupos: HashMap<&'static str, Grupo>,
    colas: HashMap<&'static str, Cola>,
    /// Categorías donde un texto repetido es el MISMO suceso visto dos veces (inotify
    /// emite `create` y `close_write` por un único cambio): ahí no suma al total.
    unicas: Vec<&'static str>,
    /// Categorías cuyo PRIMER evento sale en el acto (ver `marcar_inmediata`).
    inmediatas: Vec<&'static str>,
    calma: Duration,
    tope: Duration,
    salida: Salida,
}

impl Agrupador {
    pub fn new(salida: Salida) -> Self {
        Agrupador {
            orden: vec![],
            grupos: HashMap::new(),
            colas: HashMap::new(),
            unicas: vec![],
            inmediatas: vec![],
            calma: CALMA,
            tope: TOPE,
            salida,
        }
    }

    pub fn marcar_unica(&mut self, cat: &'static str) {
        self.unicas.push(cat);
    }

    /// El primer evento de cada ventana se avisa YA, sin esperar la calma: para los de
    /// autenticación, 4 s (más lo que tarde el resto de la ráfaga) es llegar tarde. Lo
    /// que llegue después se agrupa como siempre y el resumen SUSTITUYE esa tarjeta
    /// (`notify-send -r`), así que una ráfaga sigue siendo una sola tarjeta.
    pub fn marcar_inmediata(&mut self, cat: &'static str) {
        self.inmediatas.push(cat);
    }

    /// Cambia la ventana (la de archivos se ensancha durante una actualización).
    pub fn ventana(&mut self, calma: Duration, tope: Duration) {
        self.calma = calma;
        self.tope = tope;
    }

    pub fn registrar(&mut self, cat: &'static str, g: Grupo) {
        self.orden.push(cat);
        self.grupos.insert(cat, g);
        self.colas.insert(cat, Cola::default());
    }

    pub fn encolar(&mut self, cat: &str, texto: &str, ahora: Instant) {
        let Some(cola) = self.colas.get_mut(cat) else {
            log(&format!("encolar: categoría no registrada: {cat}"));
            return;
        };
        let txt = recortar(texto);
        if let Some(&i) = cola.indice.get(&txt) {
            if self.unicas.contains(&cat) {
                return;
            }
            cola.total += 1;
            cola.items[i].1 += 1;
        } else if cola.items.len() < CAP {
            cola.total += 1;
            cola.indice.insert(txt.clone(), cola.items.len());
            cola.items.push((txt, 1));
        } else {
            cola.total += 1;
        }
        // Pasado el CAP el evento cuenta en el total pero no entra en la lista.
        cola.abierta.get_or_insert(ahora);
        cola.ultimo = Some(ahora);
        if cola.total == 1 && self.inmediatas.contains(&cat) {
            let g = &self.grupos[cat];
            let (titulo, cuerpo) = formatear(g, &cola.items, 1);
            let id = Arc::new(OnceLock::new());
            notificar_ext(self.salida, g.evento, g.urgencia, &titulo, &cuerpo, g.tmo_ms, None, Some(id.clone()));
            cola.aviso = Some(id);
        }
    }

    #[cfg(test)]
    pub fn total(&self, cat: &str) -> usize {
        self.colas[cat].total
    }

    /// Cuánto falta para que venza la ventana más próxima; `None` si no hay nada.
    pub fn plazo(&self, ahora: Instant) -> Option<Duration> {
        self.colas
            .values()
            .filter_map(|c| Some(self.vence(c.abierta?, c.ultimo?)))
            .min()
            .map(|t| t.saturating_duration_since(ahora))
    }

    /// Emite las categorías cuya ventana ya venció (o todas con `forzar`).
    pub fn volcar(&mut self, ahora: Instant, forzar: bool) {
        for cat in self.orden.clone() {
            let c = &self.colas[cat];
            let (Some(a), Some(u)) = (c.abierta, c.ultimo) else { continue };
            if !forzar && ahora < self.vence(a, u) {
                continue;
            }
            let cola = std::mem::take(self.colas.get_mut(cat).unwrap());
            // Un solo evento en una categoría inmediata: ya salió al encolarse.
            if cola.aviso.is_some() && cola.total == 1 {
                continue;
            }
            let g = &self.grupos[cat];
            let (titulo, cuerpo) = formatear(g, &cola.items, cola.total);
            // Sin id (notify-send aún no contestó o falló) sale como tarjeta nueva.
            let reemplaza = cola.aviso.as_ref().and_then(|a| a.get().copied());
            notificar_ext(self.salida, g.evento, g.urgencia, &titulo, &cuerpo, g.tmo_ms, reemplaza, None);
        }
    }
}

impl Agrupador {
    fn vence(&self, abierta: Instant, ultimo: Instant) -> Instant {
        (ultimo + self.calma).min(abierta + self.tope)
    }
}

/// Mismo formato que notif_volcar: un evento → el aviso de siempre; varios → título
/// "<n> <plural>" y lista con multiplicidad.
pub fn formatear(g: &Grupo, items: &[(String, usize)], total: usize) -> (String, String) {
    if total == 1 {
        let txt = items.first().map(|i| i.0.as_str()).unwrap_or("");
        return (g.titulo.to_string(), format!("{}{}{}", g.prefijo, txt, g.sufijo));
    }
    let mut lineas = vec![];
    let mut mostrados = 0;
    for (txt, n) in items.iter().take(LISTA) {
        mostrados += n;
        // Categorías sin dato variable (sudo) encolan texto vacío: informa el recuento.
        if txt.is_empty() {
            continue;
        }
        lineas.push(if *n > 1 { format!("· {txt} (×{n})") } else { format!("· {txt}") });
    }
    let mut cuerpo = lineas.join("\n");
    let resto = total.saturating_sub(mostrados);
    if resto > 0 {
        if !cuerpo.is_empty() {
            cuerpo.push('\n');
        }
        cuerpo.push_str(&format!("… y {resto} más"));
    }
    if cuerpo.is_empty() {
        cuerpo = format!("{}{}", g.prefijo, g.sufijo);
    }
    (format!("{total} {}", g.plural), cuerpo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g() -> Grupo {
        Grupo {
            evento: "x.y",
            urgencia: "normal",
            tmo_ms: 1000,
            titulo: "Fallo sudo",
            plural: "fallos de sudo",
            prefijo: "Intento fallido de sudo",
            sufijo: "",
        }
    }

    #[test]
    fn ids() {
        assert!(id_valido("kernel.oom"));
        assert!(id_valido("usb.extraccion-en-lectura"));
        assert!(!id_valido("Kernel.oom"));
        assert!(!id_valido("a..b"));
        assert!(!id_valido(""));
    }

    #[test]
    fn un_evento_es_el_aviso_de_siempre() {
        let (t, c) = formatear(&g(), &[(String::new(), 1)], 1);
        assert_eq!(t, "Fallo sudo");
        assert_eq!(c, "Intento fallido de sudo");
    }

    #[test]
    fn repetidos_cuentan_en_el_total() {
        let (t, c) = formatear(&g(), &[(String::new(), 5)], 5);
        assert_eq!(t, "5 fallos de sudo");
        assert_eq!(c, "Intento fallido de sudo");
        let (t, c) = formatear(&g(), &[("a".into(), 2), ("b".into(), 1)], 3);
        assert_eq!(t, "3 fallos de sudo");
        assert_eq!(c, "· a (×2)\n· b");
    }

    #[test]
    fn resto_mas_alla_de_la_lista() {
        let items: Vec<_> = (0..10).map(|i| (format!("l{i}"), 1)).collect();
        let (_, c) = formatear(&g(), &items, 12);
        assert!(c.ends_with("… y 4 más"), "{c}");
    }

    #[test]
    fn inmediata_avisa_al_encolar_y_resume_reemplazando() {
        let mut a = Agrupador::new(Salida::Simulado);
        a.registrar("s", g());
        a.marcar_inmediata("s");
        let t0 = Instant::now();
        a.encolar("s", "", t0);
        let id = a.colas["s"].aviso.clone().expect("salió al encolar");
        assert_eq!(id.get(), Some(&1));
        // Un solo evento: el volcado no repite la tarjeta.
        a.volcar(t0 + CALMA, false);
        assert!(a.colas["s"].aviso.is_none());
        assert_eq!(a.plazo(t0 + CALMA), None);
    }

    #[test]
    fn ventana_por_categoria() {
        let mut a = Agrupador::new(Salida::Simulado);
        a.registrar("s", g());
        let t0 = Instant::now();
        a.encolar("s", "", t0);
        assert_eq!(a.plazo(t0), Some(CALMA));
        // Eventos continuos: el tope manda.
        a.encolar("s", "", t0 + Duration::from_secs(18));
        assert_eq!(a.plazo(t0 + Duration::from_secs(18)), Some(Duration::from_secs(2)));
        a.volcar(t0 + TOPE, false);
        assert_eq!(a.plazo(t0 + TOPE), None);
    }
}
