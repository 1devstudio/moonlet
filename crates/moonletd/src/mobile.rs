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
use moonlet_proto::methods::{self as m, MobileDevice, MobileHost, MobilePairing, MobileStatus};
use moonlet_proto::{Frame, Message, RpcError, read_frame, write_frame};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::daemon::Daemon;

pub const DEFAULT_PORT: u16 = 47428;
/// How long a pairing code works.
pub const PAIR_TTL_MS: u64 = 5 * 60 * 1000;
/// Wrong codes before the current one is cancelled.
pub const PAIR_ATTEMPTS: u32 = 5;
/// How often the listener checks the Tailscale addresses.
const RESCAN: Duration = Duration::from_secs(30);
/// Retry delay after a bind failed (a daemon handing over still holds it).
const REBIND: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const FAIL_DELAY: Duration = Duration::from_secs(1);
/// What an auth failure says, whatever the reason.
const UNAUTHORIZED: &str = "this phone is not paired with this Mac";

/// Tailscale's IPv4 range (`100.64.0.0/10`) and IPv6 prefix (`fd7a:115c:a1e0::/48`).
pub fn is_tailscale(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

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

fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("read /dev/urandom");
    hex(&buf)
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
        if code == self.code {
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
        }
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
            devices: data
                .devices
                .iter()
                .map(|d| MobileDevice {
                    id: d.id.clone(),
                    name: d.name.clone(),
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
            self.pairing.lock().unwrap().take();
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
        let code = random_hex(16);
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
        {
            let mut data = self.data.lock().unwrap();
            let before = data.devices.len();
            data.devices.retain(|d| d.id != id);
            if data.devices.len() == before {
                return Err(RpcError::new("not_found", format!("no phone {id}")));
            }
            self.save(&data);
        }
        for c in self.conns.lock().unwrap().values() {
            if c.device_id == id {
                let _ = c.close.send(true);
            }
        }
        self.changed();
        Ok(())
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
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
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

/// Keeps the listener in line with the settings and the Tailscale
/// addresses until the daemon shuts down.
pub fn spawn(daemon: Arc<Daemon>) {
    tokio::spawn(async move {
        let mobile = daemon.mobile.clone();
        let mut shutdown = daemon.shutdown_signal();
        loop {
            let wait = reconcile(&daemon).await;
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = mobile.kick.notified() => {}
                _ = shutdown.changed() => break,
            }
        }
        mobile.listening.lock().unwrap().stop();
    });
}

/// Binds or closes listeners as needed; returns when to look again.
async fn reconcile(daemon: &Arc<Daemon>) -> Duration {
    let mobile = &daemon.mobile;
    let (enabled, port) = {
        let d = mobile.data.lock().unwrap();
        (d.enabled, d.port)
    };
    let want = if enabled {
        tailscale_addresses()
    } else {
        Vec::new()
    };
    let key = (want.clone(), port);
    if mobile.listening.lock().unwrap().bound_for.as_ref() == Some(&key) {
        return RESCAN;
    }
    mobile.listening.lock().unwrap().stop();
    if want.is_empty() {
        mobile.changed();
        return RESCAN;
    }
    let mut bound = Vec::new();
    for ip in &want {
        match TcpListener::bind(SocketAddr::new(*ip, port)).await {
            Ok(l) => bound.push(l),
            Err(e) => {
                tracing::warn!("cannot listen for phones on {ip}:{port}: {e}");
                return REBIND;
            }
        }
    }
    let mut listening = Listening {
        bound_for: Some(key),
        ..Default::default()
    };
    for l in bound {
        if let Ok(a) = l.local_addr() {
            tracing::info!("listening for phones on {a}");
            listening.addrs.push(a);
        }
        let daemon = daemon.clone();
        listening.tasks.push(tokio::spawn(accept_loop(daemon, l)));
    }
    {
        // Phone access may have been turned off while binding.
        let mut current = mobile.listening.lock().unwrap();
        if !mobile.data.lock().unwrap().enabled {
            listening.stop();
            return RESCAN;
        }
        *current = listening;
    }
    mobile.changed();
    RESCAN
}

async fn accept_loop(daemon: Arc<Daemon>, listener: TcpListener) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve_phone(daemon, stream).await {
                        tracing::debug!(%peer, "phone connection ended: {e:#}");
                    }
                });
            }
            Err(e) => {
                tracing::warn!("accepting a phone connection: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn serve_phone(daemon: Arc<Daemon>, mut stream: TcpStream) -> Result<()> {
    let _ = stream.set_nodelay(true);
    let first = tokio::time::timeout(AUTH_TIMEOUT, read_frame(&mut stream))
        .await
        .context("no auth in time")??;
    let authed = match first {
        Some(Frame::Json(Message::Auth {
            token,
            pair,
            device,
            route,
        })) => daemon.mobile.authenticate(
            token.as_deref(),
            pair.as_deref(),
            device.as_deref(),
            route.as_deref(),
        ),
        _ => None,
    };
    let Some(authed) = authed else {
        tokio::time::sleep(FAIL_DELAY).await;
        let _ = write_frame(
            &mut stream,
            &Frame::Json(Message::err(0, RpcError::new("unauthorized", UNAUTHORIZED))),
        )
        .await;
        return Ok(());
    };
    write_frame(
        &mut stream,
        &Frame::Json(Message::Authed {
            device_id: authed.device_id.clone(),
            token: authed.token.clone(),
        }),
    )
    .await?;

    let Some((conn, mut close)) = daemon.mobile.register(&authed.device_id) else {
        return Ok(());
    };
    let result = match &authed.route {
        Some(alias) => route(stream, alias, &mut close).await,
        None => {
            // The phone's connection runs through a pipe, so closing it
            // (revoke, phone access off) ends the client cleanly.
            let (here, there) = tokio::io::duplex(256 * 1024);
            let (r, w) = tokio::io::split(there);
            let client = tokio::spawn(crate::server::handle_connection(
                daemon.clone(),
                r,
                w,
                Some(authed.device_id.clone()),
            ));
            let mut here = here;
            tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut stream, &mut here) => {}
                _ = close.changed() => {}
            }
            drop(here);
            drop(stream);
            let _ = client.await;
            Ok(())
        }
    };
    daemon.mobile.unregister(conn);
    result
}

/// Pipes the phone to `ssh <alias> moonletd proxy`.
async fn route(stream: TcpStream, alias: &str, close: &mut watch::Receiver<bool>) -> Result<()> {
    let _ = moonlet_core::paths::ensure_private_dir(&moonlet_core::paths::run_dir());
    let mut child = tokio::process::Command::new("ssh")
        .args(moonlet_core::ssh::base_args())
        .arg(alias)
        .arg(format!("{} proxy", moonlet_core::ssh::REMOTE_MOONLETD))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("cannot run ssh")?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });
    let (mut tr, tw) = stream.into_split();
    // Replies the Mac makes itself share the write half with the host's
    // frames, whole frames at a time so they never interleave.
    let tw = Arc::new(tokio::sync::Mutex::new(tw));
    let down = {
        let tw = tw.clone();
        async move {
            while let Some(frame) = read_frame(&mut stdout).await? {
                write_frame(&mut *tw.lock().await, &frame).await?;
            }
            Ok::<_, anyhow::Error>(())
        }
    };
    let ssh_ended = tokio::select! {
        _ = forward_from_phone(&mut tr, &mut stdin, &tw) => false,
        _ = down => true,
        _ = close.changed() => false,
    };
    let mut tw = tw.lock().await;
    drop(stdin);
    if ssh_ended {
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        let text = tokio::time::timeout(Duration::from_secs(1), errors)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if let Some(line) = text.lines().rev().find(|l| !l.trim().is_empty()) {
            let frame = moonlet_proto::encode_frame(&Frame::Json(Message::err(
                0,
                RpcError::new("route_failed", line.trim()),
            )))?;
            let _ = tw.write_all(&frame).await;
        }
    }
    let _ = tw.shutdown().await;
    Ok(())
}

/// Copies a routed phone's frames to the host, except requests to manage
/// phones: the host's daemon cannot tell the phone from the Mac's app, and
/// a phone that paired itself there would keep access after the Mac
/// removes it. The Mac answers those itself.
async fn forward_from_phone(
    from: &mut tokio::net::tcp::OwnedReadHalf,
    to: &mut tokio::process::ChildStdin,
    reply: &tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>,
) -> Result<()> {
    while let Some(frame) = read_frame(from).await? {
        if let Frame::Json(Message::Request { id, method, .. }) = &frame
            && method.starts_with("mobile.")
            && method != m::MOBILE_HOSTS
        {
            let err = Message::err(
                *id,
                RpcError::new("forbidden", "manage phones from the Mac"),
            );
            write_frame(&mut *reply.lock().await, &Frame::Json(err)).await?;
            continue;
        }
        write_frame(to, &frame).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tailscale_addresses_count() {
        // Addresses as `ifconfig` lists them on a Mac with Tailscale.
        for a in [
            "100.101.102.103",
            "100.64.0.1",
            "100.127.255.254",
            "fd7a:115c:a1e0::1234:5678",
        ] {
            assert!(is_tailscale(a.parse().unwrap()), "{a}");
        }
        for a in [
            "192.168.1.23",
            "100.63.255.255",
            "100.128.0.1",
            "127.0.0.1",
            "fe80::1",
            "fd7a:115c:a1e1::1",
        ] {
            assert!(!is_tailscale(a.parse().unwrap()), "{a}");
        }
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
    fn a_code_works_once_within_five_minutes() {
        let mut p = Pairing::new("c0de".into(), 1_000);
        assert_eq!(p.check("c0de", 1_000 + PAIR_TTL_MS), PairCheck::Expired);
        assert_eq!(p.check("c0de", 1_000 + PAIR_TTL_MS - 1), PairCheck::Paired);
    }

    #[test]
    fn a_code_pairs_one_phone_only() {
        let mut slot = Some(Pairing::new("c0de".into(), 0));
        assert_eq!(
            claim(&mut slot, "c0de", 1).map(|c| c.0),
            Some(PairCheck::Paired)
        );
        assert!(
            slot.is_none(),
            "the code is used up by the claim that paired"
        );
        assert_eq!(claim(&mut slot, "c0de", 2).map(|c| c.0), None);
        let mut slot = Some(Pairing::new("c0de".into(), 0));
        assert_eq!(
            claim(&mut slot, "nope", 1).map(|c| c.0),
            Some(PairCheck::Wrong)
        );
        assert!(slot.is_some());
    }

    #[test]
    fn five_wrong_codes_cancel_the_pairing() {
        let mut p = Pairing::new("c0de".into(), 0);
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
