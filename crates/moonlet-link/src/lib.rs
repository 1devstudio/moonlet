//! One app-side connection to a `moonletd` (ADR 0008): the desktop app's
//! local daemon, SSH hosts (R1, R3) and tailnet hosts (X57), and the phone
//! app's paired Macs (X39).
//!
//! A [`Host`] keeps one connection and reconnects with backoff on its own.
//! The daemon keeps sessions alive meanwhile, so a dropped link only pauses
//! output. How the bytes get to the daemon is the [`Connector`]'s business;
//! what the app does with statuses and events is the [`Events`]'s.
//!
//! PTY output is batched every 8 ms into one buffer per host: repeated
//! `[u32 BE session][u32 BE len][bytes]` records. A session id with
//! [`RESET_FLAG`] set carries an attach snapshot.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_proto::{
    Frame, FrameDecoder, Message, PROTOCOL_VERSION, PackAssembler, RpcError, TerminalId,
    encode_frame,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot, watch};

pub mod tailnet;

/// High bit on a session id in the output stream: reset the terminal and
/// treat the record as an attach snapshot.
pub const RESET_FLAG: TerminalId = 0x8000_0000;

/// A connection error whose message starts with this waits for
/// [`Host::reconnect`] instead of retrying: the remote helper is missing or
/// a different version and needs the user's consent to install (R2).
pub const NEEDS_INSTALL: &str = "needs_install: ";

/// A connection error for a daemon that speaks another protocol and cannot
/// be installed from here (X57). Like [`NEEDS_INSTALL`], the host waits for
/// [`Host::reconnect`]. `os` is the daemon's, when it says (X58).
#[derive(Debug, Clone, PartialEq)]
pub struct NeedsUpdate {
    pub daemon_version: String,
    pub os: Option<String>,
}

impl std::fmt::Display for NeedsUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the host runs moonletd {}, which speaks another protocol", self.daemon_version)
    }
}

impl std::error::Error for NeedsUpdate {}

/// A connection error for a daemon that refused the credentials, such as a
/// removed device's token (X57); it holds the daemon's message. Retrying
/// cannot help until the user does something, so the host waits.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HostStatus {
    Connecting,
    Connected,
    Reconnecting,
    /// The remote helper is missing or a different version; needs consent to install.
    NeedsInstall,
    /// The daemon speaks another protocol; `daemon_version` says which side
    /// to update (X57).
    NeedsUpdate,
    /// The daemon no longer accepts this device; `message` is its reason (X57).
    Refused,
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
    /// `macos` or `linux`, from a tailnet daemon's `authed` (X58).
    pub os: Option<String>,
}

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Opens the byte stream to a daemon.
pub trait Connector: Send + Sync + 'static {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>>;

    /// Sees the daemon's reply to `hello` before the link is used. An error
    /// ends this attempt; the host then reconnects.
    fn welcomed<'a>(&'a self, _reply: &'a Frame) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

/// Where a host's statuses and daemon events go.
pub trait Events: Send + Sync + 'static {
    fn status(&self, info: &HostInfo);
    fn event(&self, host: &str, name: String, data: Value);
}

/// Answers the requests a daemon sends on the link. Only a worker's link
/// to its central host gets any (X41); a host without a handler refuses
/// them with `unknown_method`.
pub trait Requests: Send + Sync + 'static {
    fn request(&self, method: String, params: Value) -> BoxFuture<'static, Result<Value, RpcError>>;
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;
type OutputSink = Box<dyn Fn(Vec<u8>) + Send + Sync>;

struct Link {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Bytes that go out ahead of everything queued on `tx`: replies to
    /// pings, which must not wait behind a pack (X60).
    urgent: mpsc::UnboundedSender<Vec<u8>>,
}

pub struct Host {
    pub id: String,
    remote: bool,
    client: String,
    info: Mutex<HostInfo>,
    link: Mutex<Option<Link>>,
    pending: Mutex<Pending>,
    /// Request id of each in-flight `terminal.attach`, with its session.
    attaching: Mutex<HashMap<u64, TerminalId>>,
    next_id: AtomicU64,
    output: Mutex<Option<OutputSink>>,
    requests: Mutex<Option<Arc<dyn Requests>>>,
    /// Packs the daemon sent, by transfer id, for its requests (X60).
    packs: Mutex<PackAssembler>,
    next_transfer: AtomicU32,
    batch: Mutex<Vec<u8>>,
    stop: watch::Sender<bool>,
    /// Kicks the reconnect loop to retry immediately.
    retry: tokio::sync::Notify,
    /// Why the daemon (or the Mac routing to it) ended the last link, shown
    /// while reconnecting.
    failure: Mutex<Option<String>>,
    events: Arc<dyn Events>,
    rt: Handle,
    /// What takes input the daemon relays for one of this machine's
    /// terminals (X72).
    relayed_input: Mutex<Option<RelayedInput>>,
}

/// Takes input for relay `id`, from the central host (X72).
pub type RelayedInput = Arc<dyn Fn(TerminalId, Vec<u8>) + Send + Sync>;

/// What a new [`Host`] is called and how it introduces itself.
pub struct HostOptions {
    pub id: String,
    pub label: String,
    pub remote: bool,
    /// The `client` name sent in `hello`.
    pub client: String,
}

impl Host {
    /// Creates the host and starts connecting on `rt`.
    pub fn start(
        opts: HostOptions,
        connector: Arc<dyn Connector>,
        events: Arc<dyn Events>,
        rt: Handle,
    ) -> Arc<Host> {
        let (stop, stop_rx) = watch::channel(false);
        let host = Arc::new(Host {
            id: opts.id.clone(),
            remote: opts.remote,
            client: opts.client,
            info: Mutex::new(HostInfo {
                id: opts.id,
                label: opts.label,
                remote: opts.remote,
                status: HostStatus::Connecting,
                message: None,
                daemon_version: None,
                hostname: None,
                home: None,
                os: None,
            }),
            link: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            attaching: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            output: Mutex::new(None),
            requests: Mutex::new(None),
            packs: Mutex::new(PackAssembler::default()),
            next_transfer: AtomicU32::new(1),
            batch: Mutex::new(Vec::new()),
            stop,
            retry: tokio::sync::Notify::new(),
            failure: Mutex::new(None),
            events,
            rt: rt.clone(),
            relayed_input: Mutex::new(None),
        });
        rt.spawn(flush_loop(Arc::downgrade(&host)));
        rt.spawn(connection_loop(host.clone(), connector, stop_rx));
        host
    }

    pub fn info(&self) -> HostInfo {
        self.info.lock().unwrap().clone()
    }

    pub fn remote(&self) -> bool {
        self.remote
    }

    /// Where batched PTY output goes from now on.
    pub fn set_output(&self, sink: impl Fn(Vec<u8>) + Send + Sync + 'static) {
        *self.output.lock().unwrap() = Some(Box::new(sink));
    }

    /// What takes the input the daemon relays for one of this machine's
    /// terminals from now on (X72).
    pub fn set_relayed_input(&self, sink: RelayedInput) {
        *self.relayed_input.lock().unwrap() = Some(sink);
    }

    /// Sends output of a terminal of this machine that the central host
    /// relays to one of its clients as `relay` (X72).
    pub fn send_output(&self, relay: TerminalId, data: Vec<u8>) -> Result<(), RpcError> {
        let link = self.link.lock().unwrap();
        let link = link
            .as_ref()
            .ok_or_else(|| RpcError::new("disconnected", "not connected"))?;
        let bytes = encode_frame(&Frame::Output { terminal: relay, data })
            .map_err(|e| RpcError::new("too_large", e.to_string()))?;
        link.tx
            .send(bytes)
            .map_err(|_| RpcError::new("disconnected", "connection closed"))
    }

    /// What answers the daemon's requests from now on (X41).
    pub fn set_requests(&self, handler: Arc<dyn Requests>) {
        *self.requests.lock().unwrap() = Some(handler);
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
            if method == moonlet_proto::methods::TERMINAL_ATTACH
                && let Some(sid) = params.get("id").and_then(Value::as_u64)
            {
                self.attaching.lock().unwrap().insert(id, sid as TerminalId);
            }
            // A terminal of another member, through the central host (X72):
            // its relay id comes with the reply.
            if method == moonlet_proto::methods::SESSION_ATTACH {
                self.attaching.lock().unwrap().insert(id, RELAY_IN_REPLY);
            }
            let frame = Frame::Json(Message::Request {
                id,
                method: method.into(),
                params,
            });
            let bytes = encode_frame(&frame).map_err(|e| {
                self.forget_request(id);
                RpcError::new("too_large", e.to_string())
            })?;
            if link.tx.send(bytes).is_err() {
                self.forget_request(id);
                return Err(RpcError::new("disconnected", "connection closed"));
            }
        }
        match tokio::time::timeout(request_timeout(method), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => {
                self.forget_request(id);
                Err(RpcError::new(
                    "disconnected",
                    "connection lost before reply",
                ))
            }
            Err(_) => {
                self.forget_request(id);
                Err(RpcError::new("timeout", format!("{method} timed out")))
            }
        }
    }

    /// Drops a request that will get no reply, including an attach's
    /// pending snapshot routing.
    fn forget_request(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
        self.attaching.lock().unwrap().remove(&id);
    }

    /// Sends `pack` to the daemon in [`Frame::Pack`] chunks and returns its
    /// transfer id, for the request that uses it to name (X60). Frames go
    /// out in order, so the pack is whole before that request arrives.
    pub fn send_pack(&self, pack: &[u8]) -> Result<u32, RpcError> {
        let link = self.link.lock().unwrap();
        let link = link
            .as_ref()
            .ok_or_else(|| RpcError::new("disconnected", "not connected"))?;
        let transfer = self.next_transfer.fetch_add(1, Ordering::Relaxed);
        // Chunk by chunk, so a ping's reply can go out between two.
        for f in moonlet_proto::pack_frames(transfer, pack) {
            let bytes = encode_frame(&f).map_err(|e| RpcError::new("too_large", e.to_string()))?;
            link.tx
                .send(bytes)
                .map_err(|_| RpcError::new("disconnected", "connection closed"))?;
        }
        Ok(transfer)
    }

    /// Sends output of routed command `run` to the central host (X62):
    /// `stream` 1 is stdout, 2 stderr.
    pub fn send_run_output(&self, run: u32, stream: u8, data: Vec<u8>) -> Result<(), RpcError> {
        let link = self.link.lock().unwrap();
        let link = link
            .as_ref()
            .ok_or_else(|| RpcError::new("disconnected", "not connected"))?;
        let bytes = encode_frame(&Frame::RunOutput { run, stream, data })
            .map_err(|e| RpcError::new("too_large", e.to_string()))?;
        link.tx
            .send(bytes)
            .map_err(|_| RpcError::new("disconnected", "connection closed"))
    }

    /// The pack the daemon sent as `transfer`, once it is whole; once.
    pub fn take_pack(&self, transfer: u32) -> Option<Vec<u8>> {
        self.packs.lock().unwrap().take(transfer)
    }

    pub fn input(&self, session: TerminalId, data: Vec<u8>) -> Result<(), RpcError> {
        let link = self.link.lock().unwrap();
        let link = link
            .as_ref()
            .ok_or_else(|| RpcError::new("disconnected", "not connected"))?;
        let bytes = encode_frame(&Frame::Input {
            terminal: session,
            data,
        })
        .map_err(|e| RpcError::new("too_large", e.to_string()))?;
        link.tx
            .send(bytes)
            .map_err(|_| RpcError::new("disconnected", "connection closed"))
    }

    /// Drops the current link and retries at once.
    pub fn reconnect(&self) {
        self.link.lock().unwrap().take();
        // Wake a waiting link loop only: a stored permit would drop the next
        // fresh link right after its handshake.
        self.retry.notify_waiters();
    }

    /// Ends the host's connection for good.
    pub fn stop(&self) {
        let _ = self.stop.send(true);
        self.link.lock().unwrap().take();
    }

    fn set_status(&self, status: HostStatus, message: Option<String>) {
        let info = {
            let mut i = self.info.lock().unwrap();
            i.status = status;
            i.message = message;
            i.clone()
        };
        self.events.status(&info);
    }

    fn push_output(&self, session: TerminalId, data: &[u8]) {
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
        if let Some(sink) = self.output.lock().unwrap().as_ref() {
            sink(buf);
        }
    }

    fn fail_pending(&self, why: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(RpcError::new("disconnected", why)));
        }
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

/// How long to wait before each retry: 300 ms, doubling up to 5 s, and
/// back to 300 ms once a connection is made.
struct Backoff(Duration);

impl Backoff {
    const FIRST: Duration = Duration::from_millis(300);
    const MAX: Duration = Duration::from_secs(5);

    fn new() -> Backoff {
        Backoff(Self::FIRST)
    }

    fn next(&mut self) -> Duration {
        let wait = self.0;
        self.0 = (self.0 * 2).min(Self::MAX);
        wait
    }

    fn reset(&mut self) {
        self.0 = Self::FIRST;
    }
}

async fn connection_loop(
    host: Arc<Host>,
    connector: Arc<dyn Connector>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = Backoff::new();
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
        let failure = host.failure.lock().unwrap().take();
        host.set_status(status, failure);
        let connected = connector.connect().await;
        // Stopped while connecting: whatever came of it is no news.
        if *stop.borrow() {
            return;
        }
        match connected {
            Ok((reader, writer)) => {
                backoff.reset();
                if let Err(e) = run_link(&host, &*connector, reader, writer, &mut stop).await {
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
                let waiting = if let Some(m) = msg.strip_prefix(NEEDS_INSTALL) {
                    Some((HostStatus::NeedsInstall, Some(m.to_string())))
                } else if let Some(n) = e.downcast_ref::<NeedsUpdate>() {
                    let mut i = host.info.lock().unwrap();
                    i.daemon_version = Some(n.daemon_version.clone());
                    i.os = n.os.clone();
                    drop(i);
                    Some((HostStatus::NeedsUpdate, None))
                } else {
                    e.downcast_ref::<Refused>()
                        .map(|r| (HostStatus::Refused, Some(r.0.clone())))
                };
                if let Some((status, message)) = waiting {
                    host.set_status(status, message);
                    // Wait for the user to act, then retry.
                    tokio::select! {
                        _ = host.retry.notified() => {}
                        _ = stop.changed() => return,
                    }
                    attempt = 0;
                    continue;
                }
                host.set_status(HostStatus::Error, Some(msg));
            }
        }
        attempt += 1;
        tokio::select! {
            _ = tokio::time::sleep(backoff.next()) => {}
            _ = host.retry.notified() => {}
            _ = stop.changed() => return,
        }
    }
}

async fn run_link(
    host: &Arc<Host>,
    connector: &dyn Connector,
    mut reader: Reader,
    mut writer: Writer,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    writer
        .write_all(&encode_frame(&Frame::Json(Message::Hello {
            protocol: PROTOCOL_VERSION,
            client: host.client.clone(),
        }))?)
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
    connector.welcomed(&welcome).await?;
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

    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (urgent, urgent_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    // A pack cut off by the last link will never be whole.
    *host.packs.lock().unwrap() = PackAssembler::default();
    *host.link.lock().unwrap() = Some(Link { tx, urgent });
    // Fetch home for path display; ignore failures.
    let h2 = host.clone();
    host.rt.spawn(async move {
        if let Ok(v) = h2
            .request(moonlet_proto::methods::DAEMON_INFO, Value::Null)
            .await
        {
            h2.info.lock().unwrap().home = v.get("home").and_then(Value::as_str).map(String::from);
        }
        // Not when the link dropped meanwhile: the loop reports that.
        if h2.link.lock().unwrap().is_some() {
            h2.set_status(HostStatus::Connected, None);
        }
    });

    let writer_task = host.rt.spawn(write_link(writer, urgent_rx, rx));

    let result = 'link: loop {
        // Frames already buffered alongside the handshake.
        while let Some(frame) = decoder.next_frame()? {
            if let Err(e) = dispatch(host, frame) {
                break 'link Err(e.into());
            }
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

/// Writes queued bytes, coalescing what is already queued. `urgent` bytes
/// go out first, and between any two pack chunks (each up to 1 MiB).
async fn write_link<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut urgent: mpsc::UnboundedReceiver<Vec<u8>>,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let mut urgent_open = true;
    loop {
        let mut bytes = Vec::new();
        while let Ok(more) = urgent.try_recv() {
            bytes.extend_from_slice(&more);
        }
        if bytes.is_empty() {
            tokio::select! {
                biased;
                b = urgent.recv(), if urgent_open => match b {
                    Some(b) => bytes = b,
                    None => {
                        urgent_open = false;
                        continue;
                    }
                },
                b = rx.recv() => match b {
                    Some(b) => bytes = b,
                    None => return,
                },
            }
        }
        while bytes.len() < 256 * 1024 {
            if let Ok(more) = urgent.try_recv() {
                bytes.extend_from_slice(&more);
                continue;
            }
            match rx.try_recv() {
                Ok(more) => bytes.extend_from_slice(&more),
                Err(_) => break,
            }
        }
        if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
            return;
        }
    }
}

/// In `attaching`, for a `session.attach`: the terminal is the relay id
/// the reply names (X72).
const RELAY_IN_REPLY: TerminalId = TerminalId::MAX;

/// Fails only on a pack over its limits, which ends the link.
fn dispatch(host: &Arc<Host>, frame: Frame) -> Result<(), moonlet_proto::PackError> {
    match frame {
        Frame::Output { terminal, data } => host.push_output(terminal, &data),
        // Input a client of the central host typed into a terminal of this
        // machine it relays (X72).
        Frame::Input { terminal, data } => {
            let sink = host.relayed_input.lock().unwrap().clone();
            if let Some(sink) = sink {
                sink(terminal, data);
            }
        }
        Frame::Pack { transfer, data } => host.packs.lock().unwrap().push(transfer, data)?,
        // An error no request asked for: the daemon says why it ends the link.
        Frame::Json(Message::Response {
            id: 0,
            error: Some(e),
            ..
        }) => {
            *host.failure.lock().unwrap() = Some(e.message.clone());
            host.set_status(HostStatus::Error, Some(e.message));
        }
        Frame::Json(Message::Response {
            id,
            mut result,
            error,
        }) => {
            // Attach snapshots travel on the output stream, flagged as a reset,
            // so the webview sees them strictly before the live output after them.
            let attached = host.attaching.lock().unwrap().remove(&id).and_then(|sid| {
                if sid != RELAY_IN_REPLY {
                    return Some(sid);
                }
                result
                    .as_ref()
                    .and_then(|r| r["info"]["id"].as_u64())
                    .and_then(|i| TerminalId::try_from(i).ok())
            });
            if let Some(session) = attached
                && let Some(snapshot) = result
                    .as_mut()
                    .and_then(|r| r.as_object_mut())
                    .and_then(|o| o.remove("snapshot"))
            {
                host.push_output(
                    session | RESET_FLAG,
                    snapshot.as_str().unwrap_or("").as_bytes(),
                );
            }
            if let Some(tx) = host.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(match error {
                    Some(e) => Err(e),
                    None => Ok(result.unwrap_or(Value::Null)),
                });
            }
        }
        Frame::Json(Message::Request { id, method, params }) => answer(host, id, method, params),
        Frame::Json(Message::Event { name, data }) => {
            if name == moonlet_proto::methods::EV_AGENT_ATTENTION || name.starts_with("session.") {
                // Make sure output that preceded the state change is on screen first.
                host.flush_output();
            }
            host.events.event(&host.id, name, data);
        }
        _ => {}
    }
    Ok(())
}

/// Runs the handler for a daemon's request and sends its reply on the
/// link the request came on, if that link is still up.
fn answer(host: &Arc<Host>, id: u64, method: String, params: Value) {
    let handler = host.requests.lock().unwrap().clone();
    // The link this request came on: a reply must not reach a newer one,
    // whose daemon numbers its own requests from 1 again.
    // A ping's reply goes ahead of a pack being sent, or a big pack on a
    // slow link would make the central host drop this worker (X60).
    let Some(link) = host.link.lock().unwrap().as_ref().map(|l| {
        if method == moonlet_proto::methods::WORKER_PING {
            l.urgent.clone()
        } else {
            l.tx.clone()
        }
    }) else {
        return;
    };
    host.rt.clone().spawn(async move {
        let result = match handler {
            Some(h) => h.request(method, params).await,
            None => Err(RpcError::new("unknown_method", format!("unknown method {method}"))),
        };
        let reply = match result {
            Ok(value) => Message::ok(id, value),
            Err(e) => Message::err(id, e),
        };
        let bytes = match encode_frame(&Frame::Json(reply)) {
            Ok(b) => b,
            Err(e) => match encode_frame(&Frame::Json(Message::err(id, RpcError::new("too_large", e.to_string())))) {
                Ok(b) => b,
                Err(_) => return,
            },
        };
        let _ = link.send(bytes);
    });
}

/// How long the app waits for a daemon reply. `claude update` gets ten
/// minutes in the daemon (X36): wait a little longer, so its own timeout
/// is the one reported.
fn request_timeout(method: &str) -> Duration {
    let secs = if method == moonlet_proto::methods::CLAUDE_UPDATE {
        660
    } else if method.starts_with("gh.") || method.starts_with("workspace.") || method.starts_with("repo.") {
        180
    } else if method.starts_with("sync.")
        || method == moonlet_proto::methods::SESSION_OPEN
        || method == moonlet_proto::methods::SESSION_OFFER
        || method == moonlet_proto::methods::SESSION_TRANSCRIPT
        || method == moonlet_proto::methods::SESSION_TRANSCRIPT_FETCH
    {
        // A copy's first pack can be a whole repository's history (X60,
        // X72), and opening one may clone the project first.
        600
    } else {
        60
    };
    Duration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pings_reply_never_waits_behind_a_pack_queued_before_it() {
        // X60: this worker sends a 3 MiB pack, then answers a ping.
        let (tx, rx) = mpsc::unbounded_channel();
        let (urgent_tx, urgent) = mpsc::unbounded_channel();
        for f in moonlet_proto::pack_frames(7, &vec![0u8; 3 * 1024 * 1024]) {
            tx.send(encode_frame(&f).unwrap()).unwrap();
        }
        urgent_tx
            .send(encode_frame(&Frame::Json(Message::ok(1, serde_json::json!({})))).unwrap())
            .unwrap();
        drop((tx, urgent_tx));
        let (ours, mut theirs) = tokio::io::duplex(64 * 1024);
        tokio::spawn(write_link(ours, urgent, rx));
        let mut order = Vec::new();
        while let Some(f) = moonlet_proto::read_frame(&mut theirs).await.unwrap() {
            order.push(match f {
                Frame::Pack { data, .. } if data.is_empty() => "end",
                Frame::Pack { .. } => "chunk",
                Frame::Json(Message::Response { .. }) => "pong",
                _ => "other",
            });
        }
        assert_eq!(order, ["pong", "chunk", "chunk", "chunk", "end"]);
    }

    #[test]
    fn retries_wait_longer_each_time_up_to_five_seconds() {
        // X41's worked sequence, in milliseconds.
        let mut b = Backoff::new();
        let waits: Vec<u128> = (0..7).map(|_| b.next().as_millis()).collect();
        assert_eq!(waits, [300, 600, 1200, 2400, 4800, 5000, 5000]);
        b.reset();
        assert_eq!(b.next(), Duration::from_millis(300));
    }

    #[test]
    fn waits_longer_than_the_daemon_for_claude_update() {
        // The daemon gives `claude update` ten minutes (X36); the app must
        // not give up first.
        assert_eq!(request_timeout("claude.update"), Duration::from_secs(660));
        assert_eq!(request_timeout("gh.prs"), Duration::from_secs(180));
        assert_eq!(request_timeout("claude.version"), Duration::from_secs(60));
        // A lookup asks gh twice: `gh auth status`, then `gh repo view` (X59).
        assert_eq!(request_timeout("repo.lookup"), Duration::from_secs(180));
    }
}
