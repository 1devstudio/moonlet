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
}
