//! How moonlet reaches a daemon on an SSH host (R1, R3): the desktop app
//! connects to the hosts the user added, and the daemon routes a phone to
//! the same hosts (X39).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Where the helper daemon lives on an SSH host (R2).
pub const REMOTE_MOONLETD: &str = "~/.moonlet/bin/moonletd";

/// ssh options for every connection to a host: no prompts, keep-alives, and
/// one shared master connection per host.
pub fn base_args() -> Vec<String> {
    let control = crate::paths::run_dir().join("ssh-%C");
    vec![
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ServerAliveInterval=10".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", control.display()),
        "-o".into(),
        "ControlPersist=10m".into(),
    ]
}

/// The SSH hosts the desktop app has added (R4), in `app-hosts.json`.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct SavedHosts {
    pub remotes: Vec<String>,
}

pub fn saved_hosts_file() -> PathBuf {
    crate::paths::home().join("app-hosts.json")
}

/// The saved hosts; none when the file is missing or unreadable.
pub fn saved_hosts() -> SavedHosts {
    std::fs::read_to_string(saved_hosts_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
