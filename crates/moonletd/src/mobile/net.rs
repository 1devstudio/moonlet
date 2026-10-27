//! The phone listener (X39): binds on the Tailscale addresses while phone
//! access is on, checks each phone's `auth`, and serves it as a client or
//! pipes it to `ssh <host> moonletd proxy`. The state it checks against
//! (settings, pairing, devices) is the parent module's.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use moonlet_proto::methods as m;
use moonlet_proto::{Frame, Message, RpcError, read_frame, write_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::{Listening, tailscale_addresses};
use crate::daemon::Daemon;

/// How often the listener checks the Tailscale addresses.
const RESCAN: Duration = Duration::from_secs(30);
/// Retry delay after a bind failed (a daemon handing over still holds it).
const REBIND: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const FAIL_DELAY: Duration = Duration::from_secs(1);
/// What an auth failure says, whatever the reason.
const UNAUTHORIZED: &str = "this phone is not paired with this Mac";

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
            kind,
        })) => daemon.mobile.authenticate(
            token.as_deref(),
            pair.as_deref(),
            device.as_deref(),
            kind,
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
            protocol: Some(moonlet_proto::PROTOCOL_VERSION),
            daemon_version: Some(env!("CARGO_PKG_VERSION").into()),
            host: Some(super::host_label()),
            os: Some(std::env::consts::OS.into()),
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
/// phones, the host's worker link, its cloud workers or its heavy-command
/// approvals: the host's daemon cannot tell the
/// phone from the Mac's app, and a phone that paired itself there would
/// keep access after the Mac removes it. The Mac answers those itself.
async fn forward_from_phone(
    from: &mut tokio::net::tcp::OwnedReadHalf,
    to: &mut tokio::process::ChildStdin,
    reply: &tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>,
) -> Result<()> {
    while let Some(frame) = read_frame(from).await? {
        let refusal = match &frame {
            Frame::Json(Message::Request { method, .. })
                if method.starts_with("mobile.") && method != m::MOBILE_HOSTS =>
            {
                Some("manage phones from the Mac")
            }
            Frame::Json(Message::Request { method, .. })
                if method == m::LINK_SET || method == m::LINK_RETRY || method == m::LINK_PAIR =>
            {
                Some("manage the link from the Mac")
            }
            // Credentials and approvals: the host takes the phone for the app.
            Frame::Json(Message::Request { method, .. }) if method == m::CLOUD_SET => {
                Some("change cloud workers from the Mac")
            }
            Frame::Json(Message::Request { method, .. }) if method == m::HEAVY_APPROVE => {
                Some("approve heavy commands from the Mac")
            }
            Frame::Json(Message::Request { method, .. }) if method == m::DAEMON_UPDATE => {
                Some("update moonlet from a Mac")
            }
            _ => None,
        };
        if let (Frame::Json(Message::Request { id, .. }), Some(refusal)) = (&frame, refusal) {
            let err = Message::err(*id, RpcError::new("forbidden", refusal));
            write_frame(&mut *reply.lock().await, &Frame::Json(err)).await?;
            continue;
        }
        write_frame(to, &frame).await?;
    }
    Ok(())
}
