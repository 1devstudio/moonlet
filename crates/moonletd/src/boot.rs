//! moonletd at system start, before anyone logs in (X113).

use std::sync::atomic::{AtomicBool, Ordering};

static STARTED_AT_BOOT: AtomicBool = AtomicBool::new(false);

/// Whether this daemon was started at system start, outside a login session.
pub fn started_at_boot() -> bool {
    STARTED_AT_BOOT.load(Ordering::SeqCst)
}

/// The user's choice in `app.toml`'s text: `start_daemon_at_boot`, off
/// when missing or when the file does not parse.
pub fn wants_boot(app_toml: &str) -> bool {
    toml::from_str::<toml::Table>(app_toml)
        .ok()
        .and_then(|t| t.get("start_daemon_at_boot")?.as_bool())
        .unwrap_or(false)
}

/// `moonletd daemon --boot`, run as the user by `moonletd boot`: whether to
/// go on and serve. With `check_choice`, only a user who turned the switch
/// on gets a daemon. Call it before any thread exists: it sets the
/// environment.
pub fn start_daemon(check_choice: bool) -> bool {
    if check_choice {
        let file = moonlet_core::paths::home().join("app.toml");
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        if !wants_boot(&text) {
            return false;
        }
    }
    // launchd gives a launch daemon no TMPDIR; a login session has the
    // user's own temporary folder there.
    #[cfg(target_os = "macos")]
    if std::env::var_os("TMPDIR").is_none()
        && let Some(dir) = user_temp_dir()
    {
        // SAFETY: the caller runs before any other thread exists.
        unsafe { std::env::set_var("TMPDIR", dir) };
    }
    STARTED_AT_BOOT.store(true, Ordering::SeqCst);
    true
}

/// The calling user's temporary folder, `confstr(_CS_DARWIN_USER_TEMP_DIR)`.
#[cfg(target_os = "macos")]
fn user_temp_dir() -> Option<std::ffi::OsString> {
    use std::os::unix::ffi::OsStringExt;
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: `buf` is writable for its length.
    let n = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n == 0 || n > buf.len() {
        return None;
    }
    buf.truncate(n - 1);
    Some(std::ffi::OsString::from_vec(buf))
}

/// A local account, as `getpwent` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: std::path::PathBuf,
    pub shell: std::path::PathBuf,
}

/// The accounts the launcher starts a daemon for, once each: people, with
/// a uid from 501, a home folder under `/Users` and a shell they can log
/// in with. Whether each wants one is theirs to say, in their `app.toml`.
pub fn local_users(all: Vec<Account>) -> Vec<Account> {
    let mut seen = std::collections::BTreeSet::new();
    all.into_iter()
        .filter(|a| {
            a.uid >= 501
                && a.home.starts_with("/Users")
                && a.home != std::path::Path::new("/Users")
                && !["/usr/bin/false", "/sbin/nologin", "/usr/sbin/nologin"]
                    .iter()
                    .any(|s| a.shell == std::path::Path::new(s))
        })
        .filter(|a| seen.insert(a.uid))
        .collect()
}

/// What the launcher does once a user's daemon has exited.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterExit {
    /// It handed over at login, found a daemon already listening, or its
    /// user left the switch off.
    Done,
    /// It crashed: started again after [`RESTART_AFTER`].
    Restart,
}

/// The daemon's exit code, `None` when a signal killed it.
pub fn after_exit(code: Option<i32>) -> AfterExit {
    match code {
        Some(0) => AfterExit::Done,
        _ => AfterExit::Restart,
    }
}

/// As launchd's own throttle.
pub const RESTART_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

/// `moonletd boot`, run as root by the bundled launch daemon at system
/// start: starts every local user's daemon as that user, and starts again
/// one that crashes. It reads none of the users' files: each daemon, already
/// its user, checks its own `app.toml`.
#[cfg(target_os = "macos")]
pub fn run() -> anyhow::Result<()> {
    use std::time::Instant;
    if !nix::unistd::getuid().is_root() {
        anyhow::bail!("moonletd boot runs from launchd at system start");
    }
    init_log();
    let exe = std::env::current_exe()?;
    struct Daemon {
        account: Account,
        child: Option<std::process::Child>,
        start_at: Instant,
    }
    let mut daemons: Vec<Daemon> = local_users(launcher::accounts())
        .into_iter()
        .map(|account| Daemon {
            account,
            child: None,
            start_at: Instant::now(),
        })
        .collect();
    tracing::info!(users = daemons.len(), "moonletd boot starting");
    while !daemons.is_empty() {
        daemons.retain_mut(|d| {
            let uid = d.account.uid;
            match &mut d.child {
                None if Instant::now() >= d.start_at => match launcher::spawn(&exe, &d.account) {
                    Ok(child) => {
                        tracing::info!(uid, pid = child.id(), "started moonletd");
                        d.child = Some(child);
                    }
                    Err(e) => {
                        tracing::warn!(uid, "cannot start moonletd: {e:#}");
                        d.start_at = Instant::now() + RESTART_AFTER;
                    }
                },
                None => {}
                Some(child) => match child.try_wait() {
                    Ok(None) => {}
                    Ok(Some(status)) => {
                        let code = status.code();
                        match after_exit(code) {
                            AfterExit::Done => {
                                tracing::info!(uid, "moonletd exited 0");
                                return false;
                            }
                            AfterExit::Restart => {
                                tracing::warn!(uid, ?status, "moonletd exited; starting it again");
                                d.child = None;
                                d.start_at = Instant::now() + RESTART_AFTER;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(uid, "cannot wait for moonletd: {e}");
                        return false;
                    }
                },
            }
            true
        });
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    tracing::info!("every daemon is done; moonletd boot exits");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run() -> anyhow::Result<()> {
    anyhow::bail!(
        "moonletd boot is for macOS: on Linux, `loginctl enable-linger` starts the daemon at boot (X58)"
    )
}

/// `/Library/Logs/moonlet/boot.log`, which names users by uid only.
#[cfg(target_os = "macos")]
fn init_log() {
    let dir = std::path::Path::new("/Library/Logs/moonlet");
    let _ = std::fs::create_dir_all(dir);
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("boot.log"))
    {
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .init();
    }
}

#[cfg(target_os = "macos")]
mod launcher {
    use super::Account;
    use std::ffi::{CStr, CString};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};

    /// Every account `getpwent` lists.
    pub fn accounts() -> Vec<Account> {
        let mut all = Vec::new();
        // SAFETY: one thread; each entry is copied before the next call.
        unsafe {
            libc::setpwent();
            loop {
                let pw = libc::getpwent();
                if pw.is_null() {
                    break;
                }
                let pw = &*pw;
                let text =
                    |p: *const libc::c_char| CStr::from_ptr(p).to_string_lossy().into_owned();
                all.push(Account {
                    name: text(pw.pw_name),
                    uid: pw.pw_uid,
                    gid: pw.pw_gid,
                    home: PathBuf::from(text(pw.pw_dir)),
                    shell: PathBuf::from(text(pw.pw_shell)),
                });
            }
            libc::endpwent();
        }
        all
    }

    /// Starts `moonletd daemon --boot` as `a`, with only the variables a
    /// login would set; launchd sets none of them for a daemon.
    pub fn spawn(exe: &Path, a: &Account) -> anyhow::Result<Child> {
        let name = CString::new(a.name.as_str())?;
        let (uid, gid) = (a.uid, a.gid);
        let mut cmd = Command::new(exe);
        cmd.args(["daemon", "--boot"])
            .env_clear()
            .env("HOME", &a.home)
            .env("USER", &a.name)
            .env("LOGNAME", &a.name)
            .env("SHELL", &a.shell)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir(&a.home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: the launcher has one thread, so the child may call these
        // between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                let fail = || Err(std::io::Error::last_os_error());
                if libc::initgroups(name.as_ptr(), gid as libc::c_int) != 0
                    || libc::setgid(gid) != 0
                    || libc::setuid(uid) != 0
                {
                    return fail();
                }
                // Root must be gone for good.
                if libc::setuid(0) == 0
                    || libc::getuid() != uid
                    || libc::geteuid() != uid
                    || libc::getegid() != gid
                {
                    return Err(std::io::Error::other("still able to become root"));
                }
                Ok(())
            });
        }
        Ok(cmd.spawn()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn account(name: &str, uid: u32, gid: u32, home: &str, shell: &str) -> Account {
        Account {
            name: name.into(),
            uid,
            gid,
            home: PathBuf::from(home),
            shell: PathBuf::from(shell),
        }
    }

    #[test]
    fn the_launcher_tries_only_real_local_users() {
        // As `getpwent` lists them on macOS 27 (`dscl . -read /Users/<name>`),
        // plus two people: `nobody`'s uid -2 reads as 4294967294.
        let all = vec![
            account("root", 0, 0, "/var/root", "/bin/sh"),
            account("daemon", 1, 1, "/var/root", "/usr/bin/false"),
            account(
                "nobody",
                4294967294,
                4294967294,
                "/var/empty",
                "/usr/bin/false",
            ),
            account("_www", 70, 70, "/Library/WebServer", "/usr/bin/false"),
            account("_mbsetupuser", 248, 248, "/var/setup", "/bin/bash"),
            account("alex", 501, 20, "/Users/alex", "/bin/zsh"),
            account("kim", 502, 20, "/Users/kim", "/usr/bin/false"),
            account("sam", 503, 20, "/Users/sam", "/bin/bash"),
            account("alex", 501, 20, "/Users/alex", "/bin/zsh"),
        ];
        let names: Vec<String> = local_users(all).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["alex", "sam"]);
    }

    #[test]
    fn a_crashed_boot_daemon_is_started_again_and_a_finished_one_is_not() {
        // Exit 0: it handed over at login, found a daemon already
        // listening, or its user left the switch off.
        assert_eq!(after_exit(Some(0)), AfterExit::Done);
        assert_eq!(after_exit(Some(1)), AfterExit::Restart);
        // Killed by a signal.
        assert_eq!(after_exit(None), AfterExit::Restart);
    }

    #[test]
    fn the_boot_choice_is_read_from_app_toml() {
        assert!(wants_boot(
            "start_daemon_at_login = true\nstart_daemon_at_boot = true\n"
        ));
        assert!(!wants_boot("start_daemon_at_boot = false\n"));
        assert!(!wants_boot("start_daemon_at_login = true\n"));
        assert!(!wants_boot("start_daemon_at_boot = \"yes\"\n"));
        assert!(!wants_boot("this is [not toml"));
    }
}
