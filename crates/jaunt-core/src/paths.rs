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

#[cfg(test)]
mod tests {
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

pub fn state_file() -> PathBuf {
    home().join("state.json")
}

pub fn log_file() -> PathBuf {
    home().join("logs").join("jauntd.log")
}

pub fn bin_dir() -> PathBuf {
    home().join("bin")
}

/// Creates `dir` (and parents) and restricts it to the current user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
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
