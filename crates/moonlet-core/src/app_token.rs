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

/// Whether a local process that runs `exe`, as the kernel says, may count
/// as the app, with the credential. `daemon_exe` is the daemon's own
/// executable; `test_exe` is what [`TEST_APP_EXE`] names.
///
/// Only these exact files may: the app beside `daemon_exe`, `daemon_exe`
/// itself (`moonletd proxy` vouches for the app on an SSH host, and
/// `moonletd pair`, `tailnet` and `join` stand in for it on a host without
/// it), and `test_exe`. Compared as canonical paths; a path that cannot be
/// resolved never matches.
pub fn may_be_the_app(exe: &Path, daemon_exe: &Path, test_exe: Option<&Path>) -> bool {
    let (Ok(exe), Ok(daemon_exe)) = (exe.canonicalize(), daemon_exe.canonicalize()) else {
        return false;
    };
    let is_exe = |p: &Path| p.canonicalize().is_ok_and(|p| p == exe);
    exe == daemon_exe
        || daemon_exe.parent().is_some_and(|dir| is_exe(&dir.join(APP_EXE)))
        || test_exe.is_some_and(is_exe)
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
    fn only_the_app_beside_the_daemon_and_the_daemon_itself_may_be_the_app() {
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
        assert!(may_be_the_app(&app, &daemon, None));
        assert!(may_be_the_app(&daemon, &daemon, None));
        // The same file by another path.
        let via = dir.path().join("moonlet.app/Contents/MacOS/../MacOS/moonlet-app");
        assert!(may_be_the_app(&via, &daemon, None));

        // A copy elsewhere under the app's name, or another binary beside it.
        assert!(!may_be_the_app(&copy, &daemon, None));
        assert!(!may_be_the_app(&cli, &daemon, None));
        assert!(!may_be_the_app(&test, &daemon, None));
        // A path that does not resolve is never the app.
        let gone = dir.path().join("moonlet.app/Contents/MacOS/gone");
        assert!(!may_be_the_app(&gone, &daemon, None));
        assert!(!may_be_the_app(&app, &gone.with_file_name("moonletd-gone"), None));

        assert!(may_be_the_app(&test, &daemon, Some(&test)));
        assert!(!may_be_the_app(&copy, &daemon, Some(&test)));
    }
}
