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
        let entry = HostEntry {
            info: info.clone(),
            kind: self.1,
        };
        let _ = self.0.emit("host-status", entry);
    }

    fn event(&self, host: &str, name: String, data: Value) {
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
            if mismatch && !UPGRADE_TRIED.swap(true, Ordering::SeqCst) {
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
}

impl HostManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mgr = Arc::new(Self {
            app,
            hosts: Mutex::new(HashMap::new()),
            tailnet: Mutex::new(HashMap::new()),
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
    pub async fn remove(&self, id: &str) {
        if id == LOCAL {
            return;
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
        self.tailnet.lock().unwrap().remove(id);
        if let Some(h) = self.hosts.lock().unwrap().remove(id) {
            h.stop();
        }
        self.persist();
    }

    pub fn reconnect(&self, id: &str) -> Result<(), RpcError> {
        self.get(id)?.reconnect();
        Ok(())
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

/// What the daemon says, whatever is wrong, to a code it does not accept (X39).
const NOT_PAIRED: &str = "this phone is not paired with this Mac";

/// A tailnet host's id and label: the name typed, without a port.
pub fn tailnet_host_id(typed: &str) -> Result<String, String> {
    let (name, _) = moonlet_core::tailnet::name_and_port(typed.trim());
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Enter the host's name on your tailnet, such as studio-mini.".into());
    }
    Ok(name.to_string())
}

/// What the Add host dialog says when pairing fails.
pub fn pair_error_text(id: &str, error: &str) -> String {
    if error == NOT_PAIRED {
        format!("The code was not accepted. Start pairing again on {id}.")
    } else {
        format!("Cannot pair with {id}: {error}")
    }
}

/// This Mac's name as a host lists it among its paired devices.
fn device_name() -> String {
    let h = moonlet_core::paths::hostname();
    h.strip_suffix(".local").unwrap_or(&h).to_string()
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
    .map_err(|e| failed(pair_error_text(&id, &format!("{e:#}"))))?;
    Ok(mgr.add_tailnet(TailnetHost {
        id,
        device_id: paired.device_id,
        addrs,
        token: paired.token,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_refused_code_says_to_start_again_on_the_host() {
        assert_eq!(
            pair_error_text("studio-mini", "this phone is not paired with this Mac"),
            "The code was not accepted. Start pairing again on studio-mini."
        );
        assert_eq!(
            pair_error_text(
                "studio-mini",
                "cannot reach the host over Tailscale: 100.101.102.103:47428: Connection refused"
            ),
            "Cannot pair with studio-mini: cannot reach the host over Tailscale: 100.101.102.103:47428: Connection refused"
        );
    }
}
