//! Live upgrade (S3): hand every PTY to a new `moonletd` binary over a private
//! Unix socket with `SCM_RIGHTS`, then exit without touching the terminals.

use std::io::{IoSlice, IoSliceMut, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_core::terminal::{ExportedTerminal, TerminalManager};
use nix::sys::socket::{ControlMessage, ControlMessageOwned, MsgFlags, recvmsg, sendmsg};

use crate::daemon::Daemon;

const FD_CHUNK: usize = 64;

/// The pid of the daemon listening on `socket`, next to it and named after
/// it: `moonletd.pid` for `moonletd.sock`, and jaunt's `jauntd.pid` for
/// `jauntd.sock` (X27).
pub fn pid_file(socket: &Path) -> PathBuf {
    let stem = socket.file_stem().unwrap_or_default().to_string_lossy();
    socket.with_file_name(format!("{stem}.pid"))
}

/// Where `moonletd upgrade` tells the daemon on `socket` which binary to
/// hand over to. jaunt's daemon reads the same name.
fn request_file(socket: &Path) -> PathBuf {
    socket.with_file_name("upgrade.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct UpgradeRequest {
    binary: PathBuf,
}

pub fn write_pid(socket: &Path) {
    let _ = std::fs::write(pid_file(socket), std::process::id().to_string());
}

/// `moonletd upgrade`, run from the new binary: ask the running daemon to hand
/// over to us, then wait until the new daemon answers.
pub async fn request_upgrade(socket: &Path, binary: PathBuf) -> Result<()> {
    request_upgrade_from(socket, socket, binary).await
}

/// Asks the daemon on `old` to hand over to `binary`, and waits until the
/// new daemon answers on `new`. Taking over from jaunt's daemon (X27), the
/// two sockets differ.
pub async fn request_upgrade_from(old: &Path, new: &Path, binary: PathBuf) -> Result<()> {
    let pid: i32 = std::fs::read_to_string(pid_file(old))
        .context("no running daemon (pid file missing)")?
        .trim()
        .parse()
        .context("invalid pid file")?;
    if pid == std::process::id() as i32 {
        bail!("refusing to upgrade into ourselves");
    }
    let req = request_file(old);
    std::fs::write(&req, serde_json::to_vec(&UpgradeRequest { binary })?)?;
    std::fs::set_permissions(&req, std::fs::Permissions::from_mode(0o600))?;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGUSR2,
    )
    .context("cannot signal the daemon")?;
    // Done when a daemon with a different pid answers on the socket.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(mut c) = moonlet_core::client::Client::connect(new, "moonletd-upgrade").await
            && let moonlet_proto::Message::Welcome { pid: new_pid, .. } = c.welcome.clone()
            && new_pid as i32 != pid
        {
            let _: serde_json::Value = c.request(moonlet_proto::methods::DAEMON_INFO, ()).await?;
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            bail!("upgrade did not complete within 30 s (see ~/.moonlet/logs/moonletd.log)");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Old-daemon side, triggered by SIGUSR2 or `daemon.upgrade`.
/// One upgrade at a time: two concurrent handoffs would export the same PTY
/// fds to two new daemons.
pub async fn hand_off(daemon: Arc<Daemon>, binary: Option<PathBuf>) -> Result<()> {
    if !daemon.begin_upgrade() {
        bail!("an upgrade is already in progress");
    }
    hand_off_claimed(daemon, binary).await
}

/// [`hand_off`] for a caller that already claimed the upgrade.
pub async fn hand_off_claimed(daemon: Arc<Daemon>, binary: Option<PathBuf>) -> Result<()> {
    let result = hand_off_once(daemon.clone(), binary).await;
    if result.is_err() {
        // Terminal I/O may have been stopped for the export: keep serving.
        daemon.terminals.resume_io();
        daemon.end_upgrade();
    }
    result
}

async fn hand_off_once(daemon: Arc<Daemon>, binary: Option<PathBuf>) -> Result<()> {
    let binary = match binary {
        Some(b) => b,
        None => {
            let req = request_file(daemon.terminals.socket());
            let raw = std::fs::read(&req).context("no upgrade request")?;
            let _ = std::fs::remove_file(&req);
            serde_json::from_slice::<UpgradeRequest>(&raw)?.binary
        }
    };
    if !binary.is_file() {
        bail!("new moonletd binary not found: {}", binary.display());
    }
    let path = daemon
        .terminals
        .socket()
        .with_file_name(format!("handoff-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;

    let mut cmd = Command::new(&binary);
    cmd.args(["daemon", "--handoff"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("cannot start {}", binary.display()))?;
    tracing::info!(binary = %binary.display(), pid = child.id(), "handing terminals to new daemon");

    // Chats are not handed over: the new daemon resumes them from disk.
    daemon.chats.shutdown();
    let terminals = daemon.terminals.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        listener.set_nonblocking(false)?;
        // Wait for the child to connect, but notice if it dies first.
        let (stream, _) = accept_with_timeout(&listener, &mut child, Duration::from_secs(15))?;
        check_peer(&stream)?;
        let exported = terminals.export();
        send_terminals(&stream, terminals.base_env(), &exported)?;
        let mut ack = [0u8; 1];
        (&stream)
            .read_exact(&mut ack)
            .context("new daemon did not confirm")?;
        if ack[0] != b'A' {
            bail!("new daemon rejected the handoff");
        }
        Ok(())
    })
    .await?;
    let _ = std::fs::remove_file(&path);
    result?;
    tracing::info!("handoff complete; exiting");
    daemon.set_handed_off();
    let _ = std::fs::remove_file(pid_file(daemon.terminals.socket()));
    daemon.request_shutdown();
    Ok(())
}

fn accept_with_timeout(
    listener: &UnixListener,
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<(UnixStream, std::os::unix::net::SocketAddr)> {
    listener.set_nonblocking(true)?;
    let start = std::time::Instant::now();
    loop {
        match listener.accept() {
            Ok(pair) => {
                pair.0.set_nonblocking(false)?;
                return Ok(pair);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        if let Ok(Some(status)) = child.try_wait() {
            bail!("new daemon exited during handoff ({status})");
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            bail!("new daemon did not connect for the handoff");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn check_peer(stream: &UnixStream) -> Result<()> {
    #[cfg(target_os = "linux")]
    let uid = nix::unistd::Uid::from_raw(
        nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .context("peer credentials")?
            .uid(),
    );
    #[cfg(not(target_os = "linux"))]
    let (uid, _) = nix::unistd::getpeereid(stream).context("peer credentials")?;
    if uid != nix::unistd::getuid() {
        bail!("handoff peer belongs to another user");
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Header {
    env: std::collections::BTreeMap<String, String>,
    // "sessions" in handoffs from daemons before the rename (ADR 0005).
    #[serde(alias = "sessions")]
    terminals: Vec<ExportedTerminal>,
}

fn send_terminals(
    stream: &UnixStream,
    env: &std::collections::BTreeMap<String, String>,
    terminals: &[ExportedTerminal],
) -> Result<()> {
    #[derive(serde::Serialize)]
    struct HeaderRef<'a> {
        env: &'a std::collections::BTreeMap<String, String>,
        terminals: &'a [ExportedTerminal],
    }
    let header = serde_json::to_vec(&HeaderRef { env, terminals })?;
    let mut s = stream;
    s.write_all(&(header.len() as u32).to_be_bytes())?;
    s.write_all(&header)?;
    for chunk in terminals.chunks(FD_CHUNK) {
        let fds: Vec<RawFd> = chunk.iter().map(|e| e.fd).collect();
        let cmsg = [ControlMessage::ScmRights(&fds)];
        let n = [chunk.len() as u8];
        sendmsg::<()>(
            stream.as_raw_fd(),
            &[IoSlice::new(&n)],
            &cmsg,
            MsgFlags::empty(),
            None,
        )?;
    }
    Ok(())
}

pub struct Incoming {
    stream: UnixStream,
    exported: Vec<ExportedTerminal>,
    /// Owned, so fds that are not adopted get closed.
    fds: Vec<OwnedFd>,
}

/// New-daemon side, step 1: read the header and the PTY fds.
pub fn receive(path: &Path) -> Result<Incoming> {
    let stream =
        UnixStream::connect(path).with_context(|| format!("connect {}", path.display()))?;
    check_peer(&stream)?;
    let mut s = &stream;
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let mut header = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut header)?;
    // The old daemon's environment is ignored: the new one captures a clean
    // login environment itself (the field stays in the header for older peers).
    let Header {
        env: _,
        terminals: exported,
    } = serde_json::from_slice(&header)?;
    let mut fds: Vec<OwnedFd> = Vec::with_capacity(exported.len());
    while fds.len() < exported.len() {
        let mut n = [0u8; 1];
        let mut iov = [IoSliceMut::new(&mut n)];
        let mut space = nix::cmsg_space!([RawFd; FD_CHUNK]);
        let msg = recvmsg::<()>(
            stream.as_raw_fd(),
            &mut iov,
            Some(&mut space),
            MsgFlags::MSG_CMSG_CLOEXEC_COMPAT,
        )?;
        let mut got = 0;
        for c in msg.cmsgs()? {
            if let ControlMessageOwned::ScmRights(v) = c {
                got += v.len();
                // SAFETY: SCM_RIGHTS hands us fresh descriptors we now own.
                fds.extend(v.into_iter().map(|fd| unsafe { OwnedFd::from_raw_fd(fd) }));
            }
        }
        if got == 0 {
            bail!("handoff stream ended before all PTYs arrived");
        }
    }
    Ok(Incoming {
        stream,
        exported,
        fds,
    })
}

/// Step 2: adopt the terminals under the same ids, then confirm to the old daemon.
pub fn adopt(incoming: Incoming, terminals: &Arc<TerminalManager>) -> Result<()> {
    let Incoming {
        stream,
        exported,
        fds,
        ..
    } = incoming;
    for (e, fd) in exported.iter().zip(fds) {
        if let Err(err) =
            terminals.adopt(e.info.clone(), e.rows, e.cols, e.snapshot.as_bytes(), fd.into_raw_fd())
        {
            tracing::error!(session = e.info.id, "could not adopt session: {err:#}");
        }
    }
    tracing::info!(
        count = exported.len(),
        "adopted terminals from previous daemon"
    );
    // Before the old daemon hears "adopted" and exits: under systemd, the
    // unit then follows this process instead of stopping (X58).
    crate::notify::took_over();
    (&stream).write_all(b"A")?;
    Ok(())
}

/// `MSG_CMSG_CLOEXEC` is Linux-only; on macOS fds are made CLOEXEC on adopt.
trait CloexecCompat {
    const MSG_CMSG_CLOEXEC_COMPAT: MsgFlags;
}

impl CloexecCompat for MsgFlags {
    #[cfg(target_os = "linux")]
    const MSG_CMSG_CLOEXEC_COMPAT: MsgFlags = MsgFlags::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    const MSG_CMSG_CLOEXEC_COMPAT: MsgFlags = MsgFlags::empty();
}
