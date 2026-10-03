//! Starting the daemon detached from its caller, and capturing the user's
//! login environment so PTYs and git see the same PATH as a terminal would.

use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::UnixStream;

/// Spawns `jauntd daemon` in its own session so it survives the caller
/// (the app, a CLI call or an SSH connection) and waits until it listens.
pub async fn ensure_running(socket: &Path) -> Result<()> {
    if UnixStream::connect(socket).await.is_ok() {
        return Ok(());
    }
    let exe = std::env::current_exe().context("cannot locate jauntd binary")?;
    let log = jaunt_core::paths::log_file();
    if let Some(dir) = log.parent() {
        jaunt_core::paths::ensure_private_dir(dir)?;
    }
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var_os("JAUNT_SOCK").is_none() {
        cmd.env("JAUNT_SOCK", socket);
    }
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("failed to spawn jauntd")?;
    jaunt_core::client::wait_for_socket(&socket.to_path_buf(), Duration::from_secs(10)).await
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
    "JAUNT_TERMINAL_ID",
    "JAUNT_SESSION",
];

/// Runs the login shell once to read the environment the user's terminals
/// get (PATH from `.zprofile`, nvm, Homebrew…). Falls back to our own env.
pub fn login_environment() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    let shell = jaunt_core::pty::user_shell();
    let child = Command::new(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return env };
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
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(buf) => {
            let _ = child.wait();
            for entry in buf.split(|b| *b == 0) {
                let entry = String::from_utf8_lossy(entry);
                if let Some((k, v)) = entry.split_once('=')
                    && !k.is_empty()
                    && !SKIP.contains(&k)
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
