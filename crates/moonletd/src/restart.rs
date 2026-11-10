//! `moonletd restart [--force]` (X96): a fresh daemon process in place of the
//! running one. Without `--force` its terminals are handed over (S3); with
//! it, a stuck daemon is killed and a new one started.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use moonlet_core::client::Client;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

use crate::{launch, upgrade};

/// The exit code of `moonletd restart` when only `--force` can restart it.
pub const STUCK: i32 = 3;

/// How long the running daemon has to answer before it counts as stuck.
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

pub enum Outcome {
    Restarted,
    /// The daemon can't hand over; only a force restart replaces it.
    Stuck(String),
}

pub async fn restart(socket: &Path, binary: PathBuf, force: bool) -> Result<Outcome> {
    if force {
        kill_daemon(socket).await?;
        launch::ensure_running(socket).await?;
        return Ok(Outcome::Restarted);
    }
    match answers(socket).await {
        Answer::Nobody => {
            if let Some(pid) = daemon_pid(socket) {
                return Ok(Outcome::Stuck(format!(
                    "the daemon (pid {pid}) runs but doesn't listen on its socket"
                )));
            }
            launch::ensure_running(socket).await?;
            Ok(Outcome::Restarted)
        }
        Answer::Silent => Ok(Outcome::Stuck("the daemon isn't answering".into())),
        Answer::Yes => match upgrade::request_upgrade(socket, binary).await {
            Ok(()) => Ok(Outcome::Restarted),
            Err(e) => Ok(Outcome::Stuck(format!(
                "the daemon didn't hand over its terminals: {e:#}"
            ))),
        },
    }
}

enum Answer {
    /// Nothing listens on the socket.
    Nobody,
    /// Something listens but doesn't answer in time.
    Silent,
    Yes,
}

async fn answers(socket: &Path) -> Answer {
    if tokio::net::UnixStream::connect(socket).await.is_err() {
        return Answer::Nobody;
    }
    let asked = tokio::time::timeout(ANSWER_WITHIN, async {
        let mut c = Client::connect(socket, "moonletd-restart").await?;
        c.request::<_, serde_json::Value>(moonlet_proto::methods::DAEMON_INFO, ())
            .await
    })
    .await;
    match asked {
        Ok(Ok(_)) => Answer::Yes,
        _ => Answer::Silent,
    }
}

/// The pid in the daemon's pid file, when that process is a live `moonletd`.
/// A file left by a daemon that died can name a pid that now belongs to
/// something else, which must never be signalled.
fn daemon_pid(socket: &Path) -> Option<i32> {
    let pid: i32 = std::fs::read_to_string(upgrade::pid_file(socket))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (pid > 0 && pid != std::process::id() as i32 && is_moonletd(pid)).then_some(pid)
}

fn is_moonletd(pid: i32) -> bool {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    else {
        return false;
    };
    let comm = String::from_utf8_lossy(&out.stdout);
    Path::new(comm.trim())
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with("moonletd"))
}

/// SIGKILLs the daemon in the pid file and waits until it's gone.
async fn kill_daemon(socket: &Path) -> Result<()> {
    let Some(pid) = daemon_pid(socket) else {
        if tokio::net::UnixStream::connect(socket).await.is_ok() {
            bail!(
                "a daemon listens on {} but its pid file doesn't name it",
                socket.display()
            );
        }
        return Ok(());
    };
    tracing::info!(pid, "force restart: killing the daemon");
    kill(Pid::from_raw(pid), Signal::SIGKILL)
        .with_context(|| format!("cannot stop the daemon (pid {pid})"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while kill(Pid::from_raw(pid), None).is_ok() {
        if tokio::time::Instant::now() > deadline {
            bail!("the daemon (pid {pid}) is still running 5 s after SIGKILL");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}
