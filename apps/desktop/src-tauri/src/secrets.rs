//! Tracker tokens (X44): the macOS Keychain, one generic password per
//! connection id. e2e builds use a 0600 file instead, so tests never prompt.

use std::collections::BTreeMap;
use std::path::PathBuf;

pub trait Secrets {
    fn get(&self, id: &str) -> Option<String>;
    fn set(&self, id: &str, token: &str) -> Result<(), String>;
    fn delete(&self, id: &str);
}

/// The store this build uses: the Keychain, or `secrets.json` in an e2e build.
pub fn store() -> Box<dyn Secrets> {
    #[cfg(all(target_os = "macos", not(feature = "e2e")))]
    return Box::new(Keychain);
    #[allow(unreachable_code)]
    Box::new(FileSecrets(moonlet_core::paths::home().join("secrets.json")))
}

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
pub struct Keychain;

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
const SERVICE: &str = "dev.onedevstudio.moonlet.trackers";

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
impl Secrets for Keychain {
    fn get(&self, id: &str) -> Option<String> {
        let bytes = security_framework::passwords::get_generic_password(SERVICE, id).ok()?;
        String::from_utf8(bytes).ok()
    }
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(SERVICE, id, token.as_bytes())
            .map_err(|e| format!("cannot keep the token in the Keychain: {e}"))
    }
    fn delete(&self, id: &str) {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, id);
    }
}

/// Tokens in a JSON file readable only by the user (e2e builds).
pub struct FileSecrets(pub PathBuf);

impl FileSecrets {
    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.0)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
    fn write(&self, all: &BTreeMap<String, String>) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = self.0.with_extension("json.tmp");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(&serde_json::to_vec(all).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.0).map_err(|e| e.to_string())
    }
}

impl Secrets for FileSecrets {
    fn get(&self, id: &str) -> Option<String> {
        self.read().remove(id)
    }
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        let mut all = self.read();
        all.insert(id.into(), token.into());
        self.write(&all)
    }
    fn delete(&self, id: &str) {
        let mut all = self.read();
        if all.remove(id).is_some() {
            let _ = self.write(&all);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_store_keeps_tokens_private_and_forgets_them() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let store = FileSecrets(path.clone());
        assert_eq!(store.get("jira:acme.atlassian.net"), None);
        store.set("jira:acme.atlassian.net", "ATATT3x-secret").unwrap();
        store.set("linear:acme", "lin_api_key").unwrap();
        assert_eq!(store.get("jira:acme.atlassian.net").as_deref(), Some("ATATT3x-secret"));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        store.delete("jira:acme.atlassian.net");
        assert_eq!(store.get("jira:acme.atlassian.net"), None);
        assert_eq!(store.get("linear:acme").as_deref(), Some("lin_api_key"));
    }
}
