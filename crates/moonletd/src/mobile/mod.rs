//! Phone access over Tailscale (X39, ADR 0008).
//!
//! While the user allows it, the daemon listens on a TCP port on the Mac's
//! Tailscale addresses only. A phone's first frame is an `auth` with its
//! device token or a pairing code; after that the connection is a normal
//! client connection (`server::handle_connection`), or, with `route`, a pipe
//! to `ssh <host> moonletd proxy` on one of the desktop app's SSH hosts.
//! Settings live in `~/.moonlet/mobile.json`; only token hashes are kept.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use moonlet_core::paths::{hostname, now_ms};
use moonlet_proto::methods::{
    self as m, DeviceKind, MobileDevice, MobileHost, MobilePairing, MobileStatus,
};
use moonlet_proto::{Message, RpcError};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

mod net;

pub use net::spawn;

pub const DEFAULT_PORT: u16 = moonlet_core::tailnet::DEFAULT_PORT;
/// How long a pairing code works.
pub const PAIR_TTL_MS: u64 = 5 * 60 * 1000;
/// Wrong codes before the current one is cancelled.
pub const PAIR_ATTEMPTS: u32 = 5;

pub use moonlet_core::tailnet::{Tailnet, is_tailscale};

/// This machine's interface addresses in Tailscale's range, IPv4 first, or
/// what the test seam `MOONLET_MOBILE_ADDRS` (comma-separated) lists. Only
/// for refusing a link to this machine itself: the listener takes the
/// addresses Tailscale reports ([`Mobile::ask_tailscale`]).
pub fn own_range_addresses() -> Vec<IpAddr> {
    if let Some(list) = seam_addresses() {
        return list;
    }
    let mut out: Vec<IpAddr> = local_addresses()
        .into_iter()
        .filter(|ip| is_tailscale(*ip))
        .collect();
    out.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    out.dedup();
    out
}

/// `MOONLET_MOBILE_ADDRS`: this machine's tailnet addresses for a test,
/// such as `127.0.0.1`. A release build never sees it ([`moonlet_core::seams`]).
fn seam_addresses() -> Option<Vec<IpAddr>> {
    let list = std::env::var("MOONLET_MOBILE_ADDRS").ok()?;
    Some(list.split(',').filter_map(|a| a.trim().parse().ok()).collect())
}

/// Every address of this machine's interfaces.
fn local_addresses() -> Vec<IpAddr> {
    nix::ifaddrs::getifaddrs()
        .map(|addrs| {
            addrs
                .filter_map(|a| a.address)
                .filter_map(|s| {
                    s.as_sockaddr_in()
                        .map(|v4| IpAddr::V4(v4.ip()))
                        .or_else(|| s.as_sockaddr_in6().map(|v6| IpAddr::V6(v6.ip())))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Where Tailscale's command line tool may be, after the daemon's PATH:
/// Homebrew's (`tailscaled` from Homebrew), the standalone app's CLI
/// launcher, the one inside the app (the App Store app has only that one),
/// and Linux packages'.
const TAILSCALE_PLACES: [&str; 5] = [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/sbin/tailscale",
];

/// The `tailscale` to ask: the first on `path`, else the first of
/// [`TAILSCALE_PLACES`] that `exists`.
pub fn find_tailscale(path: Option<&std::ffi::OsStr>, exists: impl Fn(&std::path::Path) -> bool) -> Option<PathBuf> {
    path.into_iter()
        .flat_map(std::env::split_paths)
        .map(|d| d.join("tailscale"))
        .chain(TAILSCALE_PLACES.iter().map(PathBuf::from))
        .find(|p| exists(p))
}

/// The `tailscale` this daemon asks: the test seam `MOONLET_TAILSCALE` (a
/// stub; tests never run the real one), else [`find_tailscale`].
fn tailscale_program() -> Option<PathBuf> {
    if let Some(stub) = std::env::var_os("MOONLET_TAILSCALE") {
        return Some(stub.into());
    }
    find_tailscale(std::env::var_os("PATH").as_deref(), runnable)
}

/// A file this user may run: one without the execute bits hides no later one.
fn runnable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// How long `tailscale status --json` may take.
const ASK_TIMEOUT: Duration = Duration::from_secs(5);
/// A peer the cached answer does not list makes the daemon ask Tailscale
/// again, at most this often, so a device that just joined is let in.
const ASK_AGAIN: Duration = Duration::from_secs(2);

/// `tailscale status --json` from `program`: `Err(())` when it cannot run.
async fn tailscale_status(program: &std::path::Path) -> Result<Vec<u8>, ()> {
    let run = tokio::process::Command::new(program)
        .args(["status", "--json"])
        // The app's executable acts as the CLI only when told to.
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(ASK_TIMEOUT, run).await {
        Ok(Ok(out)) => Ok(out.stdout),
        Ok(Err(_)) => Err(()),
        // It runs but does not answer: Tailscale is not usable.
        Err(_) => Ok(Vec::new()),
    }
}

/// What Tailscale said last (X39).
#[derive(Debug, Default)]
struct Seen {
    /// Whether it was asked since tailnet access was turned on.
    asked: bool,
    /// The tailnet, while Tailscale runs.
    tailnet: Option<Tailnet>,
    /// The addresses to listen on.
    listen: Vec<IpAddr>,
    /// No `tailscale` command could be run.
    missing: bool,
    at: Option<std::time::Instant>,
}

pub use moonlet_core::hash::sha256_hex;
use moonlet_core::hash::hex;

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("read /dev/urandom");
    buf
}

fn random_hex(n: usize) -> String {
    hex(&random_bytes(n))
}

/// Crockford's base32: no I, L, O or U, so a code read aloud or copied by
/// hand has nothing to confuse.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A pairing code (X57): 10 characters of [`CODE_ALPHABET`], 50 random bits.
pub fn new_code() -> String {
    random_bytes(10)
        .into_iter()
        // 256 is a multiple of 32, so every character is equally likely.
        .map(|b| CODE_ALPHABET[(b & 31) as usize] as char)
        .collect()
}

/// A code as the user typed it: uppercase, without spaces or dashes, with
/// `O` read as `0` and `I` and `L` as `1`.
pub fn normalize_code(typed: &str) -> String {
    typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

/// A device name as the phone sent it: control characters removed, at most
/// 60 characters, "Phone" when nothing is left.
pub fn clean_name(name: Option<&str>) -> String {
    let s: String = name
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    let s = s.trim();
    if s.is_empty() {
        "Phone".into()
    } else {
        s.into()
    }
}

/// The Mac's name as phones show it.
pub fn host_label() -> String {
    let h = hostname();
    h.strip_suffix(".local").unwrap_or(&h).to_string()
}

/// `moonlet://pair?v=1&host=…&addr=…[&addr=…]&code=…`, what the QR code holds.
pub fn pair_url(host: &str, addrs: &[String], code: &str) -> String {
    let mut url = format!("moonlet://pair?v=1&host={}", percent(host));
    for a in addrs {
        url.push_str("&addr=");
        url.push_str(&percent(a));
    }
    url.push_str("&code=");
    url.push_str(code);
    url
}

fn percent(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `ip:port`, with brackets around an IPv6 address.
fn addr_text(a: SocketAddr) -> String {
    a.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct StoredDevice {
    id: String,
    name: String,
    token_sha256: String,
    created_at: u64,
    #[serde(default)]
    last_seen: Option<u64>,
    #[serde(default)]
    kind: DeviceKind,
    /// The cloud machine a `cloud` device is (X63).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    machine: Option<String>,
    /// A member's link to this central host: a `desktop` device whose
    /// token reaches only a member's work, never the app's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    worker_link: bool,
    /// The paired Mac whose connection asked for this worker link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    minted_by: Option<String>,
    /// Until this worker link is first used: that use removes `minted_by`,
    /// whose token was the link's alone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    replaces: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct MobileFile {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    devices: Vec<StoredDevice>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for MobileFile {
    fn default() -> Self {
        MobileFile {
            enabled: false,
            port: DEFAULT_PORT,
            devices: Vec::new(),
        }
    }
}

/// The one pairing code that works right now.
#[derive(Debug, Clone)]
pub struct Pairing {
    code: String,
    expires_at: u64,
    attempts: u32,
    /// What the code pairs: a phone (Settings › Phones) or a Mac (Settings ›
    /// Machines › Hosts, `moonletd pair`).
    kind: DeviceKind,
}

/// What a pairing code attempt did to the current code.
#[derive(Debug, PartialEq)]
pub enum PairCheck {
    Paired,
    Wrong,
    /// Wrong, and the code is now cancelled: [`PAIR_ATTEMPTS`] wrong tries.
    Exhausted,
    Expired,
}

impl Pairing {
    pub fn new(code: String, now: u64) -> Pairing {
        Pairing {
            code,
            expires_at: now + PAIR_TTL_MS,
            attempts: 0,
            kind: DeviceKind::Phone,
        }
    }

    pub fn check(&mut self, code: &str, now: u64) -> PairCheck {
        if now >= self.expires_at {
            return PairCheck::Expired;
        }
        if normalize_code(code) == self.code {
            return PairCheck::Paired;
        }
        self.attempts += 1;
        if self.attempts >= PAIR_ATTEMPTS {
            PairCheck::Exhausted
        } else {
            PairCheck::Wrong
        }
    }
}

/// Checks `code` against the current pairing; a code that pairs is used up
/// in the same step, so two phones can never both claim it. Returns the
/// check and the code it was checked against; None without a pairing.
pub fn claim(slot: &mut Option<Pairing>, code: &str, now: u64) -> Option<(PairCheck, String)> {
    let p = slot.as_mut()?;
    let check = p.check(code, now);
    let current = p.code.clone();
    if check == PairCheck::Paired {
        slot.take();
    }
    Some((check, current))
}

/// How long a cloud machine's join code works (X63).
pub const JOIN_TTL_MS: u64 = 30 * 60_000;

/// One-use codes the central host makes for the cloud machines it creates
/// (X63), each bound to its machine: its id and the name it joins with.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JoinCodes {
    codes: Vec<JoinCode>,
}

/// Kept on disk, so a machine still joins after the central host restarts;
/// only the code's hash is kept.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JoinCode {
    code_sha256: String,
    machine: String,
    name: String,
    expires_at: u64,
}

impl JoinCodes {
    /// A new code for machine `machine`, which joins as `name`.
    pub fn mint(&mut self, machine: &str, name: &str, now: u64) -> String {
        self.codes.retain(|c| c.expires_at > now);
        let code = new_code();
        self.codes.push(JoinCode {
            code_sha256: sha256_hex(code.as_bytes()),
            machine: machine.to_string(),
            name: name.to_string(),
            expires_at: now + JOIN_TTL_MS,
        });
        code
    }

    /// The machine a code joins `name` as, using the code up; None for a
    /// code that is unknown, expired, used or for another machine.
    pub fn redeem(&mut self, code: &str, name: &str, now: u64) -> Option<String> {
        let hash = sha256_hex(normalize_code(code).as_bytes());
        let i = self.codes.iter().position(|c| c.code_sha256 == hash)?;
        let c = &self.codes[i];
        if c.expires_at <= now || c.name != name {
            return None;
        }
        Some(self.codes.remove(i).machine)
    }

    /// Whether `code` is a join code waiting to be used.
    pub fn knows(&self, code: &str) -> bool {
        let hash = sha256_hex(normalize_code(code).as_bytes());
        self.codes.iter().any(|c| c.code_sha256 == hash)
    }

    /// Machine `machine` failed or was removed: its code no longer pairs.
    pub fn forget(&mut self, machine: &str) {
        self.codes.retain(|c| c.machine != machine);
    }
}

/// An authenticated phone connection.
pub struct Authed {
    pub device_id: String,
    /// Set when this connection just paired.
    pub token: Option<String>,
    pub route: Option<String>,
    /// A cloud machine's device (X63), as it was when it authenticated: its
    /// connection stays limited even once removal forgets the device.
    pub cloud: bool,
    /// A member's worker link, as it was when it authenticated: its
    /// connection reaches only a member's work, whatever client it says.
    pub worker_link: bool,
    /// A phone's device, as it was when it authenticated: its connection
    /// reaches only a phone's methods (X40).
    pub phone: bool,
}

struct LiveConn {
    device_id: String,
    close: watch::Sender<bool>,
}

#[derive(Default)]
struct Listening {
    /// The addresses and configured port the listeners were bound for.
    bound_for: Option<(Vec<IpAddr>, u16)>,
    addrs: Vec<SocketAddr>,
    tasks: Vec<JoinHandle<()>>,
}

impl Listening {
    fn stop(&mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        self.addrs.clear();
        self.bound_for = None;
    }
}

pub struct Mobile {
    file: PathBuf,
    data: Mutex<MobileFile>,
    pairing: Mutex<Option<Pairing>>,
    conns: Mutex<HashMap<u64, LiveConn>>,
    next_conn: AtomicU64,
    listening: Mutex<Listening>,
    /// Wakes the listener loop after a settings change.
    kick: Notify,
    emit: Box<dyn Fn(Message) + Send + Sync>,
    /// Codes the central host made for its cloud machines (X63).
    joins: Mutex<JoinCodes>,
    /// Told `(machine, device)` when a cloud machine joins.
    on_join: Mutex<Option<Box<dyn Fn(&str, &str) + Send + Sync>>>,
    /// What Tailscale said last; `asking` lets one ask run at a time.
    seen: Mutex<Seen>,
    asking: tokio::sync::Mutex<()>,
    /// Connections waiting for their `auth`, at most [`UNAUTHED_MAX`].
    pub(crate) unauthed: Arc<tokio::sync::Semaphore>,
}

/// How many connections may wait for their `auth` at once.
pub const UNAUTHED_MAX: usize = 32;

impl Mobile {
    pub fn load(file: PathBuf, emit: impl Fn(Message) + Send + Sync + 'static) -> Mobile {
        let data = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let joins = std::fs::read(file.with_file_name("join-codes.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Mobile {
            file,
            data: Mutex::new(data),
            pairing: Mutex::new(None),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            listening: Mutex::new(Listening::default()),
            kick: Notify::new(),
            emit: Box::new(emit),
            joins: Mutex::new(joins),
            on_join: Mutex::new(None),
            seen: Mutex::new(Seen::default()),
            asking: tokio::sync::Mutex::new(()),
            unauthed: Arc::new(tokio::sync::Semaphore::new(UNAUTHED_MAX)),
        }
    }

    /// Asks Tailscale for this machine's addresses and its peers. With the
    /// test seam `MOONLET_MOBILE_ADDRS`, those are this machine's addresses,
    /// and the stub `MOONLET_TAILSCALE`, when set, lists the peers. Without
    /// a `tailscale` to run, or while Tailscale is not running, there is no
    /// tailnet: nothing listens and no connection is let in. Returns whether
    /// the answer changed.
    pub async fn ask_tailscale(&self) -> bool {
        let _one = self.asking.lock().await;
        self.ask_locked().await
    }

    async fn ask_locked(&self) -> bool {
        let seam = seam_addresses();
        let program = tailscale_program();
        let status = match (&seam, &program) {
            (Some(_), _) if std::env::var_os("MOONLET_TAILSCALE").is_none() => Ok(Vec::new()),
            (_, Some(p)) => tailscale_status(p).await,
            (_, None) => Err(()),
        };
        let (tailnet, listen, missing) = match seam {
            Some(own) => {
                let peers = status.ok().and_then(|s| Tailnet::from_status(&s)).unwrap_or_default();
                let t = peers.with_own(own.clone());
                (Some(t), own, false)
            }
            None => match status {
                Err(()) => (None, Vec::new(), true),
                Ok(s) => match Tailnet::from_status(&s) {
                    Some(t) => {
                        let listen = t.listen_on(&local_addresses());
                        (Some(t), listen, false)
                    }
                    None => (None, Vec::new(), false),
                },
            },
        };
        let mut seen = self.seen.lock().unwrap();
        let changed = !seen.asked || seen.tailnet != tailnet || seen.listen != listen || seen.missing != missing;
        *seen = Seen {
            asked: true,
            tailnet,
            listen,
            missing,
            at: Some(std::time::Instant::now()),
        };
        changed
    }

    /// The addresses to listen on, as Tailscale said last.
    pub fn listen_addresses(&self) -> Vec<IpAddr> {
        self.seen.lock().unwrap().listen.clone()
    }

    /// Whether a connection from `peer` comes from a device of this tailnet.
    /// A peer the last answer does not list makes the daemon ask again, at
    /// most every [`ASK_AGAIN`]. While another ask runs, such a peer is
    /// refused at once instead of waiting for it, so a burst of unknown
    /// peers never holds the places of connections waiting for their
    /// `auth`; a device that just joined connects on its next try. Before
    /// the first answer, as right after a restart, every peer waits for it.
    pub async fn lets_in(&self, peer: IpAddr) -> bool {
        let known = |seen: &Seen| seen.tailnet.as_ref().is_some_and(|t| t.lets_in(peer));
        let asked = {
            let seen = self.seen.lock().unwrap();
            if known(&seen) {
                return true;
            }
            seen.asked
        };
        let _one = match self.asking.try_lock() {
            Ok(one) => one,
            Err(_) if asked => return false,
            Err(_) => self.asking.lock().await,
        };
        {
            let seen = self.seen.lock().unwrap();
            if known(&seen) {
                return true;
            }
            if seen.at.is_some_and(|at| at.elapsed() < ASK_AGAIN) {
                return false;
            }
        }
        if self.ask_locked().await {
            // The listener binds what Tailscale now reports.
            self.kick.notify_one();
            self.changed();
        }
        known(&self.seen.lock().unwrap())
    }

    fn save_joins(&self, joins: &JoinCodes) {
        let file = self.file.with_file_name("join-codes.json");
        if let Err(e) = write_private(&file, &serde_json::to_vec_pretty(joins).unwrap()) {
            tracing::warn!("cannot write {}: {e:#}", file.display());
        }
    }

    /// Machine `machine` failed or was removed: its join code goes.
    pub fn forget_join(&self, machine: &str) {
        let mut joins = self.joins.lock().unwrap();
        joins.forget(machine);
        self.save_joins(&joins);
    }

    /// A one-use code that pairs cloud machine `machine`, named `name`.
    /// Only the central host makes them, for machines it creates.
    pub fn join_code(&self, machine: &str, name: &str) -> String {
        let mut joins = self.joins.lock().unwrap();
        let code = joins.mint(machine, name, now_ms());
        self.save_joins(&joins);
        code
    }

    /// Calls `f(machine, device)` when a cloud machine joins.
    pub fn on_join(&self, f: impl Fn(&str, &str) + Send + Sync + 'static) {
        *self.on_join.lock().unwrap() = Some(Box::new(f));
    }

    /// The cloud machine device `id` is, when it is one.
    pub fn cloud_machine(&self, id: &str) -> Option<String> {
        self.data
            .lock()
            .unwrap()
            .devices
            .iter()
            .find(|d| d.id == id && d.kind == DeviceKind::Cloud)
            .and_then(|d| d.machine.clone())
    }

    /// This host's tailnet addresses it listens on, `ip:port`.
    pub fn listening(&self) -> Vec<String> {
        self.listening.lock().unwrap().addrs.iter().map(|a| addr_text(*a)).collect()
    }

    pub fn default_file() -> PathBuf {
        moonlet_core::paths::home().join("mobile.json")
    }

    fn save(&self, data: &MobileFile) {
        if let Err(e) = write_private(&self.file, &serde_json::to_vec_pretty(data).unwrap()) {
            tracing::warn!("cannot write {}: {e:#}", self.file.display());
        }
    }

    fn changed(&self) {
        (self.emit)(Message::event(m::EV_MOBILE_CHANGED, self.status()));
    }

    pub fn status(&self) -> MobileStatus {
        let data = self.data.lock().unwrap().clone();
        let connected: Vec<String> = self
            .conns
            .lock()
            .unwrap()
            .values()
            .map(|c| c.device_id.clone())
            .collect();
        let (asked, missing, addresses) = {
            let seen = self.seen.lock().unwrap();
            let addresses: Vec<String> = seen.listen.iter().map(IpAddr::to_string).collect();
            (seen.asked, seen.missing, addresses)
        };
        MobileStatus {
            enabled: data.enabled,
            port: data.port,
            // Until Tailscale is asked, the listener is "Starting…".
            tailscale: !addresses.is_empty() || (data.enabled && !asked),
            tailscale_missing: data.enabled && missing,
            addresses,
            listening: self
                .listening
                .lock()
                .unwrap()
                .addrs
                .iter()
                .map(|a| addr_text(*a))
                .collect(),
            host: host_label(),
            // A cloud machine's device shows under its machine (X63).
            devices: data
                .devices
                .iter()
                .filter(|d| d.kind != DeviceKind::Cloud)
                .map(|d| MobileDevice {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    kind: d.kind,
                    created_at: d.created_at,
                    last_seen: d.last_seen,
                    connected: connected.contains(&d.id),
                })
                .collect(),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        {
            let mut data = self.data.lock().unwrap();
            if enabled && !data.enabled {
                // What Tailscale said before is old news.
                *self.seen.lock().unwrap() = Seen::default();
            }
            data.enabled = enabled;
            self.save(&data);
        }
        if !enabled {
            // A code on screen stops working: say so, as Cancel would.
            self.pair_cancel();
            self.listening.lock().unwrap().stop();
            for c in self.conns.lock().unwrap().values() {
                let _ = c.close.send(true);
            }
        }
        self.kick.notify_one();
        self.changed();
    }

    pub fn pair_start(self: &Arc<Self>, kind: DeviceKind) -> Result<MobilePairing, RpcError> {
        if kind == DeviceKind::Cloud {
            return Err(RpcError::new(
                "invalid_params",
                "a cloud machine pairs only with its join code",
            ));
        }
        if !self.data.lock().unwrap().enabled {
            return Err(RpcError::new("mobile_off", "phone access is off"));
        }
        let addresses: Vec<String> = self
            .listening
            .lock()
            .unwrap()
            .addrs
            .iter()
            .map(|a| addr_text(*a))
            .collect();
        if addresses.is_empty() {
            return Err(RpcError::new(
                "no_tailscale",
                "Tailscale is not running on this Mac",
            ));
        }
        let code = new_code();
        let now = now_ms();
        let pairing = Pairing {
            kind,
            ..Pairing::new(code.clone(), now)
        };
        let expires_at = pairing.expires_at;
        *self.pairing.lock().unwrap() = Some(pairing);
        // Say so when the code runs out unused.
        let me = Arc::downgrade(self);
        let mine = code.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(PAIR_TTL_MS)).await;
            if let Some(me) = me.upgrade() {
                me.end_pairing_if(&mine, "expired");
            }
        });
        let host = host_label();
        Ok(MobilePairing {
            url: pair_url(&host, &addresses, &code),
            code,
            expires_at,
            addresses,
            host,
        })
    }

    pub fn pair_cancel(&self) {
        let current = self
            .pairing
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.code.clone());
        if let Some(code) = current {
            self.end_pairing_if(&code, "cancelled");
        }
    }

    /// Ends pairing with `code` if it is still the current one.
    fn end_pairing_if(&self, code: &str, reason: &str) {
        let ended = {
            let mut p = self.pairing.lock().unwrap();
            if p.as_ref().is_some_and(|p| p.code == code) {
                p.take();
                true
            } else {
                false
            }
        };
        if ended {
            (self.emit)(Message::event(
                m::EV_MOBILE_PAIR_ENDED,
                serde_json::json!({ "reason": reason }),
            ));
        }
    }

    /// Removes device `id`, and the worker links it asked for: removing a
    /// Mac cuts its member's link too. Returns every device removed.
    pub fn revoke(&self, id: &str) -> Result<Vec<String>, RpcError> {
        let gone = self.forget(id)?;
        for d in &gone {
            self.close_device(d);
        }
        self.changed();
        Ok(gone)
    }

    /// A cloud machine being removed (X63): its token stops working at once,
    /// and its open connection stays for `worker.retire`; `close_device` ends it.
    pub fn forget_device(&self, id: &str) -> Result<(), RpcError> {
        self.forget(id)?;
        self.changed();
        Ok(())
    }

    /// A paired device removes itself (X57). Its token stops working at once;
    /// its connections close a moment later, once the reply has gone out.
    /// The worker links it asked for go with it, at once. Returns every
    /// device removed.
    pub fn unpair(self: &Arc<Self>, id: &str) -> Result<Vec<String>, RpcError> {
        let gone = self.forget(id)?;
        self.changed();
        for d in gone.iter().filter(|d| *d != id) {
            self.close_device(d);
        }
        let me = Arc::downgrade(self);
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Some(me) = me.upgrade() {
                me.close_device(&id);
            }
        });
        Ok(gone)
    }

    /// A token that only links a member, for paired Mac `device`, whose
    /// daemon asked over its link with its own token. It is listed under
    /// the Mac's name, in place of `device` with `replace`: the first time
    /// it is used, `device` is removed, so its token stops working. The
    /// worker links `device` asked for before, used or not, go now: the
    /// member keeps only the newest.
    pub fn worker_credential(&self, device: &str, replace: bool) -> Result<String, RpcError> {
        let token = random_hex(32);
        let gone: Vec<String> = {
            let mut data = self.data.lock().unwrap();
            let mut next = data.clone();
            let asker = next
                .devices
                .iter()
                .find(|d| d.id == device && d.kind == DeviceKind::Desktop && !d.worker_link)
                .ok_or_else(|| RpcError::new("forbidden", "only a paired Mac's daemon asks for a worker link"))?;
            let name = asker.name.clone();
            let gone: Vec<String> = next
                .devices
                .iter()
                .filter(|d| d.minted_by.as_deref() == Some(device))
                .map(|d| d.id.clone())
                .collect();
            next.devices.retain(|d| !gone.contains(&d.id));
            next.devices.push(StoredDevice {
                id: random_hex(8),
                name,
                token_sha256: sha256_hex(token.as_bytes()),
                created_at: now_ms(),
                last_seen: None,
                kind: DeviceKind::Desktop,
                machine: None,
                worker_link: true,
                minted_by: Some(device.to_string()),
                replaces: replace,
            });
            // Given only once kept: a token the central host would not know
            // after a restart would strand the member.
            write_private(&self.file, &serde_json::to_vec_pretty(&next).unwrap())
                .map_err(|e| RpcError::new("internal", format!("cannot write {}: {e:#}", self.file.display())))?;
            *data = next;
            gone
        };
        for id in gone {
            self.close_device(&id);
        }
        self.changed();
        Ok(token)
    }

    /// Whether device `id` is still paired. A device that removed itself
    /// keeps its connection a moment longer, for the reply.
    /// What kind of device `id` is, while it is paired.
    pub fn kind_of(&self, id: &str) -> Option<DeviceKind> {
        self.data.lock().unwrap().devices.iter().find(|d| d.id == id).map(|d| d.kind)
    }

    /// The paired Mac whose daemon asked for worker link `id`, if it is one.
    pub fn minted_by(&self, id: &str) -> Option<String> {
        self.data
            .lock()
            .unwrap()
            .devices
            .iter()
            .find(|d| d.id == id && d.worker_link)
            .and_then(|d| d.minted_by.clone())
    }

    /// Whether device `id`, or a worker link it asked for, is paired: the
    /// worker ids `id` registered stay that Mac's while its link moves.
    pub fn holds_ids_of(&self, id: &str) -> bool {
        self.data
            .lock()
            .unwrap()
            .devices
            .iter()
            .any(|d| d.id == id || d.minted_by.as_deref() == Some(id))
    }

    /// Removes device `id` and the worker links it asked for; returns
    /// their ids, `id` first.
    fn forget(&self, id: &str) -> Result<Vec<String>, RpcError> {
        let mut data = self.data.lock().unwrap();
        if !data.devices.iter().any(|d| d.id == id) {
            return Err(RpcError::new("not_found", format!("no paired device {id}")));
        }
        let mut gone = vec![id.to_string()];
        gone.extend(
            data.devices
                .iter()
                .filter(|d| d.minted_by.as_deref() == Some(id))
                .map(|d| d.id.clone()),
        );
        data.devices.retain(|d| !gone.contains(&d.id));
        self.save(&data);
        Ok(gone)
    }

    pub fn close_device(&self, id: &str) {
        for c in self.conns.lock().unwrap().values() {
            if c.device_id == id {
                let _ = c.close.send(true);
            }
        }
    }

    pub fn hosts(&self) -> Vec<MobileHost> {
        moonlet_core::ssh::saved_hosts()
            .remotes
            .into_iter()
            .map(|id| MobileHost {
                label: id.clone(),
                id,
            })
            .collect()
    }

    /// Checks an `auth` frame. Errors are logged here; the caller only
    /// learns that it failed.
    pub fn authenticate(
        &self,
        token: Option<&str>,
        pair: Option<&str>,
        device: Option<&str>,
        kind: Option<DeviceKind>,
        route: Option<&str>,
    ) -> Option<Authed> {
        let route = route.map(str::to_string);
        if let Some(r) = &route
            && !moonlet_core::ssh::saved_hosts().remotes.contains(r)
        {
            tracing::info!("phone asked for an unknown route {r:?}");
            return None;
        }
        match (token, pair) {
            (Some(token), None) => {
                let hash = sha256_hex(token.as_bytes());
                let mut data = self.data.lock().unwrap();
                if !data.enabled {
                    return None;
                }
                let d = data.devices.iter_mut().find(|d| d.token_sha256 == hash)?;
                // A cloud machine (X63) and a member's worker link reach only
                // this daemon's worker methods: a route would take them to a
                // remote host's daemon, which takes them for the app.
                if route.is_some() && (d.kind == DeviceKind::Cloud || d.worker_link) {
                    tracing::info!("a cloud machine or a worker link asked for a route");
                    return None;
                }
                d.last_seen = Some(now_ms());
                let device_id = d.id.clone();
                let cloud = d.kind == DeviceKind::Cloud;
                let worker_link = d.worker_link;
                let phone = d.kind == DeviceKind::Phone;
                // The first use of a worker link that replaces its Mac's
                // token: the member saved it, so the old token goes.
                let replaced = if d.replaces {
                    d.replaces = false;
                    d.minted_by.clone()
                } else {
                    None
                };
                if let Some(old) = &replaced {
                    data.devices.retain(|d| &d.id != old);
                }
                self.save(&data);
                drop(data);
                if let Some(old) = replaced {
                    self.close_device(&old);
                    self.changed();
                }
                Some(Authed {
                    device_id,
                    token: None,
                    route,
                    cloud,
                    worker_link,
                    phone,
                })
            }
            (None, Some(code)) if route.is_none() && self.joins.lock().unwrap().knows(code) => {
                let name = device.unwrap_or_default();
                let machine = {
                    let mut joins = self.joins.lock().unwrap();
                    let machine = joins.redeem(code, name, now_ms());
                    self.save_joins(&joins);
                    machine?
                };
                let token = random_hex(32);
                let now = now_ms();
                let dev = StoredDevice {
                    id: random_hex(8),
                    name: name.to_string(),
                    token_sha256: sha256_hex(token.as_bytes()),
                    created_at: now,
                    last_seen: Some(now),
                    kind: DeviceKind::Cloud,
                    machine: Some(machine.clone()),
                    worker_link: false,
                    minted_by: None,
                    replaces: false,
                };
                let device_id = dev.id.clone();
                {
                    let mut data = self.data.lock().unwrap();
                    data.devices.push(dev);
                    self.save(&data);
                }
                if let Some(f) = self.on_join.lock().unwrap().as_ref() {
                    f(&machine, &device_id);
                }
                Some(Authed {
                    device_id,
                    token: Some(token),
                    route: None,
                    cloud: true,
                    worker_link: false,
                    phone: false,
                })
            }
            (None, Some(code)) if route.is_none() => {
                let (check, kind) = {
                    let mut slot = self.pairing.lock().unwrap();
                    // A device pairs as what its code was made for, never as
                    // what it says it is: a phone saying "desktop" would get
                    // a Mac's rights.
                    let made_for = slot.as_ref()?.kind;
                    if kind.unwrap_or_default() != made_for {
                        tracing::info!("a device tried a code for a {made_for:?} as {kind:?}");
                        return None;
                    }
                    (claim(&mut slot, code, now_ms())?, made_for)
                };
                match check {
                    (PairCheck::Paired, _) => {
                        let token = random_hex(32);
                        let now = now_ms();
                        let dev = StoredDevice {
                            id: random_hex(8),
                            name: clean_name(device),
                            token_sha256: sha256_hex(token.as_bytes()),
                            created_at: now,
                            last_seen: Some(now),
                            kind,
                            machine: None,
                            worker_link: false,
                            minted_by: None,
                            replaces: false,
                        };
                        let device_id = dev.id.clone();
                        {
                            let mut data = self.data.lock().unwrap();
                            data.devices.push(dev.clone());
                            self.save(&data);
                        }
                        (self.emit)(Message::event(
                            m::EV_MOBILE_PAIRED,
                            serde_json::json!({ "device": { "id": dev.id, "name": dev.name } }),
                        ));
                        Some(Authed {
                            device_id,
                            token: Some(token),
                            route: None,
                            cloud: kind == DeviceKind::Cloud,
                            worker_link: false,
                            phone: kind == DeviceKind::Phone,
                        })
                    }
                    (PairCheck::Exhausted, current) => {
                        self.end_pairing_if(&current, "too_many_attempts");
                        None
                    }
                    (PairCheck::Expired, current) => {
                        self.end_pairing_if(&current, "expired");
                        None
                    }
                    (PairCheck::Wrong, _) => None,
                }
            }
            _ => None,
        }
    }

    /// Records a live connection; None when the device was removed or phone
    /// access turned off since it authenticated. Registering first and
    /// checking after means a concurrent `revoke` or `set_enabled(false)`
    /// either sees this connection and closes it, or is seen here.
    fn register(&self, device_id: &str) -> Option<(u64, watch::Receiver<bool>)> {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (close, rx) = watch::channel(false);
        self.conns.lock().unwrap().insert(
            id,
            LiveConn {
                device_id: device_id.into(),
                close,
            },
        );
        let still_allowed = {
            let data = self.data.lock().unwrap();
            data.enabled && data.devices.iter().any(|d| d.id == device_id)
        };
        if !still_allowed {
            self.conns.lock().unwrap().remove(&id);
            return None;
        }
        self.changed();
        Some((id, rx))
    }

    fn unregister(&self, conn: u64) {
        let gone = self.conns.lock().unwrap().remove(&conn);
        if let Some(c) = gone {
            let mut data = self.data.lock().unwrap();
            if let Some(d) = data.devices.iter_mut().find(|d| d.id == c.device_id) {
                d.last_seen = Some(now_ms());
                self.save(&data);
            }
        }
        self.changed();
    }
}

/// Writes `bytes` to `path` with mode 0600, through a temporary file.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        moonlet_core::paths::ensure_private_dir(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("open {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_is_asked_on_the_path_first_then_where_its_installs_put_it() {
        use std::path::Path;
        let on = |list: &'static [&'static str]| move |p: &Path| list.iter().any(|l| Path::new(l) == p);
        let path = std::ffi::OsString::from("/home/alex/bin:/usr/local/bin");
        // The standalone app's CLI launcher, or tailscaled from a package.
        assert_eq!(
            find_tailscale(Some(&path), on(&["/usr/local/bin/tailscale", "/usr/bin/tailscale"])),
            Some(PathBuf::from("/usr/local/bin/tailscale"))
        );
        // The App Store app has only the executable inside the app, and a
        // daemon started at login may have a short PATH.
        assert_eq!(
            find_tailscale(Some(std::ffi::OsStr::new("/usr/bin:/bin")), on(&["/Applications/Tailscale.app/Contents/MacOS/Tailscale"])),
            Some(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
        );
        // Homebrew's tailscaled, off the daemon's PATH.
        assert_eq!(
            find_tailscale(None, on(&["/opt/homebrew/bin/tailscale"])),
            Some(PathBuf::from("/opt/homebrew/bin/tailscale"))
        );
        assert_eq!(find_tailscale(Some(&path), on(&[])), None);
    }

    #[test]
    fn a_join_code_works_once() {
        let mut j = JoinCodes::default();
        let code = j.mint("m7k2q", "moonlet-shop-7k2q", 1_000);
        assert_eq!(code.len(), 10);
        assert_eq!(j.redeem(&code, "moonlet-shop-7k2q", 2_000).as_deref(), Some("m7k2q"));
        assert_eq!(j.redeem(&code, "moonlet-shop-7k2q", 3_000), None);
    }

    #[test]
    fn an_expired_join_code_is_refused() {
        let mut j = JoinCodes::default();
        let code = j.mint("m7k2q", "moonlet-shop-7k2q", 1_000);
        assert_eq!(j.redeem(&code, "moonlet-shop-7k2q", 1_000 + 30 * 60_000), None);
    }

    #[test]
    fn a_join_code_for_another_machine_is_refused() {
        let mut j = JoinCodes::default();
        let code = j.mint("m7k2q", "moonlet-shop-7k2q", 1_000);
        assert_eq!(j.redeem(&code, "moonlet-shop-m3x9", 2_000), None);
        // Typed as a pairing code: the same code, read the same way.
        assert_eq!(
            j.redeem(&code.to_lowercase(), "moonlet-shop-7k2q", 2_000).as_deref(),
            Some("m7k2q")
        );
    }

    #[test]
    fn the_pairing_link_carries_the_host_every_address_and_the_code() {
        assert_eq!(
            pair_url(
                "Alex's MacBook Pro",
                &[
                    "100.101.102.103:47428".into(),
                    "[fd7a:115c:a1e0::1]:47428".into()
                ],
                "00ff"
            ),
            "moonlet://pair?v=1&host=Alex%27s%20MacBook%20Pro&addr=100.101.102.103%3A47428&addr=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A47428&code=00ff"
        );
    }

    #[test]
    fn a_token_is_kept_as_its_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn device_names_are_cleaned() {
        assert_eq!(clean_name(Some("Alex's iPhone")), "Alex's iPhone");
        assert_eq!(clean_name(Some("evil\x1b[31m\nname")), "evil[31mname");
        assert_eq!(clean_name(Some("  ")), "Phone");
        assert_eq!(clean_name(None), "Phone");
        assert_eq!(clean_name(Some(&"x".repeat(80))).len(), 60);
    }

    #[test]
    fn a_pairing_code_is_ten_crockford_characters() {
        for _ in 0..50 {
            let c = new_code();
            assert_eq!(c.len(), 10, "{c}");
            assert!(
                c.chars()
                    .all(|ch| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(ch)),
                "{c}"
            );
        }
    }

    #[test]
    fn typed_codes_are_read_the_way_people_type_them() {
        for typed in ["7kq2m x9pda", "7KQ2M-X9PDA", "7KQ2MX9PDA"] {
            assert_eq!(normalize_code(typed), "7KQ2MX9PDA", "{typed:?}");
        }
        assert_eq!(normalize_code("OIL"), "011");
        let mut p = Pairing::new("7KQ2MX9PDA".into(), 0);
        assert_eq!(p.check("7kq2m-x9pda", 1), PairCheck::Paired);
    }

    #[test]
    fn a_code_works_once_within_five_minutes() {
        let mut p = Pairing::new("7KQ2MX9PDA".into(), 1_000);
        assert_eq!(
            p.check("7KQ2MX9PDA", 1_000 + PAIR_TTL_MS),
            PairCheck::Expired
        );
        assert_eq!(
            p.check("7KQ2MX9PDA", 1_000 + PAIR_TTL_MS - 1),
            PairCheck::Paired
        );
    }

    /// A Mobile whose file holds one phone with token "tok".
    fn with_phone(enabled: bool) -> (tempfile::TempDir, Mobile) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mobile.json");
        let json = serde_json::json!({
            "enabled": enabled,
            "devices": [{ "id": "d1", "name": "iPhone", "token_sha256": sha256_hex(b"tok"), "created_at": 1 }],
        });
        std::fs::write(&file, json.to_string()).unwrap();
        (dir, Mobile::load(file, |_| {}))
    }

    /// A Mobile whose file holds a paired Mac with token "tok" and a phone
    /// with token "phone".
    fn with_mac() -> (tempfile::TempDir, Mobile) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mobile.json");
        let json = serde_json::json!({
            "enabled": true,
            "devices": [
                { "id": "d1", "name": "Alex's MacBook Pro", "token_sha256": sha256_hex(b"tok"), "created_at": 1, "kind": "desktop" },
                { "id": "p1", "name": "iPhone", "token_sha256": sha256_hex(b"phone"), "created_at": 1 },
            ],
        });
        std::fs::write(&file, json.to_string()).unwrap();
        (dir, Mobile::load(file, |_| {}))
    }

    fn by_token(mobile: &Mobile, token: &str) -> Option<Authed> {
        mobile.authenticate(Some(token), None, None, None, None)
    }

    fn names(mobile: &Mobile) -> Vec<String> {
        mobile.status().devices.into_iter().map(|d| d.name).collect()
    }

    #[test]
    fn a_worker_link_replaces_the_macs_token_the_first_time_it_is_used() {
        let (_dir, mobile) = with_mac();
        let link = mobile.worker_credential("d1", true).unwrap();
        // The member may not have saved the new token yet: the old one works
        // until the new one is used.
        let old = by_token(&mobile, "tok").expect("the old token before the new one is used");
        assert!(!old.worker_link);
        let authed = by_token(&mobile, &link).expect("the worker link");
        assert!(authed.worker_link);
        assert!(!authed.cloud);
        assert!(by_token(&mobile, "tok").is_none(), "the old token still works");
        assert_eq!(names(&mobile), ["iPhone", "Alex's MacBook Pro"]);
        assert_eq!(mobile.kind_of(&authed.device_id), Some(DeviceKind::Desktop));
        // It stays a worker link.
        assert!(by_token(&mobile, &link).unwrap().worker_link);
    }

    #[test]
    fn a_worker_link_beside_the_apps_token_leaves_that_token_working() {
        let (_dir, mobile) = with_mac();
        let link = mobile.worker_credential("d1", false).unwrap();
        assert!(by_token(&mobile, &link).unwrap().worker_link);
        let app = by_token(&mobile, "tok").expect("the app's token");
        assert!(!app.worker_link);
    }

    #[test]
    fn only_a_paired_macs_own_token_gets_a_worker_link() {
        let (_dir, mobile) = with_mac();
        assert_eq!(mobile.worker_credential("p1", true).unwrap_err().code, "forbidden");
        assert_eq!(mobile.worker_credential("nope", true).unwrap_err().code, "forbidden");
        let link = mobile.worker_credential("d1", false).unwrap();
        let id = by_token(&mobile, &link).unwrap().device_id;
        assert_eq!(mobile.worker_credential(&id, false).unwrap_err().code, "forbidden");
    }

    #[test]
    fn a_worker_link_that_cannot_be_saved_is_never_given() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mobile) = with_mac();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let asked = mobile.worker_credential("d1", true);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(asked.unwrap_err().code, "internal");
        assert_eq!(names(&mobile), ["Alex's MacBook Pro", "iPhone"]);
        assert!(!by_token(&mobile, "tok").unwrap().worker_link);
    }

    #[test]
    fn removing_a_mac_removes_the_worker_link_it_asked_for() {
        let (_dir, mobile) = with_mac();
        let link = mobile.worker_credential("d1", false).unwrap();
        mobile.revoke("d1").unwrap();
        assert!(by_token(&mobile, &link).is_none(), "the Mac's link still works");
        assert_eq!(names(&mobile), ["iPhone"]);
    }

    #[test]
    fn asking_again_drops_the_worker_link_asked_for_before() {
        let (_dir, mobile) = with_mac();
        let first = mobile.worker_credential("d1", true).unwrap();
        let second = mobile.worker_credential("d1", true).unwrap();
        assert!(by_token(&mobile, &first).is_none(), "the first worker link still works");
        assert!(by_token(&mobile, &second).unwrap().worker_link);
        assert_eq!(names(&mobile), ["iPhone", "Alex's MacBook Pro"]);
    }

    #[test]
    fn a_device_paired_before_x57_is_a_phone() {
        let (_dir, mobile) = with_phone(true);
        assert_eq!(mobile.status().devices[0].kind, DeviceKind::Phone);
    }

    #[test]
    fn a_token_works_only_while_phone_access_is_on() {
        let (_dir, mobile) = with_phone(false);
        assert!(
            mobile
                .authenticate(Some("tok"), None, None, None, None)
                .is_none()
        );
        mobile.set_enabled(true);
        let authed = mobile
            .authenticate(Some("tok"), None, None, None, None)
            .expect("on again");
        assert_eq!(authed.device_id, "d1");
        assert!(
            mobile
                .authenticate(Some("other"), None, None, None, None)
                .is_none()
        );
    }

    #[test]
    fn a_code_pairs_one_phone_only() {
        let mut slot = Some(Pairing::new("7KQ2MX9PDA".into(), 0));
        assert_eq!(
            claim(&mut slot, "7KQ2MX9PDA", 1).map(|c| c.0),
            Some(PairCheck::Paired)
        );
        assert!(
            slot.is_none(),
            "the code is used up by the claim that paired"
        );
        assert_eq!(claim(&mut slot, "7KQ2MX9PDA", 2).map(|c| c.0), None);
        let mut slot = Some(Pairing::new("7KQ2MX9PDA".into(), 0));
        assert_eq!(
            claim(&mut slot, "nope", 1).map(|c| c.0),
            Some(PairCheck::Wrong)
        );
        assert!(slot.is_some());
    }

    #[test]
    fn five_wrong_codes_cancel_the_pairing() {
        let mut p = Pairing::new("7KQ2MX9PDA".into(), 0);
        for _ in 0..4 {
            assert_eq!(p.check("nope", 1), PairCheck::Wrong);
        }
        assert_eq!(p.check("nope", 1), PairCheck::Exhausted);
    }

    #[test]
    fn mobile_json_round_trips_and_defaults_the_port() {
        let f: MobileFile = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(f.port, 47428);
        assert!(f.devices.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile.json");
        write_private(&path, br#"{"enabled":true,"port":1}"#).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
