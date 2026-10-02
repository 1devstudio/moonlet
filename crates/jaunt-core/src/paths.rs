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
    run_dir().join("jauntd.sock")
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
