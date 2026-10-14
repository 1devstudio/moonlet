//! Connections from the app to `moonletd` instances: the local daemon over its
//! Unix socket, remote daemons through `ssh <host> moonletd proxy` (R1, R3).
//! Each connection is a [`moonlet_link::Host`] (ADR 0008); this module says
//! how to reach each host and hands statuses and events to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
pub use moonlet_link::HostInfo;
use moonlet_link::{
    BoxFuture, Connector, Events, Host, HostOptions, NEEDS_INSTALL, Reader, Writer,
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

/// Sends host statuses and daemon events to the webview.
struct WebviewEvents(AppHandle);

#[derive(Serialize, Clone)]
struct DaemonEvent<'a> {
    host: &'a str,
    name: String,
    data: Value,
}

impl Events for WebviewEvents {
    fn status(&self, info: &HostInfo) {
        let _ = self.0.emit("host-status", info);
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
}


impl HostManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mgr = Arc::new(Self {
            app,
            hosts: Mutex::new(HashMap::new()),
        });
        mgr.add(LOCAL, false);
        for r in moonlet_core::ssh::saved_hosts().remotes {
            mgr.add(&r, true);
        }
        mgr
    }

    fn persist(&self) {
        let remotes: Vec<String> = self
            .hosts
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.remote())
            .map(|h| h.id.clone())
            .collect();
        let _ = moonlet_core::paths::ensure_private_dir(&moonlet_core::paths::home());
        let _ = std::fs::write(
            moonlet_core::ssh::saved_hosts_file(),
            serde_json::to_vec_pretty(&moonlet_core::ssh::SavedHosts { remotes }).unwrap(),
        );
    }

    pub fn get(&self, id: &str) -> Result<Arc<Host>, RpcError> {
        self.hosts
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new("unknown_host", format!("unknown host {id}")))
    }

    pub fn list(&self) -> Vec<HostInfo> {
        let mut v: Vec<HostInfo> = self
            .hosts
            .lock()
            .unwrap()
            .values()
            .map(|h| h.info())
            .collect();
        v.sort_by(|a, b| a.remote.cmp(&b.remote).then(a.id.cmp(&b.id)));
        v
    }

    pub fn add(self: &Arc<Self>, id: &str, remote: bool) -> HostInfo {
        if let Ok(h) = self.get(id) {
            return h.info();
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
            Arc::new(WebviewEvents(self.app.clone())),
            tauri::async_runtime::handle().inner().clone(),
        );
        self.hosts
            .lock()
            .unwrap()
            .insert(id.to_string(), host.clone());
        if remote {
            self.persist();
        }
        host.info()
    }

    pub fn remove(&self, id: &str) {
        if id == LOCAL {
            return;
        }
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
