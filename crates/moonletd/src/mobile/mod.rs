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
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

mod net;

pub use net::spawn;

pub const DEFAULT_PORT: u16 = moonlet_core::tailnet::DEFAULT_PORT;
/// How long a pairing code works.
pub const PAIR_TTL_MS: u64 = 5 * 60 * 1000;
/// Wrong codes before the current one is cancelled.
pub const PAIR_ATTEMPTS: u32 = 5;

pub use moonlet_core::tailnet::is_tailscale;

/// The machine's Tailscale addresses, IPv4 first. `MOONLET_MOBILE_ADDRS`
/// (comma-separated) replaces them, for tests.
pub fn tailscale_addresses() -> Vec<IpAddr> {
    if let Ok(list) = std::env::var("MOONLET_MOBILE_ADDRS") {
        return list
            .split(',')
            .filter_map(|a| a.trim().parse().ok())
            .collect();
    }
    let mut out: Vec<IpAddr> = nix::ifaddrs::getifaddrs()
        .map(|addrs| {
            addrs
                .filter_map(|a| a.address)
                .filter_map(|s| {
                    s.as_sockaddr_in()
                        .map(|v4| IpAddr::V4(v4.ip()))
                        .or_else(|| s.as_sockaddr_in6().map(|v6| IpAddr::V6(v6.ip())))
                })
                .filter(|ip| is_tailscale(*ip))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    out.dedup();
    out
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

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
#[derive(Debug, Default)]
pub struct JoinCodes {
    codes: Vec<JoinCode>,
}

#[derive(Debug, Clone)]
struct JoinCode {
    code: String,
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
            code: code.clone(),
            machine: machine.to_string(),
            name: name.to_string(),
            expires_at: now + JOIN_TTL_MS,
        });
        code
    }

    /// The machine a code joins `name` as, using the code up; None for a
    /// code that is unknown, expired, used or for another machine.
    pub fn redeem(&mut self, code: &str, name: &str, now: u64) -> Option<String> {
        let code = normalize_code(code);
        let i = self.codes.iter().position(|c| c.code == code)?;
        let c = &self.codes[i];
        if c.expires_at <= now || c.name != name {
            return None;
        }
        Some(self.codes.remove(i).machine)
    }

    /// Whether `code` is a join code waiting to be used.
    pub fn knows(&self, code: &str) -> bool {
        let code = normalize_code(code);
        self.codes.iter().any(|c| c.code == code)
    }
}

/// An authenticated phone connection.
pub struct Authed {
    pub device_id: String,
    /// Set when this connection just paired.
    pub token: Option<String>,
    pub route: Option<String>,
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
}

impl Mobile {
    pub fn load(file: PathBuf, emit: impl Fn(Message) + Send + Sync + 'static) -> Mobile {
        let data = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
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
            joins: Mutex::default(),
            on_join: Mutex::new(None),
        }
    }

    /// A one-use code that pairs cloud machine `machine`, named `name`.
    /// Only the central host makes them, for machines it creates.
    pub fn join_code(&self, machine: &str, name: &str) -> String {
        self.joins.lock().unwrap().mint(machine, name, now_ms())
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
        let addresses: Vec<String> = tailscale_addresses()
            .iter()
            .map(IpAddr::to_string)
            .collect();
        MobileStatus {
            enabled: data.enabled,
            port: data.port,
            tailscale: !addresses.is_empty(),
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

    pub fn pair_start(self: &Arc<Self>) -> Result<MobilePairing, RpcError> {
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
        let pairing = Pairing::new(code.clone(), now);
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

    pub fn revoke(&self, id: &str) -> Result<(), RpcError> {
        self.forget(id)?;
        self.close_device(id);
        self.changed();
        Ok(())
    }

    /// A paired device removes itself (X57). Its token stops working at once;
    /// its connections close a moment later, once the reply has gone out.
    pub fn unpair(self: &Arc<Self>, id: &str) -> Result<(), RpcError> {
        self.forget(id)?;
        self.changed();
        let me = Arc::downgrade(self);
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Some(me) = me.upgrade() {
                me.close_device(&id);
            }
        });
        Ok(())
    }

    /// Whether device `id` is still paired. A device that removed itself
    /// keeps its connection a moment longer, for the reply.
    pub fn is_paired(&self, id: &str) -> bool {
        self.data.lock().unwrap().devices.iter().any(|d| d.id == id)
    }

    fn forget(&self, id: &str) -> Result<(), RpcError> {
        let mut data = self.data.lock().unwrap();
        let before = data.devices.len();
        data.devices.retain(|d| d.id != id);
        if data.devices.len() == before {
            return Err(RpcError::new("not_found", format!("no paired device {id}")));
        }
        self.save(&data);
        Ok(())
    }

    fn close_device(&self, id: &str) {
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
                d.last_seen = Some(now_ms());
                let device_id = d.id.clone();
                self.save(&data);
                Some(Authed {
                    device_id,
                    token: None,
                    route,
                })
            }
            (None, Some(code)) if route.is_none() && self.joins.lock().unwrap().knows(code) => {
                let name = device.unwrap_or_default();
                let machine = self.joins.lock().unwrap().redeem(code, name, now_ms())?;
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
                })
            }
            (None, Some(code)) if route.is_none() => {
                let check = claim(&mut self.pairing.lock().unwrap(), code, now_ms())?;
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
                            // A cloud device pairs only with a join code.
                            kind: kind.filter(|k| *k != DeviceKind::Cloud).unwrap_or_default(),
                            machine: None,
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
