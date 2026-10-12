//! The installed Claude Code version and `claude update` (X36). Both run
//! the `claude` agents run: found on the daemon's login-shell PATH.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// The version in `claude --version`'s output, `2.1.296 (Claude Code)`.
pub fn parse_version(out: &str) -> Option<String> {
    let (version, rest) = out.trim().split_once(' ')?;
    let numeric = !version.is_empty()
        && version
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    (numeric && rest == "(Claude Code)").then(|| version.to_string())
}

/// The `claude` agents run, with the daemon's environment `env`.
pub fn command(env: &BTreeMap<String, String>) -> Result<Command> {
    let exe = crate::paths::find_program("claude", env).context("claude not found on PATH")?;
    let mut cmd = Command::new(exe);
    cmd.env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    Ok(cmd)
}

/// The installed version; None when `claude` is missing or says something
/// else.
pub async fn installed(env: &BTreeMap<String, String>) -> Option<String> {
    let run = command(env).ok()?.arg("--version").output();
    let out = tokio::time::timeout(Duration::from_secs(15), run)
        .await
        .ok()?
        .ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// Runs `claude update`, handing each line of its stdout and stderr to
/// `on_line` as it comes. Returns whether it exited with 0, and its output.
pub async fn update(
    env: &BTreeMap<String, String>,
    mut on_line: impl FnMut(&str),
) -> Result<(bool, String)> {
    let mut child = command(env)?
        .arg("update")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start claude update")?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    forward(child.stdout.take(), tx.clone());
    forward(child.stderr.take(), tx);
    let run = async {
        let mut output = String::new();
        let mut take = |line: String| {
            on_line(&line);
            output.push_str(&line);
            output.push('\n');
        };
        let status = loop {
            tokio::select! {
                Some(line) = rx.recv() => take(line),
                status = child.wait() => break status?,
            }
        };
        // A process it left behind may hold the pipes open: read what is
        // left, briefly.
        while let Ok(Some(line)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await
        {
            take(line);
        }
        anyhow::Ok((status.success(), output))
    };
    tokio::time::timeout(Duration::from_secs(600), run)
        .await
        .context("claude update timed out")?
}

fn forward(
    pipe: Option<impl AsyncRead + Unpin + Send + 'static>,
    tx: mpsc::UnboundedSender<String>,
) {
    let Some(pipe) = pipe else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx.send(line);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_version_claude_prints() {
        // Captured from `claude --version` 2.1.296.
        assert_eq!(
            parse_version("2.1.296 (Claude Code)\n").as_deref(),
            Some("2.1.296")
        );
        assert_eq!(parse_version("zsh: command not found: claude\n"), None);
        assert_eq!(parse_version(""), None);
    }
}
