//! moonletd at system start, before anyone logs in (X113): launchd runs
//! `moonletd daemon --boot` as the user, from a plist in
//! `/Library/LaunchDaemons` that the app writes with an administrator's
//! password. Nothing of moonlet runs as root.

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

/// `moonletd daemon --boot`, run as the user by launchd: whether to
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

/// For a daemon that finds one already listening on `socket`: when that
/// one was started at system start and this one was not, it hands its
/// terminals over, and this returns the socket to take them from.
pub async fn take_over_from_boot(socket: &std::path::Path) -> anyhow::Result<Option<std::path::PathBuf>> {
    use moonlet_proto::methods;
    if started_at_boot() {
        return Ok(None);
    }
    let mut c = moonlet_core::client::Client::connect(socket, "moonletd-login").await?;
    let info: moonlet_proto::types::DaemonInfo = c.request(methods::DAEMON_INFO, ()).await?;
    if !info.started_at_boot {
        return Ok(None);
    }
    let path: String = c.request(methods::DAEMON_HAND_OVER, ()).await?;
    Ok(Some(path.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
