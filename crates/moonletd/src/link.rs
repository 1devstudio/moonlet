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
use moonlet_core::account::RecordKind;
use moonlet_core::session::{SessionManager, WorkerSettings};
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
    /// `central`'s token is a worker link of its own, which reaches only a
    /// member's work there; until then it is the token this Mac paired
    /// with, which the link trades for one (`worker.credential`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    worker_link: bool,
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
                    worker_link: false,
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
                let (central, worker_link) = other.map_or((None, false), |d| (d.central, d.worker_link));
                let d = LinkFile {
                    central,
                    worker: LinkWorker {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: computer_name.to_string(),
                        enabled: false,
                        slots: m::default_slots(),
                        cloud: false,
                    },
                    worker_link,
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

    /// Whether `central`'s token is a worker link of its own.
    pub fn worker_link(&self) -> bool {
        self.data.worker_link
    }

    /// Keeps `token`, a worker link of this Mac's own, in place of the
    /// token `was`. False, with nothing stored, when the central host's
    /// token is no longer `was`: it changed meanwhile, and the newer stands.
    fn take_worker_link(&mut self, was: &str, token: String) -> Result<bool, RpcError> {
        let mut next = self.data.clone();
        match next.central.as_mut() {
            Some(c) if c.token == was => c.token = token,
            _ => return Ok(false),
        }
        next.worker_link = true;
        save(&self.path, &next)
            .map_err(|e| RpcError::new("internal", format!("cannot write {}: {e:#}", self.path.display())))?;
        self.data = next;
        Ok(true)
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
            // A token from `link.set` or a pairing is the paired Mac's.
            next.worker_link = false;
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

/// What can need the link to the central host.
pub struct LinkNeeds {
    /// This machine takes heavy commands.
    pub heavy: bool,
    /// Sessions it keeps in sync (X60).
    pub copies: usize,
    /// It shares the account of its central host (X68).
    pub member: bool,
}

/// Whether the link should be open: a central host is set, and something
/// needs it.
pub fn should_link(central: bool, needs: LinkNeeds) -> bool {
    central && (needs.member || needs.heavy || needs.copies > 0)
}

/// How long [`WorkerLink::sync_now`] waits for the link to answer before it
/// makes it again.
const ANSWER_BEFORE_RELINKING: std::time::Duration = std::time::Duration::from_secs(2);

/// How often a member catches up with its central host's account, in case
/// an `account.changed` went missing (X68). `MOONLET_ACCOUNT_RESYNC_MS`
/// shortens it in tests.
fn account_resync_interval() -> std::time::Duration {
    std::env::var("MOONLET_ACCOUNT_RESYNC_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(std::time::Duration::from_secs(60), std::time::Duration::from_millis)
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

/// How far other hosts' clocks are from this one's, to the minute (X68).
#[derive(Default)]
struct Clocks {
    /// The central host's, from the last exchange with it.
    central: Option<i64>,
    /// The central host's version at the last exchange.
    central_version: Option<moonlet_core::account::Version>,
    /// Each linked member's by worker id, from its last `account.sync`
    /// here.
    members: std::collections::HashMap<String, i64>,
}

/// `ms` to the nearest minute, so a round trip's jitter says nothing new;
/// 0 for less than a minute.
fn to_minute(ms: i64) -> i64 {
    if ms.abs() < 60_000 {
        return 0;
    }
    (ms as f64 / 60_000.0).round() as i64 * 60_000
}

/// The version a member sends its central host (X68). While the central
/// host's clock is more than a day ahead of this member's, this member
/// refuses most of what it would send back, so it says it has seen what
/// `central` (the central host's last version) holds: the central host then
/// sends only what is new, not the whole log every minute. Once the clocks
/// agree, `own` asks for everything this member lacks again.
fn version_to_send(
    own: moonlet_core::account::Version,
    central: Option<&moonlet_core::account::Version>,
    central_ahead_ms: Option<i64>,
) -> moonlet_core::account::Version {
    let behind = central_ahead_ms.is_some_and(|ms| ms > moonlet_core::account::AHEAD_MS as i64);
    let (true, Some(central)) = (behind, central) else { return own };
    let mut v = own;
    for (member, n) in central {
        let seen = v.entry(member.clone()).or_insert(0);
        *seen = (*seen).max(*n);
    }
    v
}

/// The worker side of the link: its settings, its state and, while it
/// should be open, the connection.
pub struct WorkerLink {
    store: Mutex<LinkStore>,
    state: Mutex<LinkState>,
    /// Since when the link has been down, while it is (X73).
    down_since: Mutex<Option<u64>>,
    host: Mutex<Option<Arc<Host>>>,
    /// Which host is current: a stopped host's late news carries an older
    /// number and is ignored.
    generation: AtomicU64,
    /// Sessions this Mac keeps in sync (X60); the link stays open for them.
    synced: AtomicUsize,
    /// Set while `link.set` applies a change, which says `link.changed` once.
    quiet: AtomicBool,
    /// Set while the link trades its paired token for a worker link: a
    /// registration asked for meanwhile is the move's to make.
    moving: AtomicBool,
    /// Which account exchange loop is current: the connection reconnects
    /// and registers again by itself, and each registration starts a new
    /// loop that ends the one before (X68).
    account_loop: AtomicU64,
    /// How far other hosts' clocks are from this one's (X68).
    clocks: Mutex<Clocks>,
    /// Why the account does not sync with the central host now (X68):
    /// `too_large` once an exchange could not fit one message.
    not_syncing: Mutex<Option<String>>,
    /// The copies this Mac keeps, which the link serves (X60).
    sync: std::sync::OnceLock<Weak<crate::sync::LiveCopies>>,
    /// Routed commands this machine runs for its central host (X62).
    runs: std::sync::OnceLock<Weak<crate::exec::Runs>>,
    /// Takes the central host's requests for this member's sessions (X72).
    forwarder: std::sync::OnceLock<Forwarder>,
    /// Answers a cloud machine's `session.files_fetch` for a session of
    /// this member's it runs a command of (X89, X74).
    files: std::sync::OnceLock<FilesFetcher>,
    /// Takes the central host's terminal relays (X72).
    relayer: std::sync::OnceLock<Relayer>,
    /// Shows a URL the central host found the user here for (X75).
    shower: std::sync::OnceLock<Shower>,
    tunneler: std::sync::OnceLock<Tunneler>,
    signer: std::sync::OnceLock<Signer>,
    /// Takes input for those relays, and forgets an earlier link's (X72).
    relay_input: std::sync::OnceLock<(moonlet_link::RelayedInput, Arc<dyn Fn() + Send + Sync>)>,
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
            down_since: Mutex::new(None),
            host: Mutex::new(None),
            generation: AtomicU64::new(0),
            synced: AtomicUsize::new(0),
            quiet: AtomicBool::new(false),
            moving: AtomicBool::new(false),
            account_loop: AtomicU64::new(0),
            clocks: Mutex::new(Clocks::default()),
            not_syncing: Mutex::new(None),
            sync: std::sync::OnceLock::new(),
            runs: std::sync::OnceLock::new(),
            forwarder: std::sync::OnceLock::new(),
            files: std::sync::OnceLock::new(),
            relayer: std::sync::OnceLock::new(),
            shower: std::sync::OnceLock::new(),
            tunneler: std::sync::OnceLock::new(),
            signer: std::sync::OnceLock::new(),
            relay_input: std::sync::OnceLock::new(),
            sessions,
            emit: Box::new(emit),
        })
    }

    /// The account this machine shares (X68): its central host's, once it
    /// has said so, else its own.
    pub fn account_info(&self) -> m::AccountInfo {
        let info = self.info();
        let central = info.central.map(|c| c.name);
        // Said while a central host is set, even before it named the
        // account: one that never answered could not.
        let not_syncing = self.not_syncing.lock().unwrap().clone().filter(|_| central.is_some());
        let mut out = match self.sessions.central_account().filter(|_| central.is_some()) {
            Some(account) => m::AccountInfo { account, central: central.clone(), clocks: Vec::new(), not_syncing },
            None => m::AccountInfo { account: info.worker.id, central: None, clocks: Vec::new(), not_syncing },
        };
        let names = self.sessions.member_names();
        let clocks = self.clocks.lock().unwrap();
        if let (Some(name), Some(ahead)) = (central, clocks.central) {
            out.clocks.push(m::ClockOff { worker: out.account.clone(), name, ahead_ms: ahead });
        }
        for (worker, ahead) in &clocks.members {
            let name = names.get(worker).cloned().unwrap_or_else(|| worker.clone());
            out.clocks.push(m::ClockOff { worker: worker.clone(), name, ahead_ms: *ahead });
        }
        out.clocks.retain(|c| c.ahead_ms != 0);
        out
    }

    /// Notes that member `worker`'s clock said `their_ms` when this host's
    /// said `now_ms`, in its `account.sync` (X68). Says `account.info` when
    /// what this host says of clocks changes.
    pub fn member_clock(&self, worker: &str, their_ms: u64, now_ms: u64) {
        let ahead = to_minute(their_ms as i64 - now_ms as i64);
        self.clocks_changed(|c| {
            c.members.insert(worker.to_string(), ahead);
        });
    }

    /// Forgets member `worker`'s clock once its link closes.
    pub fn member_gone(&self, worker: &str) {
        self.clocks_changed(|c| {
            c.members.remove(worker);
        });
    }

    /// Changes what this host knows of clocks with `f`, and says
    /// `account.info` when what it says of them changes.
    fn clocks_changed(&self, f: impl FnOnce(&mut Clocks)) {
        self.info_changed(|| f(&mut self.clocks.lock().unwrap()));
    }

    /// Notes why the account does not sync with the central host now, or
    /// that it does, and says `account.info` when that changes.
    fn set_not_syncing(&self, why: Option<&str>) {
        self.info_changed(|| *self.not_syncing.lock().unwrap() = why.map(String::from));
    }

    /// Runs `f`, and says `account.info` when what it says changes.
    fn info_changed(&self, f: impl FnOnce()) {
        let before = self.account_info();
        f();
        let after = self.account_info();
        if after != before {
            (self.emit)(Message::event(m::EV_ACCOUNT_INFO, after));
        }
    }

    pub fn info(&self) -> LinkInfo {
        let store = self.store.lock().unwrap();
        LinkInfo {
            central: store.central_info(),
            worker: store.worker().clone(),
            state: self.state.lock().unwrap().clone(),
            unreachable_since: *self.down_since.lock().unwrap(),
        }
    }

    fn changed(&self) {
        if !self.quiet.load(Ordering::SeqCst) {
            (self.emit)(Message::event(m::EV_LINK_CHANGED, self.info()));
        }
    }

    fn set_state(&self, state: LinkState) {
        // A central host that answers, if only to refuse this Mac or ask
        // for an update, is not offline (X73).
        let out_of_reach = matches!(
            state,
            LinkState::Connecting | LinkState::Reconnecting | LinkState::Error { .. }
        );
        self.set_state_as(state, out_of_reach);
    }

    /// [`Self::set_state`], saying whether the central host is out of reach.
    fn set_state_as(&self, state: LinkState, out_of_reach: bool) {
        {
            let mut s = self.state.lock().unwrap();
            if *s == state {
                return;
            }
            // Since when the central host has been out of reach (X73).
            let mut down = self.down_since.lock().unwrap();
            if out_of_reach {
                down.get_or_insert_with(now_ms);
            } else {
                *down = None;
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
        let settings = req.worker.as_ref().map(|w| WorkerSettings {
            heavy: w.enabled,
            slots: w.slots,
        });
        self.store.lock().unwrap().set_at(req, own, revision)?;
        // The account keeps every member's worker settings, so any app
        // shows and changes them (X89). Without an account, link.json
        // alone keeps them.
        if let Some(settings) = settings.filter(|s| s.heavy.is_some() || s.slots.is_some())
            && self.sessions.has_account()
            && let Err(e) = self
                .sessions
                .set_worker_settings(&self.info().worker.id, settings)
        {
            tracing::warn!("cannot keep this host's worker settings in the account: {e:#}");
        }
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
            // A new central host, or new addresses or token: link again,
            // and share its account once it says which (X68).
            self.close();
            self.clocks_changed(|c| {
                c.central = None;
                c.central_version = None;
            });
            if self.sessions.set_central_account(None) {
                (self.emit)(Message::event(m::EV_ACCOUNT_INFO, self.account_info()));
            }
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
        if renamed {
            self.sessions.name_member(&self.info().worker.name);
        }
        self.quiet.store(false, Ordering::SeqCst);
        self.changed();
        Ok(self.info())
    }

    /// Takes this host's worker settings from the account, when another
    /// member changed them (X89): as `link.set` would, so routing copies
    /// go when heavy commands are turned off, and the central host learns
    /// the new values.
    pub fn follow_settings(self: &Arc<Self>) {
        let info = self.info();
        let Some(s) = self.sessions.worker_settings().remove(&info.worker.id) else {
            return;
        };
        let enabled = s.heavy.filter(|h| *h != info.worker.enabled);
        let slots = s
            .slots
            .filter(|n| *n != info.worker.slots && (1..=64).contains(n));
        if enabled.is_none() && slots.is_none() {
            return;
        }
        let req = LinkSet {
            central: None,
            worker: Some(m::LinkWorkerSet {
                enabled,
                slots,
                name: None,
            }),
        };
        if let Err(e) = self.set(req, &[]) {
            tracing::warn!("cannot take this host's worker settings from the account: {e}");
        }
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

    /// What handles a request the central host passes on for one of this
    /// member's sessions (X72).
    pub fn set_forwarder(&self, f: Forwarder) {
        let _ = self.forwarder.set(f);
    }

    /// What answers a cloud machine's `session.files_fetch` (X89).
    pub fn set_files_fetcher(&self, f: FilesFetcher) {
        let _ = self.files.set(f);
    }

    /// What takes input for the terminals the central host relays, and
    /// what forgets an earlier link's relays, each time a link is made
    /// (X72). Set before the link starts.
    pub fn set_relay_input(&self, sink: moonlet_link::RelayedInput, relink: Arc<dyn Fn() + Send + Sync>) {
        let _ = self.relay_input.set((sink, relink));
    }

    /// What attaches to the terminals the central host relays (X72).
    pub fn set_relayer(&self, f: Relayer) {
        let _ = self.relayer.set(f);
    }

    pub fn set_shower(&self, f: Shower) {
        let _ = self.shower.set(f);
    }

    pub fn set_tunneler(&self, f: Tunneler) {
        let _ = self.tunneler.set(f);
    }

    pub fn set_signer(&self, f: Signer) {
        let _ = self.signer.set(f);
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
                central.is_some(),
                LinkNeeds {
                    heavy: store.worker().enabled,
                    copies: self.synced.load(Ordering::SeqCst),
                    member: self.sessions.has_account(),
                },
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
                // Output of commands the central host runs for this member
                // goes to their `moonlet exec` (X89).
                let me = Arc::downgrade(self);
                h.set_run_output(Arc::new(move |run, stream, data| {
                    if let Some(runs) = me.upgrade().and_then(|l| l.runs()) {
                        runs.forward(crate::peer::LINK_PEER, run, stream, data);
                    }
                }));
                // Before the link can carry a relay (X72): what an earlier
                // link relayed has no client any more, and input for the
                // new link's relays has somewhere to go from its first frame.
                if let Some((sink, relink)) = self.relay_input.get() {
                    relink();
                    h.set_relayed_input(sink.clone());
                }
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

    /// Trades the token this Mac paired with for a worker link of its own,
    /// over the link `host` made with it, and links again with the new
    /// one. True when the link moves, so `host` registers nothing. A
    /// central host from before worker links, or one that refuses, keeps
    /// the paired token in use.
    async fn take_worker_link(self: &Arc<Self>, host: &Arc<Host>) -> bool {
        if self.store.lock().unwrap().worker_link() {
            return false;
        }
        // One move at a time: a second ask would make the central host drop
        // the worker link the first one is saving. The move registers.
        if self.moving.swap(true, Ordering::SeqCst) {
            return true;
        }
        let moved = self.move_to_worker_link(host).await;
        self.moving.store(false, Ordering::SeqCst);
        // A link made meanwhile by `link.set` left its registration to
        // this move.
        if moved && !self.is_current(host) {
            self.register_again();
        }
        moved
    }

    async fn move_to_worker_link(self: &Arc<Self>, host: &Arc<Host>) -> bool {
        let was = {
            let store = self.store.lock().unwrap();
            match store.central() {
                // A cloud machine's token is only a cloud machine's (X63).
                Some(c) if !store.worker_link() && !store.worker().cloud => c.token.clone(),
                _ => return false,
            }
        };
        // This Mac's app keeps a token of its own to reach the host (X57),
        // which may be the one it handed to the link (X41): that one stays
        // the app's. One the link alone holds goes once the new one works.
        let apps = moonlet_core::ssh::saved_hosts().tailnet.iter().any(|t| t.token == was);
        let ask = serde_json::to_value(m::WorkerCredential { replace: !apps }).unwrap();
        let given = match host.request(m::WORKER_CREDENTIAL, ask).await {
            Ok(v) => match serde_json::from_value::<m::WorkerCredentialGiven>(v) {
                Ok(g) => g,
                Err(e) => {
                    tracing::warn!("the central host gave no worker link: {e}");
                    return false;
                }
            },
            Err(e) => {
                tracing::info!("the link keeps this Mac's paired token: {}", e.message);
                return false;
            }
        };
        // Taken under the host's lock, so a `link.set` cannot slip between.
        let mut current = self.host.lock().unwrap();
        if !current.as_ref().is_some_and(|h| Arc::ptr_eq(h, host)) {
            return true;
        }
        match self.store.lock().unwrap().take_worker_link(&was, given.token) {
            Ok(true) => {}
            Ok(false) => return true,
            Err(e) => {
                tracing::warn!("cannot keep the worker link: {}", e.message);
                return false;
            }
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(h) = current.take() {
            h.stop();
        }
        drop(current);
        self.apply();
        true
    }

    /// Introduces this worker to its central host, on every new link.
    async fn register(self: Arc<Self>, host: Arc<Host>) {
        // Tests only: a slow registration, so a copy can start before it.
        if let Some(ms) = std::env::var("MOONLET_TEST_REGISTER_DELAY_MS").ok().and_then(|v| v.parse().ok()) {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        if self.take_worker_link(&host).await {
            return;
        }
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
            // A member routes and runs other members' commands through its
            // central host (X89); a cloud machine runs its central host's.
            peer: !worker.cloud,
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
                // It answered, so it is not offline.
                if current {
                    self.set_state_as(LinkState::Error { message: e.message }, false);
                }
            }
        }
    }

    /// Keeps this member's account and its central host's in step while
    /// `host` is the link and this is the newest loop: at once, then every
    /// minute (X68).
    async fn keep_account(self: Arc<Self>, host: Arc<Host>) {
        // A machine that joined as a cloud machine after the daemon started
        // has an account attached, but is no member. A registration with a
        // former central host that ends late leaves the newer loop running.
        if !self.sessions.has_account() || self.is_cloud() || !self.is_current(&host) {
            return;
        }
        let generation = self.account_loop.fetch_add(1, Ordering::SeqCst) + 1;
        let every = account_resync_interval();
        // Whether this member's log was checked against the central host's
        // copy of it, once per link: a log goes back in time only while
        // the daemon is down.
        let mut checked = false;
        while self.account_loop.load(Ordering::SeqCst) == generation && self.is_current(&host) {
            let synced = self.sync_account(&host, !checked).await;
            checked |= synced.is_ok();
            match synced {
                Ok(()) => self.set_not_syncing(None),
                // A central host from before X68, or one whose account
                // could not be read, has none to share; one that takes this
                // machine for no member shares none with it.
                Err(e) if e.code == "unknown_method" || e.code == "no_account" || e.code == "forbidden" => {
                    tracing::info!("the central host shares no account: {}", e.message);
                    // Nor does it say anything of the account's size now.
                    self.set_not_syncing(None);
                    return;
                }
                // What it would send does not fit one message: a central
                // host from before pages, with a log past 16 MiB. Asking
                // every minute cannot change that; the next link asks
                // again, as the central host may have been updated by then.
                Err(e) if e.code == "too_large" => {
                    tracing::warn!("the account does not sync with the central host until it links again: {}", e.message);
                    self.set_not_syncing(Some("too_large"));
                    return;
                }
                Err(e) => tracing::warn!("cannot sync the account: {}", e.message),
            }
            tokio::time::sleep(every).await;
        }
    }

    /// Whether this is a cloud machine (X63), which is never a member of
    /// the account (X68).
    fn is_cloud(&self) -> bool {
        self.store.lock().unwrap().worker().cloud
    }

    /// Whether `host` is still this link's connection: a reply from a
    /// former central host is not taken in.
    fn is_current(&self, host: &Arc<Host>) -> bool {
        self.host.lock().unwrap().as_ref().is_some_and(|h| Arc::ptr_eq(h, host))
    }

    /// One exchange: what this member lacks first, then what the central
    /// host lacks, by the version it gave. With `check`, this member's log
    /// is checked against the central host's copy of it first.
    async fn sync_account(&self, host: &Arc<Host>, check: bool) -> Result<(), RpcError> {
        let before = self.sessions.own_log();
        let mut version = self.send_account(host, Vec::new()).await?;
        if check && let Some((name, count)) = &before {
            self.check_own_log(host, name, *count, &version).await?;
        }
        // Only this machine's own changes: the central host takes no other
        // member's from it.
        let own = self.info().worker.id;
        let mut lacks = self.sessions.account_changes_for(&version);
        lacks.retain(|c| moonlet_core::account::log_owner(&c.stamp.member) == Some(own.as_str()));
        if !lacks.is_empty() {
            version = self.send_account(host, lacks).await?;
        }
        if let Some((name, _)) = before {
            self.restamp_own(host, &name, &version).await?;
        }
        Ok(())
    }

    /// Stamps again, by this Mac's clock, its own changes the central host
    /// (at `theirs`) refused for a stamp more than a day ahead: made while
    /// this Mac's clock was wrong, when it has made none since (X68).
    /// Nothing while it still is. The central host's copies of this log's
    /// changes past the gap tell which it holds: one extra `account.sync`
    /// from the count it gave.
    async fn restamp_own(&self, host: &Arc<Host>, name: &str, theirs: &moonlet_core::account::Version) -> Result<(), RpcError> {
        let counted = theirs.get(name).copied().unwrap_or(0);
        if !self.sessions.own_changes_ahead(counted) {
            return Ok(());
        }
        let mut from = self.sessions.account_version();
        from.insert(name.to_string(), counted);
        let got = self.exchange_all(host, from).await?;
        let held: Vec<_> = got.into_iter().filter(|c| c.stamp.member == name).collect();
        self.sessions
            .restamp_own(counted, &held)
            .map_err(|e| RpcError::new("internal", format!("cannot stamp this member's account changes again: {e:#}")))?;
        Ok(())
    }

    /// Whether this member's log `name`, holding `count` of its changes
    /// before this exchange, went back in time (restored from a backup, or
    /// a write lost) since the central host, at `theirs`, took its changes.
    /// Its changes made since then have numbers its lost ones had, which
    /// the central host already holds and takes no other change under. The
    /// changes both hold tell, from the last one this member held before
    /// the exchange on: one differs once the log went back, since every
    /// change has a stamp of its own. Those made here during the exchange
    /// are among them. One that went back takes its lost changes back, and
    /// sends again those it made since under new numbers.
    async fn check_own_log(&self, host: &Arc<Host>, name: &str, count: u64, theirs: &moonlet_core::account::Version) -> Result<(), RpcError> {
        let last = count.min(theirs.get(name).copied().unwrap_or(0));
        if last == 0 {
            return Ok(());
        }
        let from = |seq: u64| {
            let mut v = self.sessions.account_version();
            v.insert(name.to_string(), seq);
            v
        };
        let got = self.exchange_all(host, from(last - 1)).await?;
        if !self.sessions.own_log_differs(&got) {
            return Ok(());
        }
        let got = self.exchange_all(host, from(0)).await?;
        let own = got.into_iter().filter(|c| c.stamp.member == name).collect();
        self.sessions
            .take_back_own(own)
            .map_err(|e| RpcError::new("internal", format!("cannot take back this member's account changes: {e:#}")))?;
        Ok(())
    }

    /// One `account.sync` with the central host, from `version`: what it
    /// answers, not taken in yet.
    async fn exchange(&self, host: &Arc<Host>, version: moonlet_core::account::Version, changes: Vec<moonlet_proto::types::Change>) -> Result<m::AccountSynced, RpcError> {
        let sent = moonlet_core::account::now_ms();
        let send = m::AccountSync { version, changes, now_ms: Some(sent) };
        let got: m::AccountSynced = parse(host.request(m::ACCOUNT_SYNC, serde_json::to_value(send).unwrap()).await?)?;
        if !self.is_current(host) {
            return Err(RpcError::new("gone", "the central host changed meanwhile"));
        }
        // The central host's clock against this one's halfway through the
        // round trip.
        let back = moonlet_core::account::now_ms();
        let mid = sent / 2 + back / 2;
        let ahead = got.now_ms.map(|t| to_minute(t as i64 - mid as i64));
        let version = got.version.clone();
        self.clocks_changed(|c| {
            c.central = ahead;
            c.central_version = Some(version);
        });
        // Its own changes the central host counts are never stamped again.
        if let Some((name, _)) = self.sessions.own_log() {
            self.sessions.set_own_counted(got.version.get(&name).copied().unwrap_or(0));
        }
        Ok(got)
    }

    /// Sends `changes` with this member's version, takes in what the central
    /// host answers, and returns the central host's version. Changes too
    /// many for one message go a part at a time, and so do those the
    /// central host answers: each part is taken in as it comes, so the next
    /// is asked for from past it.
    async fn send_account(&self, host: &Arc<Host>, changes: Vec<moonlet_proto::types::Change>) -> Result<moonlet_core::account::Version, RpcError> {
        let mut parts = moonlet_core::account::in_parts(changes, m::ACCOUNT_PAGE_BYTES).into_iter();
        let mut send = parts.next().unwrap_or_default();
        loop {
            let mut version = {
                let c = self.clocks.lock().unwrap();
                version_to_send(self.sessions.account_version(), c.central_version.as_ref(), c.central)
            };
            let theirs = loop {
                let got = self.exchange(host, version.clone(), std::mem::take(&mut send)).await?;
                // A central host that says more is missing but sends none
                // would otherwise be asked for ever.
                let more = got.more && !got.changes.is_empty();
                moonlet_core::account::seen_through(&mut version, &got.changes);
                self.sessions.apply_account(got.changes);
                if got.account.is_some() && self.sessions.set_central_account(got.account) {
                    (self.emit)(Message::event(m::EV_ACCOUNT_INFO, self.account_info()));
                }
                if !more {
                    break got.version;
                }
            };
            match parts.next() {
                Some(next) => send = next,
                None => return Ok(theirs),
            }
        }
    }

    /// Every change the central host holds that a member at `version`
    /// lacks, asked for a part at a time, not taken in.
    async fn exchange_all(&self, host: &Arc<Host>, mut version: moonlet_core::account::Version) -> Result<Vec<moonlet_proto::types::Change>, RpcError> {
        let mut all = Vec::new();
        loop {
            let got = self.exchange(host, version.clone(), Vec::new()).await?;
            let more = got.more && !got.changes.is_empty();
            moonlet_core::account::seen_through(&mut version, &got.changes);
            all.extend(got.changes);
            if !more {
                return Ok(all);
            }
        }
    }

    /// Asks the central host now for what of the account this member lacks,
    /// and takes it in (X73, after a sleep): true once it answered, within
    /// `wait`. The link's state is not taken at its word, as a link from
    /// before a sleep can look up long after the central host dropped it:
    /// it proves itself first with a round trip, and one that gives no
    /// answer within [`ANSWER_BEFORE_RELINKING`] is made again, once.
    pub async fn sync_now(self: &Arc<Self>, wait: std::time::Duration) -> bool {
        if self.central_name().is_none() || !self.sessions.has_account() || self.is_cloud() {
            return false;
        }
        let until = tokio::time::Instant::now() + wait;
        let mut made_again = false;
        loop {
            let left = until.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            let up = matches!(*self.state.lock().unwrap(), LinkState::Connected { .. });
            if let Some(host) = self.host().filter(|_| up) {
                let proved = tokio::time::timeout(left.min(ANSWER_BEFORE_RELINKING), host.request(m::DAEMON_INFO, Value::Null)).await;
                match proved {
                    // A link that answers has the rest of the time, however
                    // much the account has to catch up.
                    Ok(Ok(_)) => {
                        let left = until.saturating_duration_since(tokio::time::Instant::now());
                        match tokio::time::timeout(left, self.send_account(&host, Vec::new())).await {
                            Ok(Ok(_)) => return true,
                            // A central host that shares no account has none to say.
                            Ok(Err(e)) if e.code == "unknown_method" || e.code == "no_account" => return false,
                            // Nor can one whose answer does not fit one
                            // message: asking again makes it build that
                            // answer again, for nothing.
                            Ok(Err(e)) if e.code == "too_large" => {
                                self.set_not_syncing(Some("too_large"));
                                return false;
                            }
                            // Lost, or not registered yet on a new link: again.
                            Ok(Err(_)) => {}
                            Err(_) => return false,
                        }
                    }
                    // Lost: the link is made again by itself.
                    Ok(Err(_)) => {}
                    Err(_) if !made_again => {
                        made_again = true;
                        host.reconnect();
                    }
                    Err(_) => {}
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100).min(left)).await;
        }
    }

    /// Sends changes made on this member to its central host, when linked.
    /// A change that does not get there now goes at the next exchange.
    pub fn push_account(self: &Arc<Self>, changes: Vec<moonlet_proto::types::Change>) {
        if self.is_cloud() || !matches!(*self.state.lock().unwrap(), LinkState::Connected { .. }) {
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
            HostStatus::Reconnecting => {
                // The central host ended this link's relays with it (X72),
                // and may have lost what it was told.
                if let Some((_, relink)) = self.relay_input.get() {
                    relink();
                }
                LinkState::Reconnecting
            }
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
            // Tests only: a member that misses every change as it happens.
            let ignore = std::env::var_os("MOONLET_TEST_IGNORE_ACCOUNT_EVENTS").is_some();
            // A former central host's late news is not this link's.
            let current = self.1 == link.generation.load(Ordering::SeqCst);
            if !ignore && current && let Ok(c) = serde_json::from_value::<m::AccountChanged>(data) {
                link.sessions.apply_account(c.changes);
            }
            return;
        }
        // The member that ran one of this member's commands went away
        // (X89): the command runs again here.
        if name == m::EV_EXEC_LOST {
            if let (Some(runs), Some(run)) = (link.runs(), data["run"].as_u64()) {
                runs.lost(run as u32);
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

/// Handles a request the central host passes on for one of this member's
/// sessions (X72).
pub type Forwarder = Arc<dyn Fn(m::SessionForward) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

/// Answers `session.files_fetch` for a cloud machine (X89).
pub type FilesFetcher = Arc<dyn Fn(m::SessionFilesFetch) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

/// Shows this Mac's app a URL from another member (X75); false when it was
/// kept for the app, which is not connected.
pub type Shower = Arc<dyn Fn(m::BrowserShow) -> bool + Send + Sync>;

/// Checks or runs a sign-in on this member for the central host (X75).
pub type Signer = Arc<dyn Fn(m::SignInsHere) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

/// Hands a request the browser made on another Mac to this member's waiting
/// sign-in (X75).
pub type Tunneler = Arc<dyn Fn(m::TunnelOpen) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

/// Attaches to or detaches from a terminal the central host relays (X72).
pub type Relayer = Arc<dyn Fn(m::SessionRelay) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

impl Requests for WorkerRequests {
    fn request(
        &self,
        method: String,
        params: Value,
    ) -> BoxFuture<'static, Result<Value, RpcError>> {
        let link = self.0.upgrade();
        Box::pin(async move {
            match method.as_str() {
                m::WORKER_PING => {
                    let runs = link.as_ref().and_then(|l| l.runs());
                    let used = runs.as_ref().map(|r| r.used_here());
                    let running = runs.map(|r| r.serving_now()).unwrap_or_default();
                    Ok(serde_json::json!({ "load": load(), "used": used, "running": running }))
                }
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
                    Ok(serde_json::to_value(sync.prepare_run(req.session, None, req.setup).await?).unwrap())
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
                    let peer = crate::peer::Peer::Link(host);
                    Ok(serde_json::json!(runs.start_here(req, sync, peer, info.worker.slots, info.worker.cloud).await?))
                }
                m::EXEC_CANCEL => {
                    let req: m::ExecCancel = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let runs = link.runs().ok_or_else(|| RpcError::new("gone", "no runs"))?;
                    Ok(serde_json::json!(runs.cancel_here(crate::peer::LINK_PEER, req.run)))
                }
                // Another member, through the central host (X89): it runs a
                // command of this member's, or has this member run one of
                // its own.
                m::PEER_CALL => {
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let call: m::PeerCall = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let from = call.from.clone().ok_or_else(|| RpcError::new("invalid_params", "from whom"))?;
                    relayed(link, from, call.method, call.params).await
                }
                // The central host makes and ends its routing copy of this
                // member's session, which it runs a command of (X89).
                m::SYNC_OPEN | m::SYNC_FETCH | m::SYNC_CLOSE | m::EXEC_DONE => {
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
                    let host = link.host().ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let peer = crate::peer::Peer::Link(host);
                    let bad = |e: serde_json::Error| RpcError::new("invalid_params", e.to_string());
                    match method.as_str() {
                        m::SYNC_OPEN => {
                            let req: m::SyncOpen = serde_json::from_value(params).map_err(bad)?;
                            if req.kind != m::CopyKind::Run {
                                return Err(RpcError::new("forbidden", "the central host keeps no live copy of a member's session"));
                            }
                            Ok(serde_json::to_value(sync.open(&peer, req).await?).unwrap())
                        }
                        m::SYNC_FETCH => {
                            let req: m::SyncFetch = serde_json::from_value(params).map_err(bad)?;
                            Ok(serde_json::to_value(sync.fetch(&peer, req).await?).unwrap())
                        }
                        m::SYNC_CLOSE => {
                            let req: m::CopyRef = serde_json::from_value(params).map_err(bad)?;
                            Ok(serde_json::json!(sync.close(&peer, &req.copy).await?))
                        }
                        _ => {
                            let req: m::ExecDone = serde_json::from_value(params).map_err(bad)?;
                            let runs = link.runs().ok_or_else(|| RpcError::new("gone", "no runs"))?;
                            let name = link.info().worker.name;
                            Ok(serde_json::to_value(runs.take_done(&sync, &peer, req, &name).await?).unwrap())
                        }
                    }
                }
                m::SESSION_RELAY => {
                    let req: m::SessionRelay = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let f = link
                        .relayer
                        .get()
                        .cloned()
                        .ok_or_else(|| RpcError::new("gone", "nothing relays terminals"))?;
                    f(req).await
                }
                m::EV_BROWSER_SHOW => {
                    // The central host found the user at this Mac (X75).
                    let req: m::BrowserShow = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    moonlet_core::browser::check_url(&req.url).map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let show = link.shower.get().cloned().ok_or_else(|| RpcError::new("gone", "nothing shows URLs"))?;
                    // Kept for the app: the central host knows the user is
                    // not here.
                    Ok(if show(req) { serde_json::json!(true) } else { serde_json::json!({ "kept": true }) })
                }
                m::SIGNINS_HERE => {
                    let req: m::SignInsHere = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let f = link.signer.get().cloned().ok_or_else(|| RpcError::new("gone", "no sign-ins here"))?;
                    f(req).await
                }
                m::TUNNEL_OPEN => {
                    let req: m::TunnelOpen = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let f = link.tunneler.get().cloned().ok_or_else(|| RpcError::new("gone", "no sign-in waits here"))?;
                    f(req).await
                }
                m::SESSION_FORWARD => {
                    let req: m::SessionForward = serde_json::from_value(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))?;
                    let link = link.ok_or_else(|| RpcError::new("gone", "the link closed"))?;
                    let f = link
                        .forwarder
                        .get()
                        .cloned()
                        .ok_or_else(|| RpcError::new("gone", "nothing takes sessions' requests"))?;
                    f(req).await
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

/// Shares this machine's workspaces and sections with the other members of
/// its account (X68): the log is named after its worker id, and every change
/// made here goes to the members linked to it, when it is a central host,
/// and to its own central host. A cloud machine is a worker only, never a
/// member, and shares nothing.
pub fn attach_account(daemon: &Arc<crate::daemon::Daemon>) {
    let worker = daemon.link.info().worker;
    if worker.cloud {
        return;
    }
    if let Err(e) = daemon.sessions.attach_account(moonlet_core::paths::home().join("account.json"), &worker.id) {
        tracing::warn!("cannot share workspaces with the account: {e:#}");
        return;
    }
    daemon.sessions.name_member(&worker.name);
    // Worker settings kept in link.json before X89 become the account's,
    // giving way to any change another member made meanwhile; then this
    // host follows the account's (X89).
    let seed = WorkerSettings {
        heavy: Some(worker.enabled),
        slots: Some(worker.slots),
    };
    if let Err(e) = daemon.sessions.seed_worker_settings(&worker.id, seed) {
        tracing::warn!("cannot keep this host's worker settings in the account: {e:#}");
    }
    daemon.link.follow_settings();
    daemon.heavy.seed_account();
    let d = Arc::downgrade(daemon);
    let me = worker.id.clone();
    daemon.sessions.on_account_applied(move |changes| {
        let Some(d) = d.upgrade() else { return };
        // Another member approved a project's heavy commands (X89): the
        // project pages show it.
        if changes.iter().any(|c| c.kind == RecordKind::HeavyApproval.as_str()) {
            d.terminals.emit(Message::event(m::EV_HEAVY_APPROVAL_CHANGED, serde_json::json!({})));
        }
        let worker = RecordKind::Worker.as_str();
        if changes.iter().any(|c| c.kind == worker) {
            if changes.iter().any(|c| c.kind == worker && c.id == me) {
                d.link.follow_settings();
            }
            d.worker_settings_changed();
        }
    });
    let workers = Arc::downgrade(&daemon.workers);
    let link = Arc::downgrade(&daemon.link);
    daemon.sessions.on_account_change(move |changes| {
        if let Some(workers) = workers.upgrade() {
            workers.send_to_members(Message::event(m::EV_ACCOUNT_CHANGED, m::AccountChanged { changes: changes.clone() }), None);
        }
        if let Some(link) = link.upgrade() {
            link.push_account(changes);
        }
    });
}

/// A routing call from member `from`, passed on by the central host (X89):
/// as a runner of `from`'s command, or as the router of one `from` runs.
async fn relayed(link: Arc<WorkerLink>, from: String, method: String, params: Value) -> Result<Value, RpcError> {
    let bad = |e: serde_json::Error| RpcError::new("invalid_params", e.to_string());
    let sync = link.sync().ok_or_else(|| RpcError::new("gone", "no copies"))?;
    let runs = link.runs().ok_or_else(|| RpcError::new("gone", "no runs"))?;
    let host = link.host().ok_or_else(|| RpcError::new("gone", "the link closed"))?;
    let peer = crate::peer::Peer::Relay(host.clone(), from.clone());
    let me = link.info().worker;
    // Only a member of this account, and for a runner's work, only while
    // this host takes other hosts' commands.
    // A cloud machine has no account: it runs what its central host passes
    // on, as it runs the central host's own commands (X63).
    let runner_side = crate::relay::TO_RUNNER.contains(&method.as_str());
    // A cloud machine the central host offered calls back only as the
    // runner of this member's command.
    let name = if me.cloud || (!runner_side && sync.was_offered(&from)) {
        from.clone()
    } else {
        link.sessions
            .member_names()
            .remove(&from)
            .ok_or_else(|| RpcError::new("forbidden", "not a member of this account"))?
    };
    if runner_side && !matches!(method.as_str(), m::SYNC_CLOSING | m::EXEC_CANCEL) && !me.enabled {
        return Err(RpcError::new("not_approved", "heavy commands are off here"));
    }
    let own_copy = |copy: &str| {
        if sync.copy_member(copy).as_deref() == Some(from.as_str()) {
            Ok(())
        } else {
            Err(RpcError::new("not_found", "no such routing copy"))
        }
    };
    match method.as_str() {
        m::EXEC_PREPARE => {
            let req: m::ExecPrepare = serde_json::from_value(params).map_err(bad)?;
            Ok(serde_json::to_value(sync.prepare_run(req.session, Some((from, name)), req.setup).await?).unwrap())
        }
        m::EXEC_START => {
            let req: m::ExecStart = serde_json::from_value(params).map_err(bad)?;
            own_copy(&req.copy)?;
            Ok(serde_json::json!(runs.start_here(req, sync, peer, me.slots, me.cloud).await?))
        }
        m::EXEC_CANCEL => {
            let req: m::ExecCancel = serde_json::from_value(params).map_err(bad)?;
            Ok(serde_json::json!(runs.cancel_here(crate::peer::LINK_PEER, req.run)))
        }
        m::SYNC_UPDATE => {
            let req: m::SyncUpdate = serde_json::from_value(params).map_err(bad)?;
            own_copy(&req.copy)?;
            let pack = match req.pack {
                Some(t) => Some(host.take_pack(t).ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive"))?),
                None => None,
            };
            Ok(serde_json::to_value(sync.update(req, pack).await?).unwrap())
        }
        m::SYNC_CLOSING => {
            let req: m::SyncClosing = serde_json::from_value(params).map_err(bad)?;
            own_copy(&req.copy)?;
            Ok(serde_json::to_value(sync.closing(req).await?).unwrap())
        }
        m::SYNC_OPEN => {
            let req: m::SyncOpen = serde_json::from_value(params).map_err(bad)?;
            if req.kind != m::CopyKind::Run {
                return Err(RpcError::new("forbidden", "a member keeps no live copy of another's session"));
            }
            Ok(serde_json::to_value(sync.open(&peer, req).await?).unwrap())
        }
        m::SYNC_FETCH => {
            let req: m::SyncFetch = serde_json::from_value(params).map_err(bad)?;
            Ok(serde_json::to_value(sync.fetch(&peer, req).await?).unwrap())
        }
        m::SYNC_CLOSE => {
            let req: m::CopyRef = serde_json::from_value(params).map_err(bad)?;
            Ok(serde_json::json!(sync.close(&peer, &req.copy).await?))
        }
        m::EXEC_DONE => {
            let req: m::ExecDone = serde_json::from_value(params).map_err(bad)?;
            Ok(serde_json::to_value(runs.take_done(&sync, &peer, req, &me.name).await?).unwrap())
        }
        // A cloud machine running a command of this member's session asks
        // for the files X74 copies to cloud machines.
        m::SESSION_FILES_FETCH => {
            let req: m::SessionFilesFetch = serde_json::from_value(params).map_err(bad)?;
            if !sync.was_offered(&from) || !sync.was_asked(&from, &req.session) {
                return Err(RpcError::new("forbidden", "this host asked no command of that session there"));
            }
            let f = link.files.get().cloned().ok_or_else(|| RpcError::new("gone", "nothing answers"))?;
            f(req).await
        }
        other => Err(RpcError::new("forbidden", format!("{other} does not go between members"))),
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

    #[test]
    fn a_member_whose_clock_is_more_than_a_day_behind_asks_only_for_what_is_new() {
        use moonlet_core::account::Version;
        let own = Version::from([("book.k3x9q2".to_string(), 7), ("mini.a1b2c3".to_string(), 3)]);
        let central = Version::from([("book.k3x9q2".to_string(), 5), ("mini.a1b2c3".to_string(), 40), ("air.f0e1d2".to_string(), 9)]);
        let day = 24 * 60 * 60 * 1000;
        // studio-mini's clock eight days ahead: what it already sent and
        // this Mac refused is not asked for again.
        assert_eq!(
            version_to_send(own.clone(), Some(&central), Some(8 * day)),
            Version::from([("book.k3x9q2".to_string(), 7), ("mini.a1b2c3".to_string(), 40), ("air.f0e1d2".to_string(), 9)])
        );
        // An hour, a clock behind, or no clock from an older central host:
        // everything this Mac lacks.
        for ahead in [Some(3_600_000), Some(-8 * day), None] {
            assert_eq!(version_to_send(own.clone(), Some(&central), ahead), own);
        }
        assert_eq!(version_to_send(own.clone(), None, Some(8 * day)), own);
    }

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
    fn the_link_is_open_while_a_central_host_is_set_and_something_needs_it() {
        let needs = |heavy, copies, member| LinkNeeds { heavy, copies, member };
        assert!(!should_link(false, needs(false, 0, false)));
        assert!(!should_link(false, needs(true, 0, false)), "no central host");
        assert!(!should_link(false, needs(false, 2, false)), "no central host");
        assert!(!should_link(false, needs(false, 0, true)), "no central host");
        assert!(!should_link(true, needs(false, 0, false)), "nothing needs it");
        assert!(should_link(true, needs(true, 0, false)), "heavy commands");
        assert!(should_link(true, needs(false, 1, false)), "a session kept in sync (X60)");
        assert!(should_link(true, needs(false, 0, true)), "a member of an account (X68)");
    }
}
