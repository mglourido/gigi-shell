// gigishell-guardian: el motor de decisiones — máquina de estados PURA. Recibe
// hechos (una apertura, una respuesta del usuario, el paso del tiempo, AGS que
// se conecta o se va) y devuelve efectos que el daemon ejecuta (responder a
// fanotify, mandar una pregunta a AGS, conceder en el BPF, apuntar en el
// historial). No toca el kernel, el disco ni el socket: así cada regla se
// prueba con un test normal, sin root.
//
// Tiempos: milisegundos desde epoch (`ahora`); el historial guarda segundos.
// Descriptores: el `RawFd` del evento de fanotify es solo un identificador aquí;
// el `OwnedFd` de verdad lo guarda el daemon hasta ejecutar `Responder`.
use std::collections::{BTreeMap, HashMap};
use std::os::fd::RawFd;

use serde::{Deserialize, Serialize};

use crate::historial::{Entrada, Resultado};
use crate::proceso::{self, InfoProceso};
use crate::tipos::{Pendiente, BORRAR, LEER, MODIFICAR};

/// Tiempo que una pregunta espera respuesta antes de denegar.
pub const ESPERA_MS: u64 = 30_000;
/// Ventana en la que denegaciones iguales se agrupan en un solo aviso.
pub const AGRUPAR_MS: u64 = 10_000;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Siempre,
    Proceso,
    Denegar,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Pregunta {
    pub id: u64,
    pub ruta: String,
    pub programa: String,
    pub pid: u32,
    pub operacion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    pub interprete: bool,
    /// El programa tenía permiso pero su ejecutable ha cambiado (y no es uno de
    /// confianza bajo /usr): AGS lo avisa en la ventana.
    pub cambiado: bool,
    /// Milisegundos desde epoch en que se denegará sola.
    pub caduca: u64,
}

pub struct Apertura {
    pub fd: RawFd,
    pub fichero: u32,
    pub ruta: String,
    pub proceso: InfoProceso,
    pub pendiente: Option<Pendiente>,
    /// `proceso::exe_confiable` del ejecutable (lo calcula el daemon: toca disco).
    pub confiable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Efecto {
    Responder { fd: RawFd, permitir: bool },
    EnviarPregunta(Pregunta),
    CerrarPregunta { id: u64 },
    EnviarDenegado { ruta: String, programa: String, operacion: String, interprete: bool },
    Conceder { fichero: u32, programa: String, mascara: u8 },
    ConcederProceso { fichero: u32, tgid: u32, mascara: u8 },
    /// El permiso por ruta sigue valiendo pero el inodo del ejecutable cambió
    /// (actualización): volver a traducir la ruta a (dev, ino) en el BPF.
    RefrescarPrograma { fichero: u32, programa: String },
    Historial(Entrada),
}

pub fn nombre_operacion(mascara: u8) -> &'static str {
    match mascara as u32 {
        LEER => "leer",
        MODIFICAR => "modificar",
        m if m == LEER | MODIFICAR => "leer y modificar",
        BORRAR => "borrar",
        _ => "abrir",
    }
}

struct Abierta {
    pregunta: Pregunta,
    fichero: u32,
    tgid: u32,
    pedido: u8,
    fds: Vec<RawFd>,
}

pub struct Motor {
    cliente: bool,
    siguiente_id: u64,
    abiertas: BTreeMap<u64, Abierta>,
    /// Última vez que se avisó de cada denegación (fichero, programa, op, silenciosa).
    ultimas: HashMap<(u32, String, u8, bool), u64>,
    resumen: Vec<Entrada>,
}

impl Motor {
    pub fn new() -> Self {
        Motor {
            cliente: false,
            siguiente_id: 1,
            abiertas: BTreeMap::new(),
            ultimas: HashMap::new(),
            resumen: Vec::new(),
        }
    }

    /// AGS se conecta o se va. Al irse, todo lo que estaba esperando respuesta
    /// se deniega: nadie la va a dar, y el proceso no puede quedarse colgado.
    pub fn cliente_conectado(&mut self, si: bool, ahora: u64) -> Vec<Efecto> {
        self.cliente = si;
        if si {
            return Vec::new();
        }
        let mut efectos = Vec::new();
        for (_, a) in std::mem::take(&mut self.abiertas) {
            let entrada = entrada_de(&a.pregunta, Resultado::SinAgs, ahora);
            self.resumen.push(entrada.clone());
            efectos.extend(a.fds.iter().map(|&fd| Efecto::Responder { fd, permitir: false }));
            efectos.push(Efecto::Historial(entrada));
        }
        efectos
    }

    /// Una apertura de fanotify sobre un fichero protegido. `permiso_ruta` es
    /// lo que la política dice que tiene el programa por su RUTA (el BPF lo
    /// juzga por inodo: si la política lo cubre y aun así llegó aquí, es que el
    /// inodo del ejecutable ha cambiado).
    pub fn apertura(&mut self, a: Apertura, permiso_ruta: u8, ahora: u64) -> Vec<Efecto> {
        let programa = a.proceso.exe.display().to_string();
        let interprete = proceso::es_interprete(&a.proceso.exe);
        let script = if interprete { proceso::script(&a.proceso.args) } else { None };

        // Sin pendiente (el BPF no dejó dicho qué se pidió) se pregunta por
        // «abrir» con lo máximo que una apertura puede pedir.
        let (pedido, operacion) = match a.pendiente {
            Some(p) => (p.pedido, nombre_operacion(p.pedido).to_string()),
            None => ((LEER | MODIFICAR) as u8, "abrir".to_string()),
        };

        let entrada = |resultado| Entrada {
            fecha: ahora / 1000,
            ruta: a.ruta.clone(),
            programa: programa.clone(),
            pid: a.proceso.tgid,
            script: script.clone(),
            operacion: operacion.clone(),
            resultado,
        };

        // Regla 1: el BPF ya lo tenía permitido (permiso o categoría).
        if let Some(p) = a.pendiente {
            if p.permitido != 0 {
                let r = if p.permitido == 2 { Resultado::Categoria } else { Resultado::Automatico };
                return vec![
                    Efecto::Responder { fd: a.fd, permitir: true },
                    Efecto::Historial(entrada(r)),
                ];
            }
        }

        // Regla 3: la política lo cubre por ruta pero el inodo cambió.
        let cubierto = pedido != 0 && permiso_ruta & pedido == pedido;
        if cubierto && a.confiable {
            return vec![
                Efecto::RefrescarPrograma { fichero: a.fichero, programa: programa.clone() },
                Efecto::Responder { fd: a.fd, permitir: true },
                Efecto::Historial(entrada(Resultado::Automatico)),
            ];
        }

        // Regla 4: sin AGS no hay a quién preguntar.
        if !self.cliente {
            let e = entrada(Resultado::SinAgs);
            self.resumen.push(e.clone());
            return vec![
                Efecto::Responder { fd: a.fd, permitir: false },
                Efecto::Historial(e),
            ];
        }

        // Regla 5: misma petición con una pregunta ya abierta ⇒ se agrupa.
        if let Some(abierta) = self
            .abiertas
            .values_mut()
            .find(|x| x.fichero == a.fichero && x.tgid == a.proceso.tgid && x.pedido == pedido)
        {
            abierta.fds.push(a.fd);
            return Vec::new();
        }

        let id = self.siguiente_id;
        self.siguiente_id += 1;
        let pregunta = Pregunta {
            id,
            ruta: a.ruta.clone(),
            programa,
            pid: a.proceso.tgid,
            operacion,
            script,
            interprete,
            cambiado: cubierto,
            caduca: ahora + ESPERA_MS,
        };
        self.abiertas.insert(
            id,
            Abierta {
                pregunta: pregunta.clone(),
                fichero: a.fichero,
                tgid: a.proceso.tgid,
                pedido,
                fds: vec![a.fd],
            },
        );
        vec![Efecto::EnviarPregunta(pregunta)]
    }

    /// Respuesta del usuario a la pregunta `id`. Una respuesta a una pregunta
    /// que ya no existe (venció, o AGS contestó dos veces) no hace nada.
    pub fn responder(&mut self, id: u64, decision: Decision, ahora: u64) -> Vec<Efecto> {
        let Some(a) = self.abiertas.remove(&id) else {
            return Vec::new();
        };
        let mut efectos = Vec::new();
        // A un intérprete nunca se le concede «siempre»: el permiso iría al
        // binario del intérprete y valdría para cualquier script.
        let decision = match decision {
            Decision::Siempre if a.pregunta.interprete => Decision::Proceso,
            d => d,
        };
        // El permiso se concede ANTES de responder: el proceso sigue en cuanto
        // recibe la respuesta, y lo siguiente que haga (p.ej. el rename de un
        // guardado atómico) ya tiene que encontrarlo en el BPF.
        match decision {
            Decision::Siempre => efectos.push(Efecto::Conceder {
                fichero: a.fichero,
                programa: a.pregunta.programa.clone(),
                mascara: a.pedido,
            }),
            Decision::Proceso => efectos.push(Efecto::ConcederProceso {
                fichero: a.fichero,
                tgid: a.tgid,
                mascara: a.pedido,
            }),
            Decision::Denegar => {}
        }
        let permitir = decision != Decision::Denegar;
        efectos.extend(a.fds.iter().map(|&fd| Efecto::Responder { fd, permitir }));
        let r = if permitir { Resultado::Permitido } else { Resultado::Denegado };
        efectos.push(Efecto::Historial(entrada_de(&a.pregunta, r, ahora)));
        efectos
    }

    /// Deniega las preguntas cuyo plazo ha pasado.
    pub fn vencer(&mut self, ahora: u64) -> Vec<Efecto> {
        let vencidas: Vec<u64> = self
            .abiertas
            .iter()
            .filter(|(_, a)| a.pregunta.caduca <= ahora)
            .map(|(&id, _)| id)
            .collect();
        let mut efectos = Vec::new();
        for id in vencidas {
            let a = self.abiertas.remove(&id).expect("id recién listado");
            efectos.extend(a.fds.iter().map(|&fd| Efecto::Responder { fd, permitir: false }));
            efectos.push(Efecto::CerrarPregunta { id });
            efectos.push(Efecto::Historial(entrada_de(
                &a.pregunta,
                Resultado::TiempoAgotado,
                ahora,
            )));
        }
        efectos
    }

    pub fn proximo_vencimiento(&self) -> Option<u64> {
        self.abiertas.values().map(|a| a.pregunta.caduca).min()
    }

    /// Una operación que el BPF ya denegó (borrar, mover, atributos… o una
    /// lectura en silencio). `proceso` es `None` si el proceso ya terminó.
    pub fn denegacion(
        &mut self,
        fichero: u32,
        ruta: &str,
        proceso: Option<&InfoProceso>,
        op: u8,
        silencioso: bool,
        ahora: u64,
    ) -> Vec<Efecto> {
        let programa = proceso
            .map(|p| p.exe.display().to_string())
            .unwrap_or_else(|| "?".to_string());
        let clave = (fichero, programa.clone(), op, silencioso);
        if let Some(&antes) = self.ultimas.get(&clave) {
            if ahora.saturating_sub(antes) < AGRUPAR_MS {
                return Vec::new();
            }
        }
        self.ultimas.insert(clave, ahora);
        // La tabla solo necesita la ventana actual: sin esto crecería con cada
        // programa distinto que se haya topado alguna vez con un protegido.
        self.ultimas.retain(|_, &mut t| ahora.saturating_sub(t) < AGRUPAR_MS);

        let interprete = proceso.is_some_and(|p| proceso::es_interprete(&p.exe));
        let entrada = Entrada {
            fecha: ahora / 1000,
            ruta: ruta.to_string(),
            programa: programa.clone(),
            pid: proceso.map(|p| p.tgid).unwrap_or(0),
            script: proceso.filter(|_| interprete).and_then(|p| proceso::script(&p.args)),
            operacion: nombre_operacion(op).to_string(),
            resultado: if silencioso { Resultado::Silencioso } else { Resultado::Denegado },
        };
        if silencioso {
            return vec![Efecto::Historial(entrada)];
        }
        if !self.cliente {
            self.resumen.push(entrada.clone());
            return vec![Efecto::Historial(entrada)];
        }
        vec![
            Efecto::Historial(entrada.clone()),
            Efecto::EnviarDenegado {
                ruta: entrada.ruta,
                programa,
                operacion: entrada.operacion,
                interprete,
            },
        ]
    }

    /// Lo que se denegó mientras AGS no estaba (y lo vacía).
    pub fn tomar_resumen(&mut self) -> Vec<Entrada> {
        std::mem::take(&mut self.resumen)
    }
}

fn entrada_de(p: &Pregunta, resultado: Resultado, ahora: u64) -> Entrada {
    Entrada {
        fecha: ahora / 1000,
        ruta: p.ruta.clone(),
        programa: p.programa.clone(),
        pid: p.pid,
        script: p.script.clone(),
        operacion: p.operacion.clone(),
        resultado,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn proc_(exe: &str, tgid: u32) -> InfoProceso {
        InfoProceso { tgid, exe: PathBuf::from(exe), args: vec![exe.to_string(), "/tmp/s.py".into()] }
    }

    fn pend(pedido: u32, permitido: u8) -> Option<Pendiente> {
        Some(Pendiente { fichero: 1, pedido: pedido as u8, permitido, _pad: [0; 2] })
    }

    fn ap(fd: RawFd, exe: &str, tgid: u32, pendiente: Option<Pendiente>) -> Apertura {
        Apertura {
            fd,
            fichero: 1,
            ruta: "/h/banco.pdf".into(),
            proceso: proc_(exe, tgid),
            pendiente,
            confiable: false,
        }
    }

    fn resultados(ef: &[Efecto]) -> Vec<Resultado> {
        ef.iter()
            .filter_map(|e| match e {
                Efecto::Historial(h) => Some(h.resultado),
                _ => None,
            })
            .collect()
    }

    fn conectado() -> Motor {
        let mut m = Motor::new();
        m.cliente_conectado(true, 0);
        m
    }

    #[test]
    fn regla1_permitido_por_bpf_responde_al_momento() {
        let mut m = conectado();
        let ef = m.apertura(ap(5, "/usr/bin/evince", 10, pend(LEER, 1)), 0, 0);
        assert_eq!(ef[0], Efecto::Responder { fd: 5, permitir: true });
        assert_eq!(resultados(&ef), vec![Resultado::Automatico]);
        let ef = m.apertura(ap(6, "/usr/bin/rg", 11, pend(LEER, 2)), 0, 0);
        assert_eq!(resultados(&ef), vec![Resultado::Categoria]);
    }

    #[test]
    fn regla2_sin_pendiente_pregunta_por_abrir() {
        let mut m = conectado();
        let ef = m.apertura(ap(5, "/usr/bin/evince", 10, None), 0, 0);
        let Efecto::EnviarPregunta(p) = &ef[0] else { panic!("{ef:?}") };
        assert_eq!(p.operacion, "abrir");
        let ef = m.responder(p.id, Decision::Siempre, 1);
        assert!(ef.contains(&Efecto::Conceder {
            fichero: 1,
            programa: "/usr/bin/evince".into(),
            mascara: (LEER | MODIFICAR) as u8
        }));
    }

    #[test]
    fn regla3_inodo_cambiado_confiable_refresca_y_no_confiable_pregunta() {
        let mut m = conectado();
        let mut a = ap(5, "/usr/bin/evince", 10, pend(LEER, 0));
        a.confiable = true;
        let ef = m.apertura(a, LEER as u8, 0);
        assert!(ef.contains(&Efecto::RefrescarPrograma { fichero: 1, programa: "/usr/bin/evince".into() }));
        assert!(ef.contains(&Efecto::Responder { fd: 5, permitir: true }));

        let ef = m.apertura(ap(6, "/home/u/bin/x", 11, pend(LEER, 0)), LEER as u8, 0);
        let Efecto::EnviarPregunta(p) = &ef[0] else { panic!("{ef:?}") };
        assert!(p.cambiado);
    }

    #[test]
    fn regla4_sin_cliente_deniega_y_guarda_para_el_resumen() {
        let mut m = Motor::new();
        let ef = m.apertura(ap(5, "/usr/bin/cat", 10, pend(LEER, 0)), 0, 0);
        assert_eq!(ef[0], Efecto::Responder { fd: 5, permitir: false });
        assert_eq!(resultados(&ef), vec![Resultado::SinAgs]);
        assert_eq!(m.tomar_resumen().len(), 1);
        assert!(m.tomar_resumen().is_empty(), "tomar_resumen vacía");
    }

    #[test]
    fn regla5_misma_peticion_se_agrupa_y_la_respuesta_alcanza_a_todos() {
        let mut m = conectado();
        let ef = m.apertura(ap(5, "/usr/bin/cat", 10, pend(LEER, 0)), 0, 0);
        let Efecto::EnviarPregunta(p) = &ef[0] else { panic!() };
        assert!(m.apertura(ap(6, "/usr/bin/cat", 10, pend(LEER, 0)), 0, 0).is_empty());
        let ef = m.responder(p.id, Decision::Denegar, 1);
        assert!(ef.contains(&Efecto::Responder { fd: 5, permitir: false }));
        assert!(ef.contains(&Efecto::Responder { fd: 6, permitir: false }));
        assert_eq!(resultados(&ef), vec![Resultado::Denegado]);
    }

    #[test]
    fn regla6_siempre_a_interprete_se_degrada_y_proceso_concede_al_tgid() {
        let mut m = conectado();
        let ef = m.apertura(ap(5, "/usr/bin/python3.14", 10, pend(LEER, 0)), 0, 0);
        let Efecto::EnviarPregunta(p) = &ef[0] else { panic!() };
        assert!(p.interprete);
        assert_eq!(p.script.as_deref(), Some("/tmp/s.py"));
        let ef = m.responder(p.id, Decision::Siempre, 1);
        assert_eq!(ef[0], Efecto::ConcederProceso { fichero: 1, tgid: 10, mascara: LEER as u8 });
        assert!(ef.contains(&Efecto::Responder { fd: 5, permitir: true }));
        assert!(!ef.iter().any(|e| matches!(e, Efecto::Conceder { .. })));
    }

    #[test]
    fn regla7_vence_a_los_30_s() {
        let mut m = conectado();
        let ef = m.apertura(ap(5, "/usr/bin/cat", 10, pend(LEER, 0)), 0, 1000);
        let Efecto::EnviarPregunta(p) = &ef[0] else { panic!() };
        assert_eq!(m.proximo_vencimiento(), Some(1000 + ESPERA_MS));
        assert!(m.vencer(1000 + ESPERA_MS - 1).is_empty());
        let ef = m.vencer(1000 + ESPERA_MS);
        assert!(ef.contains(&Efecto::Responder { fd: 5, permitir: false }));
        assert!(ef.contains(&Efecto::CerrarPregunta { id: p.id }));
        assert_eq!(resultados(&ef), vec![Resultado::TiempoAgotado]);
        assert_eq!(m.proximo_vencimiento(), None);
        assert!(m.responder(p.id, Decision::Siempre, 1).is_empty());
    }

    #[test]
    fn regla8_al_irse_ags_se_deniega_lo_abierto() {
        let mut m = conectado();
        m.apertura(ap(5, "/usr/bin/cat", 10, pend(LEER, 0)), 0, 0);
        let ef = m.cliente_conectado(false, 1);
        assert!(ef.contains(&Efecto::Responder { fd: 5, permitir: false }));
        assert_eq!(m.proximo_vencimiento(), None);
    }

    #[test]
    fn regla9_denegaciones_agrupadas_silenciosas_y_sin_cliente() {
        let mut m = conectado();
        let p = proc_("/usr/bin/rm", 10);
        let ef = m.denegacion(1, "/h/.env", Some(&p), BORRAR as u8, false, 0);
        assert!(ef.iter().any(|e| matches!(e, Efecto::EnviarDenegado { operacion, .. } if operacion == "borrar")));
        assert!(m.denegacion(1, "/h/.env", Some(&p), BORRAR as u8, false, AGRUPAR_MS - 1).is_empty());
        assert!(!m.denegacion(1, "/h/.env", Some(&p), BORRAR as u8, false, AGRUPAR_MS).is_empty());

        let ef = m.denegacion(1, "/h/.env", Some(&p), LEER as u8, true, 0);
        assert_eq!(resultados(&ef), vec![Resultado::Silencioso]);
        assert_eq!(ef.len(), 1);

        let mut m = Motor::new();
        let ef = m.denegacion(1, "/h/.env", None, BORRAR as u8, false, 0);
        assert_eq!(ef.len(), 1);
        assert_eq!(m.tomar_resumen()[0].programa, "?");
    }

    #[test]
    fn nombres_de_operacion() {
        assert_eq!(nombre_operacion(1), "leer");
        assert_eq!(nombre_operacion(2), "modificar");
        assert_eq!(nombre_operacion(3), "leer y modificar");
        assert_eq!(nombre_operacion(4), "borrar");
        assert_eq!(nombre_operacion(0), "abrir");
    }
}
