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
    /// Which boot of the machine this is ([`crate::process::boot_id`]),
    /// where the kernel says: unlike the boot time, a clock change leaves it.
    #[serde(default)]
    pub boot_id: Option<String>,
    /// The agents and every process they started.
    pub processes: Vec<(u32, u64)>,
    /// Each terminal's session, by its leader: the shell the PTY started.
    pub sessions: Vec<(u32, u64)>,
}

impl Leftovers {
    /// A record of `processes` and `sessions` made during this boot.
    pub fn of(processes: Vec<(u32, u64)>, sessions: Vec<(u32, u64)>) -> Leftovers {
        Leftovers { boot: crate::process::boot_time(), boot_id: crate::process::boot_id(), processes, sessions }
    }
}

/// Where the daemon on `socket` keeps its [`Leftovers`]: next to the socket,
/// as its pid file is, so daemons on other sockets keep their own.
pub fn file(socket: &Path) -> PathBuf {
    let stem = socket.file_stem().unwrap_or_default().to_string_lossy();
    socket.with_file_name(format!("{stem}.leftovers.json"))
}

/// Writes `leftovers` to `path`, whole or not at all, readable and writable
/// by this user alone. The socket may be in a folder others can write to,
/// such as /tmp: a link planted where the record is first written is
/// replaced, never written through.
pub fn save(path: &Path, leftovers: &Leftovers) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&tmp)?;
    f.write_all(&serde_json::to_vec(leftovers)?)?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// The record in `path`, if this user wrote it: a file, not a link, owned by
/// this user and that no one else may write. Anything else may have been
/// planted by another user, to have their processes ended.
fn read_own(path: &Path) -> Option<Leftovers> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
    let meta = f.metadata().ok()?;
    // SAFETY: geteuid only reads this process's credentials.
    let me = unsafe { libc::geteuid() };
    if !meta.is_file() || meta.uid() != me || meta.mode() & 0o022 != 0 {
        tracing::warn!("ignoring {}: it is not this user's own", path.display());
        return None;
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether `left` was recorded since the machine last booted: by the boot id
/// where both have one, else by the boot time within 2 s, as the boot time
/// is the clock less the time since boot, read at two moments.
fn this_boot(left: &Leftovers) -> bool {
    if let (Some(then), Some(now)) = (&left.boot_id, crate::process::boot_id()) {
        return *then == now;
    }
    match (left.boot, crate::process::boot_time()) {
        (Some(then), Some(now)) => then.abs_diff(now) <= 2 * crate::process::BOOT_TIME_PER_SEC,
        _ => true,
    }
}

/// Ends what the daemon before this one recorded in `path` and still runs,
/// and returns it, for the next record to keep naming until it is gone. A
/// daemon that crashed ended nothing; one that stopped cleanly ended its
/// agents and what they started, but jobs that ignored its terminals' hangup
/// still run, and end now. Reads the file at once, so a new record cannot
/// overwrite it first, and ends the processes in the background (SIGTERM,
/// then SIGKILL 3 s later; terminal sessions as when a tab closes). A record
/// another user could have written ends nothing.
pub fn reap(path: &Path) -> Leftovers {
    let Some(left) = read_own(path) else {
        return Leftovers::default();
    };
    if !this_boot(&left) {
        tracing::info!("not ending what {} names: it is from before the machine restarted", path.display());
        return Leftovers::default();
    }
    let mut doomed = Doomed { group: None, agent: None, family: Family::of(left.processes.clone()) };
    if doomed.signal(None) {
        tracing::info!("ending processes the previous daemon's agents left running");
        tokio::spawn(doomed.end());
    }
    for &(sid, started) in &left.sessions {
        crate::pty::end_recorded_session(sid, Some(started));
    }
    left
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
        save(&path, &Leftovers::of(vec![], vec![(shell.id(), started)])).unwrap();
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

    /// A record naming a fresh `sleep`, changed by `made`; whether reaping
    /// it ended the `sleep`.
    async fn reaping_ends(made: impl FnOnce(&mut Leftovers)) -> bool {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        let mut sleeper = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut left = Leftovers::of(vec![(sleeper.id(), process_start(sleeper.id()).unwrap())], vec![]);
        made(&mut left);
        save(&path, &left).unwrap();
        reap(&path);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let ended = sleeper.try_wait().unwrap().is_some();
        let _ = sleeper.kill();
        sleeper.wait().unwrap();
        ended
    }

    #[tokio::test]
    async fn a_record_from_before_a_reboot_ends_nothing() {
        let second = crate::process::BOOT_TIME_PER_SEC;
        // Another boot, though at the same time by the clock.
        assert!(!reaping_ends(|l| l.boot_id = Some("00000000-0000-0000-0000-000000000000".into())).await, "a process from another boot's record was signalled");
        // Without a boot id, a boot 3 s apart is another.
        assert!(
            !reaping_ends(|l| {
                l.boot_id = None;
                l.boot = l.boot.map(|b| b - 3 * second);
            })
            .await,
            "a process from another boot's record was signalled"
        );
    }

    #[tokio::test]
    async fn a_clock_change_since_the_record_still_ends_what_it_names() {
        let second = crate::process::BOOT_TIME_PER_SEC;
        // The clock went an hour back since: the boot time with it.
        assert!(reaping_ends(|l| l.boot = l.boot.map(|b| b + 3600 * second)).await, "a clock change made the record end nothing");
        // Without a boot id, within 2 s of the boot time is the same boot.
        assert!(
            reaping_ends(|l| {
                l.boot_id = None;
                l.boot = l.boot.map(|b| b - second);
            })
            .await,
            "a boot time 1 s off made the record end nothing"
        );
    }

    #[tokio::test]
    async fn a_record_others_may_write_ends_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        let mut sleeper = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        save(&path, &Leftovers::of(vec![(sleeper.id(), process_start(sleeper.id()).unwrap())], vec![])).unwrap();
        // As if another user had written it, in a shared folder such as /tmp.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(reap(&path), Leftovers::default());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(sleeper.try_wait().unwrap().is_none(), "a process a record others may write names was signalled");
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

    #[tokio::test]
    async fn a_record_behind_a_link_ends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        let mut sleeper = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let elsewhere = dir.path().join("elsewhere.json");
        save(&elsewhere, &Leftovers::of(vec![(sleeper.id(), process_start(sleeper.id()).unwrap())], vec![])).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        assert_eq!(reap(&path), Leftovers::default());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(sleeper.try_wait().unwrap().is_none(), "a process a linked record names was signalled");
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
    }

    #[test]
    fn a_record_is_written_for_its_owner_alone_and_never_through_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        // Planted where the record is first written, pointing at a file of
        // the user's own.
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "mine").unwrap();
        std::os::unix::fs::symlink(&victim, path.with_extension("json.tmp")).unwrap();
        save(&path, &Leftovers::default()).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "mine");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[tokio::test]
    async fn reaping_ends_recorded_processes_and_spares_a_reused_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir.path().join("d.sock"));
        // Ignores SIGTERM, like a dev server: only the SIGKILL ends it.
        let ready = dir.path().join("ready");
        let script = format!("trap '' TERM; touch '{}'; while :; do sleep 1; done", ready.display());
        let stubborn = std::process::Command::new("/bin/sh").args(["-c", &script]).spawn().unwrap();
        while !ready.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let mut other = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let start = |pid| process_start(pid).unwrap();
        // `other` was recorded with a start time that is not its own: its pid
        // belonged to an earlier process.
        let left = Leftovers::of(vec![(stubborn.id(), start(stubborn.id())), (other.id(), start(other.id()) - 1)], vec![]);
        save(&path, &left).unwrap();
        assert_eq!(reap(&path), left, "what it ends is returned");
        let status = ended(stubborn).await;
        assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(libc::SIGKILL));
        assert!(other.try_wait().unwrap().is_none(), "a reused pid was signalled");
        other.kill().unwrap();
        other.wait().unwrap();
    }
}
