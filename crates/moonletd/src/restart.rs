//! `moonletd restart [--force]` (X97): a fresh daemon process in place of the
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

/// How long a killed daemon has to exit.
const GONE_WITHIN: Duration = Duration::from_secs(5);

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
        // Nothing listens: start a daemon, unless one runs that has stopped
        // listening (or whose queue of connections is full).
        Answer::Nobody if daemon_pid(socket).is_none() => {
            launch::ensure_running(socket).await?;
            Ok(Outcome::Restarted)
        }
        Answer::Nobody | Answer::Silent => Ok(Outcome::Stuck("the daemon isn't answering".into())),
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
    /// The daemon answered `daemon.info` in time.
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

/// The pid in the daemon's pid file, when that process is a live `moonletd`
/// that was already running when the file was written. A file left by a
/// daemon that died can name a pid that now belongs to something else, even
/// another home's `moonletd`, which must never be signalled.
fn daemon_pid(socket: &Path) -> Option<i32> {
    let file = upgrade::pid_file(socket);
    let pid: i32 = std::fs::read_to_string(&file).ok()?.trim().parse().ok()?;
    let written = std::fs::metadata(&file).ok()?.modified().ok()?;
    let ran = Duration::from_secs(etime_secs(&ps(pid, "etime")?)?);
    let started = std::time::SystemTime::now().checked_sub(ran)?;
    // `etime` is in whole seconds.
    (started <= written + Duration::from_secs(2)).then_some(())?;
    moonletd_pid(pid)
}

/// Seconds from `ps -o etime=`: `[[dd-]hh:]mm:ss`.
fn etime_secs(etime: &str) -> Option<u64> {
    let etime = etime.trim();
    let (days, clock) = match etime.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, etime),
    };
    let mut secs = 0;
    let parts: Vec<&str> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    for part in parts {
        secs = secs * 60 + part.parse::<u64>().ok()?;
    }
    Some(days * 86400 + secs)
}

/// The pid the daemon on `socket` gives when it greets, for a daemon whose
/// pid file is gone: it greets before it reads any request.
async fn greeting_pid(socket: &Path) -> Option<i32> {
    let c = tokio::time::timeout(ANSWER_WITHIN, Client::connect(socket, "moonletd-restart"))
        .await
        .ok()?
        .ok()?;
    match c.welcome {
        moonlet_proto::Message::Welcome { pid, .. } => moonletd_pid(pid as i32),
        _ => None,
    }
}

/// `pid` when it is a live `moonletd` other than this process.
fn moonletd_pid(pid: i32) -> Option<i32> {
    (pid > 0
        && pid != std::process::id() as i32
        && ps(pid, "comm").is_some_and(|comm| {
            Path::new(&comm)
                .file_name()
                .is_some_and(|n| n == "moonletd")
        }))
    .then_some(pid)
}

/// A field of `ps -o` for `pid`; none when there is no such process.
fn ps(pid: i32, field: &str) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", &format!("{field}=")])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !value.is_empty()).then_some(value)
}

/// Gone, or a zombie: dead, waiting only for a parent that may never reap it.
fn gone(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_err()
        || ps(pid, "stat").is_none_or(|stat| stat.starts_with('Z'))
}

/// SIGKILLs the running daemon and waits until it's gone.
async fn kill_daemon(socket: &Path) -> Result<()> {
    let pid = match daemon_pid(socket) {
        Some(pid) => pid,
        None if tokio::net::UnixStream::connect(socket).await.is_err() => return Ok(()),
        None => greeting_pid(socket).await.with_context(|| {
            format!(
                "a daemon listens on {} but neither its pid file nor its greeting names it",
                socket.display()
            )
        })?,
    };
    tracing::info!(pid, "force restart: killing the daemon");
    kill(Pid::from_raw(pid), Signal::SIGKILL)
        .with_context(|| format!("cannot stop the daemon (pid {pid})"))?;
    let deadline = tokio::time::Instant::now() + GONE_WITHIN;
    while !gone(pid) {
        if tokio::time::Instant::now() > deadline {
            bail!("the daemon (pid {pid}) is still running {GONE_WITHIN:?} after SIGKILL");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_how_long_a_process_has_run_from_ps_etime() {
        // Captured from `ps -o etime=` on macOS.
        assert_eq!(etime_secs("      00:00"), Some(0));
        assert_eq!(etime_secs("12:50:45"), Some(12 * 3600 + 50 * 60 + 45));
        assert_eq!(
            etime_secs("04-20:28:05"),
            Some(4 * 86400 + 20 * 3600 + 28 * 60 + 5)
        );
        assert_eq!(etime_secs(""), None);
        assert_eq!(etime_secs("soon"), None);
    }
}
