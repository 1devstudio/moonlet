//! launchd LaunchAgent management on macOS (S1b).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

pub const LABEL: &str = "dev.onedevstudio.jaunt.daemon";

pub fn plist_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Renders the LaunchAgent plist for `binary`.
pub fn render(binary: &Path, logs: &Path, jaunt_home: Option<&str>) -> String {
    let bin = xml_escape(&binary.display().to_string());
    let out = xml_escape(&logs.join("launchd.out.log").display().to_string());
    let err = xml_escape(&logs.join("launchd.err.log").display().to_string());
    let env = jaunt_home
        .map(|h| format!("  <key>EnvironmentVariables</key>\n  <dict>\n    <key>JAUNT_HOME</key>\n    <string>{}</string>\n  </dict>\n", xml_escape(h)))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{bin}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>{out}</string>
  <key>StandardErrorPath</key>
  <string>{err}</string>
{env}</dict>
</plist>
"#
    )
}

fn domain() -> String {
    format!("gui/{}", nix::unistd::getuid())
}

fn launchctl(args: &[&str]) -> Result<std::process::Output> {
    Command::new("launchctl")
        .args(args)
        .output()
        .context("cannot run launchctl")
}

pub fn install() -> Result<()> {
    if !cfg!(target_os = "macos") {
        bail!("launchd integration is only available on macOS");
    }
    let binary = std::env::current_exe()?.canonicalize()?;
    let logs = jaunt_core::paths::log_file()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    jaunt_core::paths::ensure_private_dir(&logs)?;
    let plist = plist_path()?;
    if let Some(dir) = plist.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let home = std::env::var("JAUNT_HOME").ok();
    std::fs::write(&plist, render(&binary, &logs, home.as_deref()))?;
    // Replace any previous registration, then load the new one.
    let _ = launchctl(&["bootout", &format!("{}/{LABEL}", domain())]);
    let out = launchctl(&["bootstrap", &domain(), &plist.display().to_string()])?;
    if !out.status.success() {
        bail!(
            "launchctl bootstrap failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let _ = launchctl(&["bootout", &format!("{}/{LABEL}", domain())]);
    let plist = plist_path()?;
    if plist.exists() {
        std::fs::remove_file(plist)?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct Status {
    pub installed: bool,
    pub loaded: bool,
    pub plist: String,
}

pub fn status() -> Result<Status> {
    let plist = plist_path()?;
    let loaded = launchctl(&["print", &format!("{}/{LABEL}", domain())])
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(Status {
        installed: plist.exists(),
        loaded,
        plist: plist.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_valid_agent() {
        let p = render(
            Path::new("/Applications/jaunt & co.app/Contents/MacOS/jauntd"),
            Path::new("/Users/me/.jaunt/logs"),
            Some("/tmp/h"),
        );
        assert!(
            p.contains("<string>/Applications/jaunt &amp; co.app/Contents/MacOS/jauntd</string>")
        );
        assert!(p.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(p.contains("<key>JAUNT_HOME</key>"));
        assert!(p.contains(LABEL));
        let without = render(Path::new("/x/jauntd"), Path::new("/l"), None);
        assert!(!without.contains("EnvironmentVariables"));
        if Path::new("/usr/bin/plutil").exists() {
            let f = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(f.path(), &p).unwrap();
            let ok = Command::new("/usr/bin/plutil")
                .arg("-lint")
                .arg(f.path())
                .output()
                .unwrap();
            assert!(
                ok.status.success(),
                "{}",
                String::from_utf8_lossy(&ok.stdout)
            );
        }
    }
}
