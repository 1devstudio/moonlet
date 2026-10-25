//! Google Cloud's Compute Engine (X67), through
//! `https://compute.googleapis.com/compute/v1`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::gcp_auth::{ServiceAccountKey, Tokens};
use crate::{
    Body, CloudError, Field, Image, Listed, Location, MachineInfo, MachineState, MachineType,
    NewMachine, Provider, ProviderInfo, Request, Transport,
};

pub const API: &str = "https://compute.googleapis.com/compute/v1";

pub fn info() -> ProviderInfo {
    ProviderInfo {
        id: "gcp".into(),
        label: "Google Cloud".into(),
        fields: vec![
            Field {
                name: "key".into(),
                label: "Service account key (JSON)".into(),
                secret: true,
                help: "A key of a service account with the Compute Instance Admin (v1) role. It can create and delete any machine in its project, so use a project made for moonlet.".into(),
            },
            Field {
                name: "max_hours".into(),
                label: "Longest a machine lives (hours)".into(),
                secret: false,
                help: "Google Cloud deletes a machine this long after it starts, even while the central host is off. A command still running then is cut off. Empty means 12.".into(),
            },
        ],
        max_name: 63,
        tailnet_key: true,
        // Every started second, and the first minute in full.
        billing: crate::Billing {
            unit_secs: 1,
            minimum_secs: 60,
        },
    }
}

/// Where each region is, for a zone's label. A region missing here shows
/// only its zone.
const REGIONS: &[(&str, &str)] = &[
    ("africa-south1", "Johannesburg, ZA"),
    ("asia-east1", "Changhua County, TW"),
    ("asia-east2", "Hong Kong, HK"),
    ("asia-northeast1", "Tokyo, JP"),
    ("asia-northeast2", "Osaka, JP"),
    ("asia-northeast3", "Seoul, KR"),
    ("asia-south1", "Mumbai, IN"),
    ("asia-south2", "Delhi, IN"),
    ("asia-southeast1", "Jurong West, SG"),
    ("asia-southeast2", "Jakarta, ID"),
    ("australia-southeast1", "Sydney, AU"),
    ("australia-southeast2", "Melbourne, AU"),
    ("europe-central2", "Warsaw, PL"),
    ("europe-north1", "Hamina, FI"),
    ("europe-north2", "Stockholm, SE"),
    ("europe-southwest1", "Madrid, ES"),
    ("europe-west1", "St. Ghislain, BE"),
    ("europe-west2", "London, GB"),
    ("europe-west3", "Frankfurt, DE"),
    ("europe-west4", "Eemshaven, NL"),
    ("europe-west6", "Zurich, CH"),
    ("europe-west8", "Milan, IT"),
    ("europe-west9", "Paris, FR"),
    ("europe-west10", "Berlin, DE"),
    ("europe-west12", "Turin, IT"),
    ("me-central1", "Doha, QA"),
    ("me-central2", "Dammam, SA"),
    ("me-west1", "Tel Aviv, IL"),
    ("northamerica-northeast1", "Montréal, CA"),
    ("northamerica-northeast2", "Toronto, CA"),
    ("northamerica-south1", "Querétaro, MX"),
    ("southamerica-east1", "Osasco, BR"),
    ("southamerica-west1", "Santiago, CL"),
    ("us-central1", "Council Bluffs, US"),
    ("us-east1", "Moncks Corner, US"),
    ("us-east4", "Ashburn, US"),
    ("us-east5", "Columbus, US"),
    ("us-south1", "Dallas, US"),
    ("us-west1", "The Dalles, US"),
    ("us-west2", "Los Angeles, US"),
    ("us-west3", "Salt Lake City, US"),
    ("us-west4", "Las Vegas, US"),
];

/// "europe-west4-a · Eemshaven, NL".
fn zone_label(zone: &str, region: &str) -> String {
    match REGIONS.iter().find(|(r, _)| *r == region) {
        Some((_, city)) => format!("{zone} · {city}"),
        None => zone.to_string(),
    }
}

/// A machine's provider id, `<zone>/<name>`.
fn zone_and_name(id: &str) -> Result<(&str, &str), CloudError> {
    id.split_once('/')
        .filter(|(z, n)| !z.is_empty() && !n.is_empty() && !n.contains('/'))
        .ok_or_else(|| CloudError::Provider(format!("{id} is not a Google Cloud machine")))
}

/// The last part of a resource's URL, such as a zone's name.
fn last_part(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

/// `s`, encoded for a query.
fn query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect()
}

/// The Ubuntu LTS image families, which run cloud-init: `<project>/<family>`,
/// its label and architecture. A family gives its newest image.
const UBUNTU: &[(&str, &str, &str)] = &[
    (
        "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
        "Ubuntu 24.04 LTS (x86)",
        "x86",
    ),
    (
        "ubuntu-os-cloud/ubuntu-2404-lts-arm64",
        "Ubuntu 24.04 LTS (Arm)",
        "arm",
    ),
    (
        "ubuntu-os-cloud/ubuntu-2604-lts-amd64",
        "Ubuntu 26.04 LTS (x86)",
        "x86",
    ),
    (
        "ubuntu-os-cloud/ubuntu-2604-lts-arm64",
        "Ubuntu 26.04 LTS (Arm)",
        "arm",
    ),
];

/// The size of a machine's boot disk.
const DISK_GB: u64 = 50;

/// How long `create` waits for its insert to be done before it leaves the
/// machine to the startup deadline.
const CREATE_WAIT_SECS: u64 = 240;

/// The insert's `requestId`, a UUID from the machine's name: a retried call
/// makes no second machine.
fn request_id(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut b: [u8; 16] = Sha256::digest(name.as_bytes())[..16]
        .try_into()
        .expect("16 bytes");
    // Version 4, variant 1.
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// The machine families offered for builds.
const FAMILIES: &[&str] = &[
    "e2", "n2", "n2d", "n4", "c3", "c3d", "c4", "c4a", "c4d", "t2a", "t2d",
];

/// The families that take no Persistent Disk, only Hyperdisk.
const HYPERDISK_ONLY: &[&str] = &["c4", "c4a", "c4d", "n4"];

/// `e2-standard-4`: a family for builds, in a standard, highcpu or highmem
/// shape, without local SSDs or a whole host.
fn for_builds(name: &str) -> bool {
    let mut parts = name.split('-');
    let (Some(family), Some(shape), Some(_size), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    FAMILIES.contains(&family) && matches!(shape, "standard" | "highcpu" | "highmem")
}

/// `x86` or `arm`; an image that says none is `x86`.
fn arch_of(v: &Value) -> &'static str {
    if v == "ARM64" { "arm" } else { "x86" }
}

/// Neither deprecated nor on its way out.
fn active(v: &Value) -> bool {
    v["deprecated"]["state"]
        .as_str()
        .is_none_or(|s| s == "ACTIVE")
}

/// `max_hours` as typed: empty is 12.
pub fn max_hours(v: &str) -> Result<u64, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(DEFAULT_MAX_HOURS);
    }
    v.parse::<u64>()
        .ok()
        .filter(|h| (1..=MAX_HOURS).contains(h))
        .ok_or_else(|| {
            format!(
                "Longest a machine lives must be a whole number of hours from 1 to {MAX_HOURS}."
            )
        })
}

const DEFAULT_MAX_HOURS: u64 = 12;

/// Google's longest run time: 120 days.
const MAX_HOURS: u64 = 2880;

/// Whether a field the user typed is one Google Cloud can use.
pub fn check_field(name: &str, value: &str) -> Result<(), String> {
    match name {
        "key" => crate::gcp_auth::read_key(value).map(|_| ()),
        "max_hours" => max_hours(value).map(|_| ()),
        _ => Ok(()),
    }
}

pub struct Gcp {
    key: ServiceAccountKey,
    max_hours: u64,
    tokens: Arc<Tokens>,
    transport: Arc<dyn Transport>,
}

impl Gcp {
    /// An adapter for `key`'s project, whose machines Google deletes
    /// `max_hours` after they start. `tokens` is shared by every adapter.
    pub fn new(
        key: ServiceAccountKey,
        max_hours: u64,
        tokens: Arc<Tokens>,
        transport: Arc<dyn Transport>,
    ) -> Gcp {
        Gcp {
            key,
            max_hours,
            tokens,
            transport,
        }
    }

    fn project(&self) -> String {
        format!("{API}/projects/{}", self.key.project_id)
    }

    /// Sends `method path` with `body`; a 404 is an error.
    async fn call(
        &self,
        method: &'static str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CloudError> {
        self.send(method, path, body, false)
            .await
            .map(Option::unwrap_or_default)
    }

    /// As `call`, but a 404 is `Ok(None)`: the machine is gone.
    async fn call_or_gone(
        &self,
        method: &'static str,
        path: &str,
    ) -> Result<Option<Value>, CloudError> {
        self.send(method, path, None, true).await
    }

    /// Every page of the list at `path`, `key` holding each page's items.
    async fn pages(&self, path: &str, key: &str) -> Result<Vec<Value>, CloudError> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let sep = if path.contains('?') { '&' } else { '?' };
            let page = match &token {
                Some(t) => format!("{path}{sep}pageToken={}", query(t)),
                None => path.to_string(),
            };
            let v = self.call("GET", &page, None).await?;
            match &v[key] {
                Value::Array(items) => out.extend(items.iter().cloned()),
                // An aggregated list: its items by zone.
                Value::Object(scopes) => out.extend(
                    scopes
                        .values()
                        .filter_map(|s| s["instances"].as_array())
                        .flatten()
                        .cloned(),
                ),
                _ => {}
            }
            match v["nextPageToken"].as_str() {
                Some(t) if !t.is_empty() => token = Some(t.to_string()),
                _ => return Ok(out),
            }
        }
    }

    async fn send(
        &self,
        method: &'static str,
        path: &str,
        body: Option<Value>,
        gone_ok: bool,
    ) -> Result<Option<Value>, CloudError> {
        let mut tries = 0;
        let mut signed_in_again = false;
        loop {
            let token = self.tokens.token(&self.key, &self.transport).await?;
            let request = Request {
                method,
                url: format!("{}{path}", self.project()),
                headers: vec![("Authorization".into(), format!("Bearer {token}"))],
                body: body.clone().map(Body::Json),
            };
            let r = self
                .transport
                .send(request)
                .await
                .map_err(|e| CloudError::Network(format!("cannot reach Google Cloud: {e}")))?;
            let reasons = reasons(&r.body);
            let limited = r.status == 429
                || (r.status == 403
                    && reasons
                        .iter()
                        .any(|r| r == "rateLimitExceeded" || r == "userRateLimitExceeded"));
            match r.status {
                200..=299 => {
                    if r.body.is_empty() {
                        return Ok(Some(Value::Null));
                    }
                    return serde_json::from_slice(&r.body).map(Some).map_err(|e| {
                        CloudError::Network(format!(
                            "Google Cloud answered with something else: {e}"
                        ))
                    });
                }
                404 if gone_ok => return Ok(None),
                // The token may have been revoked: one new one.
                401 if !signed_in_again => {
                    signed_in_again = true;
                    self.tokens.forget(&self.key);
                }
                401 => {
                    return Err(CloudError::Refused(
                        "Google Cloud refused the service-account key. Check it in Settings › Cloud workers.".into(),
                    ));
                }
                _ if limited && tries + 1 < RATE_LIMITED_TRIES => {
                    tries += 1;
                    self.transport.sleep(RATE_LIMITED_WAIT).await;
                }
                403 if reasons
                    .iter()
                    .any(|r| r == "SERVICE_DISABLED" || r == "accessNotConfigured") =>
                {
                    let p = &self.key.project_id;
                    return Err(CloudError::Provider(format!(
                        "The Compute Engine API is off in {p}. Turn it on at https://console.cloud.google.com/apis/library/compute.googleapis.com?project={p}, wait a few minutes and try again."
                    )));
                }
                403 if !limited => {
                    return Err(CloudError::Refused(format!(
                        "Google Cloud refused {}: {}. It needs the Compute Instance Admin (v1) role on {}.",
                        self.key.client_email,
                        message(&r.body).trim_end_matches('.'),
                        self.key.project_id
                    )));
                }
                status => {
                    return Err(CloudError::Provider(format!(
                        "{status} {}",
                        message(&r.body)
                    )));
                }
            }
        }
    }
}

/// How often a rate-limited request is tried in all.
const RATE_LIMITED_TRIES: usize = 3;

/// Google says no time to wait, so a rate-limited request waits this long.
const RATE_LIMITED_WAIT: Duration = Duration::from_secs(5);

/// The message of a Google error answer.
fn message(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

/// The reasons of a Google error answer: its `errors` and its `details`.
fn reasons(body: &[u8]) -> Vec<String> {
    let v: Value = serde_json::from_slice(body).unwrap_or_default();
    let e = &v["error"];
    e["errors"]
        .as_array()
        .into_iter()
        .chain(e["details"].as_array())
        .flatten()
        .filter_map(|x| x["reason"].as_str().map(String::from))
        .collect()
}

#[async_trait::async_trait]
impl Provider for Gcp {
    fn info(&self) -> ProviderInfo {
        info()
    }

    async fn locations(&self) -> Result<Vec<Location>, CloudError> {
        Ok(self
            .pages("/zones", "items")
            .await?
            .iter()
            .filter(|z| z["status"] == "UP")
            .map(|z| {
                let name = z["name"].as_str().unwrap_or_default();
                Location {
                    name: name.to_string(),
                    label: zone_label(name, last_part(z["region"].as_str().unwrap_or_default())),
                }
            })
            .collect())
    }

    async fn images(&self) -> Result<Vec<Image>, CloudError> {
        let mut out: Vec<Image> = UBUNTU
            .iter()
            .map(|(name, label, arch)| Image {
                name: name.to_string(),
                label: label.to_string(),
                arch: arch.to_string(),
            })
            .collect();
        out.extend(
            self.pages("/global/images", "items")
                .await?
                .iter()
                .filter(|i| i["status"] == "READY" && active(i))
                .map(|i| {
                    let name = i["name"].as_str().unwrap_or_default().to_string();
                    Image {
                        label: i["description"]
                            .as_str()
                            .filter(|d| !d.is_empty())
                            .map_or_else(|| name.clone(), String::from),
                        name,
                        arch: arch_of(&i["architecture"]).to_string(),
                    }
                }),
        );
        Ok(out)
    }

    async fn machine_types(&self, zone: &str) -> Result<Vec<MachineType>, CloudError> {
        Ok(self
            .pages(&format!("/zones/{zone}/machineTypes"), "items")
            .await?
            .iter()
            .filter(|t| active(t) && !t["isSharedCpu"].as_bool().unwrap_or(false))
            .filter(|t| for_builds(t["name"].as_str().unwrap_or_default()))
            .map(|t| MachineType {
                name: t["name"].as_str().unwrap_or_default().to_string(),
                cores: t["guestCpus"].as_u64().unwrap_or(0) as u32,
                memory_gb: t["memoryMb"].as_f64().unwrap_or(0.0) / 1024.0,
                arch: arch_of(&t["architecture"]).to_string(),
            })
            .collect())
    }

    async fn create(&self, m: &NewMachine) -> Result<String, CloudError> {
        let zone = &m.location;
        let family = m.kind.split('-').next().unwrap_or_default();
        let disk = if HYPERDISK_ONLY.contains(&family) {
            "hyperdisk-balanced"
        } else {
            "pd-balanced"
        };
        let image = match m.image.split_once('/') {
            Some((project, family)) => format!("projects/{project}/global/images/family/{family}"),
            None => format!("projects/{}/global/images/{}", self.key.project_id, m.image),
        };
        let body = json!({
            "name": m.name,
            "machineType": format!("zones/{zone}/machineTypes/{}", m.kind),
            "labels": m.labels,
            "disks": [{
                "boot": true,
                "autoDelete": true,
                "initializeParams": {
                    "sourceImage": image,
                    "diskSizeGb": DISK_GB.to_string(),
                    "diskType": format!("zones/{zone}/diskTypes/{disk}"),
                },
            }],
            // The external address reaches Tailscale and GitHub.
            "networkInterfaces": [{
                "network": "global/networks/default",
                "accessConfigs": [{"type": "ONE_TO_ONE_NAT"}],
            }],
            "metadata": {"items": [
                {"key": "user-data", "value": m.user_data},
                {"key": "block-project-ssh-keys", "value": "TRUE"},
            ]},
            // The machine gets no Google credentials.
            "serviceAccounts": [],
            "scheduling": {
                "maxRunDuration": {"seconds": (self.max_hours * 3600).to_string()},
                "instanceTerminationAction": "DELETE",
            },
        });
        let path = format!("/zones/{zone}/instances?requestId={}", request_id(&m.name));
        let mut op = self.call("POST", &path, Some(body)).await?;
        // Quota and capacity errors show only in the operation.
        let deadline = self.transport.now() + CREATE_WAIT_SECS;
        loop {
            if op["status"] == "DONE" {
                if let Some(e) = op["error"]["errors"].get(0) {
                    return Err(CloudError::Provider(format!(
                        "{}: {}",
                        e["code"].as_str().unwrap_or("ERROR"),
                        e["message"].as_str().unwrap_or_default()
                    )));
                }
                break;
            }
            if self.transport.now() >= deadline {
                break;
            }
            let asked = self.transport.now();
            let name = op["name"].as_str().unwrap_or_default().to_string();
            op = self
                .call(
                    "POST",
                    &format!("/zones/{zone}/operations/{name}/wait"),
                    None,
                )
                .await?;
            // A wait answers within 2 minutes, but at times at once.
            if op["status"] != "DONE" && self.transport.now().saturating_sub(asked) < 10 {
                self.transport.sleep(Duration::from_secs(5)).await;
            }
        }
        Ok(format!("{zone}/{}", m.name))
    }

    async fn get(&self, id: &str) -> Result<MachineInfo, CloudError> {
        let (zone, name) = zone_and_name(id)?;
        let Some(v) = self
            .call_or_gone("GET", &format!("/zones/{zone}/instances/{name}"))
            .await?
        else {
            return Ok(MachineInfo {
                state: MachineState::Gone,
                ipv4: None,
            });
        };
        Ok(MachineInfo {
            // Every other status of a machine that exists is on its way there,
            // as far as moonlet waits for it.
            state: if v["status"] == "RUNNING" {
                MachineState::Running
            } else {
                MachineState::Starting
            },
            ipv4: v["networkInterfaces"][0]["accessConfigs"][0]["natIP"]
                .as_str()
                .map(String::from),
        })
    }

    async fn list(&self, labels: &BTreeMap<String, String>) -> Result<Vec<Listed>, CloudError> {
        let filter = labels
            .iter()
            .map(|(k, v)| format!("(labels.{k} = \"{v}\")"))
            .collect::<Vec<_>>()
            .join(" ");
        let path = format!("/aggregated/instances?filter={}", query(&filter));
        Ok(self
            .pages(&path, "items")
            .await?
            .iter()
            .map(|i| {
                let name = i["name"].as_str().unwrap_or_default();
                Listed {
                    id: format!(
                        "{}/{name}",
                        last_part(i["zone"].as_str().unwrap_or_default())
                    ),
                    name: name.to_string(),
                    labels: i["labels"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                        .collect(),
                    created_at: i["creationTimestamp"]
                        .as_str()
                        .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
                        .map_or(0, |t| t.timestamp_millis() as u64),
                }
            })
            .collect())
    }

    async fn destroy(&self, id: &str) -> Result<(), CloudError> {
        let (zone, name) = zone_and_name(id)?;
        // Gone already is done; the boot disk goes with the machine.
        self.call_or_gone("DELETE", &format!("/zones/{zone}/instances/{name}"))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Response;
    use std::sync::Mutex;

    /// Answers each request with the next of `answers`, each taking its
    /// seconds of the clock, and records what was sent and how long it
    /// waited.
    struct Script {
        answers: Mutex<Vec<(u16, u64, &'static str)>>,
        sent: Mutex<Vec<Request>>,
        slept: Mutex<Vec<Duration>>,
        now: Mutex<u64>,
    }

    impl Script {
        /// Starts with the sign-in's token answer.
        fn new(answers: Vec<(u16, &'static str)>) -> Arc<Script> {
            Script::timed(answers.into_iter().map(|(s, b)| (s, 0, b)).collect())
        }

        fn timed(answers: Vec<(u16, u64, &'static str)>) -> Arc<Script> {
            let mut all = vec![(200, 0, include_str!("fixtures/gcp/token.json"))];
            all.extend(answers);
            Arc::new(Script {
                answers: Mutex::new(all),
                sent: Mutex::default(),
                slept: Mutex::default(),
                now: Mutex::new(1_761_400_000),
            })
        }

        /// What was sent to Compute Engine: every request but the sign-in's.
        fn compute(&self) -> Vec<Request> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.url != crate::gcp_auth::TOKEN_URL)
                .cloned()
                .collect()
        }

        fn urls(&self) -> Vec<String> {
            self.compute().into_iter().map(|r| r.url).collect()
        }
    }

    #[async_trait::async_trait]
    impl Transport for Script {
        async fn send(&self, request: Request) -> Result<Response, String> {
            self.sent.lock().unwrap().push(request);
            let (status, takes, body) = self.answers.lock().unwrap().remove(0);
            *self.now.lock().unwrap() += takes;
            Ok(Response {
                status,
                headers: vec![],
                body: body.as_bytes().to_vec(),
            })
        }
        async fn sleep(&self, duration: Duration) {
            self.slept.lock().unwrap().push(duration);
            *self.now.lock().unwrap() += duration.as_secs();
        }
        fn now(&self) -> u64 {
            *self.now.lock().unwrap()
        }
    }

    fn key() -> ServiceAccountKey {
        crate::gcp_auth::read_key(
            &serde_json::json!({
                "type": "service_account",
                "project_id": "acme-moonlet",
                "private_key_id": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
                "private_key": include_str!("fixtures/gcp/test_key.pem"),
                "client_email": "moonlet@acme-moonlet.iam.gserviceaccount.com",
            })
            .to_string(),
        )
        .unwrap()
    }

    fn gcp(script: &Arc<Script>) -> Gcp {
        Gcp::new(key(), 12, Arc::new(Tokens::default()), script.clone())
    }

    const PROJECT: &str = "https://compute.googleapis.com/compute/v1/projects/acme-moonlet";

    #[test]
    fn describes_google_cloud_and_its_billing() {
        let i = info();
        assert_eq!(i.id, "gcp");
        assert_eq!(i.label, "Google Cloud");
        assert_eq!(i.max_name, 63);
        assert!(i.tailnet_key);
        assert_eq!(
            i.billing,
            crate::Billing {
                unit_secs: 1,
                minimum_secs: 60
            }
        );
        assert_eq!(
            i.fields,
            vec![
                Field {
                    name: "key".into(),
                    label: "Service account key (JSON)".into(),
                    secret: true,
                    help: "A key of a service account with the Compute Instance Admin (v1) role. It can create and delete any machine in its project, so use a project made for moonlet.".into(),
                },
                Field {
                    name: "max_hours".into(),
                    label: "Longest a machine lives (hours)".into(),
                    secret: false,
                    help: "Google Cloud deletes a machine this long after it starts, even while the central host is off. A command still running then is cut off. Empty means 12.".into(),
                },
            ]
        );
        // A 40 s machine is billed its first minute.
        assert_eq!(i.billing.billed(40), 60);
        assert_eq!(i.billing.billed(61), 61);
    }

    #[tokio::test]
    async fn reads_every_page_of_zones() {
        let script = Script::new(vec![
            (200, include_str!("fixtures/gcp/zones_page1.json")),
            (200, include_str!("fixtures/gcp/zones_page2.json")),
        ]);
        let zones = gcp(&script).locations().await.unwrap();
        assert_eq!(
            zones,
            vec![
                Location {
                    name: "europe-west4-a".into(),
                    label: "europe-west4-a · Eemshaven, NL".into()
                },
                Location {
                    name: "us-central1-a".into(),
                    label: "us-central1-a · Council Bluffs, US".into()
                },
                // A region the adapter's table does not know yet.
                Location {
                    name: "europe-north9-a".into(),
                    label: "europe-north9-a".into()
                },
            ]
        );
        assert_eq!(
            script.urls(),
            vec![
                format!("{PROJECT}/zones"),
                format!("{PROJECT}/zones?pageToken=Cg5ldXJvcGUtd2VzdDQtYg%3D%3D"),
            ]
        );
        let sent = script.compute();
        assert_eq!(
            sent[0].headers,
            vec![(
                "Authorization".into(),
                "Bearer ya29.c.fake-access-token".into()
            )]
        );
    }
    #[tokio::test]
    async fn keeps_the_machine_types_for_builds() {
        let script = Script::new(vec![(200, include_str!("fixtures/gcp/machine_types.json"))]);
        let types = gcp(&script).machine_types("europe-west4-a").await.unwrap();
        let t = |name: &str, cores, memory_gb, arch: &str| MachineType {
            name: name.into(),
            cores,
            memory_gb,
            arch: arch.into(),
        };
        // Not the shared-core e2-micro, n1, a type with local SSDs or a
        // whole host, the deprecated t2a, a GPU type or a memory-optimised one.
        assert_eq!(
            types,
            vec![
                t("e2-standard-4", 4, 16.0, "x86"),
                t("n2d-highcpu-8", 8, 8.0, "x86"),
                t("c4-standard-8", 8, 30.0, "x86"),
                t("c4a-highmem-4", 4, 32.0, "arm"),
            ]
        );
        assert_eq!(
            script.urls(),
            vec![format!("{PROJECT}/zones/europe-west4-a/machineTypes")]
        );
    }

    #[tokio::test]
    async fn offers_ubuntu_families_then_own_images() {
        let script = Script::new(vec![(200, include_str!("fixtures/gcp/images.json"))]);
        let images = gcp(&script).images().await.unwrap();
        let i = |name: &str, label: &str, arch: &str| Image {
            name: name.into(),
            label: label.into(),
            arch: arch.into(),
        };
        // Not the deprecated image or the one still being made.
        assert_eq!(
            images,
            vec![
                i(
                    "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
                    "Ubuntu 24.04 LTS (x86)",
                    "x86"
                ),
                i(
                    "ubuntu-os-cloud/ubuntu-2404-lts-arm64",
                    "Ubuntu 24.04 LTS (Arm)",
                    "arm"
                ),
                i(
                    "ubuntu-os-cloud/ubuntu-2604-lts-amd64",
                    "Ubuntu 26.04 LTS (x86)",
                    "x86"
                ),
                i(
                    "ubuntu-os-cloud/ubuntu-2604-lts-arm64",
                    "Ubuntu 26.04 LTS (Arm)",
                    "arm"
                ),
                i("shop-builder-2026-10", "Ubuntu 24.04 with Node 24", "x86"),
                i("arm-builder", "arm-builder", "arm"),
                i("plain-disk", "plain-disk", "x86"),
            ]
        );
        assert_eq!(script.urls(), vec![format!("{PROJECT}/global/images")]);
    }
    fn machine(kind: &str, image: &str, name: &str) -> NewMachine {
        NewMachine {
            name: name.into(),
            kind: kind.into(),
            location: "europe-west4-a".into(),
            image: image.into(),
            user_data: "#!/bin/sh\necho moonlet\n".into(),
            labels: [
                ("moonlet-host", "c3f1a9e2b7d04c55"),
                ("moonlet-machine", "m7k2q"),
                ("moonlet-project", "9f86d081884c"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        }
    }

    #[tokio::test]
    async fn creates_an_instance_as_in_the_captured_request() {
        let script = Script::new(vec![
            (200, include_str!("fixtures/gcp/insert_operation.json")),
            (200, include_str!("fixtures/gcp/operation_done.json")),
        ]);
        let id = gcp(&script)
            .create(&machine(
                "c4-standard-8",
                "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
                "moonlet-shop-7k2q",
            ))
            .await
            .unwrap();
        assert_eq!(id, "europe-west4-a/moonlet-shop-7k2q");
        let sent = script.compute();
        assert_eq!(sent[0].method, "POST");
        assert_eq!(
            sent[0].url,
            format!(
                "{PROJECT}/zones/europe-west4-a/instances?requestId=6bfd5618-82d5-49c7-bdc2-4dc8146e09f8"
            )
        );
        let want = serde_json::json!({
            "name": "moonlet-shop-7k2q",
            "machineType": "zones/europe-west4-a/machineTypes/c4-standard-8",
            "labels": {
                "moonlet-host": "c3f1a9e2b7d04c55",
                "moonlet-machine": "m7k2q",
                "moonlet-project": "9f86d081884c"
            },
            "disks": [{
                "boot": true,
                "autoDelete": true,
                "initializeParams": {
                    "sourceImage": "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
                    "diskSizeGb": "50",
                    "diskType": "zones/europe-west4-a/diskTypes/hyperdisk-balanced"
                }
            }],
            "networkInterfaces": [{
                "network": "global/networks/default",
                "accessConfigs": [{"type": "ONE_TO_ONE_NAT"}]
            }],
            "metadata": {"items": [
                {"key": "user-data", "value": "#!/bin/sh\necho moonlet\n"},
                {"key": "block-project-ssh-keys", "value": "TRUE"}
            ]},
            "serviceAccounts": [],
            "scheduling": {
                "maxRunDuration": {"seconds": "43200"},
                "instanceTerminationAction": "DELETE"
            }
        });
        assert_eq!(sent[0].body, Some(Body::Json(want)));
        // Then it waits for the insert to be done.
        assert_eq!(sent[1].method, "POST");
        assert_eq!(
            sent[1].url,
            format!(
                "{PROJECT}/zones/europe-west4-a/operations/operation-1761400000000-6420a1b2c3d4e-5f6a7b8c-9d0e1f2a/wait"
            )
        );
        assert_eq!(sent.len(), 2);
    }

    #[tokio::test]
    async fn hyperdisk_for_c4_and_n4_pd_balanced_for_the_others() {
        let disk = async |kind: &str, image: &str| {
            let script = Script::new(vec![
                (200, include_str!("fixtures/gcp/insert_operation.json")),
                (200, include_str!("fixtures/gcp/operation_done.json")),
            ]);
            gcp(&script)
                .create(&machine(kind, image, "moonlet-shop-e2x1"))
                .await
                .unwrap();
            let Some(Body::Json(b)) = script.compute()[0].body.clone() else {
                panic!("no body");
            };
            (
                b["disks"][0]["initializeParams"]["diskType"].clone(),
                b["disks"][0]["initializeParams"]["sourceImage"].clone(),
            )
        };
        assert_eq!(
            disk("n4-highcpu-16", "shop-builder-2026-10").await,
            (
                "zones/europe-west4-a/diskTypes/hyperdisk-balanced".into(),
                // An own image, from the key's project.
                "projects/acme-moonlet/global/images/shop-builder-2026-10".into()
            )
        );
        assert_eq!(
            disk("c4a-standard-4", "ubuntu-os-cloud/ubuntu-2404-lts-arm64")
                .await
                .0,
            "zones/europe-west4-a/diskTypes/hyperdisk-balanced"
        );
        for kind in [
            "e2-standard-4",
            "n2d-highcpu-8",
            "c3-standard-8",
            "t2a-standard-4",
        ] {
            assert_eq!(
                disk(kind, "ubuntu-os-cloud/ubuntu-2404-lts-amd64").await.0,
                "zones/europe-west4-a/diskTypes/pd-balanced",
                "{kind}"
            );
        }
    }

    #[tokio::test]
    async fn waits_for_the_insert_and_reports_its_error() {
        let script = Script::new(vec![
            (200, include_str!("fixtures/gcp/insert_operation.json")),
            (200, include_str!("fixtures/gcp/operation_error.json")),
        ]);
        assert_eq!(
            gcp(&script)
                .create(&machine("c4-standard-8", "ubuntu-os-cloud/ubuntu-2404-lts-amd64", "moonlet-shop-7k2q"))
                .await,
            Err(CloudError::Provider(
                "ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'projects/acme-moonlet/zones/europe-west4-a' does not have enough resources available to fulfill the request.  Try a different zone, or try again later.".into()
            ))
        );
    }

    #[tokio::test]
    async fn returns_the_id_after_four_minutes_without_done() {
        let running = include_str!("fixtures/gcp/insert_operation.json");
        // Each wait answers after its 2 minutes, still running.
        let script = Script::timed(vec![
            (200, 0, running),
            (200, 120, running),
            (200, 120, running),
        ]);
        assert_eq!(
            gcp(&script)
                .create(&machine(
                    "c4-standard-8",
                    "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
                    "moonlet-shop-7k2q"
                ))
                .await,
            Ok("europe-west4-a/moonlet-shop-7k2q".into())
        );
        assert_eq!(script.compute().len(), 3);
        // A wait that answers at once is not asked again at once.
        let script = Script::timed(vec![
            (200, 0, running),
            (200, 0, running),
            (200, 0, include_str!("fixtures/gcp/operation_done.json")),
        ]);
        gcp(&script)
            .create(&machine(
                "c4-standard-8",
                "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
                "moonlet-shop-7k2q",
            ))
            .await
            .unwrap();
        assert_eq!(*script.slept.lock().unwrap(), vec![Duration::from_secs(5)]);
    }
    #[tokio::test]
    async fn reads_a_captured_instance() {
        let script = Script::new(vec![
            (200, include_str!("fixtures/gcp/instance.json")),
            (200, include_str!("fixtures/gcp/instance_staging.json")),
        ]);
        let g = gcp(&script);
        assert_eq!(
            g.get("europe-west4-a/moonlet-shop-7k2q").await.unwrap(),
            MachineInfo {
                state: MachineState::Running,
                ipv4: Some("34.90.211.17".into())
            }
        );
        assert_eq!(
            g.get("europe-west4-a/moonlet-shop-7k2q").await.unwrap(),
            MachineInfo {
                state: MachineState::Starting,
                ipv4: None
            }
        );
        assert_eq!(
            script.urls(),
            vec![format!("{PROJECT}/zones/europe-west4-a/instances/moonlet-shop-7k2q"); 2]
        );
    }

    #[tokio::test]
    async fn a_404_means_gone() {
        let script = Script::new(vec![(404, include_str!("fixtures/gcp/not_found.json"))]);
        assert_eq!(
            gcp(&script)
                .get("europe-west4-a/moonlet-shop-7k2q")
                .await
                .unwrap(),
            MachineInfo {
                state: MachineState::Gone,
                ipv4: None
            }
        );
    }

    #[tokio::test]
    async fn lists_instances_by_label_across_zones() {
        let script = Script::new(vec![(
            200,
            include_str!("fixtures/gcp/aggregated_instances.json"),
        )]);
        let labels: BTreeMap<String, String> = [
            ("moonlet-host", "c3f1a9e2b7d04c55"),
            ("moonlet-project", "9f86d081884c"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let listed = gcp(&script).list(&labels).await.unwrap();
        let l = |id: &str, name: &str, machine: &str, created_at| Listed {
            id: id.into(),
            name: name.into(),
            labels: [
                ("moonlet-host", "c3f1a9e2b7d04c55"),
                ("moonlet-machine", machine),
                ("moonlet-project", "9f86d081884c"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
            created_at,
        };
        assert_eq!(
            listed,
            vec![
                // 2026-10-25T10:00:00.140-07:00
                l(
                    "europe-west4-a/moonlet-shop-7k2q",
                    "moonlet-shop-7k2q",
                    "m7k2q",
                    1_792_947_600_140
                ),
                // 2026-10-25T03:30:00.000-07:00
                l(
                    "us-central1-a/moonlet-shop-m3x9",
                    "moonlet-shop-m3x9",
                    "mm3x9",
                    1_792_924_200_000
                ),
            ]
        );
        assert_eq!(
            script.urls(),
            vec![format!(
                "{PROJECT}/aggregated/instances?filter=%28labels.moonlet-host%20%3D%20%22c3f1a9e2b7d04c55%22%29%20%28labels.moonlet-project%20%3D%20%229f86d081884c%22%29"
            )]
        );
    }

    #[tokio::test]
    async fn a_404_on_delete_is_done() {
        let script = Script::new(vec![
            (200, include_str!("fixtures/gcp/delete_operation.json")),
            (404, include_str!("fixtures/gcp/not_found.json")),
        ]);
        let g = gcp(&script);
        g.destroy("europe-west4-a/moonlet-shop-7k2q").await.unwrap();
        g.destroy("europe-west4-a/moonlet-shop-7k2q").await.unwrap();
        let sent = script.compute();
        assert_eq!(sent[0].method, "DELETE");
        assert_eq!(
            sent[0].url,
            format!("{PROJECT}/zones/europe-west4-a/instances/moonlet-shop-7k2q")
        );
    }

    #[tokio::test]
    async fn an_id_without_a_zone_is_an_error() {
        let script = Script::new(vec![]);
        assert_eq!(
            gcp(&script).get("42").await,
            Err(CloudError::Provider(
                "42 is not a Google Cloud machine".into()
            ))
        );
    }
    #[tokio::test]
    async fn a_401_gets_a_new_token_once() {
        let token = include_str!("fixtures/gcp/token.json");
        let unauthenticated = include_str!("fixtures/gcp/unauthenticated.json");
        let script = Script::new(vec![
            (401, unauthenticated),
            (200, token),
            (200, include_str!("fixtures/gcp/instance.json")),
        ]);
        assert_eq!(
            gcp(&script)
                .get("europe-west4-a/moonlet-shop-7k2q")
                .await
                .unwrap()
                .state,
            MachineState::Running
        );
        assert_eq!(script.sent.lock().unwrap().len(), 4);
        let script = Script::new(vec![
            (401, unauthenticated),
            (200, token),
            (401, unauthenticated),
        ]);
        assert_eq!(
            gcp(&script).get("europe-west4-a/moonlet-shop-7k2q").await,
            Err(CloudError::Refused(
                "Google Cloud refused the service-account key. Check it in Settings › Cloud workers.".into()
            ))
        );
    }

    #[tokio::test]
    async fn an_api_that_is_off_says_where_to_turn_it_on() {
        let script = Script::new(vec![(
            403,
            include_str!("fixtures/gcp/service_disabled.json"),
        )]);
        assert_eq!(
            gcp(&script).locations().await,
            Err(CloudError::Provider(
                "The Compute Engine API is off in acme-moonlet. Turn it on at https://console.cloud.google.com/apis/library/compute.googleapis.com?project=acme-moonlet, wait a few minutes and try again.".into()
            ))
        );
    }

    #[tokio::test]
    async fn a_rate_limit_is_retried() {
        let limited = include_str!("fixtures/gcp/rate_limited.json");
        let script = Script::new(vec![
            (403, limited),
            (429, limited),
            (200, include_str!("fixtures/gcp/instance.json")),
        ]);
        assert_eq!(
            gcp(&script)
                .get("europe-west4-a/moonlet-shop-7k2q")
                .await
                .unwrap()
                .state,
            MachineState::Running
        );
        assert_eq!(
            *script.slept.lock().unwrap(),
            vec![Duration::from_secs(5); 2]
        );
        // Three tries in all.
        let script = Script::new(vec![(403, limited), (403, limited), (403, limited)]);
        assert_eq!(
            gcp(&script).get("europe-west4-a/moonlet-shop-7k2q").await,
            Err(CloudError::Provider(
                "403 Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'compute.googleapis.com' for consumer 'project_number:104857600000'.".into()
            ))
        );
    }

    #[tokio::test]
    async fn a_missing_role_says_which_one() {
        let script = Script::new(vec![(
            403,
            include_str!("fixtures/gcp/permission_denied.json"),
        )]);
        assert_eq!(
            gcp(&script)
                .create(&machine("c4-standard-8", "ubuntu-os-cloud/ubuntu-2404-lts-amd64", "moonlet-shop-7k2q"))
                .await,
            Err(CloudError::Refused(
                "Google Cloud refused moonlet@acme-moonlet.iam.gserviceaccount.com: Required 'compute.instances.create' permission for 'projects/acme-moonlet/zones/europe-west4-a/instances/moonlet-shop-7k2q'. It needs the Compute Instance Admin (v1) role on acme-moonlet.".into()
            ))
        );
    }

    #[tokio::test]
    async fn another_error_shows_googles_message() {
        let script = Script::new(vec![(400, include_str!("fixtures/gcp/invalid_value.json"))]);
        assert_eq!(
            gcp(&script)
                .create(&machine("c9-standard-8", "ubuntu-os-cloud/ubuntu-2404-lts-amd64", "moonlet-shop-7k2q"))
                .await,
            Err(CloudError::Provider(
                "400 Invalid value for field 'resource.machineType': 'zones/europe-west4-a/machineTypes/c9-standard-8'. Machine type with name 'c9-standard-8' does not exist in zone 'europe-west4-a'.".into()
            ))
        );
    }
    #[test]
    fn max_hours_is_a_whole_number_from_1_to_2880() {
        assert_eq!(max_hours(""), Ok(12));
        assert_eq!(max_hours(" 1 "), Ok(1));
        assert_eq!(max_hours("2880"), Ok(2880));
        let wrong = Err(
            "Longest a machine lives must be a whole number of hours from 1 to 2880.".to_string(),
        );
        for v in ["0", "2881", "1.5", "-3", "12h", "twelve"] {
            assert_eq!(max_hours(v), wrong, "{v}");
        }
    }

    #[test]
    fn checks_a_typed_field() {
        assert_eq!(check_field("max_hours", "24"), Ok(()));
        assert_eq!(
            check_field("max_hours", "0"),
            Err("Longest a machine lives must be a whole number of hours from 1 to 2880.".into())
        );
        assert_eq!(
            check_field("key", "hc_7Kq2mXw9pD"),
            Err("That is not a Google Cloud service-account key: it is not JSON.".into())
        );
        let key = serde_json::json!({
            "type": "service_account",
            "project_id": "acme-moonlet",
            "private_key_id": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
            "private_key": include_str!("fixtures/gcp/test_key.pem"),
            "client_email": "moonlet@acme-moonlet.iam.gserviceaccount.com",
        });
        assert_eq!(check_field("key", &key.to_string()), Ok(()));
    }
    #[test]
    fn removes_at_the_times_in_the_per_second_examples() {
        use crate::idle::{Activity, paid_end, removal_at};
        let at = |h: u64, m: u64, s: u64| ((h * 60 + m) * 60 + s) * 1000;
        let billing = info().billing;
        // Made at 10:00:00, ready at 10:01:30, its command 10:02–10:05.
        let created = at(10, 0, 0);
        let idle = |minutes, end| {
            let a = Activity {
                ready_at: at(10, 1, 30),
                runs: vec![(at(10, 2, 0), Some(end))],
                waiting: false,
            };
            let idle_at = removal_at(&a, minutes).unwrap();
            paid_end(idle_at, created, billing, 60_000)
        };
        assert_eq!(idle(15, at(10, 5, 0)), at(10, 20, 0));
        assert_eq!(idle(0, at(10, 3, 0)), at(10, 3, 0));
        // Within its first minute, which is paid in full, it stays until
        // just before that minute ends.
        assert_eq!(
            paid_end(at(10, 0, 40), created, billing, 60_000),
            at(10, 0, 59) + 800
        );
        // A machine that existed 40 s is booked as 60 s.
        assert_eq!(billing.billed(40), 60);
    }
}
