//! Connections from the app to `moonletd` instances: the local daemon over its
//! Unix socket, remote daemons through `ssh <host> moonletd proxy` (R1, R3),
//! and hosts paired over the tailnet (X57).
//! Each connection is a [`moonlet_link::Host`] (ADR 0008); this module says
//! how to reach each host and hands statuses and events to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use moonlet_core::ssh::{SavedHosts, TailnetHost};
pub use moonlet_link::HostInfo;
use moonlet_link::tailnet::TailnetConnector;
use moonlet_link::{
    BoxFuture, Connector, Events, Host, HostOptions, HostStatus, NEEDS_INSTALL, Reader, Writer,
};
use moonlet_proto::methods::{LinkCentral, LinkSet};
use moonlet_proto::{Frame, Message, RpcError};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const LOCAL: &str = "local";

/// The desktop app's name in `hello`.
const CLIENT: &str = "moonlet-app";

/// How the app reaches a host.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Local,
    Ssh,
    Tailnet,
}

/// A host as the webview sees it: the link's info and how it is reached.
#[derive(Serialize, Clone, Debug)]
pub struct HostEntry {
    #[serde(flatten)]
    pub info: HostInfo,
    pub kind: HostKind,
}

/// Sends one host's statuses and every daemon event to the webview.
struct WebviewEvents(AppHandle, HostKind);

#[derive(Serialize, Clone)]
struct DaemonEvent<'a> {
    host: &'a str,
    name: String,
    data: Value,
}

impl Events for WebviewEvents {
    fn status(&self, info: &HostInfo) {
        // This Mac's daemon renders its design cards in this app (X64).
        if self.1 == HostKind::Local && info.status == HostStatus::Connected {
            crate::design_render::announce(&self.0);
        }
        let entry = HostEntry {
            info: info.clone(),
            kind: self.1,
        };
        let _ = self.0.emit("host-status", entry);
    }

    fn event(&self, host: &str, name: String, data: Value) {
        // A card to render, from this Mac's daemon alone (X64): the app's
        // backend renders it, the webview never sees it.
        if name == moonlet_proto::methods::EV_DESIGN_RENDER {
            if self.1 == HostKind::Local {
                crate::design_render::handle(&self.0, data);
            }
            return;
        }
        let _ = self
            .0
            .emit("daemon-event", DaemonEvent { host, name, data });
    }
}

struct LocalDaemon;

impl Connector for LocalDaemon {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        Box::pin(connect_local())
    }

    fn welcomed<'a>(&'a self, reply: &'a Frame) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mismatch = match reply {
                Frame::Json(Message::Welcome { daemon_version, .. }) => {
                    daemon_version != env!("CARGO_PKG_VERSION")
                }
                Frame::Json(Message::Response { error: Some(e), .. }) => {
                    e.code == "protocol_mismatch"
                }
                _ => false,
            };
            let exe = std::env::current_exe().ok();
            let in_bundle = exe.as_deref().and_then(moonlet_core::bundle::app_of).is_some();
            let version = moonlet_core::bundle::this_version();
            let on_disk = match (in_bundle, version.as_deref()) {
                (false, _) => Bundle::None,
                (true, None) => Bundle::Unreadable,
                (true, Some(v)) => Bundle::Version(v),
            };
            if mismatch
                && upgrade_on_mismatch(env!("CARGO_PKG_VERSION"), on_disk)
                && !UPGRADE_TRIED.swap(true, Ordering::SeqCst)
            {
                tracing::info!("local daemon is a different version; upgrading it in place");
                upgrade_local().await?;
                bail!("daemon upgraded; reconnecting");
            }
            Ok(())
        })
    }
}

struct RemoteDaemon(String);

impl Connector for RemoteDaemon {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        Box::pin(connect_remote(&self.0))
    }
}

/// Output for one host goes to the webview's channel.
pub fn send_output(host: &Host, channel: Channel<InvokeResponseBody>) {
    host.set_output(move |buf| {
        let _ = channel.send(InvokeResponseBody::Raw(buf));
    });
}

pub struct HostManager {
    app: AppHandle,
    hosts: Mutex<HashMap<String, Arc<Host>>>,
    /// The hosts paired over the tailnet, with their tokens (X57).
    tailnet: Mutex<HashMap<String, TailnetHost>>,
    /// Held while the central host is chosen, or checked before a host is
    /// forgotten, so the two never interleave.
    central: tokio::sync::Mutex<()>,
}

impl HostManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mgr = Arc::new(Self {
            app,
            hosts: Mutex::new(HashMap::new()),
            tailnet: Mutex::new(HashMap::new()),
            central: tokio::sync::Mutex::new(()),
        });
        mgr.add(LOCAL, false);
        let saved = moonlet_core::ssh::saved_hosts();
        for r in saved.remotes {
            mgr.add(&r, true);
        }
        for t in saved.tailnet {
            mgr.add_tailnet(t);
        }
        mgr
    }

    fn persist(&self) {
        let tailnet: Vec<TailnetHost> = self.tailnet.lock().unwrap().values().cloned().collect();
        let mut remotes: Vec<String> = self
            .hosts
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.remote() && !tailnet.iter().any(|t| t.id == h.id))
            .map(|h| h.id.clone())
            .collect();
        remotes.sort();
        let saved = SavedHosts { remotes, tailnet };
        if let Err(e) =
            moonlet_core::ssh::save_hosts_at(&moonlet_core::ssh::saved_hosts_file(), &saved)
        {
            tracing::warn!("cannot save the hosts: {e}");
        }
    }

    fn kind(&self, id: &str) -> HostKind {
        if id == LOCAL {
            HostKind::Local
        } else if self.tailnet.lock().unwrap().contains_key(id) {
            HostKind::Tailnet
        } else {
            HostKind::Ssh
        }
    }

    fn entry(&self, host: &Host) -> HostEntry {
        HostEntry {
            info: host.info(),
            kind: self.kind(&host.id),
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Host>, RpcError> {
        self.hosts
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new("unknown_host", format!("unknown host {id}")))
    }

    pub fn list(&self) -> Vec<HostEntry> {
        let hosts: Vec<Arc<Host>> = self.hosts.lock().unwrap().values().cloned().collect();
        let mut v: Vec<HostEntry> = hosts.iter().map(|h| self.entry(h)).collect();
        v.sort_by(|a, b| {
            a.info
                .remote
                .cmp(&b.info.remote)
                .then(a.info.id.cmp(&b.info.id))
        });
        v
    }

    /// Adds a host paired over the tailnet and connects to it (X57).
    pub fn add_tailnet(self: &Arc<Self>, saved: TailnetHost) -> HostEntry {
        if let Ok(h) = self.get(&saved.id) {
            return self.entry(&h);
        }
        let id = saved.id.clone();
        self.tailnet
            .lock()
            .unwrap()
            .insert(id.clone(), saved.clone());
        let host = Host::start(
            HostOptions {
                id: id.clone(),
                label: id.clone(),
                remote: true,
                client: CLIENT.into(),
            },
            Arc::new(TailnetConnector {
                addrs: saved.addrs,
                token: saved.token,
                route: None,
            }),
            Arc::new(WebviewEvents(self.app.clone(), HostKind::Tailnet)),
            tauri::async_runtime::handle().inner().clone(),
        );
        self.hosts.lock().unwrap().insert(id, host.clone());
        self.persist();
        self.entry(&host)
    }

    pub fn add(self: &Arc<Self>, id: &str, remote: bool) -> HostEntry {
        if let Ok(h) = self.get(id) {
            return self.entry(&h);
        }
        let connector: Arc<dyn Connector> = if remote {
            Arc::new(RemoteDaemon(id.to_string()))
        } else {
            Arc::new(LocalDaemon)
        };
        let host = Host::start(
            HostOptions {
                id: id.to_string(),
                label: if remote {
                    id.to_string()
                } else {
                    "This Mac".into()
                },
                remote,
                client: CLIENT.into(),
            },
            connector,
            Arc::new(WebviewEvents(
                self.app.clone(),
                if remote {
                    HostKind::Ssh
                } else {
                    HostKind::Local
                },
            )),
            tauri::async_runtime::handle().inner().clone(),
        );
        self.hosts
            .lock()
            .unwrap()
            .insert(id.to_string(), host.clone());
        if remote {
            self.persist();
        }
        self.entry(&host)
    }

    /// Forgets a host. A connected tailnet host is asked to forget this Mac
    /// first (`mobile.unpair`), so its token stops working there too.
    pub async fn remove(&self, id: &str) -> Result<(), RpcError> {
        if id == LOCAL {
            return Ok(());
        }
        let host = self.hosts.lock().unwrap().get(id).cloned();
        if let Some(h) = &host
            && self.kind(id) == HostKind::Tailnet
            && h.info().status == HostStatus::Connected
        {
            let unpair = h.request(moonlet_proto::methods::MOBILE_UNPAIR, Value::Null);
            if let Ok(Err(e)) =
                tokio::time::timeout(std::time::Duration::from_secs(5), unpair).await
            {
                tracing::info!(host = id, "unpair: {}", e.message);
            }
        }
        // A host this Mac forgets is no longer its central host (X41): it is
        // kept, with its token, until that is known to be cleared.
        let _central = self.central.lock().await;
        if self.kind(id) == HostKind::Tailnet {
            let link = match self.get(LOCAL) {
                Ok(local) => local.request(moonlet_proto::methods::LINK_GET, Value::Null).await,
                Err(e) => Err(e),
            };
            if central_to_clear(id, link)? {
                self.link_central(None).await.map_err(|e| {
                    tracing::warn!(host = id, "cannot clear the central host: {}", e.message);
                    RpcError::new(e.code, format!("Cannot stop using {id} as this Mac's central host: {}", e.message))
                })?;
            }
        }
        self.tailnet.lock().unwrap().remove(id);
        if let Some(h) = self.hosts.lock().unwrap().remove(id) {
            h.stop();
        }
        self.persist();
        Ok(())
    }

    /// Makes a tailnet host this Mac's central host, or clears it (X41). The
    /// token goes from the app's own host list to the local daemon, never
    /// through the webview; the reply, like `link.get`, has no token.
    pub async fn set_central(&self, id: Option<&str>) -> Result<Value, RpcError> {
        let _central = self.central.lock().await;
        self.link_central(id).await
    }

    async fn link_central(&self, id: Option<&str>) -> Result<Value, RpcError> {
        let saved = match id {
            Some(id) => Some(self.tailnet.lock().unwrap().get(id).cloned().ok_or_else(|| {
                RpcError::new("unknown_host", format!("{id} is not a host on your tailnet"))
            })?),
            None => None,
        };
        let params = serde_json::to_value(central_link_set(saved.as_ref())).unwrap();
        self.get(LOCAL)?
            .request(moonlet_proto::methods::LINK_SET, params)
            .await
    }

    pub fn reconnect(&self, id: &str) -> Result<(), RpcError> {
        self.get(id)?.reconnect();
        Ok(())
    }

    /// Asks tailnet host `id` to update itself to `version` (X69), in place
    /// of `hello`, so it works whatever protocol the host speaks. The token
    /// stays in the app, never in the webview.
    pub async fn update(&self, id: &str, version: &str) -> Result<moonlet_proto::types::DaemonUpdated, RpcError> {
        let saved = self.tailnet.lock().unwrap().get(id).cloned();
        let Some(saved) = saved else {
            return Err(RpcError::new("invalid_params", format!("{id} is not a tailnet host")));
        };
        moonlet_link::tailnet::update(&saved.addrs, &saved.token, version).await
    }
}

/// Finds a bundled binary: next to the app executable (bundle `Contents/MacOS`,
/// or `target/<profile>` in development), or `$MOONLET_BIN_DIR`.
pub fn sibling_binary(name: &str) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("MOONLET_BIN_DIR") {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    let exe = std::env::current_exe()?;
    let p = exe.with_file_name(name);
    if p.exists() {
        return Ok(p);
    }
    bail!("{name} not found next to {}", exe.display())
}

/// Asks the running local daemon to hand its sessions to the bundled
/// `moonletd` (S3). Used once per app run when versions differ.
async fn upgrade_local() -> Result<()> {
    let moonletd = sibling_binary("moonletd")?;
    let status = tokio::process::Command::new(&moonletd)
        .arg("upgrade")
        .status()
        .await?;
    if !status.success() {
        bail!("moonletd upgrade failed ({status})");
    }
    Ok(())
}

/// The app's bundle on disk, as `welcomed` sees it.
#[derive(Debug, Clone, Copy)]
enum Bundle<'a> {
    /// Not in a bundle: a dev build.
    None,
    /// In a bundle whose version can't be read, as while it is replaced.
    Unreadable,
    Version(&'a str),
}

/// Whether the app hands the local daemon to its bundled `moonletd` when
/// their versions differ: not while the bundle on disk is newer than this
/// app, as after another Mac updated this one (X69), since the daemon
/// already runs the bundle's `moonletd` and the app relaunches into it; nor
/// while the bundle can't be read.
fn upgrade_on_mismatch(app: &str, on_disk: Bundle) -> bool {
    match on_disk {
        Bundle::None => true,
        Bundle::Unreadable => false,
        Bundle::Version(v) => !newer(v, app),
    }
}

/// Whether version `a` (`x.y.z`) is newer than `b`.
fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a) > parts(b)
}

static UPGRADE_TRIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn connect_local() -> Result<(Reader, Writer)> {
    let socket = moonlet_core::paths::socket_path();
    if tokio::net::UnixStream::connect(&socket).await.is_err() {
        let moonletd = sibling_binary("moonletd")?;
        let status = tokio::process::Command::new(&moonletd)
            .arg("start")
            .status()
            .await
            .context("cannot start moonletd")?;
        if !status.success() {
            bail!("moonletd start failed ({status})");
        }
    }
    let stream = tokio::net::UnixStream::connect(&socket)
        .await
        .with_context(|| format!("connect {}", socket.display()))?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

pub use moonlet_core::ssh::{REMOTE_MOONLETD, base_args as ssh_base_args};

async fn connect_remote(alias: &str) -> Result<(Reader, Writer)> {
    let _ = moonlet_core::paths::ensure_private_dir(&moonlet_core::paths::run_dir());
    // Version check first so a stale helper is never used silently (R2).
    let probe = crate::remote::remote_version(alias).await?;
    let want = env!("CARGO_PKG_VERSION");
    match probe {
        Some(v) if v == want => {}
        Some(v) => bail!("{NEEDS_INSTALL}remote helper is {v}, app expects {want}"),
        None => bail!("{NEEDS_INSTALL}moonlet helper is not installed on {alias}"),
    }
    let mut child = tokio::process::Command::new("ssh")
        .args(ssh_base_args())
        .arg(alias)
        .arg(format!("{REMOTE_MOONLETD} proxy"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("cannot run ssh")?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    // The child must live as long as the pipes; it is killed on drop with the reader.
    let reader = ChildReader {
        inner: stdout,
        _child: child,
    };
    tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        if !buf.trim().is_empty() {
            tracing::warn!("ssh: {}", buf.trim());
        }
    });
    Ok((Box::new(reader), Box::new(stdin)))
}

struct ChildReader {
    inner: tokio::process::ChildStdout,
    _child: tokio::process::Child,
}

impl AsyncRead for ChildReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

/// A host name the app may pass to `ssh` or use as a host's id: not empty,
/// no leading `-` (it would read as an option), no spaces or control
/// characters. SSH aliases (R1) and tailnet names (X57) share it.
pub fn valid_host_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// A tailnet host's id and label: the name typed, without a port.
pub fn tailnet_host_id(typed: &str) -> Result<String, String> {
    let (name, _) = moonlet_core::tailnet::name_and_port(typed.trim());
    if !valid_host_name(name) {
        return Err("Enter the host's name on your tailnet, such as studio-mini.".into());
    }
    Ok(name.to_string())
}

/// This Mac's name, as Sharing settings show it (`scutil --get ComputerName`),
/// or else its host name without `.local`.
fn device_name_from(computer_name: Option<&str>, hostname: &str) -> String {
    match computer_name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => hostname
            .strip_suffix(".local")
            .unwrap_or(hostname)
            .to_string(),
    }
}

/// This Mac's name as a host lists it among its paired devices.
fn device_name() -> String {
    let computer_name = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    device_name_from(computer_name.as_deref(), &moonlet_core::paths::hostname())
}

/// Pairs with a host on the tailnet (X57) and connects to it. `addrs` come
/// from a pasted link and must be on the tailnet (or loopback); without them
/// the typed name is looked up, and only its Tailscale addresses are used.
pub async fn pair_tailnet(
    mgr: &Arc<HostManager>,
    typed: &str,
    addrs: Option<Vec<String>>,
    code: &str,
) -> Result<HostEntry, RpcError> {
    let failed = |m: String| RpcError::new("pair_failed", m);
    let id = tailnet_host_id(typed).map_err(failed)?;
    if mgr.get(&id).is_ok() {
        return Err(failed(format!("A host named {id} already exists.")));
    }
    let addrs = match addrs.filter(|a| !a.is_empty()) {
        Some(a) => {
            moonlet_core::tailnet::link_addrs_allowed(&a).map_err(failed)?;
            a
        }
        None => {
            let (name, port) = moonlet_core::tailnet::name_and_port(typed.trim());
            let ips: Vec<std::net::IpAddr> = tokio::net::lookup_host((name, port))
                .await
                .map(|it| it.map(|a| a.ip()).collect())
                .unwrap_or_default();
            moonlet_core::tailnet::listener_addrs(typed.trim(), &ips).map_err(failed)?
        }
    };
    let paired = moonlet_link::tailnet::pair(
        &addrs,
        code,
        &device_name(),
        moonlet_proto::methods::DeviceKind::Desktop,
    )
    .await
    .map_err(|e| failed(moonlet_link::tailnet::pair_error_text(&id, &e)))?;
    Ok(mgr.add_tailnet(TailnetHost {
        id,
        device_id: paired.device_id,
        addrs,
        token: paired.token,
    }))
}

/// `link.set` params that make `saved` this Mac's central host (X41), or
/// clear it.
pub fn central_link_set(saved: Option<&TailnetHost>) -> LinkSet {
    LinkSet {
        central: Some(saved.map(|t| LinkCentral {
            name: t.id.clone(),
            addrs: t.addrs.clone(),
            token: t.token.clone(),
        })),
        worker: None,
    }
}

/// Whether forgetting host `id` must first clear it as this Mac's central
/// host, from what `link.get` answered. Without an answer it cannot be
/// known, so the host is not forgotten.
fn central_to_clear(id: &str, link: Result<Value, RpcError>) -> Result<bool, RpcError> {
    let link = link.map_err(|e| {
        RpcError::new(
            e.code,
            format!("Cannot check whether {id} is this Mac's central host: {}", e.message),
        )
    })?;
    Ok(link["central"]["name"] == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_daemon_is_upgraded_unless_the_bundle_on_disk_is_newer() {
        assert!(upgrade_on_mismatch("0.1.34", Bundle::Version("0.1.34")));
        // A dev build has no bundle.
        assert!(upgrade_on_mismatch("0.1.34", Bundle::None));
        // Another Mac updated this one (X69): its daemon already runs the
        // bundle's moonletd, and the app relaunches into it.
        assert!(!upgrade_on_mismatch("0.1.33", Bundle::Version("0.1.34")));
        assert!(!upgrade_on_mismatch("0.1.9", Bundle::Version("0.1.10")));
        // An older bundle on disk than this app still gets this app's daemon.
        assert!(upgrade_on_mismatch("0.1.34", Bundle::Version("0.1.33")));
        // A bundle whose version can't be read, as while it is replaced:
        // wait rather than hand the daemon to whatever binary is there.
        assert!(!upgrade_on_mismatch("0.1.34", Bundle::Unreadable));
    }

    #[test]
    fn choosing_a_central_host_hands_its_name_addresses_and_token_to_link_set() {
        let mini = TailnetHost {
            id: "studio-mini".into(),
            device_id: "d1".into(),
            addrs: vec!["100.101.102.103:47428".into()],
            token: "ab".repeat(32),
        };
        assert_eq!(
            serde_json::to_value(central_link_set(Some(&mini))).unwrap(),
            serde_json::json!({
                "central": {
                    "name": "studio-mini",
                    "addrs": ["100.101.102.103:47428"],
                    "token": "ab".repeat(32),
                }
            })
        );
        assert_eq!(
            serde_json::to_value(central_link_set(None)).unwrap(),
            serde_json::json!({ "central": null })
        );
    }

    #[test]
    fn a_host_is_forgotten_only_once_it_is_known_not_to_stay_central() {
        let link = |name: &str| Ok(serde_json::json!({ "central": { "name": name } }));
        assert_eq!(central_to_clear("studio-mini", link("studio-mini")), Ok(true));
        assert_eq!(central_to_clear("studio-mini", link("build-box")), Ok(false));
        assert_eq!(
            central_to_clear("studio-mini", Ok(serde_json::json!({ "central": null }))),
            Ok(false)
        );
        let down = Err(RpcError::new("disconnected", "this Mac's daemon is not reachable"));
        assert_eq!(
            central_to_clear("studio-mini", down).unwrap_err().message,
            "Cannot check whether studio-mini is this Mac's central host: this Mac's daemon is not reachable"
        );
    }

    #[test]
    fn a_tailnet_host_is_named_without_its_port() {
        assert_eq!(
            tailnet_host_id("studio-mini"),
            Ok("studio-mini".to_string())
        );
        assert_eq!(
            tailnet_host_id(" build-box:47500 "),
            Ok("build-box".to_string())
        );
        for bad in ["", "  ", "two words", "-oProxyCommand", "evil\u{1b}[31m"] {
            assert_eq!(
                tailnet_host_id(bad),
                Err("Enter the host's name on your tailnet, such as studio-mini.".to_string()),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn an_ssh_alias_and_a_tailnet_name_follow_one_rule() {
        for ok in ["devbox", "studio-mini", "me@devbox"] {
            assert!(valid_host_name(ok), "{ok:?}");
        }
        for bad in [
            "",
            "-oProxyCommand=x",
            "two words",
            "tab\there",
            "esc\u{1b}[31m",
        ] {
            assert!(!valid_host_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn this_mac_is_named_as_in_sharing_settings() {
        // `scutil --get ComputerName` output, with its newline.
        assert_eq!(
            device_name_from(Some("Alex's MacBook Pro\n"), "Alexs-MacBook-Pro.local"),
            "Alex's MacBook Pro"
        );
        assert_eq!(
            device_name_from(None, "Alexs-MacBook-Pro.local"),
            "Alexs-MacBook-Pro"
        );
        assert_eq!(device_name_from(Some("  "), "build-box"), "build-box");
    }
}
