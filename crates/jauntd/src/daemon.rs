//! Daemon state and request dispatch.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use jaunt_core::hooks::{self, HookPaths};
use jaunt_core::paths::{hostname, now_ms};
use jaunt_core::session::SessionManager;
use jaunt_proto::methods::{self as m, AttachResult};
use jaunt_proto::types::DaemonInfo;
use jaunt_proto::{PROTOCOL_VERSION, RpcError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::server::Conn;

pub struct Daemon {
    pub sessions: Arc<SessionManager>,
    pub socket: PathBuf,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    handed_off: AtomicBool,
}

pub type HandlerResult = Result<Value, RpcError>;

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_params", e.to_string()))
}

fn ok<T: Serialize>(v: T) -> HandlerResult {
    serde_json::to_value(v).map_err(|e| RpcError::new("internal", e.to_string()))
}

pub fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", format!("{e:#}"))
}

impl Daemon {
    pub fn new(socket: PathBuf, base_env: BTreeMap<String, String>) -> Arc<Self> {
        let (shutdown, _) = watch::channel(false);
        Arc::new(Self {
            sessions: SessionManager::new(socket.clone(), base_env),
            socket,
            started_at: now_ms(),
            shutdown,
            handed_off: AtomicBool::new(false),
        })
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    pub fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }

    pub fn handed_off(&self) -> bool {
        self.handed_off.load(Ordering::SeqCst)
    }

    pub fn set_handed_off(&self) {
        self.handed_off.store(true, Ordering::SeqCst);
    }

    pub fn on_disconnect(&self, _client: u64) {}

    pub fn info(&self) -> DaemonInfo {
        DaemonInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
            pid: std::process::id(),
            host: hostname(),
            home: dirs_home(),
            started_at: self.started_at,
            sessions: self.sessions.len(),
        }
    }

    pub async fn handle(self: &Arc<Self>, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        let s = &self.sessions;
        match method {
            m::DAEMON_INFO => ok(self.info()),
            m::DAEMON_SHUTDOWN => {
                let me = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    me.request_shutdown();
                });
                ok(true)
            }
            m::SESSION_CREATE => ok(s.create(params(p)?).map_err(internal)?),
            m::SESSION_LIST => ok(s.list()),
            m::SESSION_ATTACH => {
                let a: m::SessionAttach = params(p)?;
                let size = a.cols.zip(a.rows);
                let (info, snapshot) = s
                    .attach(a.id, conn.id, conn.tx.clone(), size)
                    .map_err(internal)?;
                ok(AttachResult {
                    info,
                    snapshot: String::from_utf8_lossy(&snapshot).into_owned(),
                })
            }
            m::SESSION_DETACH => {
                let r: m::SessionRef = params(p)?;
                s.detach(r.id, conn.id);
                ok(true)
            }
            m::SESSION_RESIZE => {
                let r: m::SessionResize = params(p)?;
                s.resize(r.id, r.cols, r.rows).map_err(internal)?;
                ok(true)
            }
            m::SESSION_KILL => {
                let r: m::SessionKill = params(p)?;
                s.kill(r.id, r.remove).map_err(internal)?;
                ok(true)
            }
            m::SESSION_WRITE => {
                let r: m::SessionWrite = params(p)?;
                s.write(r.id, r.data.into_bytes()).map_err(internal)?;
                ok(true)
            }
            m::SESSION_SEARCH => {
                let r: m::SessionSearch = params(p)?;
                ok(s.search(r.id, &r.query, r.regex, r.case_sensitive)
                    .map_err(internal)?)
            }
            m::AGENT_REPORT => {
                let r: m::AgentReport = params(p)?;
                s.report(r.session, r.state, r.source, r.message, r.agent)
                    .map_err(internal)?;
                ok(true)
            }
            m::HOOKS_STATUS => ok(hooks::status(&HookPaths::default_paths()).map_err(internal)?),
            m::HOOKS_INSTALL => {
                let r: m::HooksInstall = params(p)?;
                let bin = jaunt_cli_path().map_err(internal)?;
                ok(
                    hooks::install(&HookPaths::default_paths(), &bin, r.claude, r.codex)
                        .map_err(internal)?,
                )
            }
            m::HOOKS_UNINSTALL => {
                ok(hooks::uninstall(&HookPaths::default_paths()).map_err(internal)?)
            }
            other => Err(RpcError::new(
                "unknown_method",
                format!("unknown method {other}"),
            )),
        }
    }
}

/// The `jaunt` CLI ships next to `jauntd` (app bundle `Contents/MacOS`,
/// `~/.jaunt/bin` on remote hosts, `target/*` in development).
fn jaunt_cli_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let bin = exe.with_file_name("jaunt");
    anyhow::ensure!(
        bin.exists(),
        "jaunt CLI not found next to jauntd at {}",
        bin.display()
    );
    Ok(bin)
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
