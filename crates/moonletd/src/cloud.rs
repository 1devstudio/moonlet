//! Cloud workers on the central host (X63): the settings in `cloud.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use moonlet_proto::RpcError;
use moonlet_proto::methods::{
    CloudField, CloudInfo, CloudKind, CloudSet, CloudTailscale, ProjectCloud,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tailscale {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default = "tag_default")]
    pub tag: String,
}

impl Default for Tailscale {
    fn default() -> Self {
        Tailscale {
            client_id: String::new(),
            client_secret: String::new(),
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
        }
    }
}

/// The providers on offer, for the app's forms.
fn kinds() -> Vec<CloudKind> {
    moonlet_cloud::providers()
        .into_iter()
        .map(|p| CloudKind {
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
    data: Mutex<CloudFile>,
}

impl CloudSettings {
    /// Reads `cloud.json` in `home`, making a host id the first time.
    pub fn load(home: &Path) -> CloudSettings {
        let path = home.join("cloud.json");
        let data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(CloudFile::new);
        CloudSettings {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn file(&self) -> CloudFile {
        self.data.lock().unwrap().clone()
    }

    /// `cloud.get`: the settings without their secrets.
    pub fn info(&self) -> CloudInfo {
        let f = self.file();
        let kinds = kinds();
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
                client_id: f.tailscale.client_id,
                has_client_secret: !f.tailscale.client_secret.is_empty(),
                tag: f.tailscale.tag,
            },
            idle_minutes: f.idle_minutes,
            max_machines: f.max_machines,
            max_hours_month: f.max_hours_month,
            projects: f.projects,
            kinds,
        }
    }

    /// `cloud.set`: applies `req` and writes the file.
    pub fn set(&self, req: CloudSet) -> Result<CloudInfo, RpcError> {
        let invalid = |m: &str| RpcError::new("invalid_params", m.to_string());
        if req.idle_minutes.is_some_and(|n| n > 1440) {
            return Err(invalid("the idle time is from 0 to 1440 minutes"));
        }
        if req.max_machines == Some(0) {
            return Err(invalid("allow at least 1 machine"));
        }
        if req
            .tailscale
            .as_ref()
            .and_then(|t| t.tag.as_deref())
            .is_some_and(|t| !t.starts_with("tag:"))
        {
            return Err(invalid("a Tailscale tag starts with tag:"));
        }
        {
            let mut f = self.data.lock().unwrap();
            for (id, fields) in req.providers.into_iter().flatten() {
                match fields {
                    None => {
                        f.providers.remove(&id);
                    }
                    Some(fields) => {
                        let p = f.providers.entry(id).or_default();
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
                if let Some(v) = t.client_id {
                    f.tailscale.client_id = v;
                }
                if let Some(v) = t.client_secret {
                    f.tailscale.client_secret = v;
                }
                if let Some(v) = t.tag {
                    f.tailscale.tag = v;
                }
            }
            if let Some(n) = req.idle_minutes {
                f.idle_minutes = n;
            }
            if let Some(n) = req.max_machines {
                f.max_machines = n;
            }
            if let Some(n) = req.max_hours_month {
                f.max_hours_month = n;
            }
            for (key, project) in req.projects.into_iter().flatten() {
                match project {
                    Some(p) => f.projects.insert(key, p),
                    None => f.projects.remove(&key),
                };
            }
        }
        self.save()
            .map_err(|e| RpcError::new("internal", format!("cannot write cloud.json: {e}")))?;
        Ok(self.info())
    }

    fn save(&self) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let bytes = serde_json::to_vec_pretty(&*self.data.lock().unwrap()).unwrap_or_default();
        let tmp = self.path.with_extension("json.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        std::fs::rename(&tmp, &self.path)
    }
}
