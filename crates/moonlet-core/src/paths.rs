//! Filesystem locations. Everything lives under `~/.moonlet` (or
//! `$MOONLET_HOME`) so the layout is identical on macOS and on remote Linux
//! hosts. Before the rename it was `~/.jaunt`; [`migrate_legacy_home`] moves
//! it (X27).

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    home_in(|k| std::env::var_os(k), &user_home())
}

fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// `$MOONLET_HOME`, else jaunt's `$JAUNT_HOME`, else `<user_home>/.moonlet`.
fn home_in(var: impl Fn(&str) -> Option<OsString>, user_home: &Path) -> PathBuf {
    var("MOONLET_HOME")
        .or_else(|| var("JAUNT_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".moonlet"))
}

/// Moves jaunt's `~/.jaunt` to `~/.moonlet` once (X27). Does nothing when a
/// data folder is set through the environment.
pub fn migrate_legacy_home() {
    if std::env::var_os("MOONLET_HOME").is_some() || std::env::var_os("JAUNT_HOME").is_some() {
        return;
    }
    let user = user_home();
    let (legacy, new) = (user.join(".jaunt"), user.join(".moonlet"));
    match migrate_home(&legacy, &new) {
        Ok(true) => tracing::info!("moved {} to {}", legacy.display(), new.display()),
        Ok(false) => {}
        Err(e) => tracing::warn!("cannot move {} to {}: {e}", legacy.display(), new.display()),
    }
}

/// Renames the real folder `legacy` to `new` and leaves a symlink at
/// `legacy`, so absolute paths into it (worktrees in `state.json` and in
/// git's metadata, the working folder of open shells) keep resolving.
/// Returns whether it moved anything: nothing moves when `new` exists or
/// `legacy` is missing or a symlink.
pub fn migrate_home(legacy: &Path, new: &Path) -> std::io::Result<bool> {
    migrate_home_with(legacy, new, |target, link| std::os::unix::fs::symlink(target, link))
}

/// [`migrate_home`] with the symlink step given, so a failing one can be
/// tested. When it fails, the folder goes back to `legacy`.
fn migrate_home_with(
    legacy: &Path,
    new: &Path,
    symlink: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<bool> {
    if std::fs::symlink_metadata(new).is_ok() {
        return Ok(false);
    }
    match std::fs::symlink_metadata(legacy) {
        Ok(m) if m.file_type().is_dir() => {}
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    }
    std::fs::rename(legacy, new)?;
    if let Err(e) = symlink(new, legacy) {
        let _ = std::fs::rename(new, legacy);
        return Err(e);
    }
    Ok(true)
}

pub fn run_dir() -> PathBuf {
    home().join("run")
}

pub fn socket_path() -> PathBuf {
    if let Some(s) = std::env::var_os("MOONLET_SOCK") {
        return PathBuf::from(s);
    }
    default_socket_path()
}

/// The socket moonlet places itself (ignoring `MOONLET_SOCK`); its directory is
/// owned by moonlet and kept at mode 0700.
pub fn default_socket_path() -> PathBuf {
    let path = run_dir().join("moonletd.sock");
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
        "/tmp/moonlet-{}-{:08x}",
        nix::unistd::getuid(),
        hash as u32
    ))
    .join("moonletd.sock")
}

/// Where a jaunt daemon listens: next to moonlet's socket once `~/.jaunt`
/// has moved (X27).
pub fn legacy_socket_path() -> PathBuf {
    run_dir().join("jauntd.sock")
}

/// `sun_path` is 104 bytes on macOS (108 on Linux), including the NUL.
const MAX_SOCKET_PATH: usize = 100;

pub fn state_file() -> PathBuf {
    home().join("state.json")
}

pub fn log_file() -> PathBuf {
    home().join("logs").join("moonletd.log")
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
    fn the_data_folder_is_moonlet_home_then_jaunt_home_then_dot_moonlet() {
        use std::ffi::OsString;
        use std::path::Path;
        let user = Path::new("/Users/me");
        let both = |k: &str| match k {
            "MOONLET_HOME" => Some(OsString::from("/m")),
            "JAUNT_HOME" => Some(OsString::from("/j")),
            _ => None,
        };
        let jaunt_only = |k: &str| (k == "JAUNT_HOME").then(|| OsString::from("/j"));
        assert_eq!(super::home_in(both, user), Path::new("/m"));
        assert_eq!(super::home_in(jaunt_only, user), Path::new("/j"));
        assert_eq!(super::home_in(|_| None, user), Path::new("/Users/me/.moonlet"));
    }

    #[test]
    fn the_jaunt_folder_moves_once_and_leaves_a_symlink() {
        let t = tempfile::tempdir().unwrap();
        let legacy = t.path().join(".jaunt");
        let new = t.path().join(".moonlet");
        std::fs::create_dir_all(legacy.join("worktrees/web/fix")).unwrap();
        std::fs::write(legacy.join("state.json"), "{}").unwrap();

        assert!(super::migrate_home(&legacy, &new).unwrap());
        assert_eq!(std::fs::read_to_string(new.join("state.json")).unwrap(), "{}");
        assert!(std::fs::symlink_metadata(&legacy).unwrap().file_type().is_symlink());
        assert!(legacy.join("worktrees/web/fix").is_dir(), "old paths still resolve");

        assert!(!super::migrate_home(&legacy, &new).unwrap(), "second run changes nothing");
    }

    #[test]
    fn the_jaunt_folder_stays_when_moonlet_exists_or_it_is_a_symlink() {
        let t = tempfile::tempdir().unwrap();
        let legacy = t.path().join(".jaunt");
        let new = t.path().join(".moonlet");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::create_dir(&new).unwrap();
        assert!(!super::migrate_home(&legacy, &new).unwrap());
        assert!(std::fs::symlink_metadata(&legacy).unwrap().is_dir());

        let elsewhere = t.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = t.path().join(".jaunt-link");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let fresh = t.path().join(".moonlet-2");
        assert!(!super::migrate_home(&link, &fresh).unwrap());
        assert!(!fresh.exists());
        assert!(!super::migrate_home(&t.path().join("missing"), &fresh).unwrap());
    }

    #[test]
    fn a_failed_symlink_puts_the_jaunt_folder_back() {
        let t = tempfile::tempdir().unwrap();
        let legacy = t.path().join(".jaunt");
        let new = t.path().join(".moonlet");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("state.json"), "{}").unwrap();

        let failing = |_: &std::path::Path, _: &std::path::Path| -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
        };
        assert!(super::migrate_home_with(&legacy, &new, failing).is_err());
        assert_eq!(std::fs::read_to_string(legacy.join("state.json")).unwrap(), "{}");
        assert!(!new.exists());
    }

    #[test]
    fn long_homes_get_a_short_socket_path() {
        // SAFETY: test-only env mutation, no concurrent env readers in this test binary's case.
        unsafe {
            std::env::remove_var("MOONLET_SOCK");
            std::env::set_var("MOONLET_HOME", format!("/tmp/{}", "x".repeat(120)));
        }
        let p = super::socket_path();
        assert!(
            p.as_os_str().len() < super::MAX_SOCKET_PATH,
            "{}",
            p.display()
        );
        assert!(p.to_string_lossy().starts_with("/tmp/moonlet-"));
        unsafe { std::env::remove_var("MOONLET_HOME") };
    }
}
