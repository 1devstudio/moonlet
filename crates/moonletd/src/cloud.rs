//! Cloud workers on the central host (X63): the settings in `cloud.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use moonlet_proto::RpcError;
use moonlet_proto::methods::{
    CloudField, CloudInfo, CloudKind, CloudSet, CloudTailscale, ProjectCloud, TailscaleMode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `cloud.json`, mode 0600: it holds the provider tokens and the Tailscale
/// OAuth secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudFile {
    /// Labels this central host's machines, so two central hosts sharing a
    /// provider project never touch each other's.
    pub host_id: String,
    #[serde(default)]
    pub providers: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default)]
    pub tailscale: Tailscale,
    #[serde(default = "idle_default")]
    pub idle_minutes: u32,
    #[serde(default = "machines_default")]
    pub max_machines: u32,
    #[serde(default = "hours_default")]
    pub max_hours_month: u32,
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectCloud>,
    /// Providers asked to be removed, kept until their machines are gone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tailscale {
    #[serde(default)]
    pub mode: TailscaleMode,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// A reusable, ephemeral, tagged key the user pasted.
    #[serde(default)]
    pub auth_key: String,
    #[serde(default = "tag_default")]
    pub tag: String,
}

impl Default for Tailscale {
    fn default() -> Self {
        Tailscale {
            mode: TailscaleMode::default(),
            client_id: String::new(),
            client_secret: String::new(),
            auth_key: String::new(),
            tag: tag_default(),
        }
    }
}

fn idle_default() -> u32 {
    15
}
fn machines_default() -> u32 {
    2
}
fn hours_default() -> u32 {
    40
}
fn tag_default() -> String {
    "tag:moonlet-worker".into()
}

impl CloudFile {
    fn new() -> CloudFile {
        CloudFile {
            host_id: uuid::Uuid::new_v4().simple().to_string()[..16].to_string(),
            providers: BTreeMap::new(),
            tailscale: Tailscale::default(),
            idle_minutes: idle_default(),
            max_machines: machines_default(),
            max_hours_month: hours_default(),
            projects: BTreeMap::new(),
            removing: Vec::new(),
        }
    }
}

/// `providers` as the app's forms read them.
fn kinds(providers: Vec<moonlet_cloud::ProviderInfo>) -> Vec<CloudKind> {
    providers
        .into_iter()
        .map(|p| CloudKind {
            billing_unit_secs: p.billing.unit_secs,
            id: p.id,
            label: p.label,
            fields: p
                .fields
                .into_iter()
                .map(|f| CloudField {
                    name: f.name,
                    label: f.label,
                    secret: f.secret,
                    help: f.help,
                })
                .collect(),
        })
        .collect()
}

pub struct CloudSettings {
    path: PathBuf,
    /// The settings. Held for the whole of a change and its write, which
    /// happen in that order: memory changes only once the file has.
    data: Mutex<CloudFile>,
    /// Why `cloud.json` could not be read. It is never overwritten then.
    broken: Option<String>,
}

/// A Tailscale tag: `tag:` then letters, digits and dashes.
fn valid_tag(t: &str) -> bool {
    t.strip_prefix("tag:")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

impl CloudSettings {
    /// Reads `cloud.json` in `home`, making a host id the first time.
    pub fn load(home: &Path) -> CloudSettings {
        use std::os::unix::fs::PermissionsExt;
        let path = home.join("cloud.json");
        let (data, broken) = match std::fs::read(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (CloudFile::new(), None),
            Err(e) => (
                CloudFile::new(),
                Some(format!("cannot read cloud.json: {e}")),
            ),
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(f) => (f, None),
                Err(e) => (
                    CloudFile::new(),
                    Some(format!("cloud.json is not valid: {e}")),
                ),
            },
        };
        if let Some(why) = &broken {
            tracing::warn!("{why}; cloud workers are off until it is fixed");
        }
        // It holds secrets: private, whoever last changed it.
        if path.exists() {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let s = CloudSettings {
            path,
            data: Mutex::new(data),
            broken,
        };
        // The host id is made once: written now, not at the first change.
        if s.broken.is_none() && !s.path.exists() {
            let f = s.file();
            if let Err(e) = s.write(&f) {
                tracing::warn!("cannot write cloud.json: {e}");
            }
        }
        s
    }

    pub fn file(&self) -> CloudFile {
        self.data.lock().unwrap().clone()
    }

    /// `cloud.get`: the settings without their secrets.
    pub fn info(&self, providers: Vec<moonlet_cloud::ProviderInfo>) -> CloudInfo {
        let f = self.file();
        let kinds = kinds(providers);
        let secret = |provider: &str, field: &str| {
            kinds
                .iter()
                .find(|k| k.id == provider)
                .and_then(|k| k.fields.iter().find(|x| x.name == field))
                .is_some_and(|x| x.secret)
        };
        let providers = f
            .providers
            .iter()
            .map(|(id, fields)| {
                let shown = fields
                    .iter()
                    .map(|(k, v)| {
                        if secret(id, k) {
                            (format!("has_{k}"), Value::Bool(!v.is_empty()))
                        } else {
                            (k.clone(), Value::String(v.clone()))
                        }
                    })
                    .collect();
                (id.clone(), shown)
            })
            .collect();
        CloudInfo {
            host_id: f.host_id,
            providers,
            tailscale: CloudTailscale {
                mode: f.tailscale.mode,
                client_id: f.tailscale.client_id,
                has_client_secret: !f.tailscale.client_secret.is_empty(),
                has_auth_key: !f.tailscale.auth_key.is_empty(),
                tag: f.tailscale.tag,
            },
            idle_minutes: f.idle_minutes,
            max_machines: f.max_machines,
            max_hours_month: f.max_hours_month,
            projects: f.projects,
            kinds,
            listening: Vec::new(),
            port: 0,
        }
    }

    /// `cloud.set`: applies `req` and writes the file.
    /// `busy(provider)` says whether a provider still has machines: one
    /// asked to be removed stays until they are gone.
    pub fn set(
        &self,
        req: CloudSet,
        providers: Vec<moonlet_cloud::ProviderInfo>,
        busy: &dyn Fn(&str) -> bool,
    ) -> Result<CloudInfo, RpcError> {
        if let Some(why) = &self.broken {
            return Err(RpcError::new(
                "broken",
                format!("{why}. Fix or remove ~/.moonlet/cloud.json, then restart moonletd."),
            ));
        }
        let invalid = |m: String| RpcError::new("invalid_params", m);
        if req.idle_minutes.is_some_and(|n| n > 1440) {
            return Err(invalid("the idle time is from 0 to 1440 minutes".into()));
        }
        if req.max_machines == Some(0) {
            return Err(invalid("allow at least 1 machine".into()));
        }
        if req
            .tailscale
            .as_ref()
            .and_then(|t| t.tag.as_deref())
            .is_some_and(|t| !valid_tag(t))
        {
            return Err(invalid(
                "a Tailscale tag is tag: then letters, digits and dashes".into(),
            ));
        }
        // Only fields an adapter describes: cloud.get would show any other in clear.
        for (id, fields) in req.providers.iter().flatten() {
            let Some(fields) = fields else { continue };
            let Some(kind) = providers.iter().find(|p| &p.id == id) else {
                return Err(invalid(format!("no cloud provider {id}")));
            };
            if let Some(k) = fields
                .keys()
                .find(|k| !kind.fields.iter().any(|f| &f.name == *k))
            {
                return Err(invalid(format!("{id} has no field {k}")));
            }
            // A secret cleared while its machines run: none could be destroyed.
            let clears = |f: &&moonlet_cloud::Field| {
                f.secret
                    && fields
                        .get(&f.name)
                        .is_some_and(|v| v.as_deref().is_none_or(|v| v.trim().is_empty()))
            };
            if let Some(f) = kind.fields.iter().find(clears)
                && busy(id)
            {
                return Err(invalid(format!(
                    "{} has machines: its {} stays until they are gone",
                    kind.label, f.label
                )));
            }
        }
        let mut f = self.data.lock().unwrap();
        let mut next = f.clone();
        for (id, fields) in req.providers.into_iter().flatten() {
            match fields {
                None if busy(&id) => {
                    if !next.removing.contains(&id) {
                        next.removing.push(id);
                    }
                }
                None => {
                    next.providers.remove(&id);
                    next.removing.retain(|p| p != &id);
                }
                Some(fields) => {
                    // Set again while its machines drain: it stays.
                    next.removing.retain(|p| p != &id);
                    let p = next.providers.entry(id).or_default();
                    for (k, v) in fields {
                        match v {
                            Some(v) => p.insert(k, v),
                            None => p.remove(&k),
                        };
                    }
                }
            }
        }
        if let Some(t) = req.tailscale {
            if let Some(v) = t.mode {
                next.tailscale.mode = v;
            }
            if let Some(v) = t.auth_key {
                next.tailscale.auth_key = v;
            }
            if let Some(v) = t.client_id {
                next.tailscale.client_id = v;
            }
            if let Some(v) = t.client_secret {
                next.tailscale.client_secret = v;
            }
            if let Some(v) = t.tag {
                next.tailscale.tag = v;
            }
        }
        if let Some(n) = req.idle_minutes {
            next.idle_minutes = n;
        }
        if let Some(n) = req.max_machines {
            next.max_machines = n;
        }
        if let Some(n) = req.max_hours_month {
            next.max_hours_month = n;
        }
        for (key, project) in req.projects.into_iter().flatten() {
            match project {
                Some(p) => next.projects.insert(key, p),
                None => next.projects.remove(&key),
            };
        }
        self.write(&next)
            .map_err(|e| RpcError::new("internal", format!("cannot write cloud.json: {e}")))?;
        *f = next;
        drop(f);
        Ok(self.info(providers))
    }

    /// Providers waiting for their machines to go.
    pub fn removing(&self) -> Vec<String> {
        self.data.lock().unwrap().removing.clone()
    }

    /// Removes provider `id` if it waited for its machines to go. If the
    /// file cannot be written, it keeps waiting, and the next start tries again.
    pub fn drop_pending(&self, id: &str) {
        let mut f = self.data.lock().unwrap();
        if !f.removing.iter().any(|p| p == id) {
            return;
        }
        let mut next = f.clone();
        next.providers.remove(id);
        next.removing.retain(|p| p != id);
        match self.write(&next) {
            Ok(()) => *f = next,
            Err(e) => tracing::warn!("cannot remove cloud provider {id}: {e}"),
        }
    }

    /// Writes `f` to `cloud.json`, private, through a new temporary file.
    fn write(&self, f: &CloudFile) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let bytes = serde_json::to_vec_pretty(f).unwrap_or_default();
        let tmp = self.path.with_extension("json.tmp");
        // One left by a crash may be anyone's to read: never reused.
        let _ = std::fs::remove_file(&tmp);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn set(token: &str) -> CloudSet {
        serde_json::from_value(
            serde_json::json!({ "providers": { "hetzner": { "token": token } } }),
        )
        .unwrap()
    }

    fn remove(provider: &str) -> CloudSet {
        serde_json::from_value(serde_json::json!({ "providers": { provider: null } })).unwrap()
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let s = CloudSettings::load(home.path());
        s.set(set("hc-1"), moonlet_cloud::providers(), &|_| false)
            .unwrap();
        // The folder cannot take the new file.
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let e = s.set(set("hc-2"), moonlet_cloud::providers(), &|_| false);
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(e.is_err());
        assert_eq!(s.file().providers["hetzner"]["token"], "hc-1");
    }

    #[test]
    fn the_file_is_private_even_over_a_left_temporary_file_or_an_open_one() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("cloud.json");
        std::fs::write(home.path().join("cloud.json.tmp"), "{}").unwrap();
        std::fs::set_permissions(
            home.path().join("cloud.json.tmp"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let s = CloudSettings::load(home.path());
        s.set(set("hc-1"), moonlet_cloud::providers(), &|_| false)
            .unwrap();
        assert_eq!(mode(&file), 0o600);
        // A cloud.json someone opened up is closed again when read.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        CloudSettings::load(home.path());
        assert_eq!(mode(&file), 0o600);
    }

    #[test]
    fn a_cloud_json_that_cannot_be_read_is_never_overwritten() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("cloud.json");
        std::fs::write(
            &file,
            "{ \"host_id\": \"c3f1\", \"providers\": { \"hetzner\": { \"token\": \"hc-1\" } }",
        )
        .unwrap();
        let s = CloudSettings::load(home.path());
        let e = s
            .set(set("hc-2"), moonlet_cloud::providers(), &|_| false)
            .unwrap_err();
        assert_eq!(e.code, "broken");
        assert!(
            e.message.starts_with("cloud.json is not valid: "),
            "{}",
            e.message
        );
        assert!(std::fs::read_to_string(&file).unwrap().contains("hc-1"));
    }

    #[test]
    fn only_a_known_providers_fields_are_kept() {
        // A secret under another name would come back in clear from cloud.get.
        let home = tempfile::tempdir().unwrap();
        let s = CloudSettings::load(home.path());
        let typo: CloudSet = serde_json::from_value(
            serde_json::json!({ "providers": { "hetzner": { "tokn": "hc-1" } } }),
        )
        .unwrap();
        let e = s
            .set(typo, moonlet_cloud::providers(), &|_| false)
            .unwrap_err();
        assert_eq!(e.message, "hetzner has no field tokn");
        let other: CloudSet =
            serde_json::from_value(serde_json::json!({ "providers": { "aws": {} } })).unwrap();
        let e = s
            .set(other, moonlet_cloud::providers(), &|_| false)
            .unwrap_err();
        assert_eq!(e.message, "no cloud provider aws");
    }

    #[test]
    fn a_providers_secret_stays_while_it_has_machines() {
        // Without it, its machines could not be destroyed.
        let home = tempfile::tempdir().unwrap();
        let s = CloudSettings::load(home.path());
        s.set(set("hc-1"), moonlet_cloud::providers(), &|_| false)
            .unwrap();
        let cleared: CloudSet = serde_json::from_value(
            serde_json::json!({ "providers": { "hetzner": { "token": null } } }),
        )
        .unwrap();
        let e = s
            .set(cleared.clone(), moonlet_cloud::providers(), &|_| true)
            .unwrap_err();
        assert_eq!(
            e.message,
            "Hetzner Cloud has machines: its API token stays until they are gone"
        );
        assert_eq!(s.file().providers["hetzner"]["token"], "hc-1");
        // Replacing it is fine.
        s.set(set("hc-2"), moonlet_cloud::providers(), &|_| true)
            .unwrap();
        s.set(cleared, moonlet_cloud::providers(), &|_| false)
            .unwrap();
    }

    #[test]
    fn the_host_id_is_made_once() {
        // It labels this central host's machines: a restart keeps it.
        let home = tempfile::tempdir().unwrap();
        let first = CloudSettings::load(home.path()).file().host_id;
        assert_eq!(CloudSettings::load(home.path()).file().host_id, first);
        assert_eq!(mode(&home.path().join("cloud.json")), 0o600);
    }

    #[test]
    fn a_tag_is_letters_digits_and_dashes() {
        let home = tempfile::tempdir().unwrap();
        let s = CloudSettings::load(home.path());
        let quote: CloudSet =
            serde_json::from_value(serde_json::json!({ "tailscale": { "tag": "tag:worker\"" } }))
                .unwrap();
        let e = s
            .set(quote, moonlet_cloud::providers(), &|_| false)
            .unwrap_err();
        assert_eq!(
            e.message,
            "a Tailscale tag is tag: then letters, digits and dashes"
        );
    }

    #[test]
    fn a_provider_removed_while_busy_goes_later_even_after_a_restart_unless_added_again() {
        let home = tempfile::tempdir().unwrap();
        let s = CloudSettings::load(home.path());
        s.set(set("hc-1"), moonlet_cloud::providers(), &|_| false)
            .unwrap();
        s.set(remove("hetzner"), moonlet_cloud::providers(), &|_| true)
            .unwrap();
        // A restart remembers it.
        let s = CloudSettings::load(home.path());
        assert_eq!(s.removing(), ["hetzner"]);
        s.drop_pending("hetzner");
        assert!(!s.file().providers.contains_key("hetzner"));
        // Added again while its machines drain: it stays.
        s.set(set("hc-1"), moonlet_cloud::providers(), &|_| false)
            .unwrap();
        s.set(remove("hetzner"), moonlet_cloud::providers(), &|_| true)
            .unwrap();
        s.set(set("hc-2"), moonlet_cloud::providers(), &|_| true)
            .unwrap();
        s.drop_pending("hetzner");
        assert_eq!(s.file().providers["hetzner"]["token"], "hc-2");
        assert!(s.removing().is_empty());
    }
}
