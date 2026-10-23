//! Hetzner Cloud (X63), through `https://api.hetzner.cloud/v1`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::{
    CloudError, Field, Listed, MachineInfo, MachineState, MachineType, NewMachine, Provider,
    ProviderInfo, Request, Transport,
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
    }
}

pub struct Hetzner {
    token: String,
    transport: Arc<dyn Transport>,
}

/// How often a rate-limited request is tried again before the user sees it.
const RATE_LIMITED_TRIES: usize = 3;

impl Hetzner {
    pub fn new(token: impl Into<String>, transport: Arc<dyn Transport>) -> Hetzner {
        Hetzner {
            token: token.into(),
            transport,
        }
    }

    /// Sends `method path` with `body`; a 404 is `Ok(None)`.
    async fn call(
        &self,
        method: &'static str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Option<Value>, CloudError> {
        let mut tries = 0;
        loop {
            let request = Request {
                method,
                url: format!("{API}{path}"),
                headers: vec![("Authorization".into(), format!("Bearer {}", self.token))],
                body: body.clone(),
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
                404 => return Ok(None),
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

    async fn machine_types(&self, location: &str) -> Result<Vec<MachineType>, CloudError> {
        let v = self
            .call("GET", "/server_types?per_page=50", None)
            .await?
            .unwrap_or_default();
        // A type is offered at a location when it has a price there.
        Ok(v["server_types"]
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
            })
            .collect())
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
        let v = self
            .call("POST", "/servers", Some(body))
            .await?
            .ok_or_else(|| CloudError::Provider("404 not found".into()))?;
        let id = id_of(&v["server"]["id"]);
        if id.is_empty() {
            return Err(CloudError::Network("Hetzner made no server".into()));
        }
        Ok(id)
    }

    async fn get(&self, id: &str) -> Result<MachineInfo, CloudError> {
        let Some(v) = self.call("GET", &format!("/servers/{id}"), None).await? else {
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
            let v = self.call("GET", &path, None).await?.unwrap_or_default();
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
        self.call("DELETE", &format!("/servers/{id}"), None)
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
                body: Some(serde_json::json!({
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
                })),
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
    async fn reads_captured_server_types() {
        let script = Script::new(vec![ok(include_str!("fixtures/hetzner/server_types.json"))]);
        let types = hetzner(&script).machine_types("fsn1").await.unwrap();
        assert_eq!(
            types,
            [
                MachineType {
                    name: "cpx41".into(),
                    cores: 8,
                    memory_gb: 16.0,
                    arch: "x86".into()
                },
                MachineType {
                    name: "cax21".into(),
                    cores: 4,
                    memory_gb: 8.0,
                    arch: "arm".into()
                },
            ]
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
