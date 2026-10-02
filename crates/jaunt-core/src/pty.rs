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
