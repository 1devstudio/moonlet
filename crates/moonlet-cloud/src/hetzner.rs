//! Hetzner Cloud (X63), through `https://api.hetzner.cloud/v1`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::{
    Body, CloudError, Field, Image, Listed, Location, MachineInfo, MachineState, MachineType,
    NewMachine, Provider, ProviderInfo, Request, Transport,
};

pub const API: &str = "https://api.hetzner.cloud/v1";

pub fn info() -> ProviderInfo {
    ProviderInfo {
        id: "hetzner".into(),
        label: "Hetzner Cloud".into(),
        fields: vec![Field {
            name: "token".into(),
            label: "API token".into(),
            secret: true,
            help: "It can create and delete anything in its Hetzner project, so use a project made for moonlet.".into(),
        }],
        max_name: 63,
        tailnet_key: true,
        // Every started hour.
        billing: crate::Billing {
            unit_secs: 3600,
            minimum_secs: 0,
        },
    }
}

pub struct Hetzner {
    token: String,
    transport: Arc<dyn Transport>,
}

/// How often a rate-limited request is tried again before the user sees it.
const RATE_LIMITED_TRIES: usize = 3;

/// The longest a rate-limited request waits for the limit to reset. Hetzner
/// refills its hourly quota slowly, and a wait past this would outlast the
/// sweep's patience with a create call.
const MAX_RATE_LIMIT_WAIT: u64 = 60;

impl Hetzner {
    pub fn new(token: impl Into<String>, transport: Arc<dyn Transport>) -> Hetzner {
        Hetzner {
            token: token.into(),
            transport,
        }
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

    async fn send(
        &self,
        method: &'static str,
        path: &str,
        body: Option<Value>,
        gone_ok: bool,
    ) -> Result<Option<Value>, CloudError> {
        let mut tries = 0;
        loop {
            let request = Request {
                method,
                url: format!("{API}{path}"),
                headers: vec![("Authorization".into(), format!("Bearer {}", self.token))],
                body: body.clone().map(Body::Json),
            };
            let r = self
                .transport
                .send(request)
                .await
                .map_err(|e| CloudError::Network(format!("cannot reach Hetzner: {e}")))?;
            match r.status {
                200..=299 => {
                    if r.body.is_empty() {
                        return Ok(Some(Value::Null));
                    }
                    return serde_json::from_slice(&r.body).map(Some).map_err(|e| {
                        CloudError::Network(format!("Hetzner answered with something else: {e}"))
                    });
                }
                404 if gone_ok => return Ok(None),
                401 | 403 => {
                    return Err(CloudError::Refused(
                        "Hetzner refused the token. Check it in Settings › Cloud workers.".into(),
                    ));
                }
                429 if tries + 1 < RATE_LIMITED_TRIES => {
                    tries += 1;
                    // Until the limit resets, or 5 s when it does not say.
                    let wait = r
                        .header("RateLimit-Reset")
                        .and_then(|v| v.trim().parse::<u64>().ok())
                        .map(|reset| reset.saturating_sub(self.transport.now()))
                        .filter(|s| *s > 0)
                        .unwrap_or(5);
                    if wait > MAX_RATE_LIMIT_WAIT {
                        return Err(CloudError::Provider(format!(
                            "429 Hetzner's rate limit resets in {} min",
                            wait.div_ceil(60)
                        )));
                    }
                    self.transport.sleep(Duration::from_secs(wait)).await;
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

/// The message of a Hetzner error answer.
fn message(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

fn id_of(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn labels_of(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
        .collect()
}

/// `running` is running; every other state of a machine that exists is on
/// its way there, as far as moonlet waits for it.
fn state_of(status: &str) -> MachineState {
    if status == "running" {
        MachineState::Running
    } else {
        MachineState::Starting
    }
}

/// `key=value,…`, as `label_selector` takes it, encoded for a query.
fn selector(labels: &BTreeMap<String, String>) -> String {
    let raw = labels
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    raw.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            c => {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf)
                    .bytes()
                    .map(|b| format!("%{b:02X}"))
                    .collect()
            }
        })
        .collect()
}

#[async_trait::async_trait]
impl Provider for Hetzner {
    fn info(&self) -> ProviderInfo {
        info()
    }

    async fn locations(&self) -> Result<Vec<Location>, CloudError> {
        // Six of them: one page.
        let v = self.call("GET", "/locations", None).await?;
        Ok(v["locations"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| Location {
                name: l["name"].as_str().unwrap_or_default().to_string(),
                label: format!(
                    "{}, {}",
                    l["city"].as_str().unwrap_or_default(),
                    l["country"].as_str().unwrap_or_default()
                ),
            })
            .collect())
    }

    async fn images(&self) -> Result<Vec<Image>, CloudError> {
        let mut out = Vec::new();
        for kind in ["system", "snapshot"] {
            let mut page = 1;
            loop {
                let v = self
                    .call(
                        "GET",
                        &format!("/images?type={kind}&status=available&per_page=50&page={page}"),
                        None,
                    )
                    .await?;
                out.extend(
                    v["images"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|i| i["deprecated"].is_null())
                        .map(|i| {
                            let description = i["description"].as_str().unwrap_or_default();
                            // A snapshot has no name: `create` takes its id.
                            match i["name"].as_str() {
                                Some(name) => Image {
                                    name: name.to_string(),
                                    label: description.to_string(),
                                    arch: i["architecture"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string(),
                                },
                                None => Image {
                                    name: id_of(&i["id"]),
                                    label: format!("Snapshot: {description}"),
                                    arch: i["architecture"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string(),
                                },
                            }
                        }),
                );
                match v["meta"]["pagination"]["next_page"].as_u64() {
                    Some(next) if next > page => page = next,
                    _ => break,
                }
            }
        }
        Ok(out)
    }

    async fn machine_types(&self, location: &str) -> Result<Vec<MachineType>, CloudError> {
        let mut out = Vec::new();
        let mut page = 1;
        loop {
            let v = self
                .call(
                    "GET",
                    &format!("/server_types?per_page=50&page={page}"),
                    None,
                )
                .await?;
            // A type is offered at a location when it has a price there.
            out.extend(
                v["server_types"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|t| !t["deprecated"].as_bool().unwrap_or(false))
                    .filter(|t| {
                        t["prices"]
                            .as_array()
                            .is_some_and(|p| p.iter().any(|p| p["location"] == location))
                    })
                    .map(|t| MachineType {
                        name: t["name"].as_str().unwrap_or_default().to_string(),
                        cores: t["cores"].as_u64().unwrap_or(0) as u32,
                        memory_gb: t["memory"].as_f64().unwrap_or(0.0),
                        arch: t["architecture"].as_str().unwrap_or_default().to_string(),
                    }),
            );
            match v["meta"]["pagination"]["next_page"].as_u64() {
                Some(next) if next > page => page = next,
                _ => return Ok(out),
            }
        }
    }

    async fn create(&self, m: &NewMachine) -> Result<String, CloudError> {
        let body = json!({
            "name": m.name,
            "server_type": m.kind,
            "image": m.image,
            "location": m.location,
            "user_data": m.user_data,
            "labels": m.labels,
            "start_after_create": true,
        });
        let v = self.call("POST", "/servers", Some(body)).await?;
        let id = id_of(&v["server"]["id"]);
        if id.is_empty() {
            return Err(CloudError::Network("Hetzner made no server".into()));
        }
        Ok(id)
    }

    async fn get(&self, id: &str) -> Result<MachineInfo, CloudError> {
        let Some(v) = self.call_or_gone("GET", &format!("/servers/{id}")).await? else {
            return Ok(MachineInfo {
                state: MachineState::Gone,
                ipv4: None,
            });
        };
        let s = &v["server"];
        Ok(MachineInfo {
            state: state_of(s["status"].as_str().unwrap_or_default()),
            ipv4: s["public_net"]["ipv4"]["ip"].as_str().map(String::from),
        })
    }

    async fn list(&self, labels: &BTreeMap<String, String>) -> Result<Vec<Listed>, CloudError> {
        let mut out = Vec::new();
        let mut page = 1;
        loop {
            let path = format!(
                "/servers?label_selector={}&per_page=50&page={page}",
                selector(labels)
            );
            let v = self.call("GET", &path, None).await?;
            for s in v["servers"].as_array().into_iter().flatten() {
                out.push(Listed {
                    id: id_of(&s["id"]),
                    name: s["name"].as_str().unwrap_or_default().to_string(),
                    labels: labels_of(&s["labels"]),
                    created_at: s["created"]
                        .as_str()
                        .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
                        .map_or(0, |t| t.timestamp_millis() as u64),
                });
            }
            match v["meta"]["pagination"]["next_page"].as_u64() {
                Some(next) if next > page => page = next,
                _ => return Ok(out),
            }
        }
    }

    async fn destroy(&self, id: &str) -> Result<(), CloudError> {
        // Gone already is done.
        self.call_or_gone("DELETE", &format!("/servers/{id}"))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Response;
    use std::sync::Mutex;

    /// Answers each request with the next of `answers`, and records what was
    /// sent and how long it waited.
    struct Script {
        answers: Mutex<Vec<(u16, Vec<(String, String)>, &'static str)>>,
        sent: Mutex<Vec<Request>>,
        slept: Mutex<Vec<Duration>>,
    }

    impl Script {
        fn new(answers: Vec<(u16, Vec<(String, String)>, &'static str)>) -> Arc<Script> {
            Arc::new(Script {
                answers: Mutex::new(answers),
                sent: Mutex::default(),
                slept: Mutex::default(),
            })
        }
    }

    #[async_trait::async_trait]
    impl Transport for Script {
        async fn send(&self, request: Request) -> Result<Response, String> {
            self.sent.lock().unwrap().push(request);
            let (status, headers, body) = self.answers.lock().unwrap().remove(0);
            Ok(Response {
                status,
                headers,
                body: body.as_bytes().to_vec(),
            })
        }
        async fn sleep(&self, duration: Duration) {
            self.slept.lock().unwrap().push(duration);
        }
        fn now(&self) -> u64 {
            1_792_000_000
        }
    }

    fn ok(body: &'static str) -> (u16, Vec<(String, String)>, &'static str) {
        (200, vec![], body)
    }

    fn hetzner(script: &Arc<Script>) -> Hetzner {
        Hetzner::new("hc-token", script.clone())
    }

    fn labels() -> BTreeMap<String, String> {
        [
            ("moonlet-host", "c3f1a9e2b7d04c55"),
            ("moonlet-machine", "m7k2q"),
            ("moonlet-project", "9f86d081884c"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[tokio::test]
    async fn creates_a_server_as_in_the_captured_request() {
        let script = Script::new(vec![(
            201,
            vec![],
            include_str!("fixtures/hetzner/create_server.json"),
        )]);
        let id = hetzner(&script)
            .create(&NewMachine {
                name: "moonlet-shop-7k2q".into(),
                kind: "cpx41".into(),
                location: "fsn1".into(),
                image: "ubuntu-24.04".into(),
                user_data: "#cloud-config\n".into(),
                labels: labels(),
            })
            .await
            .unwrap();
        assert_eq!(id, "42");
        let sent = script.sent.lock().unwrap();
        assert_eq!(
            sent[0],
            Request {
                method: "POST",
                url: "https://api.hetzner.cloud/v1/servers".into(),
                headers: vec![("Authorization".into(), "Bearer hc-token".into())],
                body: Some(Body::Json(serde_json::json!({
                    "name": "moonlet-shop-7k2q",
                    "server_type": "cpx41",
                    "image": "ubuntu-24.04",
                    "location": "fsn1",
                    "user_data": "#cloud-config\n",
                    "labels": {
                        "moonlet-host": "c3f1a9e2b7d04c55",
                        "moonlet-machine": "m7k2q",
                        "moonlet-project": "9f86d081884c"
                    },
                    "start_after_create": true
                }))),
            }
        );
    }

    #[tokio::test]
    async fn reads_a_captured_server() {
        let script = Script::new(vec![ok(include_str!("fixtures/hetzner/server.json"))]);
        let got = hetzner(&script).get("42").await.unwrap();
        assert_eq!(
            got,
            MachineInfo {
                state: MachineState::Running,
                ipv4: Some("203.0.113.10".into())
            }
        );
        assert_eq!(
            script.sent.lock().unwrap()[0].url,
            "https://api.hetzner.cloud/v1/servers/42"
        );
    }

    #[tokio::test]
    async fn lists_servers_by_label() {
        let script = Script::new(vec![ok(include_str!("fixtures/hetzner/servers.json"))]);
        let host: BTreeMap<String, String> =
            [("moonlet-host".to_string(), "c3f1a9e2b7d04c55".to_string())].into();
        let listed = hetzner(&script).list(&host).await.unwrap();
        assert_eq!(
            script.sent.lock().unwrap()[0].url,
            "https://api.hetzner.cloud/v1/servers?label_selector=moonlet-host%3Dc3f1a9e2b7d04c55&per_page=50&page=1"
        );
        assert_eq!(
            listed
                .iter()
                .map(|l| (l.id.as_str(), l.name.as_str(), l.created_at))
                .collect::<Vec<_>>(),
            [
                ("42", "moonlet-shop-7k2q", 1_792_665_600_000),
                ("43", "moonlet-shop-m3x9", 1_792_667_130_000)
            ]
        );
        assert_eq!(listed[1].labels["moonlet-machine"], "mm3x9");
    }

    #[tokio::test]
    async fn a_404_means_gone() {
        let script = Script::new(vec![
            (404, vec![], include_str!("fixtures/hetzner/not_found.json")),
            (404, vec![], include_str!("fixtures/hetzner/not_found.json")),
        ]);
        let h = hetzner(&script);
        assert_eq!(h.get("42").await.unwrap().state, MachineState::Gone);
        assert_eq!(h.destroy("42").await, Ok(()));
        assert_eq!(script.sent.lock().unwrap()[1].method, "DELETE");
    }

    #[tokio::test]
    async fn reads_every_page_of_server_types() {
        let first = r#"{ "server_types": [ { "name": "cpx41", "cores": 8, "memory": 16.0, "architecture": "x86", "deprecated": false, "prices": [ { "location": "fsn1" } ] } ],
            "meta": { "pagination": { "page": 1, "next_page": 2 } } }"#;
        let second = r#"{ "server_types": [ { "name": "ccx63", "cores": 48, "memory": 192.0, "architecture": "x86", "deprecated": false, "prices": [ { "location": "fsn1" } ] } ],
            "meta": { "pagination": { "page": 2, "next_page": null } } }"#;
        let script = Script::new(vec![ok(first), ok(second)]);
        let names: Vec<String> = hetzner(&script)
            .machine_types("fsn1")
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, ["cpx41", "ccx63"]);
        assert_eq!(
            script.sent.lock().unwrap()[1].url,
            "https://api.hetzner.cloud/v1/server_types?per_page=50&page=2"
        );
    }

    #[tokio::test]
    async fn a_404_on_the_list_is_an_error_not_an_empty_list() {
        // Read as "no machines", it would make the sweep forget every record.
        let script = Script::new(vec![(
            404,
            vec![],
            include_str!("fixtures/hetzner/not_found.json"),
        )]);
        let host: BTreeMap<String, String> =
            [("moonlet-host".to_string(), "c3f1a9e2b7d04c55".to_string())].into();
        assert_eq!(
            hetzner(&script).list(&host).await,
            Err(CloudError::Provider(
                "404 server with ID '42' not found".into()
            ))
        );
    }

    #[tokio::test]
    async fn a_429_resetting_later_than_a_minute_fails_instead_of_waiting() {
        // `now` is 1792000000 in the script: the limit resets in 50 minutes.
        let script = Script::new(vec![(
            429,
            vec![("RateLimit-Reset".into(), "1792003000".into())],
            include_str!("fixtures/hetzner/rate_limited.json"),
        )]);
        assert_eq!(
            hetzner(&script).get("42").await,
            Err(CloudError::Provider(
                "429 Hetzner's rate limit resets in 50 min".into()
            ))
        );
        assert!(script.slept.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn reads_captured_locations() {
        let script = Script::new(vec![ok(include_str!("fixtures/hetzner/locations.json"))]);
        let all = hetzner(&script).locations().await.unwrap();
        assert_eq!(
            all.iter()
                .map(|l| (l.name.as_str(), l.label.as_str()))
                .collect::<Vec<_>>(),
            [
                ("fsn1", "Falkenstein, DE"),
                ("nbg1", "Nuremberg, DE"),
                ("hel1", "Helsinki, FI"),
                ("ash", "Ashburn, VA, US"),
                ("hil", "Hillsboro, OR, US"),
                ("sin", "Singapore, SG"),
            ]
        );
        assert_eq!(
            script.sent.lock().unwrap()[0].url,
            "https://api.hetzner.cloud/v1/locations"
        );
    }

    #[tokio::test]
    async fn reads_captured_images() {
        let script = Script::new(vec![
            ok(include_str!("fixtures/hetzner/images_system.json")),
            ok(include_str!("fixtures/hetzner/images_snapshot.json")),
        ]);
        let all = hetzner(&script).images().await.unwrap();
        assert_eq!(all.len(), 32);
        assert_eq!(
            all[14..16]
                .iter()
                .map(|i| (i.name.as_str(), i.label.as_str(), i.arch.as_str()))
                .collect::<Vec<_>>(),
            [
                ("ubuntu-24.04", "Ubuntu 24.04", "x86"),
                ("ubuntu-24.04", "Ubuntu 24.04", "arm"),
            ]
        );
        let sent = script.sent.lock().unwrap();
        assert_eq!(
            sent[0].url,
            "https://api.hetzner.cloud/v1/images?type=system&status=available&per_page=50&page=1"
        );
        assert_eq!(
            sent[1].url,
            "https://api.hetzner.cloud/v1/images?type=snapshot&status=available&per_page=50&page=1"
        );
    }

    #[tokio::test]
    async fn a_snapshot_goes_by_its_id_and_a_deprecated_image_is_left_out() {
        // Shaped as the captured system images.
        let system = r#"{ "images": [
            { "id": 45780948, "name": "rocky-8", "architecture": "x86", "deprecated": "2026-11-01T00:00:00Z", "description": "Rocky Linux 8", "type": "system" },
            { "id": 161547269, "name": "ubuntu-24.04", "architecture": "x86", "deprecated": null, "description": "Ubuntu 24.04", "type": "system" } ],
            "meta": { "pagination": { "page": 1, "next_page": null } } }"#;
        let snapshots = r#"{ "images": [
            { "id": 401234567, "name": null, "architecture": "arm", "deprecated": null, "description": "shop deps", "type": "snapshot" } ],
            "meta": { "pagination": { "page": 1, "next_page": null } } }"#;
        let script = Script::new(vec![ok(system), ok(snapshots)]);
        assert_eq!(
            hetzner(&script).images().await.unwrap(),
            [
                Image {
                    name: "ubuntu-24.04".into(),
                    label: "Ubuntu 24.04".into(),
                    arch: "x86".into()
                },
                Image {
                    name: "401234567".into(),
                    label: "Snapshot: shop deps".into(),
                    arch: "arm".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn reads_captured_server_types() {
        let script = Script::new(vec![ok(include_str!("fixtures/hetzner/server_types.json"))]);
        // Ashburn sells 11 of the 26 types.
        let types = hetzner(&script).machine_types("ash").await.unwrap();
        assert_eq!(
            types.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            [
                "cpx11", "cpx21", "cpx31", "cpx41", "cpx51", "ccx13", "ccx23", "ccx33", "ccx43",
                "ccx53", "ccx63"
            ]
        );
        assert_eq!(
            types[3],
            MachineType {
                name: "cpx41".into(),
                cores: 8,
                memory_gb: 16.0,
                arch: "x86".into()
            }
        );
    }

    #[tokio::test]
    async fn a_401_says_the_token_was_refused() {
        let script = Script::new(vec![(
            401,
            vec![],
            include_str!("fixtures/hetzner/unauthorized.json"),
        )]);
        let e = hetzner(&script).get("42").await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "Hetzner refused the token. Check it in Settings › Cloud workers."
        );
    }

    #[tokio::test]
    async fn a_403_says_the_token_was_refused() {
        let script = Script::new(vec![(
            403,
            vec![],
            include_str!("fixtures/hetzner/forbidden.json"),
        )]);
        let e = hetzner(&script).destroy("42").await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "Hetzner refused the token. Check it in Settings › Cloud workers."
        );
    }

    #[tokio::test]
    async fn a_429_waits_for_the_reset_time() {
        let script = Script::new(vec![
            (
                429,
                vec![("RateLimit-Reset".into(), "1792000012".into())],
                include_str!("fixtures/hetzner/rate_limited.json"),
            ),
            ok(include_str!("fixtures/hetzner/server.json")),
        ]);
        assert_eq!(
            hetzner(&script).get("42").await.unwrap().state,
            MachineState::Running
        );
        assert_eq!(*script.slept.lock().unwrap(), [Duration::from_secs(12)]);
    }

    #[tokio::test]
    async fn a_429_without_a_reset_time_waits_five_seconds() {
        let script = Script::new(vec![
            (
                429,
                vec![],
                include_str!("fixtures/hetzner/rate_limited.json"),
            ),
            ok(include_str!("fixtures/hetzner/server.json")),
        ]);
        assert_eq!(
            hetzner(&script).get("42").await.unwrap().state,
            MachineState::Running
        );
        assert_eq!(*script.slept.lock().unwrap(), [Duration::from_secs(5)]);
    }

    #[tokio::test]
    async fn another_error_shows_the_providers_message() {
        let script = Script::new(vec![(
            503,
            vec![],
            include_str!("fixtures/hetzner/unavailable.json"),
        )]);
        let e = hetzner(&script).destroy("42").await.unwrap_err();
        assert_eq!(e.to_string(), "503 Service Unavailable");
    }
}
