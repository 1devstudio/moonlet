//! Socket server: accepts clients, runs the handshake, dispatches requests
//! and streams events and PTY output back.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use moonlet_core::terminal::{ClientId, ClientTx, dequeued};
use std::sync::atomic::AtomicUsize;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, RpcError, encode_frame, read_frame};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use crate::daemon::Daemon;

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

/// Per-connection context passed to request handlers.
pub struct Conn {
    pub id: ClientId,
    pub tx: ClientTx,
    pub client: String,
    /// The paired phone's device id on a phone connection (X39).
    pub phone: Option<String>,
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
    let writer_task = tokio::spawn(write_loop(writer, rx, tx.counter()));

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
        client,
        phone,
    });
    tracing::debug!(client = %conn.client, id = conn.id, "client connected");

    // Fan daemon events out to this client.
    let mut events = daemon.terminals.subscribe_events();
    let ev_tx = tx.clone();
    // The text an agent asks to read is for the app alone, not for the
    // agent's own `moonlet` connections (X31).
    let is_cli = conn.client == crate::daemon::CLI_CLIENT;
    let event_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(Message::Event { name, .. })
                    if is_cli && name == moonlet_proto::methods::EV_TERMINAL_READ_REQUEST => {}
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
        while let Some(frame) = read_frame(&mut reader).await? {
            match frame {
                Frame::Input { terminal, data } => {
                    let _ = daemon.terminals.write(terminal, data);
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
                other => tracing::debug!("ignoring unexpected frame {other:?}"),
            }
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

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
/// syscall so bursts of PTY output cost one write.
async fn write_loop<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut rx: mpsc::UnboundedReceiver<Frame>,
    queued: Arc<AtomicUsize>,
) {
    let mut buf = Vec::with_capacity(64 * 1024);
    while let Some(frame) = rx.recv().await {
        buf.clear();
        dequeued(&queued, &frame);
        push_frame(&mut buf, frame);
        while buf.len() < 256 * 1024 {
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
