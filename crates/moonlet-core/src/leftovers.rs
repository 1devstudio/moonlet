//! What this daemon's agents and terminals have running, kept on disk so the
//! next daemon can end it when this one crashed (X79). After a crash nothing
//! links those processes to moonlet any more: launchd is their parent, and
//! macOS hides the environment of its own binaries (`zsh`, `tail`, `log`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::process::{Doomed, Family};

/// Processes and terminal sessions, each as pid and start time, so a pid that
/// another process got since is left alone.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leftovers {
    /// When the machine booted ([`crate::process::boot_time`]): a record from
    /// before a reboot names no process that still runs.
    #[serde(default)]
    pub boot: Option<u64>,
    /// The agents and every process they started.
    pub processes: Vec<(u32, u64)>,
    /// Each terminal's session, by its leader: the shell the PTY started.
    pub sessions: Vec<(u32, u64)>,
}

/// Where the daemon on `socket` keeps its [`Leftovers`]: next to the socket,
/// as its pid file is, so daemons on other sockets keep their own.
pub fn file(socket: &Path) -> PathBuf {
    let stem = socket.file_stem().unwrap_or_default().to_string_lossy();
    socket.with_file_name(format!("{stem}.leftovers.json"))
}

/// Writes `leftovers` to `path`, whole or not at all.
pub fn save(path: &Path, leftovers: &Leftovers) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(leftovers)?)?;
    std::fs::rename(&tmp, path)
}

/// Ends what the daemon before this one recorded in `path` and still runs:
/// a daemon that stopped cleanly ended it all already, one that crashed did
/// not. Reads the file now, so a new record cannot overwrite it first, and
/// ends the processes in the background (SIGTERM, then SIGKILL 3 s later).
pub fn reap(path: &Path) {
    let Some(left) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Leftovers>(&b).ok()) else {
        return;
    };
    let _ = std::fs::remove_file(path);
    if left.boot.is_some() && left.boot != crate::process::boot_time() {
        return;
    }
    let mut doomed = Doomed { group: None, family: Family::of(left.processes) };
    if doomed.signal(None) {
        tracing::info!("ending processes the previous daemon's agents left running");
        tokio::spawn(doomed.end());
    }
    for (sid, started) in left.sessions {
        crate::pty::end_recorded_session(sid, Some(started));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::process_start;

    /// Waits up to 6 s for `child` to end.
    async fn ended(mut child: std::process::Child) -> std::process::ExitStatus {
        let waited = tokio::task::spawn_blocking(move || child.wait().unwrap());
        tokio::time::timeout(std::time::Duration::from_secs(6), waited).await.expect("still running").unwrap()
    }

    #[tokio::test]
    async fn reaping_ends_a_recorded_terminal_session_whose_shell_is_gone() {
        use std::os::unix::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        let pid_file = dir.path().join("job.pid");
        // A shell in a session of its own, as a PTY's is, that leaves a job
        // ignoring SIGHUP and exits, as after a daemon's crash.
        let script = format!("set -m; (trap '' HUP; exec sleep 60) </dev/null >/dev/null 2>&1 & echo $! > '{}'", pid_file.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        // SAFETY: setsid is async-signal-safe.
        unsafe { cmd.pre_exec(|| (libc::setsid() >= 0).then_some(()).ok_or_else(std::io::Error::last_os_error)) };
        let mut shell = cmd.spawn().unwrap();
        let started = process_start(shell.id()).unwrap();
        shell.wait().unwrap();
        let job = nix::unistd::Pid::from_raw(std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap());
        save(&path, &Leftovers { boot: crate::process::boot_time(), processes: vec![], sessions: vec![(shell.id(), started)] }).unwrap();
        reap(&path);
        for _ in 0..80 {
            if nix::sys::signal::kill(job, None).is_err() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = nix::sys::signal::kill(job, nix::sys::signal::Signal::SIGKILL);
        panic!("the recorded session's job still runs");
    }

    #[tokio::test]
    async fn a_record_from_before_a_reboot_ends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        let mut sleeper = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let boot = crate::process::boot_time().map(|b| b - 1);
        save(&path, &Leftovers { boot, processes: vec![(sleeper.id(), process_start(sleeper.id()).unwrap())], sessions: vec![] }).unwrap();
        reap(&path);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(sleeper.try_wait().unwrap().is_none(), "a process from another boot's record was signalled");
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

    #[tokio::test]
    async fn reaping_ends_recorded_processes_and_spares_a_reused_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        // Ignores SIGTERM, like a dev server: only the SIGKILL ends it.
        let ready = dir.path().join("ready");
        let script = format!("trap '' TERM; touch '{}'; while :; do sleep 1; done", ready.display());
        let mut stubborn = std::process::Command::new("/bin/sh").args(["-c", &script]).spawn().unwrap();
        while !ready.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let mut other = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let start = |pid| process_start(pid).unwrap();
        // `other` was recorded with a start time that is not its own: its pid
        // belonged to an earlier process.
        let left = Leftovers { boot: crate::process::boot_time(), processes: vec![(stubborn.id(), start(stubborn.id())), (other.id(), start(other.id()) - 1)], sessions: vec![] };
        save(&path, &left).unwrap();
        reap(&path);
        assert!(!path.exists(), "a reaped record is used once");
        let status = ended(stubborn).await;
        assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(libc::SIGKILL));
        assert!(other.try_wait().unwrap().is_none(), "a reused pid was signalled");
        other.kill().unwrap();
        other.wait().unwrap();
    }
}
