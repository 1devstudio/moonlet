//! How moonlet reaches a daemon on an SSH host (R1, R3): the desktop app
//! connects to the hosts the user added, and the daemon routes a phone to
//! the same hosts (X39).

use std::path::{Path, PathBuf};

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

/// The remote hosts the desktop app has added: SSH hosts (R4) and hosts
/// paired over the tailnet (X57).
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct SavedHosts {
    /// SSH aliases. Phones route only to these (X39).
    pub remotes: Vec<String>,
    #[serde(default)]
    pub tailnet: Vec<TailnetHost>,
}

/// A host this Mac paired with over the tailnet (X57).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TailnetHost {
    /// The host's name on the tailnet, which is also its id and label.
    pub id: String,
    /// This Mac's device id on the host.
    pub device_id: String,
    /// `ip:port`s of the host's tailnet listener, tried in order.
    pub addrs: Vec<String>,
    /// The device token, full access to the host. The app keeps it in the
    /// Keychain (X57) and writes it here as `""`, which builds from before
    /// still read; a token here is one not moved there yet.
    #[serde(default)]
    pub token: String,
    /// The token's SHA-256 in hex, so this Mac's daemon can tell the app's
    /// token from one only its link holds (X41) without reading the token.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token_sha256: String,
}

impl SavedHosts {
    /// Whether the app holds `token` for one of its tailnet hosts, in this
    /// file or in the Keychain beside it.
    pub fn holds_token(&self, token: &str) -> bool {
        let digest = crate::hash::sha256_hex(token.as_bytes());
        self.tailnet
            .iter()
            .any(|t| (!t.token.is_empty() && t.token == token) || t.token_sha256 == digest)
    }
}

pub fn saved_hosts_file() -> PathBuf {
    crate::paths::home().join("app-hosts.json")
}

/// The saved hosts; none when the file is missing or unreadable.
pub fn saved_hosts() -> SavedHosts {
    saved_hosts_at(&saved_hosts_file())
}

pub fn saved_hosts_at(file: &Path) -> SavedHosts {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes the hosts readable by this user only, through a temporary file.
pub fn save_hosts_at(file: &Path, hosts: &SavedHosts) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = file.parent() {
        crate::paths::ensure_private_dir(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(&serde_json::to_vec_pretty(hosts).expect("hosts serialize"))?;
    f.sync_all()?;
    std::fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_from_before_x57_has_ssh_hosts_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app-hosts.json");
        std::fs::write(&file, r#"{ "remotes": ["devbox"] }"#).unwrap();
        let hosts = saved_hosts_at(&file);
        assert_eq!(hosts.remotes, ["devbox"]);
        assert!(hosts.tailnet.is_empty());
    }

    /// A host whose token is in the Keychain keeps `"token": ""`, so a build
    /// from before, whose entries must have a token, still lists every host
    /// (and fails to connect) rather than reading the file as empty.
    #[test]
    fn a_host_whose_token_moved_still_reads_in_builds_from_before() {
        #[derive(Deserialize)]
        struct Before {
            remotes: Vec<String>,
            tailnet: Vec<BeforeHost>,
        }
        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct BeforeHost {
            id: String,
            device_id: String,
            addrs: Vec<String>,
            token: String,
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app-hosts.json");
        let moved = TailnetHost {
            id: "studio-mini".into(),
            device_id: "d1".into(),
            addrs: vec!["100.101.102.103:47428".into()],
            token: String::new(),
            token_sha256: "65dcf16ea3dfa49069628089eb4a75483070f5584b2a21ee64912b5f621f12da".into(),
        };
        save_hosts_at(&file, &SavedHosts { remotes: vec!["devbox".into()], tailnet: vec![moved.clone()] }).unwrap();
        let before: Before = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(before.remotes, ["devbox"]);
        assert_eq!(before.tailnet[0].id, "studio-mini");
        assert_eq!(before.tailnet[0].token, "");
        assert_eq!(saved_hosts_at(&file).tailnet, [moved]);
    }

    #[test]
    fn tailnet_hosts_are_kept_with_their_token_readable_by_this_user_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app-hosts.json");
        let hosts = SavedHosts {
            remotes: vec!["devbox".into()],
            tailnet: vec![TailnetHost {
                id: "studio-mini".into(),
                device_id: "d1".into(),
                addrs: vec!["100.101.102.103:47428".into()],
                token: "tok".into(),
                token_sha256: String::new(),
            }],
        };
        save_hosts_at(&file, &hosts).unwrap();
        assert_eq!(saved_hosts_at(&file), hosts);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
