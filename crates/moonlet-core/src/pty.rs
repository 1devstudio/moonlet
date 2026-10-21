//! Minimal PTY layer on top of `openpty(3)`.
//!
//! We own the master file descriptor directly (instead of going through a
//! cross-platform crate) so it can be passed to a new daemon process with
//! `SCM_RIGHTS` during a live upgrade. A process adopted that way is not our
//! child, so exit is detected by EOF/EIO on the master plus `kill(pid, 0)`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::pty::{Winsize, openpty};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

pub struct SpawnSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: std::path::PathBuf,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Pty {
    master: OwnedFd,
    pid: u32,
    /// `Some` only when this process spawned the child and can reap it.
    child: Option<std::process::Child>,
}

fn winsize(cols: u16, rows: u16) -> Winsize {
    Winsize {
        ws_row: rows.max(1),
        ws_col: cols.max(1),
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

impl Pty {
    pub fn spawn(spec: SpawnSpec) -> io::Result<Pty> {
        let pair = openpty(&winsize(spec.cols, spec.rows), None).map_err(io::Error::from)?;
        set_cloexec(pair.master.as_raw_fd())?;

        let slave = pair.slave;
        let stdin = Stdio::from(slave.try_clone()?);
        let stdout = Stdio::from(slave.try_clone()?);
        let stderr = Stdio::from(slave);

        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(stdin)
            .stdout(stdout)
            .stderr(stderr);
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                // Restore default signal dispositions the daemon may have changed.
                for sig in [
                    libc::SIGPIPE,
                    libc::SIGHUP,
                    libc::SIGINT,
                    libc::SIGQUIT,
                    libc::SIGTERM,
                    libc::SIGCHLD,
                ] {
                    libc::signal(sig, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        // `cmd` (and with it the slave fds) is dropped here, so the master
        // sees EOF once the child and its descendants close the terminal.
        drop(cmd);
        set_nonblocking(pair.master.as_raw_fd())?;
        Ok(Pty {
            master: pair.master,
            pid: child.id(),
            child: Some(child),
        })
    }

    /// Wraps a master fd received from a previous daemon (live upgrade).
    ///
    /// # Safety
    /// `fd` must be an open PTY master owned by the caller.
    pub unsafe fn adopt(fd: RawFd, pid: u32) -> io::Result<Pty> {
        let master = unsafe { OwnedFd::from_raw_fd(fd) };
        set_cloexec(fd)?;
        set_nonblocking(fd)?;
        Ok(Pty {
            master,
            pid,
            child: None,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn master_fd(&self) -> RawFd {
        self.master.as_raw_fd()
    }

    /// Duplicate of the master, for the async reader/writer.
    pub fn clone_master(&self) -> io::Result<OwnedFd> {
        let fd = self.master.as_fd().try_clone_to_owned()?;
        set_cloexec(fd.as_raw_fd())?;
        Ok(fd)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let ws = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ with a valid winsize pointer.
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) };
        if rc < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Sends `signal` to the whole process group of the session.
    pub fn signal(&self, signal: Signal) -> io::Result<()> {
        let _ = kill(Pid::from_raw(-(self.pid as i32)), signal);
        kill(Pid::from_raw(self.pid as i32), signal).map_err(io::Error::from)
    }

    pub fn is_alive(&self) -> bool {
        kill(Pid::from_raw(self.pid as i32), None).is_ok()
    }

    /// Reaps the child if we spawned it. Returns `(code, signal)`.
    pub fn try_wait(&mut self) -> Option<(Option<i32>, Option<i32>)> {
        use std::os::unix::process::ExitStatusExt;
        match self.child.as_mut()?.try_wait() {
            Ok(Some(status)) => Some((status.code(), status.signal())),
            _ => None,
        }
    }

    /// Blocks until the child exits, if we own it.
    pub fn wait_blocking(&mut self) -> Option<(Option<i32>, Option<i32>)> {
        use std::os::unix::process::ExitStatusExt;
        let status = self.child.as_mut()?.wait().ok()?;
        Some((status.code(), status.signal()))
    }

    /// Releases the reaping handle without killing the child (used before
    /// handing the PTY to another daemon process).
    pub fn forget_child(&mut self) {
        self.child = None;
    }
}

/// Sends `signal` to every process in the session `sid` (the pid of a PTY's
/// child, which is the session leader). Unlike the leader's process group,
/// this reaches jobs a shell moved to their own group, even after the leader
/// has exited. Returns `false` once the session has no processes left.
///
/// Pass `leader_reaped` once the leader has been waited for: its pid is then
/// free, and a process holding it leads a new, unrelated session.
pub fn signal_session(sid: u32, signal: Signal, leader_reaped: bool) -> bool {
    // SAFETY: getsid only reads the process table.
    if leader_reaped && unsafe { libc::getsid(sid as i32) } == sid as i32 {
        return false;
    }
    let mut any = false;
    for pid in all_pids() {
        // SAFETY: getsid only reads the process table.
        if unsafe { libc::getsid(pid) } == sid as i32 {
            any = true;
            let _ = kill(Pid::from_raw(pid), signal);
        }
    }
    any
}

/// After a SIGHUP to session `sid`: SIGTERM after 1.5 s, then SIGKILL after
/// 3 s more, while any process is left in it. `reaped` says whether the
/// session's leader was waited for (see [`signal_session`]).
pub fn escalate_session(sid: u32, reaped: impl Fn() -> bool + Send + 'static) {
    tokio::spawn(async move {
        for (delay, sig) in [(1500, Signal::SIGTERM), (3000, Signal::SIGKILL)] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            if !signal_session(sid, sig, reaped()) {
                return;
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<i32> {
    // SAFETY: a null buffer asks for the count; the second call fills at most
    // `pids.len()` entries and returns how many it wrote.
    unsafe {
        let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if n <= 0 {
            return Vec::new();
        }
        // Headroom for processes started between the two calls.
        let mut pids = vec![0i32; n as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
        let n = libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes);
        pids.truncate(n.max(0) as usize);
        pids
    }
}

#[cfg(not(target_os = "macos"))]
fn all_pids() -> Vec<i32> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect()
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = fcntl(
        unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) },
        FcntlArg::F_GETFL,
    )
    .map_err(io::Error::from)?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(
        unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) },
        FcntlArg::F_SETFL(flags),
    )
    .map_err(io::Error::from)?;
    Ok(())
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    fcntl(
        unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) },
        FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC),
    )
    .map_err(io::Error::from)?;
    Ok(())
}

/// The user's login shell, falling back to `/bin/zsh` on macOS and `/bin/sh` elsewhere.
pub fn user_shell() -> String {
    if let Ok(s) = std::env::var("SHELL")
        && !s.is_empty()
    {
        return s;
    }
    if let Ok(Some(user)) = nix::unistd::User::from_uid(nix::unistd::getuid()) {
        let shell = user.shell.to_string_lossy().to_string();
        if !shell.is_empty() {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh".into()
    } else {
        "/bin/sh".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_session_on_the_exited_leaders_pid_is_left_alone() {
        // A process that called setsid() leads a session whose id is its own
        // pid, just like a new session that took over a reaped leader's pid.
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        // SAFETY: setsid is async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut other = cmd.spawn().unwrap();
        let sid = other.id();

        assert!(!signal_session(sid, Signal::SIGKILL, true));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            other.try_wait().unwrap().is_none(),
            "the other session was killed"
        );

        // While the leader is still ours, the same call stops it.
        assert!(signal_session(sid, Signal::SIGKILL, false));
        other.wait().unwrap();
    }
}
