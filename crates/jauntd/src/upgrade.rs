//! Live upgrade (S3): hand every PTY to a new `jauntd` binary over a private
//! Unix socket with `SCM_RIGHTS`, then exit without touching the sessions.

use std::io::{IoSlice, IoSliceMut, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jaunt_core::session::{ExportedSession, SessionManager};
use nix::sys::socket::{ControlMessage, ControlMessageOwned, MsgFlags, recvmsg, sendmsg};

use crate::daemon::Daemon;

const FD_CHUNK: usize = 64;

pub fn pid_file() -> PathBuf {
    jaunt_core::paths::socket_path().with_file_name("jauntd.pid")
}

fn request_file() -> PathBuf {
    jaunt_core::paths::socket_path().with_file_name("upgrade.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct UpgradeRequest {
    binary: PathBuf,
}

pub fn write_pid() {
    let _ = std::fs::write(pid_file(), std::process::id().to_string());
}

/// `jauntd upgrade`, run from the new binary: ask the running daemon to hand
/// over to us, then wait until the new daemon answers.
pub async fn request_upgrade(socket: &Path, binary: PathBuf) -> Result<()> {
    let pid: i32 = std::fs::read_to_string(pid_file())
        .context("no running daemon (pid file missing)")?
        .trim()
        .parse()
        .context("invalid pid file")?;
    if pid == std::process::id() as i32 {
        bail!("refusing to upgrade into ourselves");
    }
    let req = request_file();
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
        if let Ok(mut c) = jaunt_core::client::Client::connect(socket, "jauntd-upgrade").await
            && let jaunt_proto::Message::Welcome { pid: new_pid, .. } = c.welcome.clone()
            && new_pid as i32 != pid
        {
            let _: serde_json::Value = c.request(jaunt_proto::methods::DAEMON_INFO, ()).await?;
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            bail!("upgrade did not complete within 30 s (see ~/.jaunt/logs/jauntd.log)");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Old-daemon side, triggered by SIGUSR2 or `daemon.upgrade`.
pub async fn hand_off(daemon: Arc<Daemon>, binary: Option<PathBuf>) -> Result<()> {
    let binary = match binary {
        Some(b) => b,
        None => {
            let raw = std::fs::read(request_file()).context("no upgrade request")?;
            let _ = std::fs::remove_file(request_file());
            serde_json::from_slice::<UpgradeRequest>(&raw)?.binary
        }
    };
    if !binary.is_file() {
        bail!("new jauntd binary not found: {}", binary.display());
    }
    let path = jaunt_core::paths::socket_path()
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
    tracing::info!(binary = %binary.display(), pid = child.id(), "handing sessions to new daemon");

    let sessions = daemon.sessions.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        listener.set_nonblocking(false)?;
        // Wait for the child to connect, but notice if it dies first.
        let (stream, _) = accept_with_timeout(&listener, &mut child, Duration::from_secs(15))?;
        check_peer(&stream)?;
        let exported = sessions.export();
        send_sessions(&stream, sessions.base_env(), &exported)?;
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
    let _ = std::fs::remove_file(pid_file());
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
    sessions: Vec<ExportedSession>,
}

fn send_sessions(
    stream: &UnixStream,
    env: &std::collections::BTreeMap<String, String>,
    sessions: &[ExportedSession],
) -> Result<()> {
    #[derive(serde::Serialize)]
    struct HeaderRef<'a> {
        env: &'a std::collections::BTreeMap<String, String>,
        sessions: &'a [ExportedSession],
    }
    let header = serde_json::to_vec(&HeaderRef { env, sessions })?;
    let mut s = stream;
    s.write_all(&(header.len() as u32).to_be_bytes())?;
    s.write_all(&header)?;
    for chunk in sessions.chunks(FD_CHUNK) {
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
    pub env: std::collections::BTreeMap<String, String>,
    exported: Vec<ExportedSession>,
    fds: Vec<RawFd>,
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
    let Header {
        env,
        sessions: exported,
    } = serde_json::from_slice(&header)?;
    let mut fds: Vec<RawFd> = Vec::with_capacity(exported.len());
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
                fds.extend(v);
            }
        }
        if got == 0 {
            bail!("handoff stream ended before all PTYs arrived");
        }
    }
    Ok(Incoming {
        stream,
        env,
        exported,
        fds,
    })
}

/// Step 2: adopt the sessions under the same ids, then confirm to the old daemon.
pub fn adopt(incoming: Incoming, sessions: &Arc<SessionManager>) -> Result<()> {
    let Incoming {
        stream,
        exported,
        fds,
        ..
    } = incoming;
    for (e, fd) in exported.iter().zip(fds) {
        if let Err(err) = sessions.adopt(e.info.clone(), e.rows, e.cols, e.snapshot.as_bytes(), fd)
        {
            tracing::error!(session = e.info.id, "could not adopt session: {err:#}");
        }
    }
    tracing::info!(
        count = exported.len(),
        "adopted sessions from previous daemon"
    );
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
