//! Connections from the app to `jauntd` instances: the local daemon over its
//! Unix socket, remote daemons through `ssh <host> jauntd proxy` (R1, R3).
//!
//! Each host keeps one connection and reconnects with backoff on its own.
//! The daemon keeps sessions alive meanwhile, so a dropped link only pauses
//! output. PTY output is batched every 8 ms into one binary message per host
//! for the webview: repeated `[u32 BE session][u32 BE len][bytes]` records.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jaunt_proto::{
    Frame, FrameDecoder, Message, PROTOCOL_VERSION, RpcError, SessionId, encode_frame,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

pub const LOCAL: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HostStatus {
    Connecting,
    Connected,
    Reconnecting,
    /// The remote helper is missing or a different version; needs consent to install.
    NeedsInstall,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostInfo {
    pub id: String,
    pub label: String,
    pub remote: bool,
    pub status: HostStatus,
    pub message: Option<String>,
    pub daemon_version: Option<String>,
    pub hostname: Option<String>,
    pub home: Option<String>,
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

struct Link {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

pub struct Host {
    pub id: String,
    remote: bool,
    info: Mutex<HostInfo>,
    link: Mutex<Option<Link>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    output: Mutex<Option<Channel<InvokeResponseBody>>>,
    batch: Mutex<Vec<u8>>,
    stop: watch::Sender<bool>,
    /// Kicks the reconnect loop to retry immediately.
    retry: tokio::sync::Notify,
}

impl Host {
    pub fn info(&self) -> HostInfo {
        self.info.lock().unwrap().clone()
    }

    pub fn set_output(&self, channel: Channel<InvokeResponseBody>) {
        *self.output.lock().unwrap() = Some(channel);
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let link = self.link.lock().unwrap();
            let Some(link) = link.as_ref() else {
                return Err(RpcError::new(
                    "disconnected",
                    format!("{} is not connected", self.id),
                ));
            };
            self.pending.lock().unwrap().insert(id, tx);
            let frame = Frame::Json(Message::Request {
                id,
                method: method.into(),
                params,
            });
            if link.tx.send(encode_frame(&frame)).is_err() {
                self.pending.lock().unwrap().remove(&id);
                return Err(RpcError::new("disconnected", "connection closed"));
            }
        }
        let timeout = if method.starts_with("gh.") || method.starts_with("workspace.") {
            180
        } else {
            60
        };
        match tokio::time::timeout(Duration::from_secs(timeout), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(RpcError::new(
                "disconnected",
                "connection lost before reply",
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcError::new("timeout", format!("{method} timed out")))
            }
        }
    }

    pub fn input(&self, session: SessionId, data: Vec<u8>) -> Result<(), RpcError> {
        let link = self.link.lock().unwrap();
        let link = link
            .as_ref()
            .ok_or_else(|| RpcError::new("disconnected", "not connected"))?;
        link.tx
            .send(encode_frame(&Frame::Input { session, data }))
            .map_err(|_| RpcError::new("disconnected", "connection closed"))
    }

    fn set_status(&self, app: &AppHandle, status: HostStatus, message: Option<String>) {
        let info = {
            let mut i = self.info.lock().unwrap();
            i.status = status;
            i.message = message;
            i.clone()
        };
        let _ = app.emit("host-status", info);
    }

    fn push_output(&self, session: SessionId, data: &[u8]) {
        let mut b = self.batch.lock().unwrap();
        b.extend_from_slice(&session.to_be_bytes());
        b.extend_from_slice(&(data.len() as u32).to_be_bytes());
        b.extend_from_slice(data);
    }

    fn flush_output(&self) {
        let buf = {
            let mut b = self.batch.lock().unwrap();
            if b.is_empty() {
                return;
            }
            std::mem::take(&mut *b)
        };
        if let Some(ch) = self.output.lock().unwrap().as_ref() {
            let _ = ch.send(InvokeResponseBody::Raw(buf));
        }
    }

    fn fail_pending(&self, why: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(RpcError::new("disconnected", why)));
        }
    }
}

pub struct HostManager {
    app: AppHandle,
    hosts: Mutex<HashMap<String, Arc<Host>>>,
}

#[derive(Serialize, Deserialize, Default)]
struct SavedHosts {
    remotes: Vec<String>,
}

fn saved_hosts_file() -> PathBuf {
    jaunt_core::paths::home().join("app-hosts.json")
}

impl HostManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mgr = Arc::new(Self {
            app,
            hosts: Mutex::new(HashMap::new()),
        });
        mgr.add(LOCAL, false);
        let saved: SavedHosts = std::fs::read_to_string(saved_hosts_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for r in saved.remotes {
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
            .filter(|h| h.remote)
            .map(|h| h.id.clone())
            .collect();
        let _ = jaunt_core::paths::ensure_private_dir(&jaunt_core::paths::home());
        let _ = std::fs::write(
            saved_hosts_file(),
            serde_json::to_vec_pretty(&SavedHosts { remotes }).unwrap(),
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
        let (stop, stop_rx) = watch::channel(false);
        let host = Arc::new(Host {
            id: id.to_string(),
            remote,
            info: Mutex::new(HostInfo {
                id: id.to_string(),
                label: if remote {
                    id.to_string()
                } else {
                    "This Mac".into()
                },
                remote,
                status: HostStatus::Connecting,
                message: None,
                daemon_version: None,
                hostname: None,
                home: None,
            }),
            link: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            output: Mutex::new(None),
            batch: Mutex::new(Vec::new()),
            stop,
            retry: tokio::sync::Notify::new(),
        });
        self.hosts
            .lock()
            .unwrap()
            .insert(id.to_string(), host.clone());
        if remote {
            self.persist();
        }
        tauri::async_runtime::spawn(flush_loop(Arc::downgrade(&host)));
        tauri::async_runtime::spawn(connection_loop(self.app.clone(), host.clone(), stop_rx));
        host.info()
    }

    pub fn remove(&self, id: &str) {
        if id == LOCAL {
            return;
        }
        if let Some(h) = self.hosts.lock().unwrap().remove(id) {
            let _ = h.stop.send(true);
            h.link.lock().unwrap().take();
        }
        self.persist();
    }

    pub fn reconnect(&self, id: &str) -> Result<(), RpcError> {
        let h = self.get(id)?;
        h.link.lock().unwrap().take();
        h.retry.notify_one();
        Ok(())
    }
}

async fn flush_loop(host: std::sync::Weak<Host>) {
    let mut tick = tokio::time::interval(Duration::from_millis(8));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Some(h) = host.upgrade() else { return };
        h.flush_output();
    }
}

type Reader = Box<dyn AsyncRead + Unpin + Send>;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

/// Finds a bundled binary: next to the app executable (bundle `Contents/MacOS`,
/// or `target/<profile>` in development), or `$JAUNT_BIN_DIR`.
pub fn sibling_binary(name: &str) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("JAUNT_BIN_DIR") {
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

async fn connect_local() -> Result<(Reader, Writer)> {
    let socket = jaunt_core::paths::socket_path();
    if tokio::net::UnixStream::connect(&socket).await.is_err() {
        let jauntd = sibling_binary("jauntd")?;
        let status = tokio::process::Command::new(&jauntd)
            .arg("start")
            .status()
            .await
            .context("cannot start jauntd")?;
        if !status.success() {
            bail!("jauntd start failed ({status})");
        }
    }
    let stream = tokio::net::UnixStream::connect(&socket)
        .await
        .with_context(|| format!("connect {}", socket.display()))?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

pub fn ssh_base_args() -> Vec<String> {
    let control = jaunt_core::paths::run_dir().join("ssh-%C");
    vec![
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ServerAliveInterval=10".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", control.display()),
        "-o".into(),
        "ControlPersist=10m".into(),
    ]
}

pub const REMOTE_JAUNTD: &str = "~/.jaunt/bin/jauntd";

async fn connect_remote(alias: &str) -> Result<(Reader, Writer)> {
    let _ = jaunt_core::paths::ensure_private_dir(&jaunt_core::paths::run_dir());
    // Version check first so a stale helper is never used silently (R2).
    let probe = crate::remote::remote_version(alias).await?;
    let want = env!("CARGO_PKG_VERSION");
    match probe {
        Some(v) if v == want => {}
        Some(v) => bail!("needs_install: remote helper is {v}, app expects {want}"),
        None => bail!("needs_install: jaunt helper is not installed on {alias}"),
    }
    let mut child = tokio::process::Command::new("ssh")
        .args(ssh_base_args())
        .arg(alias)
        .arg(format!("{REMOTE_JAUNTD} proxy"))
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

async fn connection_loop(app: AppHandle, host: Arc<Host>, mut stop: watch::Receiver<bool>) {
    let mut backoff = Duration::from_millis(300);
    let mut attempt = 0u32;
    loop {
        if *stop.borrow() {
            return;
        }
        let status = if attempt == 0 {
            HostStatus::Connecting
        } else {
            HostStatus::Reconnecting
        };
        host.set_status(&app, status, None);
        let connected = if host.remote {
            connect_remote(&host.id).await
        } else {
            connect_local().await
        };
        match connected {
            Ok((reader, writer)) => {
                backoff = Duration::from_millis(300);
                if let Err(e) = run_link(&app, &host, reader, writer, &mut stop).await {
                    tracing::info!(host = %host.id, "link ended: {e:#}");
                }
                host.link.lock().unwrap().take();
                host.fail_pending("connection lost");
                if *stop.borrow() {
                    return;
                }
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if let Some(m) = msg.strip_prefix("needs_install: ") {
                    host.set_status(&app, HostStatus::NeedsInstall, Some(m.to_string()));
                    // Wait for the user to install, then retry.
                    tokio::select! {
                        _ = host.retry.notified() => {}
                        _ = stop.changed() => return,
                    }
                    attempt = 0;
                    continue;
                }
                host.set_status(&app, HostStatus::Error, Some(msg));
            }
        }
        attempt += 1;
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = host.retry.notified() => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}

async fn run_link(
    app: &AppHandle,
    host: &Arc<Host>,
    mut reader: Reader,
    mut writer: Writer,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    writer
        .write_all(&encode_frame(&Frame::Json(Message::Hello {
            protocol: PROTOCOL_VERSION,
            client: "jaunt-app".into(),
        })))
        .await?;
    writer.flush().await?;

    let mut decoder = FrameDecoder::new();
    let mut buf = vec![0u8; 256 * 1024];
    // Handshake.
    let welcome = loop {
        let n = tokio::time::timeout(Duration::from_secs(15), reader.read(&mut buf))
            .await
            .context("handshake timed out")??;
        if n == 0 {
            bail!("daemon closed the connection during handshake");
        }
        decoder.push(&buf[..n]);
        if let Some(frame) = decoder.next_frame()? {
            break frame;
        }
    };
    match welcome {
        Frame::Json(Message::Welcome {
            daemon_version,
            host: hostname,
            ..
        }) => {
            let mut i = host.info.lock().unwrap();
            i.daemon_version = Some(daemon_version);
            i.hostname = Some(hostname);
        }
        Frame::Json(Message::Response { error: Some(e), .. }) => bail!("{}", e.message),
        other => bail!("unexpected handshake reply {other:?}"),
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    *host.link.lock().unwrap() = Some(Link { tx });
    // Fetch home for path display; ignore failures.
    let h2 = host.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(v) = h2
            .request(jaunt_proto::methods::DAEMON_INFO, Value::Null)
            .await
        {
            h2.info.lock().unwrap().home = v.get("home").and_then(Value::as_str).map(String::from);
        }
        h2.set_status(&app2, HostStatus::Connected, None);
    });

    let writer_task = tauri::async_runtime::spawn(async move {
        while let Some(mut bytes) = rx.recv().await {
            while let Ok(more) = rx.try_recv() {
                bytes.extend_from_slice(&more);
            }
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });

    let result = loop {
        // Frames already buffered alongside the handshake.
        while let Some(frame) = decoder.next_frame()? {
            dispatch(app, host, frame);
        }
        tokio::select! {
            n = reader.read(&mut buf) => {
                let n = n?;
                if n == 0 {
                    break Ok(());
                }
                decoder.push(&buf[..n]);
            }
            _ = stop.changed() => break Ok(()),
            _ = host.retry.notified() => break Ok(()),
        }
    };
    writer_task.abort();
    result
}

#[derive(Serialize, Clone)]
struct DaemonEvent<'a> {
    host: &'a str,
    name: String,
    data: Value,
}

fn dispatch(app: &AppHandle, host: &Arc<Host>, frame: Frame) {
    match frame {
        Frame::Output { session, data } => host.push_output(session, &data),
        Frame::Json(Message::Response { id, result, error }) => {
            if let Some(tx) = host.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(match error {
                    Some(e) => Err(e),
                    None => Ok(result.unwrap_or(Value::Null)),
                });
            }
        }
        Frame::Json(Message::Event { name, data }) => {
            if name == jaunt_proto::methods::EV_AGENT_ATTENTION || name.starts_with("session.") {
                // Make sure output that preceded the state change is on screen first.
                host.flush_output();
            }
            let _ = app.emit(
                "daemon-event",
                DaemonEvent {
                    host: &host.id,
                    name,
                    data,
                },
            );
        }
        _ => {}
    }
}
