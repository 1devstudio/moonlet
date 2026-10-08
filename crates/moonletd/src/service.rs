//! launchd LaunchAgent management on macOS (S1b).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

pub const LABEL: &str = "dev.onedevstudio.moonlet.daemon";
/// jaunt's agent, replaced after taking over its daemon (X27).
const JAUNT_LABEL: &str = "dev.onedevstudio.jaunt.daemon";

fn agents_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join("Library/LaunchAgents"))
}

pub fn plist_path() -> Result<PathBuf> {
    Ok(agents_dir()?.join(format!("{LABEL}.plist")))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Renders the LaunchAgent plist for `binary`.
pub fn render(binary: &Path, logs: &Path, moonlet_home: Option<&str>) -> String {
    let bin = xml_escape(&binary.display().to_string());
    let out = xml_escape(&logs.join("launchd.out.log").display().to_string());
    let err = xml_escape(&logs.join("launchd.err.log").display().to_string());
    let env = moonlet_home
        .map(|h| format!("  <key>EnvironmentVariables</key>\n  <dict>\n    <key>MOONLET_HOME</key>\n    <string>{}</string>\n  </dict>\n", xml_escape(h)))
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
    let logs = moonlet_core::paths::log_file()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    moonlet_core::paths::ensure_private_dir(&logs)?;
    let plist = plist_path()?;
    if let Some(dir) = plist.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let home = std::env::var("MOONLET_HOME").ok();
    std::fs::write(&plist, render(&binary, &logs, home.as_deref()))?;
    // A loaded agent may be the daemon serving every session right now:
    // booting it out would end them. The rewritten plist applies at the
    // next login; binary updates go through the live upgrade instead.
    if is_loaded()? {
        return Ok(());
    }
    let out = launchctl(&["bootstrap", &domain(), &plist.display().to_string()])?;
    if !out.status.success() {
        bail!(
            "launchctl bootstrap failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// After taking over jaunt's daemon (X27): if jaunt ran it under launchd,
/// unload and remove jaunt's agent, which would start jaunt's daemon again at
/// login, and install moonlet's in its place.
pub fn replace_jaunt_agent() -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let had = remove_jaunt_agent(&agents_dir()?, |target| {
        // Its daemon has handed over and exited; nothing else runs in it.
        let _ = launchctl(&["bootout", target]);
    })?;
    if had {
        install()?;
    }
    Ok(())
}

/// Removes jaunt's agent from `agents` after `bootout`. Returns whether it
/// was there.
fn remove_jaunt_agent(agents: &Path, bootout: impl FnOnce(&str)) -> Result<bool> {
    let plist = agents.join(format!("{JAUNT_LABEL}.plist"));
    if !plist.exists() {
        return Ok(false);
    }
    bootout(&format!("{}/{JAUNT_LABEL}", domain()));
    std::fs::remove_file(&plist)?;
    Ok(true)
}

/// Whether launchd has the agent loaded. A failure that does not clearly
/// mean "not loaded" is an error, never a "no".
fn is_loaded() -> Result<bool> {
    let out = launchctl(&["print", &format!("{}/{LABEL}", domain())])?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("Could not find service") || err.contains("not find") || out.status.code() == Some(113) {
        return Ok(false);
    }
    bail!("launchctl print failed: {}", err.trim())
}

/// Stops the agent (and the daemon it runs, ending its sessions; the app
/// asks first) and removes the plist.
pub fn uninstall() -> Result<()> {
    if is_loaded()? {
        let out = launchctl(&["bootout", &format!("{}/{LABEL}", domain())])?;
        // Gone in between is fine; anything else must not be reported as removed.
        if !out.status.success() && is_loaded()? {
            bail!(
                "launchctl bootout failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
    }
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
    let loaded = is_loaded()?;
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
            Path::new("/Applications/moonlet & co.app/Contents/MacOS/moonletd"),
            Path::new("/Users/me/.moonlet/logs"),
            Some("/tmp/h"),
        );
        assert!(
            p.contains("<string>/Applications/moonlet &amp; co.app/Contents/MacOS/moonletd</string>")
        );
        assert!(p.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(p.contains("<key>MOONLET_HOME</key>"));
        assert!(p.contains("<key>Label</key>\n  <string>dev.onedevstudio.moonlet.daemon</string>"));
        let without = render(Path::new("/x/moonletd"), Path::new("/l"), None);
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

    /// X27: jaunt's agent would start jaunt's daemon again at login.
    #[test]
    fn replacing_removes_only_jaunts_agent() {
        let agents = tempfile::tempdir().unwrap();
        let jaunts = agents.path().join("dev.onedevstudio.jaunt.daemon.plist");
        let other = agents.path().join("com.example.agent.plist");
        std::fs::write(&jaunts, "<plist/>").unwrap();
        std::fs::write(&other, "<plist/>").unwrap();

        assert!(remove_jaunt_agent(agents.path(), |_| {}).unwrap());
        assert!(!jaunts.exists());
        assert!(other.exists());
        assert!(!remove_jaunt_agent(agents.path(), |_| {}).unwrap(), "nothing left to replace");
    }
}
