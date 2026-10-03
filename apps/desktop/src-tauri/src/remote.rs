//! Remote hosts over the user's own OpenSSH (R1, R2): host discovery from
//! `~/.ssh/config`, and consent-based install of the version-pinned,
//! checksum-verified `jauntd` helper into `~/.jaunt/bin` on the host.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::hosts::{REMOTE_JAUNTD, ssh_base_args};

async fn ssh(alias: &str, command: &str, stdin: Option<&[u8]>) -> Result<(i32, String, String)> {
    let mut child = tokio::process::Command::new("ssh")
        .args(ssh_base_args())
        .arg(alias)
        .arg(command)
        .stdin(if stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("cannot run ssh")?;
    // Write stdin while the output pipes drain, all under one timeout: a
    // remote that fills stderr must not deadlock a multi-MB upload.
    let writer = match (stdin, child.stdin.take()) {
        (Some(data), Some(mut pipe)) => {
            let data = data.to_vec();
            Some(tokio::spawn(async move {
                let r = pipe.write_all(&data).await;
                drop(pipe);
                r
            }))
        }
        _ => None,
    };
    let out = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let out = child.wait_with_output().await?;
        if let Some(w) = writer {
            w.await.context("stdin writer failed")??;
        }
        anyhow::Ok(out)
    })
    .await
    .context("ssh timed out")??;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

/// Installed helper version on the host, `None` if it is not installed.
pub async fn remote_version(alias: &str) -> Result<Option<String>> {
    let (code, out, err) = ssh(
        alias,
        &format!(
            "if [ -x {REMOTE_JAUNTD} ]; then {REMOTE_JAUNTD} --version; else echo __missing__; fi"
        ),
        None,
    )
    .await?;
    if code == 255 {
        bail!(
            "ssh {alias}: {}",
            if err.is_empty() {
                "connection failed".into()
            } else {
                err
            }
        );
    }
    if out.contains("__missing__") || code != 0 {
        return Ok(None);
    }
    Ok(out.split_whitespace().nth(1).map(String::from))
}

fn target_triple(uname: &str) -> Result<&'static str> {
    let parts: Vec<&str> = uname.split_whitespace().collect();
    match parts.as_slice() {
        ["Linux", "x86_64"] => Ok("x86_64-unknown-linux-musl"),
        ["Linux", "aarch64" | "arm64"] => Ok("aarch64-unknown-linux-musl"),
        ["Darwin", "arm64"] => Ok("aarch64-apple-darwin"),
        ["Darwin", "x86_64"] => Ok("x86_64-apple-darwin"),
        _ => bail!("unsupported remote platform: {uname}"),
    }
}

/// Where helper builds are looked up, in order.
pub fn helper_dirs(resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = std::env::var_os("JAUNT_REMOTE_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Some(r) = resource_dir {
        dirs.push(r.join("remote"));
    }
    // Development: the workspace target directory.
    if let Ok(exe) = std::env::current_exe()
        && let Some(target) = exe
            .ancestors()
            .find(|a| a.file_name().is_some_and(|n| n == "target"))
    {
        dirs.push(target.to_path_buf());
    }
    dirs
}

fn find_helper(dirs: &[PathBuf], name: &str, triple: &str) -> Option<PathBuf> {
    for d in dirs {
        for candidate in [
            d.join(format!("{name}-{triple}")),
            d.join(triple).join("release").join(name),
            d.join(triple).join("debug").join(name),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // Same platform as this Mac: the bundled binaries work as-is.
    if triple == host_triple() {
        return crate::hosts::sibling_binary(name).ok();
    }
    None
}

fn host_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-musl"
    } else {
        "x86_64-unknown-linux-musl"
    }
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Uploads to `<name>.new`, verifies the checksum (and, with
/// `expect_version`, the version it reports), then replaces the installed
/// binary. A rejected build never replaces a working one.
async fn upload(alias: &str, local: &Path, remote_name: &str, expect_version: Option<&str>) -> Result<()> {
    let data = std::fs::read(local).with_context(|| format!("read {}", local.display()))?;
    let want = sha256_hex(&data);
    let tmp = format!("~/.jaunt/bin/{remote_name}.new");
    let script = format!(
        "set -e; umask 077; mkdir -p ~/.jaunt/bin; cat > {tmp}; chmod 700 {tmp}; \
         (sha256sum {tmp} 2>/dev/null || shasum -a 256 {tmp}) | cut -d' ' -f1"
    );
    let (code, out, err) = ssh(alias, &script, Some(&data)).await?;
    if code != 0 {
        bail!("upload of {remote_name} failed: {err}");
    }
    if out.trim() != want {
        let _ = ssh(alias, &format!("rm -f {tmp}"), None).await;
        bail!("checksum mismatch for {remote_name} (expected {want}, got {out})");
    }
    if let Some(expected) = expect_version {
        let (_, out, _) = ssh(alias, &format!("{tmp} --version"), None).await?;
        let got = out.split_whitespace().nth(1).unwrap_or("").to_string();
        if got != expected {
            let _ = ssh(alias, &format!("rm -f {tmp}"), None).await;
            bail!(
                "the {remote_name} build reports version {got:?}, but this app expects {expected}; rebuild the helpers (scripts/build-remote.sh)"
            );
        }
    }
    let (code, _, err) = ssh(
        alias,
        &format!("mv -f {tmp} ~/.jaunt/bin/{remote_name}"),
        None,
    )
    .await?;
    if code != 0 {
        bail!("installing {remote_name} failed: {err}");
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub triple: String,
    pub version: String,
}

/// Installs `jauntd` and `jaunt` for the host's platform. Only called after
/// the user confirmed the install dialog.
pub async fn install(alias: &str, resource_dir: Option<PathBuf>) -> Result<InstallResult> {
    let (code, uname, err) = ssh(alias, "uname -sm", None).await?;
    if code != 0 {
        bail!("ssh {alias}: {err}");
    }
    let triple = target_triple(&uname)?;
    let dirs = helper_dirs(resource_dir);
    let jauntd = find_helper(&dirs, "jauntd", triple).with_context(|| {
        format!("no jauntd build for {triple}; build it with `scripts/build-remote.sh {triple}`")
    })?;
    let want = env!("CARGO_PKG_VERSION");
    upload(alias, &jauntd, "jauntd", Some(want)).await?;
    if let Some(cli) = find_helper(&dirs, "jaunt", triple) {
        upload(alias, &cli, "jaunt", None).await?;
    }
    let version = remote_version(alias)
        .await?
        .context("helper installed but does not run")?;
    if version != want {
        bail!("installed helper reports {version}, but this app expects {want}; rebuild the helpers (scripts/build-remote.sh)");
    }
    Ok(InstallResult {
        triple: triple.into(),
        version,
    })
}

/// Concrete host aliases from `~/.ssh/config` and its `Include`s.
pub fn ssh_config_hosts() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let mut hosts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_hosts(
        &home.join(".ssh/config"),
        &home.join(".ssh"),
        &mut hosts,
        &mut seen,
        0,
    );
    hosts
}

fn collect_hosts(
    file: &Path,
    ssh_dir: &Path,
    out: &mut Vec<String>,
    seen: &mut std::collections::HashSet<PathBuf>,
    depth: u8,
) {
    if depth > 4 || !seen.insert(file.to_path_buf()) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        let mut parts = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.next().unwrap_or("").trim();
        match key.as_str() {
            "host" => {
                for name in value.split_whitespace() {
                    if !name.contains(['*', '?', '!']) && !out.iter().any(|h| h == name) {
                        out.push(name.to_string());
                    }
                }
            }
            "include" => {
                for pattern in value.split_whitespace() {
                    let path = if let Some(rest) = pattern.strip_prefix("~/") {
                        dirs::home_dir().unwrap_or_default().join(rest)
                    } else if Path::new(pattern).is_absolute() {
                        PathBuf::from(pattern)
                    } else {
                        ssh_dir.join(pattern)
                    };
                    for p in expand_glob(&path) {
                        collect_hosts(&p, ssh_dir, out, seen, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Minimal `*` globbing in the last path component (enough for `config.d/*`).
fn expand_glob(path: &Path) -> Vec<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains('*') {
        return vec![path.to_path_buf()];
    }
    let (prefix, suffix) = name.split_once('*').unwrap();
    let Some(dir) = path.parent() else {
        return vec![];
    };
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            n.starts_with(prefix) && n.ends_with(suffix) && p.is_file()
        })
        .collect();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triples() {
        assert_eq!(
            target_triple("Linux x86_64").unwrap(),
            "x86_64-unknown-linux-musl"
        );
        assert_eq!(
            target_triple("Linux aarch64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        assert!(target_triple("FreeBSD amd64").is_err());
    }

    #[test]
    fn parses_ssh_config_with_includes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("config.d")).unwrap();
        std::fs::write(dir.path().join("config"), "Include config.d/*\nHost devbox gpu-*\n  HostName 10.0.0.1\nHost *\n  ForwardAgent no\n").unwrap();
        std::fs::write(dir.path().join("config.d/work"), "Host=bastion\n").unwrap();
        let mut out = Vec::new();
        collect_hosts(
            &dir.path().join("config"),
            dir.path(),
            &mut out,
            &mut Default::default(),
            0,
        );
        assert_eq!(out, vec!["bastion", "devbox"]);
    }

    #[test]
    fn checksum() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
