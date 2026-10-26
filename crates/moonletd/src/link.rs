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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use moonlet_core::paths::now_ms;
use moonlet_core::session::SessionManager;
use moonlet_link::tailnet::TailnetConnector;
use moonlet_link::{BoxFuture, Events, Host, HostInfo, HostOptions, HostStatus, Requests};
use moonlet_proto::methods::{
    self as m, DeviceKind, LinkCentral, LinkCentralInfo, LinkInfo, LinkPair, LinkSet, LinkState, LinkWorker,
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
    /// How many times `central` was set since the daemon started: a
    /// pairing saves its token only if it has not moved meanwhile (X61).
    revision: u64,
}

impl LinkStore {
    /// Reads `path`. The first time, this machine gets a worker id that
    /// never changes afterwards, and the name `computer_name`.
    pub fn load(path: PathBuf, computer_name: &str) -> LinkStore {
        let bytes = match std::fs::read(&path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                // It may hold the id: never written over while unreadable.
                tracing::warn!("cannot read {}: {e}", path.display());
                let data = LinkFile {
                    central: None,
                    worker: LinkWorker {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: computer_name.to_string(),
                        enabled: false,
                        slots: m::default_slots(),
                        cloud: false,
                    },
                };
                return LinkStore { path, data, revision: 0 };
            }
        };
        let read = bytes
            .as_deref()
            .and_then(|b| serde_json::from_slice::<LinkFile>(b).ok());
        if bytes.is_some() && read.is_none() {
            // Kept for the user rather than written over: it holds the id.
            let bad = path.with_extension("json.bad");
            match std::fs::rename(&path, &bad) {
                Ok(()) => tracing::warn!("cannot read {}; kept it as {}", path.display(), bad.display()),
                Err(e) => tracing::warn!("cannot read {} nor keep it aside: {e}", path.display()),
            }
        }
        let data = match read {
            Some(mut d) if !d.worker.id.is_empty() => {
                // A hand edit outside what `link.set` allows reads as the default.
                if !(1..=64).contains(&d.worker.slots) {
                    tracing::warn!(
                        "{}: slots {} is not from 1 to 64; using {}",
                        path.display(),
                        d.worker.slots,
                        m::default_slots()
                    );
                    d.worker.slots = m::default_slots();
                }
                d
            }
            other => {
                let d = LinkFile {
                    central: other.and_then(|d| d.central),
                    worker: LinkWorker {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: computer_name.to_string(),
                        enabled: false,
                        slots: m::default_slots(),
                        cloud: false,
                    },
                };
                if let Err(e) = save(&path, &d) {
                    tracing::warn!("cannot write {}: {e:#}", path.display());
                }
                d
            }
        };
        LinkStore { path, data, revision: 0 }
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
    #[cfg(test)]
    pub fn set(&mut self, req: LinkSet, own: &[IpAddr]) -> Result<(), RpcError> {
        self.set_at(req, own, None)
    }

    /// The current [`LinkStore::revision`] of `central`.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Marks this machine a cloud machine (X63).
    fn set_cloud(&mut self) -> Result<(), RpcError> {
        let mut next = self.data.clone();
        next.worker.cloud = true;
        save(&self.path, &next)
            .map_err(|e| RpcError::new("internal", format!("cannot write {}: {e:#}", self.path.display())))?;
        self.data = next;
        Ok(())
    }

    /// [`LinkStore::set`], refused with `conflict` when `central` has been
    /// set since `revision`.
    fn set_at(&mut self, req: LinkSet, own: &[IpAddr], revision: Option<u64>) -> Result<(), RpcError> {
        if revision.is_some_and(|r| r != self.revision) {
            return Err(RpcError::new("conflict", "the central host changed"));
        }
        let moves = req.central.is_some();
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
            if let Some(slots) = w.slots {
                if !(1..=64).contains(&slots) {
                    return Err(RpcError::new("invalid_params", "slots must be from 1 to 64"));
                }
                next.worker.slots = slots;
            }
        }
        save(&self.path, &next)
            .map_err(|e| RpcError::new("internal", format!("cannot write {}: {e:#}", self.path.display())))?;
        self.data = next;
        if moves {
            self.revision += 1;
        }
        Ok(())
    }
}

/// Where a cloud machine's first-boot script writes `machine-setup.json`
/// (X63): `MOONLET_MACHINE_SETUP_DIR` stands in for it in tests.
fn machine_setup_file() -> std::path::PathBuf {
    std::env::var_os("MOONLET_MACHINE_SETUP_DIR")
        .map_or_else(|| std::path::PathBuf::from("/var/lib/moonlet"), std::path::PathBuf::from)
        .join("machine-setup.json")
}

/// `machine-setup.json` as a step: running, done or failed.
fn setup_step(v: &Value) -> Option<m::WorkerStep> {
    let started = v["started"].as_u64()?;
    let (state, error) = match (v["ended"].as_u64(), v["exit"].as_i64()) {
        (Some(_), Some(0)) => ("done", None),
        (Some(_), Some(code)) => ("failed", Some(format!("exit {code}; its output is in /var/log/moonlet/machine-setup.log"))),
        _ => ("running", None),
    };
    Some(m::WorkerStep {
        step: "machine_setup".into(),
        state: state.into(),
        took_ms: v["ended"].as_u64().map(|e| e.saturating_sub(started) * 1000),
        error,
    })
}

/// Tells the central host how the machine setup goes, until it has ended
/// or the link closes.
async fn report_machine_setup(host: Arc<Host>) {
    let mut sent: Option<m::WorkerStep> = None;
    loop {
        if !matches!(host.info().status, moonlet_link::HostStatus::Connected) {
            return;
        }
        let read = std::fs::read(machine_setup_file())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| setup_step(&v));
        if let Some(step) = read
            && sent.as_ref() != Some(&step)
        {
            let ended = step.state != "running";
            if host.request(m::WORKER_STEP, serde_json::to_value(&step).unwrap()).await.is_ok() {
                sent = Some(step);
                if ended {
                    return;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// This machine's 1-minute load average (X62). `MOONLET_TEST_LOAD`
/// stands in for it in tests.
pub fn load() -> Option<f64> {
    if let Some(v) = std::env::var("MOONLET_TEST_LOAD").ok().and_then(|v| v.parse().ok()) {
        return Some(v);
    }
    let mut avg = [0f64; 3];
    // SAFETY: getloadavg writes at most the number of samples asked for.
    let n = unsafe { libc::getloadavg(avg.as_mut_ptr(), 1) };
    (n >= 1).then_some(avg[0])
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_reply", e.to_string()))
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
    check_target(&c.name, &c.addrs, own)?;
    if c.token.len() != 64 || !c.token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(invalid("the token is not 64 hex characters"));
    }
    Ok(())
}

/// The central host's name and addresses, which are never this machine's.
fn check_target(name: &str, addrs: &[String], own: &[IpAddr]) -> Result<(), RpcError> {
    check_name(name)?;
    if addrs.is_empty() {
        return Err(invalid("the central host has no address"));
    }
    for a in addrs {
        let addr: SocketAddr = a
            .parse()
            .map_err(|_| invalid(format!("{a} is not an ip:port address")))?;
        // `::ffff:100.x` is the same address as `100.x`.
        if own.contains(&addr.ip().to_canonical()) {
            return Err(invalid("this Mac is the central host"));
        }
    }
    Ok(())
}

fn save(path: &Path, data: &LinkFile) -> anyhow::Result<()> {
    crate::mobile::write_private(path, &serde_json::to_vec_pretty(data)?)
}

/// Whether the link should be open: a central host is set, and this
/// machine shares its account (X68), takes heavy commands, or keeps at
/// least one session in sync (X60).
pub fn should_link(enabled: bool, central: bool, synced_copies: usize, member: bool) -> bool {
    central && (member || enabled || synced_copies > 0)
}

/// How often a member catches up with its central host's account, in case
/// an `account.changed` went missing (X68).
const ACCOUNT_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

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
    /// Which host is current: a stopped host's late news carries an older
    /// number and is ignored.
    generation: AtomicU64,
    /// Sessions this Mac keeps in sync (X60); the link stays open for them.
    synced: AtomicUsize,
    /// Set while `link.set` applies a change, which says `link.changed` once.
    quiet: AtomicBool,
    /// Which account exchange loop is current: the connection reconnects
    /// and registers again by itself, and each registration starts a new
    /// loop that ends the one before (X68).
    account_loop: AtomicU64,
    /// The copies this Mac keeps, which the link serves (X60).
    sync: std::sync::OnceLock<Weak<crate::sync::LiveCopies>>,
    /// Routed commands this machine runs for its central host (X62).
    runs: std::sync::OnceLock<Weak<crate::exec::Runs>>,
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
            generation: AtomicU64::new(0),
            synced: AtomicUsize::new(0),
            quiet: AtomicBool::new(false),
            account_loop: AtomicU64::new(0),
            sync: std::sync::OnceLock::new(),
            runs: std::sync::OnceLock::new(),
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
        if !self.quiet.load(Ordering::SeqCst) {
            (self.emit)(Message::event(m::EV_LINK_CHANGED, self.info()));
        }
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
        self.set_at(req, own, None)
    }

    /// [`WorkerLink::set`], only while `central` is still at `revision`.
    fn set_at(self: &Arc<Self>, req: LinkSet, own: &[IpAddr], revision: Option<u64>) -> Result<LinkInfo, RpcError> {
        let moved = req.central.is_some();
        // What the central host lists of this worker: its name, slots and
        // whether it takes heavy commands (X62).
        let renamed = req
            .worker
            .as_ref()
            .is_some_and(|w| w.name.is_some() || w.slots.is_some() || w.enabled.is_some());
        self.store.lock().unwrap().set_at(req, own, revision)?;
        // Routing copies go with heavy commands, and with the central host
        // they were made for (X62).
        if let Some(sync) = self.sync() {
            let info = self.info();
            if !info.worker.enabled {
                sync.remove_run_copies(None);
            } else if moved {
                sync.remove_run_copies(info.central.map(|c| c.name));
            }
        }
        // One link.changed for the whole change, at the end.
        self.quiet.store(true, Ordering::SeqCst);
        if moved {
            // A new central host, or new addresses or token: link again.
            self.close();
        }
        self.apply();
        // A link waiting for the user tries again on new settings, too.
        if !moved && self.waiting() {
            self.retry();
        }
        // The central host learns a new name, slots or heavy commands now,
        // not at the next link.
        if renamed && !moved {
            self.register_again();
        }
        self.quiet.store(false, Ordering::SeqCst);
        self.changed();
        Ok(self.info())
    }

    /// Tells the central host this worker's details again, now, when the
    /// link is up: what it lists of the worker changed.
    pub fn register_again(self: &Arc<Self>) {
        if matches!(*self.state.lock().unwrap(), LinkState::Connected { .. })
            && let Some(host) = self.host.lock().unwrap().clone()
        {
            tokio::spawn(self.clone().register(host));
        }
    }

    /// `link.pair` (X61): pairs this machine with the central host using a
    /// code from it, then makes it the central host with the new token.
    /// Nothing is stored when the pairing fails, nor when the central host
    /// was changed while it ran: the newer choice stands.
    pub async fn pair(self: &Arc<Self>, req: LinkPair, own: &[IpAddr]) -> Result<LinkInfo, RpcError> {
        let LinkPair { central, code } = req;
        check_target(&central.name, &central.addrs, own)?;
        let (device, revision) = {
            let store = self.store.lock().unwrap();
            (store.worker().name.clone(), store.revision())
        };
        let paired = moonlet_link::tailnet::pair(&central.addrs, &code, &device, DeviceKind::Desktop)
            .await
            .map_err(|e| RpcError::new("pair_failed", moonlet_link::tailnet::pair_error_text(&central.name, &e)))?;
        let name = central.name.clone();
        let req = LinkSet {
            central: Some(Some(LinkCentral {
                name: central.name,
                addrs: central.addrs,
                token: paired.token,
            })),
            worker: None,
        };
        self.set_at(req, own, Some(revision)).map_err(|e| match e.code.as_str() {
            "conflict" => RpcError::new("conflict", format!("The central host changed while pairing with {name}. Pair again.")),
            // The central host has paired this machine, and only the token
            // in hand could use that pairing.
            _ => RpcError::new(
                "pair_unsaved",
                format!("Paired with {name}, but could not save it. Remove {device} on {name} and pair again: {}", e.message),
            ),
        })
    }

    /// `link.join` (X63): a cloud machine pairs with its central host with
    /// the join code the central host made for it, as `name`, and takes
    /// heavy commands.
    pub async fn join(self: &Arc<Self>, req: m::LinkJoin, own: &[IpAddr]) -> Result<LinkInfo, RpcError> {
        let revision = self.store.lock().unwrap().revision();
        let paired = moonlet_link::tailnet::pair(&req.addrs, &req.code, &req.name, DeviceKind::Cloud)
            .await
            .map_err(|e| RpcError::new("pair_failed", moonlet_link::tailnet::pair_error_text("the central host", &e)))?;
        let central = paired
            .host
            .filter(|h| !h.is_empty())
            .or_else(|| req.addrs.first().cloned())
            .unwrap_or_default();
        self.store.lock().unwrap().set_cloud()?;
        let set = LinkSet {
            central: Some(Some(LinkCentral {
                name: central,
                addrs: req.addrs,
                token: paired.token,
            })),
            worker: Some(m::LinkWorkerSet {
                enabled: Some(true),
                name: Some(req.name),
                slots: None,
            }),
        };
        self.set_at(set, own, Some(revision))
    }

    /// Whether the link waits for the user: an update, or pairing again.
    fn waiting(&self) -> bool {
        matches!(
            *self.state.lock().unwrap(),
            LinkState::NeedsUpdate { .. } | LinkState::Refused | LinkState::Error { .. }
        )
    }

    /// `link.retry`: a link waiting for the user tries again now. A link
    /// that works, or is being made, is left alone.
    pub fn retry(&self) {
        if matches!(
            *self.state.lock().unwrap(),
            LinkState::Connected { .. } | LinkState::Connecting
        ) {
            return;
        }
        if let Some(h) = self.host.lock().unwrap().as_ref() {
            h.reconnect();
        }
    }

    /// Where the central host's `sync.*` requests and the link's ups and
    /// downs go (X60).
    pub fn set_sync(&self, sync: Weak<crate::sync::LiveCopies>) {
        let _ = self.sync.set(sync);
    }

    fn sync(&self) -> Option<Arc<crate::sync::LiveCopies>> {
        self.sync.get().and_then(Weak::upgrade)
    }

    pub fn set_runs(&self, runs: Weak<crate::exec::Runs>) {
        let _ = self.runs.set(runs);
    }

    fn runs(&self) -> Option<Arc<crate::exec::Runs>> {
        self.runs.get().and_then(Weak::upgrade)
    }

    /// The central host's name, when one is set.
    pub fn central_name(&self) -> Option<String> {
        self.store.lock().unwrap().central().map(|c| c.name.clone())
    }

    /// The link's connection while it is open (X60).
    pub fn host(&self) -> Option<Arc<Host>> {
        self.host.lock().unwrap().clone()
    }

    /// How many sessions this Mac keeps in sync (X60).
    pub fn set_synced(self: &Arc<Self>, copies: usize) {
        self.synced.store(copies, Ordering::SeqCst);
        self.apply();
    }

    /// Opens the link when it should be open and is not, and closes it
    /// when it should not be.
    pub fn apply(self: &Arc<Self>) {
        // Decided under the host's lock, so a close cannot slip in between.
        let mut host = self.host.lock().unwrap();
        let (want, central) = {
            let store = self.store.lock().unwrap();
            let central = store.central().cloned();
            let want = should_link(
                store.worker().enabled,
                central.is_some(),
                self.synced.load(Ordering::SeqCst),
                self.sessions.has_account(),
            );
            (want, central)
        };
        match (want, central) {
            (true, Some(central)) => {
                if host.is_some() {
                    return;
                }
                let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
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
                    Arc::new(LinkEvents(Arc::downgrade(self), generation)),
                    tokio::runtime::Handle::current(),
                );
                h.set_requests(Arc::new(WorkerRequests(Arc::downgrade(self))));
                *host = Some(h);
            }
            _ => {
                drop(host);
                self.close();
            }
        }
    }

    /// Closes the link, if it is open.
    pub fn close(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(h) = self.host.lock().unwrap().take() {
            h.stop();
        }
        self.set_state(LinkState::Off);
        // A stopped host reports nothing more, so the copies hear it here.
        if let Some(sync) = self.sync() {
            sync.link_down();
        }
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
            slots: worker.slots,
            heavy: worker.enabled,
        };
        let params = serde_json::to_value(reg).unwrap();
        match host.request(m::WORKER_REGISTER, params).await {
            // The central host serves copies to registered workers only.
            Ok(_) => {
                if let Some(sync) = self.sync() {
                    sync.link_up();
                }
                tokio::spawn(self.clone().keep_account(host.clone()));
                // A cloud machine reports its machine setup (X63).
                if self.store.lock().unwrap().worker().cloud {
                    tokio::spawn(report_machine_setup(host.clone()));
                }
            }
            Err(e) => {
                tracing::warn!("cannot register with the central host: {}", e.message);
                // Linked but not listed: say so, and wait for a retry.
                let current = self.host.lock().unwrap().as_ref().is_some_and(|h| Arc::ptr_eq(h, &host));
                if current {
                    self.set_state(LinkState::Error { message: e.message });
                }
            }
        }
    }

    /// Keeps this member's account and its central host's in step while
    /// `host` is the link and this is the newest loop: at once, then every
    /// minute (X68).
    async fn keep_account(self: Arc<Self>, host: Arc<Host>) {
        if !self.sessions.has_account() {
            return;
        }
        let me = self.account_loop.fetch_add(1, Ordering::SeqCst) + 1;
        let current = |link: &WorkerLink| {
            link.account_loop.load(Ordering::SeqCst) == me
                && link.host.lock().unwrap().as_ref().is_some_and(|h| Arc::ptr_eq(h, &host))
        };
        while current(&self) {
            if let Err(e) = self.sync_account(&host).await {
                // A central host from before X68 has no account to share.
                if e.code == "unknown_method" {
                    tracing::info!("the central host shares no account: update moonlet on it");
                    return;
                }
                tracing::warn!("cannot sync the account: {}", e.message);
            }
            tokio::time::sleep(ACCOUNT_EVERY).await;
        }
    }

    /// One exchange: what this member lacks first, then what the central
    /// host lacks, by the version it gave.
    async fn sync_account(&self, host: &Host) -> Result<(), RpcError> {
        let ask = m::AccountSync { version: self.sessions.account_version(), changes: Vec::new() };
        let got: m::AccountSynced = parse(host.request(m::ACCOUNT_SYNC, serde_json::to_value(ask).unwrap()).await?)?;
        self.sessions.apply_account(got.changes);
        let lacks = self.sessions.account_changes_for(&got.version);
        if !lacks.is_empty() {
            self.send_account(host, lacks).await?;
        }
        Ok(())
    }

    async fn send_account(&self, host: &Host, changes: Vec<moonlet_proto::types::Change>) -> Result<(), RpcError> {
        let send = m::AccountSync { version: self.sessions.account_version(), changes };
        let got: m::AccountSynced = parse(host.request(m::ACCOUNT_SYNC, serde_json::to_value(send).unwrap()).await?)?;
        self.sessions.apply_account(got.changes);
        Ok(())
    }

    /// Sends changes made on this member to its central host, when linked.
    /// A change that does not get there now goes at the next exchange.
    pub fn push_account(self: &Arc<Self>, changes: Vec<moonlet_proto::types::Change>) {
        if !matches!(*self.state.lock().unwrap(), LinkState::Connected { .. }) {
            return;
        }
        let Some(host) = self.host() else { return };
        let link = self.clone();
        tokio::spawn(async move {
            if let Err(e) = link.send_account(&host, changes).await {
                tracing::debug!("account changes wait for the next exchange: {}", e.message);
            }
        });
    }

    fn status(self: &Arc<Self>, info: &HostInfo, generation: u64) {
        // A stopped host's last words are not this link's.
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
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
            HostStatus::Refused => LinkState::Refused,
            HostStatus::NeedsInstall | HostStatus::Error => LinkState::Error {
                message: info
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("cannot reach {name}")),
            },
        };
        let up = matches!(state, LinkState::Connected { .. });
        self.set_state(state);
        // Up counts once this Mac is registered (see `register`).
        if !up && let Some(sync) = self.sync() {
            sync.link_down();
        }
    }
}

pub fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub(crate) fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

/// How a retiring cloud machine (X63) leaves its tailnet: as `moonlet`, with
/// the one sudo rule its cloud-init wrote, so moonletd needs no other say
/// over tailscaled. `stub`, from `MOONLET_TAILSCALE`, is the fake provider's.
fn logout_command(
    stub: Option<std::ffi::OsString>,
) -> (std::ffi::OsString, Vec<std::ffi::OsString>) {
    match stub {
        Some(stub) => (stub, vec!["logout".into()]),
        None => (
            "sudo".into(),
            vec!["-n".into(), "/usr/bin/tailscale".into(), "logout".into()],
        ),
    }
}

/// A host's news for its link, with the host's generation.
struct LinkEvents(Weak<WorkerLink>, u64);

impl Events for LinkEvents {
    fn status(&self, info: &HostInfo) {
        if let Some(link) = self.0.upgrade() {
            link.status(info, self.1);
        }
    }

    fn event(&self, _host: &str, name: String, data: Value) {
        let Some(link) = self.0.upgrade() else { return };
        // Changes from the other members (X68).
        if name == m::EV_ACCOUNT_CHANGED {
            if let Ok(c) = serde_json::from_value::<m::AccountChanged>(data) {
                link.sessions.apply_account(c.changes);
            }
            return;
        }
        // New sessions, for the projects that keep them in sync (X60).
        let Some(sync) = link.sync() else {
            return;
        };
        match name.as_str() {
            m::EV_SESSIONS_CHANGED => sync.sessions_changed(data),
            m::EV_PROJECTS_CHANGED => sync.projects_changed(),
            _ => {}
        }
    }
}

/// What a worker answers its central host.
struct WorkerRequests(Weak<WorkerLink>);

impl Requests for WorkerRequests {
    fn request(
        &self,
        method: String,
        params: Value,
    ) -> BoxFuture<'static, Result<Value, RpcError>> {
        let link = self.0.upgrade();
        Box::pin(async move {
            match method.as_str() {
                m::WORKER_PING => Ok(serde_json::json!({ "load": load() })),
                // The machine is being removed (X63): it leaves the tailnet.
                // Only a cloud machine: a Mac or host paired as a worker stays.
                m::WORKER_RETIRE => {
                    if !link.as_ref().is_some_and(|l| l.info().worker.cloud) {
                        return Err(RpcError::new("forbidden", "only a cloud machine retires"));
                    }
                    // The fake provider (X63) points this at a stub, so a test
                    // never logs the machine running it out of its tailnet.
                    let (program, args) = logout_command(std::env::var_os("MOONLET_TAILSCALE"));
                    let logout = tokio::process::Command::new(program)
                        .args(args)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), logout).await;
                    Ok(serde_json::json!(true))
                }
                m::SYNC_UPDATE => {
                    let req: m::SyncUpdate = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
                    let pack = req.pack.and_then(|t| link.host().and_then(|h| h.take_pack(t)));
                    if req.pack.is_some() && pack.is_none() {
                        return Err(RpcError::new("invalid_params", "the pack did not arrive"));
                    }
                    let done = sync.update(req, pack).await?;
                    Ok(serde_json::to_value(done).unwrap())
                }
                m::EXEC_PREPARE => {
                    let req: m::ExecPrepare = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    if !link.info().worker.enabled {
                        return Err(RpcError::new("not_approved", "heavy commands are off here"));
                    }
                    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
                    Ok(serde_json::to_value(sync.prepare_run(req.session).await?).unwrap())
                }
                m::EXEC_START => {
                    let req: m::ExecStart = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let info = link.info();
                    if !info.worker.enabled {
                        return Err(RpcError::new("not_approved", "heavy commands are off here"));
                    }
                    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
                    let runs = link.runs().ok_or_else(|| RpcError::new("gone", "no runs"))?;
                    let host = link.host().ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    Ok(serde_json::json!(runs.start_here(req, sync, host, info.worker.slots, info.worker.cloud).await?))
                }
                m::EXEC_CANCEL => {
                    let req: m::ExecCancel = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let runs = link.runs().ok_or_else(|| RpcError::new("gone", "no runs"))?;
                    Ok(serde_json::json!(runs.cancel_here(req.run)))
                }
                m::SYNC_CLOSING => {
                    let req: m::SyncClosing = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
                    Ok(serde_json::to_value(sync.closing(req).await?).unwrap())
                }
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
/// Shares this machine's workspaces and sections with the other members of
/// its account (X68): the log is named after its worker id, and every change
/// made here goes to this machine's own clients, which include the members
/// linked to it, and to its central host.
pub fn attach_account(daemon: &Arc<crate::daemon::Daemon>) {
    let member = daemon.link.info().worker.id;
    if let Err(e) = daemon.sessions.attach_account(moonlet_core::paths::home().join("account.json"), &member) {
        tracing::warn!("cannot share workspaces with the account: {e:#}");
        return;
    }
    let terminals = daemon.terminals.clone();
    let link = Arc::downgrade(&daemon.link);
    daemon.sessions.on_account_change(move |changes| {
        terminals.emit(Message::event(m::EV_ACCOUNT_CHANGED, m::AccountChanged { changes: changes.clone() }));
        if let Some(link) = link.upgrade() {
            link.push_account(changes);
        }
    });
}

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
    fn a_retiring_cloud_machine_logs_out_through_its_one_sudo_rule() {
        // Cloud-init allows `moonlet` exactly this command as root.
        assert_eq!(
            logout_command(None),
            (
                "sudo".into(),
                vec!["-n".into(), "/usr/bin/tailscale".into(), "logout".into()]
            )
        );
        // The fake provider's stub, in tests.
        assert_eq!(
            logout_command(Some("/tmp/fake/tailscale".into())),
            ("/tmp/fake/tailscale".into(), vec!["logout".into()])
        );
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
    fn a_link_json_that_cannot_be_read_is_kept_aside_not_written_over() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file(&dir), "{ \"worker\": { \"id\": ").unwrap();
        let store = LinkStore::load(file(&dir), "Alex's MacBook Pro");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("link.json.bad")).unwrap(),
            "{ \"worker\": { \"id\": "
        );
        assert_eq!(store.worker().name, "Alex's MacBook Pro");
    }

    #[test]
    fn a_link_json_that_is_not_text_is_kept_aside_too() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file(&dir), b"{\"worker\": \xff\xfe}").unwrap();
        LinkStore::load(file(&dir), "Alex's MacBook Pro");
        assert_eq!(
            std::fs::read(dir.path().join("link.json.bad")).unwrap(),
            b"{\"worker\": \xff\xfe}"
        );
    }

    #[test]
    fn a_link_json_that_cannot_be_opened_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let id = "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37";
        let kept = format!(r#"{{"central":null,"worker":{{"id":"{id}","name":"Mac","enabled":true}}}}"#);
        std::fs::write(file(&dir), &kept).unwrap();
        std::fs::set_permissions(file(&dir), std::fs::Permissions::from_mode(0o200)).unwrap();
        LinkStore::load(file(&dir), "Mac");
        std::fs::set_permissions(file(&dir), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(file(&dir)).unwrap(), kept);
    }

    #[test]
    fn link_set_fails_and_keeps_the_settings_when_link_json_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = LinkStore::load(file(&dir), "Alex's MacBook Pro");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let req: LinkSet = serde_json::from_value(serde_json::json!({
            "worker": { "name": "Work laptop" }
        }))
        .unwrap();
        let got = store.set(req, &[]);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(got.unwrap_err().code, "internal");
        assert_eq!(store.worker().name, "Alex's MacBook Pro");
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
        // The same address written as IPv6.
        let e = store
            .set(
                central("studio-mini", &["[::ffff:100.101.102.103]:47428"], TOKEN),
                &own,
            )
            .unwrap_err();
        assert_eq!(e.message, "this Mac is the central host");
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
        assert!(!should_link(false, false, 0, false));
        assert!(!should_link(true, false, 0, false), "no central host");
        assert!(!should_link(false, false, 2, false), "no central host");
        assert!(!should_link(false, false, 0, true), "no central host");
        assert!(!should_link(false, true, 0, false), "nothing needs it");
        assert!(should_link(true, true, 0, false));
        assert!(should_link(false, true, 1, false), "a session kept in sync (X60)");
        assert!(should_link(false, true, 0, true), "a member of an account (X68)");
    }
}
