//! Filesystem locations. Everything lives under `~/.jaunt` (or `$JAUNT_HOME`)
//! so the layout is identical on macOS and on remote Linux hosts.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

pub fn home() -> PathBuf {
    if let Some(h) = std::env::var_os("JAUNT_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".jaunt")
}

pub fn run_dir() -> PathBuf {
    home().join("run")
}

pub fn socket_path() -> PathBuf {
    if let Some(s) = std::env::var_os("JAUNT_SOCK") {
        return PathBuf::from(s);
    }
    default_socket_path()
}

/// The socket jaunt places itself (ignoring `JAUNT_SOCK`); its directory is
/// owned by jaunt and kept at mode 0700.
pub fn default_socket_path() -> PathBuf {
    let path = run_dir().join("jauntd.sock");
    if path.as_os_str().len() < MAX_SOCKET_PATH {
        return path;
    }
    // Unix socket paths are limited to ~104 bytes on macOS. With a long home
    // directory, fall back to a short per-user directory, like tmux does.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in home().as_os_str().as_encoded_bytes() {
        hash = (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3);
    }
    PathBuf::from(format!(
        "/tmp/jaunt-{}-{:08x}",
        nix::unistd::getuid(),
        hash as u32
    ))
    .join("jauntd.sock")
}

/// `sun_path` is 104 bytes on macOS (108 on Linux), including the NUL.
const MAX_SOCKET_PATH: usize = 100;

pub fn state_file() -> PathBuf {
    home().join("state.json")
}

pub fn log_file() -> PathBuf {
    home().join("logs").join("jauntd.log")
}

pub fn bin_dir() -> PathBuf {
    home().join("bin")
}

/// Creates `dir` (parents as needed) at mode 0700, or checks an existing
/// one: it must be a real directory (not a symlink) owned by this user.
/// Matters for the socket fallback under world-writable `/tmp`, where
/// another user could pre-create the path.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent)?;
            }
            match std::fs::DirBuilder::new().mode(0o700).create(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            std::fs::symlink_metadata(dir)?
        }
        Err(e) => return Err(e),
    };
    let refuse = |why: &str| {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{}: {why}", dir.display()),
        ))
    };
    if !meta.file_type().is_dir() {
        return refuse("not a directory (or a symlink)");
    }
    if meta.uid() != nix::unistd::getuid().as_raw() {
        return refuse("owned by another user");
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "localhost".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn private_dirs_refuse_symlinks_and_tighten_modes() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("a/b");
        super::ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        super::ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&d, &link).unwrap();
        assert!(super::ensure_private_dir(&link).is_err());
    }

    #[test]
    fn long_homes_get_a_short_socket_path() {
        // SAFETY: test-only env mutation, no concurrent env readers in this test binary's case.
        unsafe {
            std::env::remove_var("JAUNT_SOCK");
            std::env::set_var("JAUNT_HOME", format!("/tmp/{}", "x".repeat(120)));
        }
        let p = super::socket_path();
        assert!(
            p.as_os_str().len() < super::MAX_SOCKET_PATH,
            "{}",
            p.display()
        );
        assert!(p.to_string_lossy().starts_with("/tmp/jaunt-"));
        unsafe { std::env::remove_var("JAUNT_HOME") };
    }
}
