//! A worker's link to its central host (X41, ADR 0009).
//!
//! The settings live in `~/.moonlet/link.json`, mode 0600 because they hold
//! the device token this Mac got when it paired with the central host. The
//! link itself is a `moonlet-link` [`Host`] over the tailnet connector
//! (ADR 0011): the worker authenticates with the token, says
//! `moonletd-worker` in its hello and registers. The central host's side
//! is in [`crate::workers`].

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use moonlet_core::paths::now_ms;
use moonlet_core::session::SessionManager;
use moonlet_link::tailnet::TailnetConnector;
use moonlet_link::{BoxFuture, Events, Host, HostInfo, HostOptions, HostStatus, Requests};
use moonlet_proto::methods::{
    self as m, LinkCentral, LinkCentralInfo, LinkInfo, LinkSet, LinkState, LinkWorker,
    WorkerProject, WorkerRegister,
};
use moonlet_proto::{Message, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The `client` a worker's daemon gives in its hello.
pub const WORKER_CLIENT: &str = "moonletd-worker";

/// What `link.json` holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct LinkFile {
    #[serde(default)]
    central: Option<LinkCentral>,
    worker: LinkWorker,
}

/// The link settings, as kept in `link.json`.
pub struct LinkStore {
    path: PathBuf,
    data: LinkFile,
}

impl LinkStore {
    /// Reads `path`. The first time, this machine gets a worker id that
    /// never changes afterwards, and the name `computer_name`.
    pub fn load(path: PathBuf, computer_name: &str) -> LinkStore {
        let read = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<LinkFile>(&s).ok());
        let data = match read {
            Some(d) if !d.worker.id.is_empty() => d,
            other => {
                let d = LinkFile {
                    central: other.and_then(|d| d.central),
                    worker: LinkWorker {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: computer_name.to_string(),
                        enabled: false,
                    },
                };
                save(&path, &d);
                d
            }
        };
        LinkStore { path, data }
    }

    pub fn central(&self) -> Option<&LinkCentral> {
        self.data.central.as_ref()
    }

    pub fn worker(&self) -> &LinkWorker {
        &self.data.worker
    }

    /// The central host as `link.get` shows it, without the token.
    pub fn central_info(&self) -> Option<LinkCentralInfo> {
        self.data.central.as_ref().map(|c| LinkCentralInfo {
            name: c.name.clone(),
            addrs: c.addrs.clone(),
        })
    }

    /// Applies `link.set`. `own` are this machine's Tailscale addresses: the
    /// central host never links to itself. Nothing is stored on an error.
    pub fn set(&mut self, req: LinkSet, own: &[IpAddr]) -> Result<(), RpcError> {
        let mut next = self.data.clone();
        if let Some(central) = req.central {
            if let Some(c) = &central {
                check_central(c, own)?;
            }
            next.central = central;
        }
        if let Some(w) = req.worker {
            if let Some(enabled) = w.enabled {
                next.worker.enabled = enabled;
            }
            if let Some(name) = w.name {
                check_name(&name)?;
                next.worker.name = name.trim().to_string();
            }
        }
        save(&self.path, &next);
        self.data = next;
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new("invalid_params", message)
}

fn check_name(name: &str) -> Result<(), RpcError> {
    if name.trim().is_empty() || name.chars().any(char::is_control) {
        return Err(invalid(format!("{name:?} is not a name")));
    }
    Ok(())
}

fn check_central(c: &LinkCentral, own: &[IpAddr]) -> Result<(), RpcError> {
    check_name(&c.name)?;
    if c.addrs.is_empty() {
        return Err(invalid("the central host has no address"));
    }
    for a in &c.addrs {
        let addr: SocketAddr = a
            .parse()
            .map_err(|_| invalid(format!("{a} is not an ip:port address")))?;
        if own.contains(&addr.ip()) {
            return Err(invalid("this Mac is the central host"));
        }
    }
    if c.token.len() != 64 || !c.token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(invalid("the token is not 64 hex characters"));
    }
    Ok(())
}

fn save(path: &Path, data: &LinkFile) {
    if let Err(e) = crate::mobile::write_private(path, &serde_json::to_vec_pretty(data).unwrap()) {
        tracing::warn!("cannot write {}: {e:#}", path.display());
    }
}

/// Whether the link should be open: a central host is set, and either this
/// Mac takes heavy commands or it keeps at least one session in sync (X60).
pub fn should_link(enabled: bool, central: bool, synced_copies: usize) -> bool {
    central && (enabled || synced_copies > 0)
}

/// This Mac's name, as Sharing settings show it (`scutil --get
/// ComputerName`), or the host name without `.local`.
pub fn computer_name() -> String {
    let named = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    named.unwrap_or_else(crate::mobile::host_label)
}

/// The worker side of the link: its settings, its state and, while it
/// should be open, the connection.
pub struct WorkerLink {
    store: Mutex<LinkStore>,
    state: Mutex<LinkState>,
    host: Mutex<Option<Arc<Host>>>,
    /// Sessions this Mac keeps in sync (X60); the link stays open for them.
    synced: AtomicUsize,
    sessions: Arc<SessionManager>,
    emit: Box<dyn Fn(Message) + Send + Sync>,
}

impl WorkerLink {
    pub fn new(
        store: LinkStore,
        sessions: Arc<SessionManager>,
        emit: impl Fn(Message) + Send + Sync + 'static,
    ) -> Arc<WorkerLink> {
        Arc::new(WorkerLink {
            store: Mutex::new(store),
            state: Mutex::new(LinkState::Off),
            host: Mutex::new(None),
            synced: AtomicUsize::new(0),
            sessions,
            emit: Box::new(emit),
        })
    }

    pub fn info(&self) -> LinkInfo {
        let store = self.store.lock().unwrap();
        LinkInfo {
            central: store.central_info(),
            worker: store.worker().clone(),
            state: self.state.lock().unwrap().clone(),
        }
    }

    fn changed(&self) {
        (self.emit)(Message::event(m::EV_LINK_CHANGED, self.info()));
    }

    fn set_state(&self, state: LinkState) {
        {
            let mut s = self.state.lock().unwrap();
            if *s == state {
                return;
            }
            *s = state;
        }
        self.changed();
    }

    /// `link.set`: stores the settings, then opens, moves or closes the link.
    pub fn set(self: &Arc<Self>, req: LinkSet, own: &[IpAddr]) -> Result<LinkInfo, RpcError> {
        let moved = req.central.is_some();
        self.store.lock().unwrap().set(req, own)?;
        if moved {
            // A new central host, or new addresses or token: link again.
            self.close();
        }
        self.apply();
        self.changed();
        Ok(self.info())
    }

    /// `link.retry`: a link waiting for the user tries again now.
    pub fn retry(&self) {
        if let Some(h) = self.host.lock().unwrap().as_ref() {
            h.reconnect();
        }
    }

    /// How many sessions this Mac keeps in sync (X60).
    #[allow(dead_code)]
    pub fn set_synced(self: &Arc<Self>, copies: usize) {
        self.synced.store(copies, Ordering::SeqCst);
        self.apply();
    }

    /// Opens the link when it should be open and is not, and closes it
    /// when it should not be.
    pub fn apply(self: &Arc<Self>) {
        let (want, central) = {
            let store = self.store.lock().unwrap();
            let central = store.central().cloned();
            let want = should_link(
                store.worker().enabled,
                central.is_some(),
                self.synced.load(Ordering::SeqCst),
            );
            (want, central)
        };
        match (want, central) {
            (true, Some(central)) => {
                let mut host = self.host.lock().unwrap();
                if host.is_some() {
                    return;
                }
                let h = Host::start(
                    HostOptions {
                        id: central.name.clone(),
                        label: central.name.clone(),
                        remote: true,
                        client: WORKER_CLIENT.into(),
                    },
                    Arc::new(TailnetConnector {
                        addrs: central.addrs.clone(),
                        token: central.token.clone(),
                        route: None,
                    }),
                    Arc::new(LinkEvents(Arc::downgrade(self))),
                    tokio::runtime::Handle::current(),
                );
                h.set_requests(Arc::new(WorkerRequests));
                *host = Some(h);
            }
            _ => self.close(),
        }
    }

    /// Closes the link, if it is open.
    pub fn close(&self) {
        if let Some(h) = self.host.lock().unwrap().take() {
            h.stop();
        }
        self.set_state(LinkState::Off);
    }

    /// Introduces this worker to its central host, on every new link.
    async fn register(self: Arc<Self>, host: Arc<Host>) {
        let worker = self.store.lock().unwrap().worker().clone();
        let projects = self
            .sessions
            .list_projects()
            .into_iter()
            .map(|p| WorkerProject {
                identity: p.identity,
                path: p.path,
            })
            .collect();
        let reg = WorkerRegister {
            id: worker.id,
            name: worker.name,
            os: os().into(),
            arch: arch().into(),
            cores: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
            version: env!("CARGO_PKG_VERSION").into(),
            projects,
        };
        let params = serde_json::to_value(reg).unwrap();
        if let Err(e) = host.request(m::WORKER_REGISTER, params).await {
            tracing::warn!("cannot register with the central host: {}", e.message);
        }
    }

    fn status(self: &Arc<Self>, info: &HostInfo) {
        // A stopped host's last words are not this link's.
        let current = self.host.lock().unwrap().clone();
        let Some(host) = current else { return };
        let name = self
            .store
            .lock()
            .unwrap()
            .central()
            .map(|c| c.name.clone())
            .unwrap_or_default();
        let state = match info.status {
            HostStatus::Connecting => LinkState::Connecting,
            HostStatus::Reconnecting => LinkState::Reconnecting,
            HostStatus::Connected => {
                tokio::spawn(self.clone().register(host));
                LinkState::Connected { since: now_ms() }
            }
            HostStatus::NeedsUpdate => LinkState::NeedsUpdate {
                daemon_version: info.daemon_version.clone().unwrap_or_default(),
            },
            HostStatus::Refused => LinkState::Error {
                message: format!("{name} no longer accepts this Mac"),
            },
            HostStatus::NeedsInstall | HostStatus::Error => LinkState::Error {
                message: info
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("cannot reach {name}")),
            },
        };
        self.set_state(state);
    }
}

fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

struct LinkEvents(Weak<WorkerLink>);

impl Events for LinkEvents {
    fn status(&self, info: &HostInfo) {
        if let Some(link) = self.0.upgrade() {
            link.status(info);
        }
    }

    fn event(&self, _host: &str, _name: String, _data: Value) {}
}

/// What a worker answers its central host.
struct WorkerRequests;

impl Requests for WorkerRequests {
    fn request(
        &self,
        method: String,
        _params: Value,
    ) -> BoxFuture<'static, Result<Value, RpcError>> {
        Box::pin(async move {
            match method.as_str() {
                m::WORKER_PING => Ok(serde_json::json!({})),
                _ => Err(RpcError::new(
                    "unknown_method",
                    format!("unknown method {method}"),
                )),
            }
        })
    }
}

/// Opens the link when the settings say so, and closes it when the daemon
/// shuts down (an upgraded daemon links again by itself).
pub fn spawn(daemon: Arc<crate::daemon::Daemon>) {
    let link = daemon.link.clone();
    link.apply();
    let mut shutdown = daemon.shutdown_signal();
    tokio::spawn(async move {
        let _ = shutdown.changed().await;
        link.close();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn central(name: &str, addrs: &[&str], token: &str) -> LinkSet {
        serde_json::from_value(serde_json::json!({
            "central": { "name": name, "addrs": addrs, "token": token }
        }))
        .unwrap()
    }

    fn file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("link.json")
    }

    #[test]
    fn the_first_load_makes_a_worker_id_that_later_loads_keep() {
        let dir = tempfile::tempdir().unwrap();
        let first = LinkStore::load(file(&dir), "Alex's MacBook Pro")
            .worker()
            .id
            .clone();
        assert_eq!(first.len(), 36, "a UUID: {first}");
        assert_eq!(first.matches('-').count(), 4, "a UUID: {first}");
        let again = LinkStore::load(file(&dir), "Alex's MacBook Pro")
            .worker()
            .id
            .clone();
        assert_eq!(again, first);
    }

    #[test]
    fn the_name_defaults_to_the_computer_name_and_link_set_changes_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Alex's MacBook Pro");
        assert_eq!(store.worker().name, "Alex's MacBook Pro");
        assert!(!store.worker().enabled);
        let req: LinkSet = serde_json::from_value(serde_json::json!({
            "worker": { "name": "Work laptop", "enabled": true }
        }))
        .unwrap();
        store.set(req, &[]).unwrap();
        let store = LinkStore::load(file(&dir), "Alex's MacBook Pro");
        assert_eq!(
            (store.worker().name.as_str(), store.worker().enabled),
            ("Work laptop", true)
        );
    }

    #[test]
    fn link_set_cannot_change_the_worker_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Mac");
        let id = store.worker().id.clone();
        let req: LinkSet = serde_json::from_value(serde_json::json!({
            "worker": { "id": "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", "enabled": true }
        }))
        .unwrap();
        store.set(req, &[]).unwrap();
        assert_eq!(LinkStore::load(file(&dir), "Mac").worker().id, id);
    }

    #[test]
    fn an_invalid_central_is_refused_and_nothing_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Mac");
        let before = std::fs::read(file(&dir)).unwrap();
        for (req, why) in [
            (central("", &["100.101.102.103:47428"], TOKEN), "empty name"),
            (
                central("studio\u{7}mini", &["100.101.102.103:47428"], TOKEN),
                "control character",
            ),
            (central("studio-mini", &[], TOKEN), "no addrs"),
            (
                central("studio-mini", &["studio-mini"], TOKEN),
                "not ip:port",
            ),
            (
                central("studio-mini", &["100.101.102.103:47428"], "0123456789"),
                "10-character token",
            ),
        ] {
            assert!(store.set(req, &[]).is_err(), "{why} was accepted");
            assert_eq!(
                std::fs::read(file(&dir)).unwrap(),
                before,
                "{why} changed the file"
            );
        }
        assert_eq!(store.central(), None);
    }

    #[test]
    fn the_central_host_never_links_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Mac");
        let own: Vec<IpAddr> = vec!["100.101.102.103".parse().unwrap()];
        let e = store
            .set(
                central("studio-mini", &["100.101.102.103:47428"], TOKEN),
                &own,
            )
            .unwrap_err();
        assert_eq!(e.message, "this Mac is the central host");
        assert_eq!(store.central(), None);
        store
            .set(central("studio-mini", &["100.64.0.9:47428"], TOKEN), &own)
            .unwrap();
        assert_eq!(
            store.central().map(|c| c.name.as_str()),
            Some("studio-mini")
        );
    }

    #[test]
    fn the_file_is_private_and_the_shown_settings_have_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Mac");
        store
            .set(
                central("studio-mini", &["100.101.102.103:47428"], TOKEN),
                &[],
            )
            .unwrap();
        let mode = std::fs::metadata(file(&dir)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let shown = serde_json::to_string(&store.central_info()).unwrap();
        assert_eq!(
            shown,
            r#"{"name":"studio-mini","addrs":["100.101.102.103:47428"]}"#
        );
        // `central: null` clears it; a later load agrees.
        let clear: LinkSet =
            serde_json::from_value(serde_json::json!({ "central": null })).unwrap();
        store.set(clear, &[]).unwrap();
        assert_eq!(LinkStore::load(file(&dir), "Mac").central(), None);
    }

    #[test]
    fn leaving_central_out_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Mac");
        store
            .set(
                central("studio-mini", &["100.101.102.103:47428"], TOKEN),
                &[],
            )
            .unwrap();
        let req: LinkSet =
            serde_json::from_value(serde_json::json!({ "worker": { "enabled": true } })).unwrap();
        store.set(req, &[]).unwrap();
        assert_eq!(
            store.central().map(|c| c.name.as_str()),
            Some("studio-mini")
        );
    }

    #[test]
    fn the_link_is_open_while_heavy_commands_are_on_or_a_session_is_kept_in_sync() {
        assert!(!should_link(false, false, 0));
        assert!(!should_link(true, false, 0), "no central host");
        assert!(!should_link(false, false, 2), "no central host");
        assert!(!should_link(false, true, 0), "nothing needs it");
        assert!(should_link(true, true, 0));
        assert!(should_link(false, true, 1), "a session kept in sync (X60)");
    }
}
