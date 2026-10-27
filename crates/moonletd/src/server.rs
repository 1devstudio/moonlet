//! Socket server: accepts clients, runs the handshake, dispatches requests
//! and streams events and PTY output back.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_core::terminal::{ClientId, ClientTx, dequeued};
use std::sync::atomic::AtomicUsize;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, PackAssembler, RpcError, encode_frame, read_frame};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot};

use crate::daemon::Daemon;

/// Events a paired device never hears: design systems and designs stay on
/// the Mac (X64, X65). A new Design mode event that names a design or its
/// files goes here.
const MAC_ONLY_EVENTS: [&str; 2] = [moonlet_proto::methods::EV_DESIGN_CHANGED, moonlet_proto::methods::EV_DESIGN_OPEN];

/// Binds the daemon socket. Refuses to start if another daemon answers on it.
pub async fn bind(path: &Path) -> Result<UnixListener> {
    if let Some(dir) = path.parent() {
        // Only moonlet's own directories are created and locked down; a
        // socket elsewhere (`--socket`, `MOONLET_SOCK`) must not change the
        // mode of a directory moonlet does not own, such as `$HOME`.
        let default_dir = moonlet_core::paths::default_socket_path().parent().map(Path::to_path_buf);
        if default_dir.as_deref() == Some(dir) {
            moonlet_core::paths::ensure_private_dir(dir)?;
        } else {
            let mode = std::fs::metadata(dir)
                .with_context(|| format!("socket directory {}", dir.display()))?
                .permissions()
                .mode();
            if mode & 0o022 != 0 && mode & 0o1000 == 0 {
                bail!("socket directory {} is writable by other users", dir.display());
            }
        }
    }
    if path.exists() {
        if UnixStream::connect(path).await.is_ok() {
            bail!("another moonletd is already listening on {}", path.display());
        }
        std::fs::remove_file(path).ok();
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub async fn serve(daemon: Arc<Daemon>, listener: UnixListener, socket: PathBuf) -> Result<()> {
    let my_uid = nix::unistd::getuid().as_raw();
    let mut shutdown = daemon.shutdown_signal();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                match stream.peer_cred() {
                    Ok(cred) if cred.uid() == my_uid => {}
                    other => {
                        tracing::warn!("rejecting connection from foreign peer: {other:?}");
                        continue;
                    }
                }
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    let (r, w) = stream.into_split();
                    if let Err(e) = handle_connection(daemon, r, w, None).await {
                        tracing::debug!("connection ended: {e:#}");
                    }
                });
            }
            _ = shutdown.changed() => break,
        }
    }
    daemon.chats.shutdown();
    // Only remove the socket if it is still ours (an upgraded daemon may own it now).
    // After a handoff the socket path belongs to the new daemon.
    if !daemon.handed_off() {
        std::fs::remove_file(&socket).ok();
        std::fs::remove_file(crate::upgrade::pid_file(&socket)).ok();
    }
    Ok(())
}

/// Queued bytes past which [`Conn::request_after_queue`] waits before its
/// timeout starts: about what a slow link writes in a second or two.
const QUEUED_BEFORE_WAITING: usize = 256 * 1024;

/// Per-connection context passed to request handlers.
pub struct Conn {
    pub id: ClientId,
    pub tx: ClientTx,
    /// Frames that go out ahead of everything queued on `tx`: pings, which
    /// must not wait behind a pack (X60).
    urgent: mpsc::UnboundedSender<Frame>,
    pub client: String,
    /// The paired phone's device id on a phone connection (X39).
    pub phone: Option<String>,
    /// Requests this daemon sent the client, waiting for its reply. Only a
    /// worker gets any (X41).
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>,
    /// Ids from 1: 0 is the reply that ends a link.
    next_request: AtomicU64,
    closed: Notify,
    /// Packs the client sent for its requests, by transfer id (X60).
    packs: Mutex<PackAssembler>,
    next_transfer: AtomicU32,
    /// Set once the connection has ended.
    gone: std::sync::atomic::AtomicBool,
    /// A cloud machine's connection (X63).
    pub cloud: std::sync::atomic::AtomicBool,
}

impl Conn {
    /// Sends the client a request and waits for its reply (X41).
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = Frame::Json(Message::Request {
            id,
            method: method.into(),
            params,
        });
        // A ping asks whether the worker is there: it must not wait behind a
        // pack, or a big one on a slow link would drop the worker (X60).
        let sent = if method == moonlet_proto::methods::WORKER_PING {
            self.urgent.send(frame).is_ok()
        } else {
            self.tx.send(frame)
        };
        if !sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcError::new("disconnected", "connection closed"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(RpcError::new("disconnected", "connection closed")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcError::new("timeout", format!("{method} timed out")))
            }
        }
    }

    /// [`Conn::request`] whose `timeout` starts once everything queued
    /// before it, such as a pack, has been written: a big pack on a slow
    /// link doesn't eat the time the client has to answer (X60).
    pub async fn request_after_queue(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        // A small pack goes out at once; only a big one is waited for.
        while self.tx.queued() > QUEUED_BEFORE_WAITING {
            if self.gone.load(Ordering::Relaxed) {
                return Err(RpcError::new("disconnected", "connection closed"));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.request(method, params, timeout).await
    }

    /// Sends `pack` in [`Frame::Pack`] chunks and returns its transfer id,
    /// for the request that uses it to name (X60). Frames go out in order,
    /// so the pack is whole before that request arrives.
    pub fn send_pack(&self, pack: &[u8]) -> Result<u32, RpcError> {
        let transfer = self.next_transfer.fetch_add(1, Ordering::Relaxed);
        for f in moonlet_proto::pack_frames(transfer, pack) {
            if !self.tx.send(f) {
                return Err(RpcError::new("disconnected", "connection closed"));
            }
        }
        Ok(transfer)
    }

    /// The pack the client sent as `transfer`, once it is whole; once.
    pub fn take_pack(&self, transfer: u32) -> Option<Vec<u8>> {
        self.packs.lock().unwrap().take(transfer)
    }

    /// The connection has ended.
    pub fn is_gone(&self) -> bool {
        self.gone.load(Ordering::Relaxed)
    }

    /// Ends the connection, as if the client had closed it.
    pub fn close(&self) {
        self.closed.notify_one();
    }

    /// Fails every request still waiting for this client's reply: it is gone.
    fn fail_pending(&self) {
        self.gone.store(true, Ordering::Relaxed);
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(RpcError::new("disconnected", "connection closed")));
        }
    }

    fn reply(&self, id: u64, reply: Result<Value, RpcError>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(reply);
        }
    }
}

/// Serves one client. `phone` is the device id of a phone connection (X39).
pub async fn handle_connection<R, W>(
    daemon: Arc<Daemon>,
    mut reader: R,
    writer: W,
    phone: Option<String>,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (raw_tx, rx) = mpsc::unbounded_channel::<Frame>();
    let tx = ClientTx::new(raw_tx);
    let (urgent, urgent_rx) = mpsc::unbounded_channel::<Frame>();
    let writer_task = tokio::spawn(write_loop(writer, urgent_rx, rx, tx.counter()));

    let client = match read_frame(&mut reader).await? {
        Some(Frame::Json(Message::Hello { protocol, client })) => {
            if protocol != PROTOCOL_VERSION {
                let _ = tx.send(Frame::Json(Message::err(
                    0,
                    RpcError::new(
                        "protocol_mismatch",
                        format!(
                            "daemon speaks protocol {PROTOCOL_VERSION}, client speaks {protocol}"
                        ),
                    ),
                )));
                drop(tx);
                let _ = writer_task.await;
                return Ok(());
            }
            if phone.is_some() && client == crate::daemon::CLI_CLIENT {
                // A phone is the app, never an agent's CLI (X39).
                let _ = tx.send(Frame::Json(Message::err(
                    0,
                    RpcError::new("forbidden", "a phone cannot connect as the moonlet CLI"),
                )));
                drop(tx);
                let _ = writer_task.await;
                return Ok(());
            }
            client
        }
        // A paired Mac may ask for an update in place of `hello`, whatever
        // protocol it speaks (X69). This exchange never changes.
        Some(Frame::Json(Message::Request { id, method, params }))
            if method == moonlet_proto::methods::DAEMON_UPDATE && phone.is_some() =>
        {
            let device = phone.as_deref().unwrap_or_default();
            let reply = match daemon.update_before_hello(device, params).await {
                Ok(v) => Message::ok(id, v),
                Err(e) => Message::err(id, e),
            };
            let _ = tx.send(Frame::Json(reply));
            drop(tx);
            let _ = writer_task.await;
            return Ok(());
        }
        _ => bail!("expected hello"),
    };
    let _ = tx.send(Frame::Json(Message::Welcome {
        protocol: PROTOCOL_VERSION,
        daemon_version: env!("CARGO_PKG_VERSION").into(),
        host: moonlet_core::paths::hostname(),
        pid: std::process::id(),
    }));

    let conn = Arc::new(Conn {
        id: daemon.terminals.new_client_id(),
        tx: tx.clone(),
        urgent,
        client,
        phone,
        pending: Mutex::new(HashMap::new()),
        next_request: AtomicU64::new(1),
        closed: Notify::new(),
        packs: Mutex::new(PackAssembler::default()),
        next_transfer: AtomicU32::new(1),
        gone: std::sync::atomic::AtomicBool::new(false),
        cloud: std::sync::atomic::AtomicBool::new(false),
    });
    tracing::debug!(client = %conn.client, id = conn.id, "client connected");

    // Fan daemon events out to this client.
    let mut events = daemon.terminals.subscribe_events();
    let ev_tx = tx.clone();
    // The text an agent asks to read is for the app alone, not for the
    // agent's own `moonlet` connections (X31).
    let is_cli = conn.client == crate::daemon::CLI_CLIENT;
    // A job's output is for the app and paired devices, as `job.output` is
    // (X62): neither an agent's CLI nor a worker hears it.
    let no_jobs = is_cli || conn.client == crate::link::WORKER_CLIENT;
    let phone = conn.phone.is_some();
    // A cloud machine (X63) reaches only what a worker needs: no terminal,
    // and none of the central host's events.
    let cloud = conn
        .phone
        .as_deref()
        .is_some_and(|d| daemon.machines.machine_of(d).is_some());
    conn.cloud.store(cloud, Ordering::Relaxed);
    let event_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(_) if cloud => {}
                Ok(Message::Event { name, .. })
                    if is_cli && name == moonlet_proto::methods::EV_TERMINAL_READ_REQUEST => {}
                Ok(Message::Event { name, .. })
                    if no_jobs
                        && (name == moonlet_proto::methods::EV_JOB_OUTPUT
                            || name == moonlet_proto::methods::EV_JOB_CHANGED) => {}
                // Setup questions go where they are answered: the app (X62).
                Ok(Message::Event { name, .. })
                    if (no_jobs || phone) && name == moonlet_proto::methods::EV_EXEC_SETUP => {}
                // Design systems and designs stay on the Mac (X64, X65): a
                // paired device hears none of the Mac-only events.
                Ok(Message::Event { name, .. }) if phone && MAC_ONLY_EVENTS.contains(&name.as_str()) => {}
                Ok(m) => {
                    if !ev_tx.send(Frame::Json(m)) {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("client lagged by {n} events");
                    let _ = ev_tx.send(Frame::Json(Message::event("events.lagged", n)));
                }
                Err(_) => break,
            }
        }
    });

    let result = async {
        loop {
            let frame = tokio::select! {
                frame = read_frame(&mut reader) => match frame? {
                    Some(frame) => frame,
                    None => break,
                },
                _ = conn.closed.notified() => break,
            };
            match frame {
                Frame::Input { terminal, data } => {
                    if !cloud {
                        let _ = daemon.terminals.write(terminal, data);
                    }
                }
                // A worker's routed command's output, for `moonlet exec`
                // (X62); from anyone else, nothing.
                Frame::RunOutput { run, stream, data } => {
                    if conn.client == crate::link::WORKER_CLIENT {
                        daemon.runs.forward(conn.id, run, stream, data);
                    }
                }
                // Before the request that names it is read (X60). Only a
                // worker's daemon sends packs; from anyone else, or over the
                // limits, they end the connection.
                Frame::Pack { transfer, data } => {
                    let refused = if conn.client != crate::link::WORKER_CLIENT {
                        Some(RpcError::new("forbidden", "only a worker sends packs"))
                    } else {
                        let pushed = conn.packs.lock().unwrap().push(transfer, data);
                        pushed.err().map(|e| RpcError::new("too_large", e.to_string()))
                    };
                    if let Some(e) = refused {
                        let _ = conn.tx.send(Frame::Json(Message::err(0, e)));
                        break;
                    }
                }
                Frame::Json(Message::Request { id, method, .. })
                    if cloud && method == moonlet_proto::methods::TERMINAL_ATTACH =>
                {
                    let e = RpcError::new("forbidden", "a cloud machine only runs heavy commands");
                    let _ = conn.tx.send(Frame::Json(Message::err(id, e)));
                }
                Frame::Json(Message::Request { id, method, params })
                    if method == moonlet_proto::methods::TERMINAL_ATTACH =>
                {
                    // Inline, so the reply is queued before live output (S2).
                    let result = serde_json::from_value::<moonlet_proto::methods::TerminalAttach>(params)
                        .map_err(|e| RpcError::new("invalid_params", e.to_string()))
                        .and_then(|a| {
                            daemon
                                .terminals
                                .attach_with(a.id, conn.id, conn.tx.clone(), a.cols.zip(a.rows), |info, snapshot| {
                                    Some(Frame::Json(Message::ok(
                                        id,
                                        moonlet_proto::methods::AttachResult {
                                            info,
                                            snapshot: String::from_utf8_lossy(&snapshot).into_owned(),
                                        },
                                    )))
                                })
                                .map_err(|e| RpcError::new("failed", format!("{e:#}")))
                        });
                    if let Err(e) = result {
                        let _ = conn.tx.send(Frame::Json(Message::err(id, e)));
                    }
                }
                Frame::Json(Message::Request { id, method, params }) => {
                    let daemon = daemon.clone();
                    let conn = conn.clone();
                    // Requests run concurrently; slow git calls must not block typing.
                    tokio::spawn(async move {
                        let reply = match daemon.handle(&conn, &method, params).await {
                            Ok(value) => Message::Response {
                                id,
                                result: Some(value),
                                error: None,
                            },
                            Err(e) => Message::err(id, e),
                        };
                        let _ = conn.tx.send(Frame::Json(reply));
                    });
                }
                Frame::Json(Message::Response { id, result, error }) => {
                    conn.reply(id, match error {
                        Some(e) => Err(e),
                        None => Ok(result.unwrap_or(Value::Null)),
                    });
                }
                other => tracing::debug!("ignoring unexpected frame {other:?}"),
            }
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

    conn.fail_pending();
    daemon.terminals.detach_all(conn.id);
    daemon.on_disconnect(conn.id);
    event_task.abort();
    drop(conn);
    drop(tx);
    let _ = writer_task.await;
    result
}

/// Encodes a frame. A reply too large for one frame becomes an error reply,
/// so the client is not disconnected; other oversized frames are dropped.
fn push_frame(buf: &mut Vec<u8>, frame: Frame) {
    match encode_frame(&frame) {
        Ok(bytes) => buf.extend_from_slice(&bytes),
        Err(e) => {
            tracing::warn!("dropping frame: {e}");
            if let Frame::Json(Message::Response { id, .. }) = frame
                && let Ok(bytes) = encode_frame(&Frame::Json(Message::err(
                    id,
                    RpcError::new("too_large", e.to_string()),
                )))
            {
                buf.extend_from_slice(&bytes);
            }
        }
    }
}

/// Writes queued frames, coalescing whatever is already queued into one
/// syscall so bursts of PTY output cost one write. `urgent` frames go out
/// first, and between any two pack chunks (each up to 1 MiB) on `rx`.
async fn write_loop<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut urgent: mpsc::UnboundedReceiver<Frame>,
    mut rx: mpsc::UnboundedReceiver<Frame>,
    queued: Arc<AtomicUsize>,
) {
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut urgent_open = true;
    loop {
        buf.clear();
        while let Ok(f) = urgent.try_recv() {
            push_frame(&mut buf, f);
        }
        if buf.is_empty() {
            tokio::select! {
                biased;
                f = urgent.recv(), if urgent_open => match f {
                    Some(f) => push_frame(&mut buf, f),
                    None => {
                        urgent_open = false;
                        continue;
                    }
                },
                f = rx.recv() => match f {
                    Some(f) => {
                        dequeued(&queued, &f);
                        push_frame(&mut buf, f);
                    }
                    None => return,
                },
            }
        }
        while buf.len() < 256 * 1024 {
            if let Ok(f) = urgent.try_recv() {
                push_frame(&mut buf, f);
                continue;
            }
            match rx.try_recv() {
                Ok(f) => {
                    dequeued(&queued, &f);
                    push_frame(&mut buf, f)
                }
                Err(_) => break,
            }
        }
        if writer.write_all(&buf).await.is_err() {
            return;
        }
        if writer.flush().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What went out, in order: pings, pack chunks and the pack's end.
    async fn written(mut out: tokio::io::DuplexStream) -> Vec<&'static str> {
        let mut order = Vec::new();
        while let Some(f) = read_frame(&mut out).await.unwrap() {
            order.push(match f {
                Frame::Pack { data, .. } if data.is_empty() => "end",
                Frame::Pack { .. } => "chunk",
                Frame::Json(Message::Request { .. }) => "ping",
                _ => "other",
            });
        }
        order
    }

    #[tokio::test]
    async fn a_ping_never_waits_behind_a_pack_queued_before_it() {
        // X60: a 3 MiB pack to a worker, then the central host's ping.
        let (tx, rx) = mpsc::unbounded_channel();
        let (urgent_tx, urgent) = mpsc::unbounded_channel();
        for f in moonlet_proto::pack_frames(7, &vec![0u8; 3 * 1024 * 1024]) {
            tx.send(f).unwrap();
        }
        urgent_tx
            .send(Frame::Json(Message::Request {
                id: 1,
                method: moonlet_proto::methods::WORKER_PING.into(),
                params: serde_json::json!({}),
            }))
            .unwrap();
        drop((tx, urgent_tx));
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        tokio::spawn(write_loop(ours, urgent, rx, Arc::new(AtomicUsize::new(0))));
        assert_eq!(written(theirs).await, ["ping", "chunk", "chunk", "chunk", "end"]);
    }
}
