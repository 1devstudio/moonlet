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
/// one of an SSH session. Only tests set it, in the daemon's own
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
    /// stand in for it on a host without one. The app only within an SSH
    /// session (see [`vouched_by_ssh`]).
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

/// Whether `exe` is sshd's: `sshd` or `sshd-session` under /usr, which
/// only root may change (/usr/sbin/sshd, /usr/libexec/sshd-session), or
/// what [`TEST_SSHD_EXE`] names (`test_sshd`).
pub fn is_sshd(exe: &Path, test_sshd: Option<&Path>) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(exe) = exe.canonicalize() else {
        return false;
    };
    if test_sshd.is_some_and(|t| t.canonicalize().is_ok_and(|t| t == exe)) {
        return true;
    }
    let named = matches!(exe.file_name().and_then(|n| n.to_str()), Some("sshd" | "sshd-session"));
    let root_only = std::fs::metadata(&exe).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0);
    named && exe.starts_with("/usr") && root_only
}

/// Whether a `moonletd` process ([`Peer::Moonletd`]) runs within an SSH
/// session, so the SSH login proved who the user is: one of its nearest 4
/// `ancestors` (pid and executable, parent first) is sshd. A process of one
/// of the daemon's own terminals or agents (below `daemon`, its pid) never
/// is, nor one whose ancestors the kernel does not show.
pub fn vouched_by_ssh(ancestors: &[(u32, Option<PathBuf>)], daemon: u32, test_sshd: Option<&Path>) -> bool {
    for (pid, exe) in ancestors.iter().take(4) {
        if *pid == daemon {
            return false;
        }
        if exe.as_deref().is_some_and(|e| is_sshd(e, test_sshd)) {
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

    #[test]
    fn only_root_s_sshd_under_usr_is_sshd() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("sshd");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        assert!(!is_sshd(&fake, None));
        assert!(is_sshd(&fake, Some(&fake)));
        assert!(!is_sshd(Path::new("/usr/bin/true"), None));
        assert!(!is_sshd(Path::new("/usr/sbin/no-such-sshd"), None));
        #[cfg(target_os = "macos")]
        assert!(is_sshd(Path::new("/usr/sbin/sshd"), None));
    }

    #[test]
    fn moonletd_is_the_app_only_within_an_ssh_session() {
        let sshd = || Some(PathBuf::from("/usr/sbin/sshd"));
        let other = |p: &str| Some(PathBuf::from(p));
        let daemon = 4100;
        // `ssh host moonletd proxy`, through the login shell or not.
        assert!(vouched_by_ssh(&[(812, sshd())], daemon, None));
        assert!(vouched_by_ssh(&[(950, other("/bin/zsh")), (812, sshd())], daemon, None));
        // `moonletd pair` typed in an SSH login, 4 processes down at most.
        let deep = [
            (990, other("/usr/bin/env")),
            (980, other("/bin/bash")),
            (950, other("/bin/zsh")),
            (812, sshd()),
        ];
        assert!(vouched_by_ssh(&deep, daemon, None));
        let deeper = [(995, other("/usr/bin/nice")), deep[0].clone(), deep[1].clone(), deep[2].clone(), deep[3].clone()];
        assert!(!vouched_by_ssh(&deeper, daemon, None));

        // Started by another process of the user's.
        assert!(!vouched_by_ssh(&[(700, other("/usr/bin/python3")), (1, other("/sbin/launchd"))], daemon, None));
        // In the daemon's terminal, though the daemon itself started under sshd.
        let in_terminal = [(990, other("/bin/sh")), (daemon, other("/opt/moonlet/moonletd")), (812, sshd())];
        assert!(!vouched_by_ssh(&in_terminal, daemon, None));
        // An ancestor the kernel does not show is not sshd.
        assert!(!vouched_by_ssh(&[(812, None)], daemon, None));
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
