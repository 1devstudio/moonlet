//! Starting the daemon detached from its caller, and capturing the user's
//! login environment so PTYs and git see the same PATH as a terminal would.

use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::UnixStream;

/// Spawns `moonletd daemon` in its own session so it survives the caller
/// (the app, a CLI call or an SSH connection) and waits until it listens.
pub async fn ensure_running(socket: &Path) -> Result<()> {
    if UnixStream::connect(socket).await.is_ok() {
        return Ok(());
    }
    let exe = std::env::current_exe().context("cannot locate moonletd binary")?;
    if socket == moonlet_core::paths::default_socket_path() && take_over_jaunt(socket, &exe).await {
        return Ok(());
    }
    let log = moonlet_core::paths::log_file();
    if let Some(dir) = log.parent() {
        moonlet_core::paths::ensure_private_dir(dir)?;
    }
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var_os("MOONLET_SOCK").is_none() {
        cmd.env("MOONLET_SOCK", socket);
    }
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("failed to spawn moonletd")?;
    moonlet_core::client::wait_for_socket(&socket.to_path_buf(), Duration::from_secs(10)).await
}

/// Hands the terminals of a jaunt daemon still running on `run/jauntd.sock`
/// to this binary, listening on `socket` (X27). False when there is none, or
/// the handoff failed and a fresh daemon has to start.
async fn take_over_jaunt(socket: &Path, exe: &Path) -> bool {
    let legacy = moonlet_core::paths::legacy_socket_path();
    if UnixStream::connect(&legacy).await.is_err() {
        return false;
    }
    match crate::upgrade::request_upgrade_from(&legacy, socket, exe.to_path_buf()).await {
        Ok(()) => {
            tracing::info!("took over jaunt's daemon");
            // Hooks and CLI calls from jaunt's binary still dial the old
            // socket until the hooks are reinstalled.
            let _ = std::fs::remove_file(&legacy);
            if let Err(e) = std::os::unix::fs::symlink(socket, &legacy) {
                tracing::warn!("cannot link {}: {e}", legacy.display());
            }
            // The launchd agent belongs to the default data folder; a daemon
            // with its own (tests, e2e) leaves the user's agents alone.
            let custom = std::env::var_os("MOONLET_HOME").is_some() || std::env::var_os("JAUNT_HOME").is_some();
            if !custom && let Err(e) = crate::service::replace_jaunt_agent() {
                tracing::warn!("cannot replace jaunt's launchd agent: {e:#}");
            }
            true
        }
        Err(e) => {
            tracing::warn!("cannot take over jaunt's daemon: {e:#}");
            false
        }
    }
}

/// Variables that describe the capturing shell, not the user's environment.
const SKIP: &[&str] = &[
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "COLORTERM",
    "PS1",
    "MOONLET_TERMINAL_ID",
    "MOONLET_SESSION",
    // Set in terminals jaunt opened (X27).
    "JAUNT_TERMINAL_ID",
    "JAUNT_SESSION",
];

/// Variables passed from the daemon's own environment into the login shell
/// that builds the terminals' environment. Everything else (tokens and session
/// markers of whatever process started the daemon, e.g. an agent) stays out.
const PASSTHROUGH: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
    "__CF_USER_TEXT_ENCODING",
];

pub fn passthrough(vars: impl Iterator<Item = (String, String)>) -> BTreeMap<String, String> {
    vars.filter(|(k, _)| PASSTHROUGH.contains(&k.as_str()) || k.starts_with("LC_"))
        .collect()
}

/// Runs the login shell once, from a clean environment, to read what the
/// user's terminals should get (PATH from `.zprofile`, nvm, Homebrew…).
pub fn login_environment() -> BTreeMap<String, String> {
    let mut base = passthrough(std::env::vars());
    base.insert(
        "PATH".into(),
        "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
    );
    let shell = moonlet_core::pty::user_shell();
    base.entry("SHELL".into()).or_insert_with(|| shell.clone());
    let child = Command::new(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/env -0"])
        .env_clear()
        .envs(&base)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return base };
    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = child.stdout.take();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            let _ = out.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    let mut env = base.clone();
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(buf) => {
            let _ = child.wait();
            for entry in buf.split(|b| *b == 0) {
                let entry = String::from_utf8_lossy(entry);
                if let Some((k, v)) = entry.split_once('=')
                    && !k.is_empty()
                {
                    env.insert(k.to_string(), v.to_string());
                }
            }
        }
        Err(_) => {
            tracing::warn!("login shell did not print its environment in time");
            let _ = child.kill();
        }
    }
    for k in SKIP {
        env.remove(*k);
    }
    env
}

#[cfg(test)]
mod tests {
    #[test]
    fn passthrough_keeps_only_safe_basics() {
        let vars = [
            ("HOME", "/Users/me"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("LC_CTYPE", "UTF-8"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
            ("CLAUDECODE", "1"),
            ("AWS_SECRET_ACCESS_KEY", "x"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let kept = super::passthrough(vars.into_iter());
        assert_eq!(
            kept.keys().cloned().collect::<Vec<_>>(),
            vec!["HOME", "LC_CTYPE", "SSH_AUTH_SOCK"]
        );
    }
}
