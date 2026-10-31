//! The app credential (X75): a random token the daemon keeps in a file only
//! the user can read. This Mac's app sends it in `hello`; a connection that
//! sends it counts as the app, whatever client name it gives.

use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Where the daemon of `home` (a `MOONLET_HOME`) keeps the token.
pub fn file_in(home: &Path) -> PathBuf {
    home.join("run").join("app-token")
}

/// Where this user's daemon keeps the token.
pub fn file() -> PathBuf {
    file_in(&crate::paths::home())
}

/// The token in `path`; `None` when there is none, or not one the daemon
/// wrote.
pub fn read(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let token = text.trim();
    well_formed(token).then(|| token.to_string())
}

/// The token in `path`, made the first time: 32 random bytes as hex, in a
/// file only the user can read. Kept across restarts, so an app that read it
/// just before the daemon restarted or upgraded still proves itself.
pub fn load_or_create(path: &Path) -> std::io::Result<String> {
    if let Some(dir) = path.parent() {
        crate::paths::ensure_private_dir(dir)?;
    }
    loop {
        if let Some(token) = read(path) {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            return Ok(token);
        }
        // A file that is not a token is replaced.
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        let mut bytes = [0u8; 32];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        let token = crate::hash::hex(&bytes);
        // Only one of two daemons starting at once writes it; the other
        // reads what that one wrote.
        match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
            Ok(mut f) => {
                f.write_all(token.as_bytes())?;
                f.sync_all()?;
                return Ok(token);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Whether `sent` is `token`. Compared as hashes, so the time it takes says
/// nothing about how much of the token matched.
pub fn matches(token: &str, sent: &str) -> bool {
    crate::hash::sha256_hex(token.as_bytes()) == crate::hash::sha256_hex(sent.as_bytes())
}

fn well_formed(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The file name of the app's executable: the Tauri crate's binary. The
/// bundle keeps it beside the `moonletd` the daemon runs from
/// (`Contents/MacOS`), and so do the dev and e2e builds (`target/debug`,
/// `target/e2e/debug`).
pub const APP_EXE: &str = "moonlet-app";

/// Names the executable a test connects from, so the test counts as the
/// app. Only tests set it, in the daemon's own environment.
pub const TEST_APP_EXE: &str = "MOONLET_TEST_APP_EXE";

/// Names sshd's executable for a test, so a process it starts counts as
/// one of an SSH session, whoever runs it. Only tests set it, in the daemon's own
/// environment.
pub const TEST_SSHD_EXE: &str = "MOONLET_TEST_SSHD_EXE";

/// What a local process that sent the credential runs, as the kernel says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peer {
    /// The app beside the daemon's executable, or what [`TEST_APP_EXE`]
    /// names: the app.
    App,
    /// The daemon's own executable: `moonletd proxy`, which vouches for the
    /// app on an SSH host, or `moonletd pair`, `tailnet` or `join`, which
    /// stand in for it on a host without one. The app only when a login
    /// started it (see [`vouched`]).
    Moonletd,
    /// Anything else, a copy of the app elsewhere included, and anything
    /// whose path does not resolve.
    Other,
}

/// What a process that runs `exe` is. `daemon_exe` is the daemon's own
/// executable; `test_exe` is what [`TEST_APP_EXE`] names. Compared as
/// canonical paths.
pub fn peer(exe: &Path, daemon_exe: &Path, test_exe: Option<&Path>) -> Peer {
    let (Ok(exe), Ok(daemon_exe)) = (exe.canonicalize(), daemon_exe.canonicalize()) else {
        return Peer::Other;
    };
    let is_exe = |p: &Path| p.canonicalize().is_ok_and(|p| p == exe);
    if daemon_exe.parent().is_some_and(|dir| is_exe(&dir.join(APP_EXE))) || test_exe.is_some_and(is_exe) {
        Peer::App
    } else if exe == daemon_exe {
        Peer::Moonletd
    } else {
        Peer::Other
    }
}

/// What starts a login session as root, and so vouches for a `moonletd` it
/// starts (X75): SSH, the console, sudo, su and runuser.
pub const SESSION_STARTERS: [&str; 6] = ["sshd", "sshd-session", "login", "sudo", "su", "runuser"];

/// One of a process's ancestors, as the kernel says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ancestor {
    pub pid: u32,
    /// The executable it runs. `None` where the kernel does not say, as
    /// Linux does not to the user for root's processes, nor for sshd's own
    /// once it changed user.
    pub exe: Option<PathBuf>,
    /// The name the kernel keeps for it (Linux's `comm`, the file name it
    /// was started as), which Linux shows even where it hides the
    /// executable. `None` on macOS.
    pub name: Option<String>,
    /// Whether it runs as root: real and effective uid 0. `None` where the
    /// kernel does not say, as on macOS.
    pub root: Option<bool>,
}

/// The nearest 4 ancestors of process `pid`, parent first, as
/// [`vouched`] takes them.
pub fn ancestors(pid: u32) -> Vec<Ancestor> {
    crate::process::ancestors(pid, 4)
        .into_iter()
        .map(|(pid, exe)| Ancestor {
            pid,
            exe,
            name: crate::process::kernel_name(pid),
            root: crate::process::runs_as_root(pid),
        })
        .collect()
}

/// Which of [`SESSION_STARTERS`] `exe` is: one under /usr, /bin or /sbin
/// that only root may change, such as /usr/sbin/sshd,
/// /usr/libexec/sshd-session or /usr/bin/sudo. Compared as a canonical
/// path.
pub fn session_starter(exe: &Path) -> Option<&'static str> {
    use std::os::unix::fs::MetadataExt;
    let exe = exe.canonicalize().ok()?;
    let name = exe.file_name()?.to_str()?;
    let starter = SESSION_STARTERS.into_iter().find(|s| *s == name)?;
    let under = ["/usr", "/bin", "/sbin"].into_iter().any(|dir| exe.starts_with(dir));
    let root_only = std::fs::metadata(&exe).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0);
    (under && root_only).then_some(starter)
}

/// Whether a `moonletd` process ([`Peer::Moonletd`]: `proxy`, `pair`,
/// `tailnet` or `join`) was started at a login that proved who the user is:
/// over SSH, at the console, through sudo or su, or by root's runuser, as a
/// cloud machine's first boot runs `moonletd join` (X63). One of its nearest
/// 4 `ancestors` (parent first) is one of [`SESSION_STARTERS`] and runs as
/// root, real and effective uid 0. sudo or su that the user runs keeps the
/// user's real uid, so it never vouches itself; what it runs as root may.
///
/// A starter is known by its executable ([`session_starter`]) where the
/// kernel shows it, else by the name the kernel keeps for it: only root
/// makes a process that runs as root. Where the kernel does not say who runs
/// a process (macOS), sshd still vouches by its executable. Init (pid 1),
/// which an orphan moves to, never vouches, nor does anything above the
/// daemon (`daemon`, its pid) for its own terminals and agents. What
/// [`TEST_SSHD_EXE`] names (`test_sshd`) vouches whoever runs it.
pub fn vouched(ancestors: &[Ancestor], daemon: u32, test_sshd: Option<&Path>) -> bool {
    let test_sshd = test_sshd.and_then(|t| t.canonicalize().ok());
    for a in ancestors.iter().take(4) {
        if a.pid == daemon || a.pid <= 1 {
            return false;
        }
        let exe = a.exe.as_deref();
        if test_sshd.is_some() && exe.and_then(|e| e.canonicalize().ok()) == test_sshd {
            return true;
        }
        let starter = match exe {
            Some(exe) => session_starter(exe),
            None => a.name.as_deref().and_then(|n| SESSION_STARTERS.into_iter().find(|s| *s == n)),
        };
        let vouches = match (starter, a.root) {
            (Some(_), Some(true)) => true,
            (Some("sshd" | "sshd-session"), None) => exe.is_some(),
            _ => false,
        };
        if vouches {
            return true;
        }
    }
    false
}

/// Whether `moonletd proxy` runs as an SSH session's command, so it may add
/// the credential to the app's `hello` (the SSH login proved who the user
/// is). `set` says whether an environment variable is set; `ancestors` are
/// the file names of the proxy's parent's executable, then its parent's.
///
/// sshd starts the command, directly or through the user's shell. Never in
/// a moonlet terminal, where an agent runs as the user too.
pub fn ssh_session_command(set: impl Fn(&str) -> bool, ancestors: &[&str]) -> bool {
    const SSHD: [&str; 2] = ["sshd", "sshd-session"];
    const SHELLS: [&str; 8] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"];
    if !set("SSH_CONNECTION") || set("MOONLET_TERMINAL_ID") || set("MOONLET_SOCK") {
        return false;
    }
    match ancestors {
        [parent, ..] if SSHD.contains(parent) => true,
        [shell, parent, ..] => SHELLS.contains(shell) && SSHD.contains(parent),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_made_once_in_a_file_only_the_user_reads() {
        let home = tempfile::tempdir().unwrap();
        let path = file_in(home.path());
        assert_eq!(path, home.path().join("run/app-token"));

        let token = load_or_create(&path).unwrap();
        assert_eq!(token.len(), 64);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(read(&path).as_deref(), Some(token.as_str()));
        // A restart keeps it.
        assert_eq!(load_or_create(&path).unwrap(), token);
    }

    #[test]
    fn a_file_that_is_not_a_token_is_replaced() {
        let home = tempfile::tempdir().unwrap();
        let path = file_in(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "moonlet-app").unwrap();
        assert_eq!(read(&path), None);

        let token = load_or_create(&path).unwrap();
        assert_ne!(token, "moonlet-app");
        assert_eq!(read(&path).as_deref(), Some(token.as_str()));
    }

    #[test]
    fn only_the_token_itself_matches() {
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(matches(token, token));
        assert!(!matches(token, "0123456789abcdef"));
        assert!(!matches(token, ""));
    }

    #[test]
    fn only_the_app_beside_the_daemon_is_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let file = |rel: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            p
        };
        let daemon = file("moonlet.app/Contents/MacOS/moonletd");
        let app = file("moonlet.app/Contents/MacOS/moonlet-app");
        let cli = file("moonlet.app/Contents/MacOS/moonlet");
        let copy = file("Downloads/moonlet-app");
        let test = file("target/debug/deps/browser-0123abcd");
        assert_eq!(peer(&app, &daemon, None), Peer::App);
        assert_eq!(peer(&daemon, &daemon, None), Peer::Moonletd);
        // The same file by another path.
        let via = dir.path().join("moonlet.app/Contents/MacOS/../MacOS/moonlet-app");
        assert_eq!(peer(&via, &daemon, None), Peer::App);

        // A copy elsewhere under the app's name, or another binary beside it.
        assert_eq!(peer(&copy, &daemon, None), Peer::Other);
        assert_eq!(peer(&cli, &daemon, None), Peer::Other);
        assert_eq!(peer(&test, &daemon, None), Peer::Other);
        // A path that does not resolve is never the app.
        let gone = dir.path().join("moonlet.app/Contents/MacOS/gone");
        assert_eq!(peer(&gone, &daemon, None), Peer::Other);
        assert_eq!(peer(&app, &gone, None), Peer::Other);

        assert_eq!(peer(&test, &daemon, Some(&test)), Peer::App);
        assert_eq!(peer(&copy, &daemon, Some(&test)), Peer::Other);
    }

    /// An ancestor as Linux shows it to the user's daemon: its name and
    /// uids, and no executable for root's processes, nor for sshd's own
    /// once it changed user.
    fn linux(pid: u32, name: &str, root: bool) -> Ancestor {
        Ancestor { pid, exe: None, name: Some(name.into()), root: Some(root) }
    }

    /// An ancestor as macOS shows it: its executable, not who runs it.
    fn mac(pid: u32, exe: &str) -> Ancestor {
        Ancestor { pid, exe: Some(PathBuf::from(exe)), name: None, root: None }
    }

    #[test]
    fn only_root_s_session_starters_under_usr_bin_or_sbin_count() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["sshd", "login", "sudo", "su", "runuser"] {
            let fake = dir.path().join(name);
            std::fs::write(&fake, "#!/bin/sh\n").unwrap();
            assert_eq!(session_starter(&fake), None, "{name}");
        }
        assert_eq!(session_starter(Path::new("/usr/bin/true")), None);
        assert_eq!(session_starter(Path::new("/usr/sbin/no-such-sshd")), None);
        #[cfg(target_os = "macos")]
        {
            assert_eq!(session_starter(Path::new("/usr/sbin/sshd")), Some("sshd"));
            assert_eq!(session_starter(Path::new("/usr/bin/login")), Some("login"));
            assert_eq!(session_starter(Path::new("/usr/bin/sudo")), Some("sudo"));
        }
    }

    #[test]
    fn moonletd_is_the_app_below_root_s_sshd_login_sudo_su_or_runuser() {
        let daemon = 4100;
        // `moonletd pair` typed in an SSH login, as /proc showed it on Alpine
        // 3 with OpenSSH 10: the user's sshd-session, then root's.
        let ssh = [
            linux(216, "ash", false),
            linux(215, "sshd-session", false),
            linux(213, "sshd-session", true),
        ];
        assert!(vouched(&ssh, daemon, None));
        // An older OpenSSH, sshd for both.
        assert!(vouched(&[linux(940, "sshd", false), linux(930, "sshd", true)], daemon, None));
        // At the console.
        assert!(vouched(&[linux(990, "bash", false), linux(812, "login", true)], daemon, None));
        // `sudo runuser -u <user> -- moonletd tailnet on`, as a cloud
        // machine's first boot runs `runuser -l moonlet -c "moonletd join …"`.
        let runuser = [linux(1412, "runuser", true), linux(1411, "sudo", false), linux(1400, "bash", false)];
        assert!(vouched(&runuser, daemon, None));
        // su and sudo that root runs.
        assert!(vouched(&[linux(172, "su", true)], daemon, None));
        assert!(vouched(&[linux(990, "sh", false), linux(980, "sudo", true)], daemon, None));
        // macOS does not say who runs sshd: its path still vouches.
        #[cfg(target_os = "macos")]
        assert!(vouched(&[mac(950, "/bin/zsh"), mac(812, "/usr/sbin/sshd")], daemon, None));

        // 4 processes up at most.
        let deep = [
            linux(990, "env", false),
            linux(980, "bash", false),
            linux(950, "zsh", false),
            linux(812, "login", true),
        ];
        assert!(vouched(&deep, daemon, None));
        let deeper = [linux(995, "nice", false), deep[0].clone(), deep[1].clone(), deep[2].clone(), deep[3].clone()];
        assert!(!vouched(&deeper, daemon, None));
    }

    #[test]
    fn sudo_that_the_user_runs_does_not_vouch() {
        // `sudo -u <user> moonletd pair`, with a terminal: sudo keeps the
        // user's real uid (`Uid: 1000 0 0 0`), as it does while it runs
        // SUDO_ASKPASS before any password is checked.
        let sudo = [linux(50, "sudo", false), linux(49, "sudo", false), linux(48, "bash", false)];
        assert!(!vouched(&sudo, 4100, None));
        for name in ["sshd", "sshd-session", "login", "su", "runuser"] {
            assert!(!vouched(&[linux(900, name, false)], 4100, None), "{name}");
        }
        // Where the kernel does not say who runs it, only sshd vouches.
        assert!(!vouched(&[mac(900, "/usr/bin/sudo")], 4100, None));
        assert!(!vouched(&[mac(900, "/usr/bin/login")], 4100, None));
    }

    #[test]
    fn init_and_root_s_other_processes_never_vouch() {
        // Init, which an orphan moves to, whatever it runs.
        assert!(!vouched(&[linux(1, "login", true)], 4100, None));
        assert!(!vouched(&[linux(990, "sh", false), linux(1, "su", true)], 4100, None));
        for name in ["cron", "systemd", "bash", "containerd-shim"] {
            assert!(!vouched(&[linux(700, name, true)], 4100, None), "{name}");
        }
        // Named sudo, but its executable is known and is not root's sudo.
        let named = Ancestor {
            pid: 812,
            exe: Some(PathBuf::from("/tmp/sudo")),
            name: Some("sudo".into()),
            root: Some(true),
        };
        assert!(!vouched(&[named], 4100, None));
        // An ancestor the kernel does not show.
        let hidden = Ancestor { pid: 812, exe: None, name: None, root: None };
        assert!(!vouched(&[hidden], 4100, None));
        // Started by another process of the user's.
        assert!(!vouched(&[mac(700, "/usr/bin/python3"), mac(650, "/sbin/launchd")], 4100, None));
    }

    #[test]
    fn an_agent_below_the_daemon_is_never_the_app() {
        let daemon = 4100;
        // In the daemon's terminal, though the daemon itself started in an
        // SSH login.
        let agent = [
            linux(990, "node", false),
            linux(980, "zsh", false),
            linux(daemon, "moonletd", false),
            linux(812, "sshd-session", true),
        ];
        assert!(!vouched(&agent, daemon, None));
        #[cfg(target_os = "macos")]
        assert!(!vouched(&[mac(990, "/bin/sh"), mac(daemon, "/opt/moonlet/moonletd"), mac(812, "/usr/sbin/sshd")], daemon, None));
    }

    #[test]
    fn the_test_s_sshd_vouches_whoever_runs_it() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("sshd");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        let chain = [Ancestor { pid: 812, exe: Some(fake.clone()), name: None, root: Some(false) }];
        assert!(!vouched(&chain, 4100, None));
        assert!(vouched(&chain, 4100, Some(&fake)));
    }

    #[test]
    fn the_proxy_vouches_only_as_an_ssh_session_s_command() {
        let ssh = |name: &str| name == "SSH_CONNECTION";
        assert!(ssh_session_command(ssh, &["sshd", "sshd"]));
        assert!(ssh_session_command(ssh, &["sshd-session", "sshd"]));
        // Through a login shell that does not exec its one command.
        assert!(ssh_session_command(ssh, &["fish", "sshd-session"]));

        // Not under sshd: run by another process of the user's.
        assert!(!ssh_session_command(ssh, &["python3", "sshd-session"]));
        assert!(!ssh_session_command(ssh, &["bash", "node"]));
        assert!(!ssh_session_command(ssh, &["browser-0123abcd", "cargo"]));
        assert!(!ssh_session_command(ssh, &[]));
        // Not an SSH session.
        assert!(!ssh_session_command(|_| false, &["sshd-session", "sshd"]));
        // In a moonlet terminal, as an agent would be.
        for var in ["MOONLET_TERMINAL_ID", "MOONLET_SOCK"] {
            let in_terminal = |name: &str| name == "SSH_CONNECTION" || name == var;
            assert!(!ssh_session_command(in_terminal, &["sshd-session", "sshd"]), "{var}");
        }
    }
}
