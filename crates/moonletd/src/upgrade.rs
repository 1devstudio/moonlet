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
        // Terminal I/O may have been stopped for the export, and the chats'
        // agents for the handoff: keep serving.
        daemon.terminals.resume_io();
        daemon.chats.resume();
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
    let (path, listener) = handoff_listener(&daemon)?;

    let mut cmd = Command::new(&binary);
    cmd.args(["daemon", "--handoff"]).arg(&path);
    // It runs where this one runs: outside a login session (X113).
    if crate::boot::started_at_boot() {
        cmd.arg("--boot");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("cannot start {}", binary.display()))?;
    tracing::info!(binary = %binary.display(), pid = child.id(), "handing terminals to new daemon");
    serve_handoff(daemon, listener, path, Receiver::Child(child)).await
}

/// Who takes the terminals.
enum Receiver {
    /// The new daemon this one started (S3).
    Child(std::process::Child),
    /// The daemon that asked with `daemon.hand_over` (X113): the process
    /// that asked, running this daemon's own executable, which sends the
    /// one-time secret it was given first.
    Caller { pid: u32, secret: String },
}

/// `handoff-<pid>.sock` beside the daemon's socket, for the new daemon only.
fn handoff_listener(daemon: &Daemon) -> Result<(PathBuf, UnixListener)> {
    let path = daemon
        .terminals
        .socket()
        .with_file_name(format!("handoff-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok((path, listener))
}

/// `daemon.hand_over` (X113), for a daemon that started at system start:
/// the daemon that asks, process `caller`, started at login, takes every
/// terminal over the returned socket once it sends the returned secret,
/// and this one exits. The caller claimed the upgrade.
pub async fn hand_over(daemon: Arc<Daemon>, caller: u32) -> Result<(PathBuf, String)> {
    let made = one_time_secret().and_then(|secret| Ok((handoff_listener(&daemon)?, secret)));
    let ((path, listener), secret) = match made {
        Ok(m) => m,
        Err(e) => {
            daemon.end_upgrade();
            return Err(e);
        }
    };
    let returned = (path.clone(), secret.clone());
    tokio::spawn(async move {
        let receiver = Receiver::Caller { pid: caller, secret };
        let result = serve_handoff(daemon.clone(), listener, path, receiver).await;
        if let Err(e) = result {
            tracing::error!("hand-over to the daemon started at login failed, still serving: {e:#}");
            daemon.terminals.resume_io();
            daemon.chats.resume();
            daemon.end_upgrade();
        }
    });
    Ok(returned)
}

/// 32 random bytes as hex.
fn one_time_secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

async fn serve_handoff(daemon: Arc<Daemon>, listener: UnixListener, path: PathBuf, mut receiver: Receiver) -> Result<()> {
    // Chats are not handed over: the new daemon resumes them from disk.
    daemon.chats.shutdown().await;
    let terminals = daemon.terminals.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        listener.set_nonblocking(false)?;
        // Wait for the new daemon to connect, but notice if a child dies first.
        let child = match &mut receiver {
            Receiver::Child(c) => Some(c),
            Receiver::Caller { .. } => None,
        };
        let (stream, _) = accept_with_timeout(&listener, child, Duration::from_secs(15))?;
        check_peer(&stream)?;
        if let Receiver::Caller { pid, secret } = &receiver {
            // The process that asked, still running this executable, and
            // holding the secret only its reply carried.
            if peer_pid(&stream)? != *pid {
                bail!("hand-over refused: another process connected");
            }
            check_peer_runs_this_executable(&stream)?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            let mut sent = vec![0u8; secret.len()];
            (&stream).read_exact(&mut sent).context("no hand-over secret")?;
            stream.set_read_timeout(None)?;
            if !moonlet_core::app_token::matches(secret, &String::from_utf8_lossy(&sent)) {
                bail!("hand-over refused: wrong secret");
            }
        }
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
    mut child: Option<&mut std::process::Child>,
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
        if let Some(child) = child.as_mut()
            && let Ok(Some(status)) = child.try_wait()
        {
            bail!("new daemon exited during handoff ({status})");
        }
        if start.elapsed() > timeout {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
            bail!("new daemon did not connect for the handoff");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The peer runs the same `moonletd` as this daemon (X113): a hand-over
/// gives every terminal to whoever connects.
fn check_peer_runs_this_executable(stream: &UnixStream) -> Result<()> {
    let ours = std::env::current_exe().context("this daemon's executable")?;
    let theirs = peer_executable(stream)?;
    let same = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if same(&ours) != same(&theirs) {
        bail!("hand-over refused: the peer runs {}, not {}", theirs.display(), ours.display());
    }
    Ok(())
}

/// The process at the other end of `stream`, as the kernel says.
#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> Result<u32> {
    let pid = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::LocalPeerPid).context("peer pid")?;
    Ok(pid as u32)
}

#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> Result<u32> {
    let cred = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials).context("peer credentials")?;
    Ok(cred.pid() as u32)
}

#[cfg(target_os = "macos")]
fn peer_executable(stream: &UnixStream) -> Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let pid = peer_pid(stream)? as i32;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is writable for its length.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        bail!("cannot read the peer's executable: {}", std::io::Error::last_os_error());
    }
    buf.truncate(n as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

#[cfg(target_os = "linux")]
fn peer_executable(stream: &UnixStream) -> Result<PathBuf> {
    std::fs::read_link(format!("/proc/{}/exe", peer_pid(stream)?)).context("cannot read the peer's executable")
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
/// With `secret`, the one-time secret of a hand-over (X113), sent first.
pub fn receive(path: &Path, secret: Option<&str>) -> Result<Incoming> {
    let stream =
        UnixStream::connect(path).with_context(|| format!("connect {}", path.display()))?;
    check_peer(&stream)?;
    if let Some(secret) = secret {
        (&stream).write_all(secret.as_bytes())?;
    }
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
        if let Err(err) = terminals.adopt(e, fd.into_raw_fd()) {
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
