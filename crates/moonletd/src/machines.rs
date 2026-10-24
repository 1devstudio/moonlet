//! Cloud machines on the central host (X63): made from a project's cloud
//! setting, followed through their startup steps, and removed. The record
//! of each is in `cloud/machines.json`, written before the provider is
//! asked to make it, so the sweep finds what a crash left behind.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use moonlet_cloud::{CloudError, MachineState, NewMachine, Provider, Transport};
use moonlet_core::session::SessionManager;
use moonlet_proto::methods::{self as m, CloudMachine, CloudMachines, CloudStep, WorkerStep};
use moonlet_proto::{Message, RpcError};
use serde::{Deserialize, Serialize};

use crate::cloud::CloudSettings;
use crate::mobile::Mobile;
use crate::workers::Workers;

/// The largest `machine_setup` script a machine is made with.
const SETUP_MAX: u64 = 16 * 1024;

fn now_ms() -> u64 {
    moonlet_core::paths::now_ms()
}

/// A test-only override of a duration, in ms.
fn env_ms(var: &str, default: Duration) -> Duration {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(default, Duration::from_millis)
}

/// How long a machine has to become ready after its create call.
fn deadline() -> Duration {
    env_ms(
        "MOONLET_TEST_CLOUD_DEADLINE_MS",
        Duration::from_secs(15 * 60),
    )
}

/// How long a ready machine's link may stay down before it is removed.
fn link_down() -> Duration {
    env_ms(
        "MOONLET_TEST_CLOUD_LINK_DOWN_MS",
        Duration::from_secs(10 * 60),
    )
}

/// How often the sweep runs.
fn sweep_every() -> Duration {
    env_ms("MOONLET_TEST_CLOUD_SWEEP_MS", Duration::from_secs(10 * 60))
}

/// How long a minute of the idle time lasts: a minute, or less in tests.
fn minute() -> u64 {
    env_ms("MOONLET_TEST_CLOUD_MINUTE_MS", Duration::from_secs(60)).as_millis() as u64
}

/// The first wait between destroy attempts; it doubles, up to 5 minutes.
fn destroy_backoff() -> Duration {
    env_ms("MOONLET_TEST_CLOUD_BACKOFF_MS", Duration::from_millis(300))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Record {
    #[serde(flatten)]
    shown: CloudMachine,
    image: String,
    /// The provider's id for it, once the create call answered.
    #[serde(default)]
    provider_id: Option<String>,
    /// The create call's start, while it runs.
    #[serde(default)]
    call_started: Option<u64>,
    created_at: u64,
    #[serde(default)]
    ready_at: Option<u64>,
    #[serde(default)]
    removed_at: Option<u64>,
    /// Its paired device and worker id, once it joined and registered.
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    worker: Option<String>,
    /// Its link has been down since.
    #[serde(default)]
    down_since: Option<u64>,
    /// Waits for its machine setup to end before it is ready.
    #[serde(default)]
    setup: bool,
    /// When its last routed command ended.
    #[serde(default)]
    last_end: Option<u64>,
    /// Commands waiting for it to be ready.
    #[serde(default)]
    waiting: u32,
    /// Removed, for this reason, once its running commands end.
    #[serde(default)]
    down_after: Option<String>,
    /// The sessions it has a routing copy of.
    #[serde(default)]
    copied: Vec<String>,
}

impl Record {
    fn active(&self) -> bool {
        matches!(
            self.shown.state.as_str(),
            "creating" | "starting" | "ready" | "removing"
        )
    }

    fn step(&mut self, id: &str, state: &str, took_ms: Option<u64>, error: Option<String>) {
        if let Some(s) = self.shown.steps.iter_mut().find(|s| s.step == id) {
            s.state = state.into();
            s.took_ms = took_ms;
            s.error = error;
        }
    }

    fn set_state(&mut self, state: &str) {
        self.shown.state = state.into();
        self.shown.since = now_ms();
    }
}

/// A sends requests over the network: the daemon's [`Transport`].
struct Net {
    client: reqwest::Client,
}

#[async_trait::async_trait]
impl Transport for Net {
    async fn send(&self, r: moonlet_cloud::Request) -> Result<moonlet_cloud::Response, String> {
        let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = self.client.request(method, &r.url);
        for (k, v) in &r.headers {
            req = req.header(k, v);
        }
        req = match r.body {
            Some(moonlet_cloud::Body::Json(v)) => req.json(&v),
            Some(moonlet_cloud::Body::Form(f)) => req.form(&f),
            None => req,
        };
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let headers = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
            .collect();
        let body = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok(moonlet_cloud::Response {
            status,
            headers,
            body,
        })
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }

    fn now(&self) -> u64 {
        now_ms() / 1000
    }
}

pub struct Machines {
    dir: PathBuf,
    settings: Arc<CloudSettings>,
    mobile: Arc<Mobile>,
    link: Arc<crate::link::WorkerLink>,
    workers: Arc<Workers>,
    sessions: Arc<SessionManager>,
    records: Mutex<Vec<Record>>,
    usage: Mutex<moonlet_cloud::usage::Usage>,
    /// Held while a machine is checked against the limits and recorded.
    making: Mutex<()>,
    fake: Option<Arc<crate::cloud_fake::Fake>>,
    net: Arc<dyn Transport>,
    /// When `tailscale status` was last asked.
    tailnet_asked: Mutex<u64>,
    emit: Box<dyn Fn(Message) + Send + Sync>,
    me: Mutex<Weak<Machines>>,
}

/// Whether a machine of state `state` counts against the machine limit.
fn counts(state: &str) -> bool {
    matches!(state, "creating" | "starting" | "ready" | "removing")
}

impl Machines {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        home: &Path,
        settings: Arc<CloudSettings>,
        mobile: Arc<Mobile>,
        link: Arc<crate::link::WorkerLink>,
        workers: Arc<Workers>,
        sessions: Arc<SessionManager>,
        emit: impl Fn(Message) + Send + Sync + 'static,
    ) -> Arc<Machines> {
        let dir = home.join("cloud");
        let mut records: Vec<Record> = std::fs::read(dir.join("machines.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // A create call does not outlive the daemon: the sweep finds what
        // it made.
        for r in &mut records {
            r.call_started = None;
        }
        let usage = std::fs::read(dir.join("usage.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let net: Arc<dyn Transport> = Arc::new(Net {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        });
        let me = Arc::new(Machines {
            dir,
            settings,
            mobile: mobile.clone(),
            link,
            workers,
            sessions,
            records: Mutex::new(records),
            usage: Mutex::new(usage),
            making: Mutex::new(()),
            fake: crate::cloud_fake::from_env().map(Arc::new),
            net,
            tailnet_asked: Mutex::new(0),
            emit: Box::new(emit),
            me: Mutex::new(Weak::new()),
        });
        *me.me.lock().unwrap() = Arc::downgrade(&me);
        let weak = Arc::downgrade(&me);
        mobile.on_join(move |machine, device| {
            if let Some(me) = weak.upgrade() {
                me.joined(machine, device);
            }
        });
        me
    }

    /// Starts the sweep and the watch over startup deadlines and links.
    pub fn start(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(me) = weak.upgrade() else { return };
                me.sweep().await;
                drop(me);
                tokio::time::sleep(sweep_every()).await;
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let Some(me) = weak.upgrade() else { return };
                me.watch();
            }
        });
    }

    fn save(&self) {
        let _ = std::fs::create_dir_all(&self.dir);
        let records = self.records.lock().unwrap().clone();
        if let Ok(b) = serde_json::to_vec_pretty(&records) {
            let tmp = self.dir.join("machines.json.tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(tmp, self.dir.join("machines.json"));
            }
        }
        if let Ok(b) = serde_json::to_vec_pretty(&*self.usage.lock().unwrap()) {
            let _ = std::fs::write(self.dir.join("usage.json"), b);
        }
    }

    fn changed(&self) {
        self.save();
        (self.emit)(Message::event(m::EV_CLOUD_CHANGED, self.list()));
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Record)) {
        if let Some(r) = self
            .records
            .lock()
            .unwrap()
            .iter_mut()
            .find(|r| r.shown.id == id)
        {
            f(r);
        }
        self.changed();
    }

    fn get(&self, id: &str) -> Option<Record> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.shown.id == id)
            .cloned()
    }

    /// The providers on offer: the fake one only with its setting.
    pub fn provider_infos(&self) -> Vec<moonlet_cloud::ProviderInfo> {
        let mut out = moonlet_cloud::providers();
        if self.fake.is_some() {
            out.push(crate::cloud_fake::info());
        }
        out
    }

    fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, RpcError> {
        match id {
            "fake" => self
                .fake
                .clone()
                .map(|f| f as Arc<dyn Provider>)
                .ok_or_else(|| RpcError::new("no_provider", "the fake provider is off")),
            "hetzner" => {
                let token = self
                    .settings
                    .file()
                    .providers
                    .get("hetzner")
                    .and_then(|p| p.get("token").cloned())
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| {
                        RpcError::new(
                            "no_provider",
                            "Add a Hetzner token in Settings › Cloud workers.",
                        )
                    })?;
                Ok(Arc::new(moonlet_cloud::hetzner::Hetzner::new(
                    token,
                    self.net.clone(),
                )))
            }
            other => Err(RpcError::new("no_provider", format!("no provider {other}"))),
        }
    }

    /// `cloud.machines`.
    pub fn list(&self) -> CloudMachines {
        let now = now_ms();
        let records = self.records.lock().unwrap().clone();
        let f = self.settings.file();
        let (removed, machines): (Vec<_>, Vec<_>) = records
            .into_iter()
            .filter(|r| {
                r.removed_at
                    .is_none_or(|t| now.saturating_sub(t) < 3_600_000)
            })
            .partition(|r| matches!(r.shown.state.as_str(), "removed" | "failed"));
        CloudMachines {
            machines: machines
                .into_iter()
                .map(|r| {
                    let until = idle_until(&r, f.idle_minutes);
                    let mut shown = r.shown;
                    shown.idle_until = until;
                    shown
                })
                .collect(),
            removed: removed.into_iter().map(|r| r.shown).collect(),
            hours_this_month: moonlet_cloud::usage::hours(&self.usage.lock().unwrap(), now),
            max_hours_month: f.max_hours_month,
            max_machines: f.max_machines,
        }
    }

    /// `cloud.types`.
    pub async fn types(
        &self,
        provider: &str,
        location: &str,
    ) -> Result<Vec<moonlet_cloud::MachineType>, RpcError> {
        self.provider(provider)?
            .machine_types(location)
            .await
            .map_err(|e| RpcError::new("provider", e.to_string()))
    }

    /// `machine_setup` of the project in `folder`: its path and content.
    fn machine_setup(folder: &Path) -> Result<Option<(String, String)>, RpcError> {
        let config = moonlet_core::project_config::load(folder, String::new());
        let Some(path) = config.config.heavy.machine_setup else {
            return Ok(None);
        };
        let refuse = |why: String| Err(RpcError::new("machine_setup", why));
        let root = folder
            .canonicalize()
            .map_err(|e| RpcError::new("machine_setup", e.to_string()))?;
        // Through links, too: the file must be in the folder.
        let file = match root.join(&path).canonicalize() {
            Ok(f) => f,
            Err(_) => return refuse(format!("{path} is missing")),
        };
        if !file.starts_with(&root) || !file.is_file() {
            return refuse(format!("{path} is outside the repository"));
        }
        let size = file.metadata().map_or(0, |m| m.len());
        if size > SETUP_MAX {
            return refuse(format!("{path} is over 16 KiB"));
        }
        let content = std::fs::read_to_string(&file)
            .map_err(|e| RpcError::new("machine_setup", e.to_string()))?;
        Ok(Some((path, content)))
    }

    /// `cloud.up`: starts a machine for project `project`, for `session`.
    pub fn up(&self, project: &str, session: Option<String>) -> Result<CloudMachine, RpcError> {
        let p = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == project)
            .ok_or_else(|| RpcError::new("not_found", format!("no project {project}")))?;
        let key = crate::heavy::key(&p.identity).ok_or_else(|| {
            RpcError::new("no_identity", format!("{} has no first commit", p.name))
        })?;
        let f = self.settings.file();
        let setting =
            f.projects.get(&key).cloned().ok_or_else(|| {
                RpcError::new("no_cloud", format!("{} has no cloud setting", p.name))
            })?;
        let provider = self.provider(&setting.provider)?;
        let info = provider.info();
        // From the session's worktree, or the project's own folder.
        let folder = match &session {
            Some(s) => PathBuf::from(
                self.sessions
                    .session(s)
                    .map_err(|e| RpcError::new("not_found", e.to_string()))?
                    .path,
            ),
            None => PathBuf::from(&p.path),
        };
        let setup = Self::machine_setup(&folder)?;
        let id = format!("m{}", moonlet_cloud::machine::suffix());
        let name = moonlet_cloud::machine::machine_name(
            &p.name,
            &moonlet_cloud::machine::suffix(),
            info.max_name,
        );
        let central = self.link.info().worker.name;
        let version = env!("CARGO_PKG_VERSION");
        let mut steps = vec![
            step("created", format!("Created at {}", info.label)),
            step("tailnet", "Joined your tailnet".into()),
            step("installed", format!("Installed moonlet {version}")),
            step("paired", format!("Paired with {central}")),
        ];
        if let Some((path, _)) = &setup {
            steps.push(step("machine_setup", format!("Machine setup {path}")));
        }
        // Made for a session: ready once it has the session's copy (X62).
        if let Some(s) = &session {
            let name = self.sessions.session(s).map(|s| s.name).unwrap_or_default();
            let config = moonlet_core::project_config::load(&folder, String::new()).config;
            let label = match config.setup {
                Some(setup) => format!("Copied {name} and ran {setup}"),
                None => format!("Copied {name}"),
            };
            steps.push(step("copy", label));
        }
        let now = now_ms();
        let record = Record {
            shown: CloudMachine {
                id: id.clone(),
                name: name.clone(),
                project: p.name.clone(),
                project_key: key.clone(),
                provider: setting.provider.clone(),
                kind: setting.kind.clone(),
                location: setting.location.clone(),
                state: "creating".into(),
                since: now,
                steps,
                deadline: Some(now + deadline().as_millis() as u64),
                idle_until: None,
                for_session: session,
                running: 0,
                error: None,
                error_since: None,
                reason: None,
            },
            image: setting.image.clone(),
            provider_id: None,
            call_started: Some(now),
            created_at: now,
            ready_at: None,
            removed_at: None,
            device: None,
            worker: None,
            down_since: None,
            setup: setup.is_some(),
            last_end: None,
            waiting: 0,
            down_after: None,
            copied: Vec::new(),
        };
        {
            // The limits and the record in one step, so two calls at once
            // never pass a limit.
            let _one = self.making.lock().unwrap();
            let mut records = self.records.lock().unwrap();
            let active = records.iter().filter(|r| counts(&r.shown.state)).count() as u32;
            if active >= f.max_machines {
                return Err(RpcError::new(
                    "cloud_limit",
                    format!(
                        "Cloud limit reached: {active} of {} machines",
                        f.max_machines
                    ),
                ));
            }
            let used = moonlet_cloud::usage::hours(&self.usage.lock().unwrap(), now);
            if used >= f64::from(f.max_hours_month) {
                return Err(RpcError::new(
                    "cloud_limit",
                    format!(
                        "Cloud limit reached: {} of {} machine-hours this month",
                        hours_text(used),
                        f.max_hours_month
                    ),
                ));
            }
            records.push(record.clone());
        }
        self.changed();
        let me = self.me.lock().unwrap().upgrade();
        if let Some(me) = me {
            let (id, name) = (id.clone(), name.clone());
            tokio::spawn(async move { me.create(id, name, provider, setup).await });
        }
        Ok(record.shown)
    }

    /// The create call and what the machine needs to join.
    async fn create(
        self: Arc<Self>,
        id: String,
        name: String,
        provider: Arc<dyn Provider>,
        setup: Option<(String, String)>,
    ) {
        let Some(r) = self.get(&id) else { return };
        let started = now_ms();
        let f = self.settings.file();
        let key = if provider.info().tailnet_key {
            let client = moonlet_cloud::tailscale::OAuthClient {
                id: f.tailscale.client_id.clone(),
                secret: f.tailscale.client_secret.clone(),
                tag: f.tailscale.tag.clone(),
            };
            match moonlet_cloud::tailscale::machine_key(&client, &name, self.net.clone()).await {
                Ok(k) => k,
                Err(e) => return self.failed(&id, e.to_string()),
            }
        } else {
            String::new()
        };
        let user_data = moonlet_cloud::cloud_init::render(&moonlet_cloud::cloud_init::CloudInit {
            name: name.clone(),
            tailscale_key: key,
            version: env!("CARGO_PKG_VERSION").into(),
            addrs: self.mobile.listening(),
            join_code: self.mobile.join_code(&id, &name),
            machine_setup: setup,
        });
        let labels = moonlet_cloud::machine::labels(&f.host_id, &id, &r.shown.project_key);
        let made = provider
            .create(&NewMachine {
                name: name.clone(),
                kind: r.shown.kind.clone(),
                location: r.shown.location.clone(),
                image: r.image.clone(),
                user_data,
                labels,
            })
            .await;
        match made {
            Ok(provider_id) => self.update(&id, |r| {
                r.provider_id = Some(provider_id);
                r.call_started = None;
                r.set_state("starting");
                r.step("created", "done", Some(now_ms() - started), None);
            }),
            Err(e) => self.failed(&id, e.to_string()),
        }
    }

    /// A machine that could not be made: nothing to remove at the provider.
    fn failed(&self, id: &str, error: String) {
        self.update(id, |r| {
            r.call_started = None;
            r.set_state("failed");
            r.shown.error = Some(error.clone());
            r.shown.error_since = Some(now_ms());
            r.shown.reason = Some(format!("could not be made: {error}"));
            r.removed_at = Some(now_ms());
        });
    }

    /// The machine paired with its join code.
    fn joined(&self, machine: &str, device: &str) {
        let tailscale = which("tailscale");
        self.update(machine, |r| {
            r.device = Some(device.to_string());
            let took = Some(now_ms().saturating_sub(r.created_at));
            // Without Tailscale here, the join itself shows it joined.
            if !tailscale {
                r.step("tailnet", "done", took, None);
            }
            r.step("installed", "done", took, None);
            r.step("paired", "done", took, None);
        });
    }

    /// The cloud machine of device `device`, when it is one.
    pub fn machine_of(&self, device: &str) -> Option<String> {
        self.mobile.cloud_machine(device)
    }

    /// Its worker registered.
    pub fn registered(&self, machine: &str, worker: &str) {
        self.update(machine, |r| {
            r.worker = Some(worker.to_string());
            r.down_since = None;
        });
        // Made for a session: the session's copy, before it is ready.
        let copy = self.get(machine).filter(|r| {
            r.shown
                .steps
                .iter()
                .any(|s| s.step == "copy" && s.state == "pending")
        });
        if let Some(r) = copy
            && let Some(session) = r.shown.for_session.clone()
            && let Some(me) = self.me.lock().unwrap().upgrade()
        {
            let (machine, worker) = (machine.to_string(), worker.to_string());
            tokio::spawn(async move { me.copy_session(machine, worker, session).await });
        }
        self.ready_if_done(machine);
    }

    /// Makes `session`'s routing copy on machine `machine`, and runs the
    /// project's setup there.
    async fn copy_session(self: Arc<Self>, machine: String, worker: String, session: String) {
        let started = now_ms();
        self.update(&machine, |r| r.step("copy", "running", None, None));
        loop {
            let Some(conn) = self.workers.conn(&worker) else {
                return;
            };
            let asked = conn
                .request(
                    m::EXEC_PREPARE,
                    serde_json::json!({ "session": session }),
                    Duration::from_secs(600),
                )
                .await;
            let asked = asked.ok();
            let reason = asked
                .as_ref()
                .and_then(|v| v["reason"].as_str().map(String::from));
            match asked
                .and_then(|v| v["state"].as_str().map(String::from))
                .as_deref()
            {
                Some("ready") => {
                    self.update(&machine, |r| {
                        r.step("copy", "done", Some(now_ms() - started), None);
                        r.copied.push(session.clone());
                    });
                    self.ready_if_done(&machine);
                    return;
                }
                Some("failed") | None => {
                    self.update(&machine, |r| {
                        r.step("copy", "failed", None, Some("the copy failed".into()))
                    });
                    let label = self
                        .get(&machine)
                        .and_then(|r| {
                            r.shown
                                .steps
                                .iter()
                                .find(|s| s.step == "copy")
                                .map(|s| s.label.clone())
                        })
                        .unwrap_or_default();
                    let why = reason.map(|r| format!(": {r}")).unwrap_or_default();
                    self.remove(&machine, format!("{label} failed{why}"));
                    return;
                }
                // Still making it, or its setup runs.
                _ => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    }

    /// Whether machine `worker` has a routing copy of `session`.
    pub fn has_copy(&self, worker: &str, session: &str) -> bool {
        self.records
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.worker.as_deref() == Some(worker) && r.copied.iter().any(|s| s == session))
    }

    /// Machine `worker` now has a routing copy of `session`.
    pub fn copied(&self, worker: &str, session: &str) {
        if let Some(id) = self.by_worker(worker) {
            self.update(&id, |r| {
                if !r.copied.iter().any(|s| s == session) {
                    r.copied.push(session.to_string());
                }
            });
        }
    }

    /// `worker.step` from machine `machine`.
    pub fn step(&self, machine: &str, s: WorkerStep) {
        let failed = s.state == "failed";
        self.update(machine, |r| {
            r.step(&s.step, &s.state, s.took_ms, s.error.clone())
        });
        if failed {
            let label = self
                .get(machine)
                .and_then(|r| {
                    r.shown
                        .steps
                        .iter()
                        .find(|x| x.step == s.step)
                        .map(|x| x.label.clone())
                })
                .unwrap_or_default();
            self.remove(
                machine,
                format!("{label} failed: {}", s.error.unwrap_or_default()),
            );
        } else {
            self.ready_if_done(machine);
        }
    }

    fn ready_if_done(&self, machine: &str) {
        let Some(r) = self.get(machine) else { return };
        let done = r.worker.is_some()
            && r.shown.state == "starting"
            && r.shown
                .steps
                .iter()
                .filter(|s| s.step != "tailnet")
                .all(|s| s.state == "done");
        if done {
            self.update(machine, |r| {
                r.set_state("ready");
                r.ready_at = Some(now_ms());
                r.shown.deadline = None;
                r.step(
                    "tailnet",
                    "done",
                    r.shown
                        .steps
                        .iter()
                        .find(|s| s.step == "paired")
                        .and_then(|s| s.took_ms),
                    None,
                );
            });
        }
    }

    /// Every 250 ms: startup deadlines and links down too long.
    fn watch(&self) {
        let now = now_ms();
        self.watch_tailnet();
        let workers: Vec<String> = self
            .workers
            .list()
            .into_iter()
            .map(|w| w.worker.id)
            .collect();
        let records = self.records.lock().unwrap().clone();
        for r in records {
            match r.shown.state.as_str() {
                "creating" | "starting" if r.shown.deadline.is_some_and(|d| now >= d) => {
                    let mins = deadline().as_secs() / 60;
                    let last = r
                        .shown
                        .steps
                        .iter()
                        .rev()
                        .find(|s| s.state == "done")
                        .map_or("nothing".to_string(), |s| s.label.clone());
                    self.remove(
                        &r.shown.id,
                        format!(
                            "{} did not come up in {mins} minutes; last: {last}",
                            r.shown.name
                        ),
                    );
                }
                "ready" => {
                    let up = r.worker.as_ref().is_some_and(|w| workers.contains(w));
                    match (up, r.down_since) {
                        (true, Some(_)) => self.update(&r.shown.id, |r| r.down_since = None),
                        (false, None) => self.update(&r.shown.id, |r| r.down_since = Some(now)),
                        (false, Some(since))
                            if now.saturating_sub(since) >= link_down().as_millis() as u64 =>
                        {
                            let mins = link_down().as_secs() / 60;
                            self.remove(
                                &r.shown.id,
                                format!("its link was down for {mins} minutes"),
                            );
                            continue;
                        }
                        _ => {}
                    }
                    if r.shown.running > 0 {
                        continue;
                    }
                    if let Some(reason) = r.down_after.clone() {
                        self.remove(&r.shown.id, reason);
                        continue;
                    }
                    let idle = self.settings.file().idle_minutes;
                    if idle_until(&r, idle).is_some_and(|until| now >= until) {
                        self.remove(&r.shown.id, format!("removed after {idle} min idle"));
                    }
                }
                _ => {}
            }
        }
    }

    /// Starting machines that `tailscale status` now lists have joined the
    /// tailnet; asked at most every 2 s.
    fn watch_tailnet(&self) {
        let waiting: Vec<(String, String, u64)> = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.shown.state == "starting")
            .filter(|r| {
                r.shown
                    .steps
                    .iter()
                    .any(|s| s.step == "tailnet" && s.state == "pending")
            })
            .map(|r| (r.shown.id.clone(), r.shown.name.clone(), r.created_at))
            .collect();
        if waiting.is_empty() || !which("tailscale") {
            return;
        }
        {
            let mut last = self.tailnet_asked.lock().unwrap();
            if now_ms().saturating_sub(*last) < 2_000 {
                return;
            }
            *last = now_ms();
        }
        let Some(me) = self.me.lock().unwrap().upgrade() else {
            return;
        };
        tokio::spawn(async move {
            let out = tokio::process::Command::new("tailscale")
                .args(["status", "--json"])
                .output()
                .await;
            let Ok(out) = out else { return };
            let Ok(status) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
                return;
            };
            for (id, name, created_at) in waiting {
                if tailnet_has(&status, &name) {
                    me.update(&id, |r| {
                        r.step(
                            "tailnet",
                            "done",
                            Some(now_ms().saturating_sub(created_at)),
                            None,
                        )
                    });
                }
            }
        });
    }

    /// The worker ids of every cloud machine.
    pub fn cloud_workers(&self) -> Vec<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| r.worker.clone())
            .collect()
    }

    /// The worker ids of project `project`'s ready cloud machines.
    pub fn workers_for(&self, project: &str) -> Vec<String> {
        let Some(key) = self.project_key(project) else {
            return Vec::new();
        };
        self.records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.shown.project_key == key && r.shown.state == "ready")
            .filter_map(|r| r.worker.clone())
            .collect()
    }

    fn project_key(&self, project: &str) -> Option<String> {
        let p = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == project)?;
        crate::heavy::key(&p.identity)
    }

    /// No worker was free for a command of project `project`: a machine
    /// starts when the project allows it and none is starting yet.
    pub fn overflow(&self, project: &str) {
        let Some(key) = self.project_key(project) else {
            return;
        };
        if !self
            .settings
            .file()
            .projects
            .get(&key)
            .is_some_and(|p| p.overflow)
        {
            return;
        }
        let starting = self.records.lock().unwrap().iter().any(|r| {
            r.shown.project_key == key && matches!(r.shown.state.as_str(), "creating" | "starting")
        });
        if !starting && let Err(e) = self.up(project, None) {
            tracing::info!("no overflow machine for {project}: {}", e.message);
        }
    }

    fn by_worker(&self, worker: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.worker.as_deref() == Some(worker))
            .map(|r| r.shown.id.clone())
    }

    /// The machine a cloud session's command waits for: the project's
    /// machine on its way, or a new one made for the session.
    pub fn for_session(&self, project: &str, session: &str) -> Result<(String, String), RpcError> {
        let key = self
            .project_key(project)
            .ok_or_else(|| RpcError::new("no_identity", "the project has no first commit"))?;
        let coming = self
            .records
            .lock()
            .unwrap()
            .iter()
            .find(|r| {
                r.shown.project_key == key
                    && matches!(r.shown.state.as_str(), "creating" | "starting" | "ready")
            })
            .map(|r| (r.shown.id.clone(), r.shown.name.clone()));
        match coming {
            Some(found) => Ok(found),
            None => self
                .up(project, Some(session.to_string()))
                .map(|m| (m.id, m.name)),
        }
    }

    /// Machine `id`'s state, and why it was removed.
    pub fn state_of(&self, id: &str) -> Option<(String, Option<String>)> {
        self.get(id).map(|r| (r.shown.state, r.shown.reason))
    }

    /// A command starts or stops waiting for machine `id`.
    pub fn wait_begin(&self, id: &str) {
        self.update(id, |r| r.waiting += 1);
    }

    pub fn wait_end(&self, id: &str) {
        self.update(id, |r| r.waiting = r.waiting.saturating_sub(1));
    }

    /// A routed command started on cloud machine `worker`.
    pub fn run_started(&self, worker: &str) {
        if let Some(id) = self.by_worker(worker) {
            self.update(&id, |r| {
                r.shown.running += 1;
                r.shown.idle_until = None;
            });
        }
    }

    /// A routed command ended on cloud machine `worker`.
    pub fn run_ended(&self, worker: &str) {
        if let Some(id) = self.by_worker(worker) {
            self.update(&id, |r| {
                r.shown.running = r.shown.running.saturating_sub(1);
                r.last_end = Some(now_ms());
            });
        }
    }

    /// `cloud.down`: removes machine `machine` (id or name).
    pub fn down(&self, machine: &str) -> Result<bool, RpcError> {
        let r = self
            .records
            .lock()
            .unwrap()
            .iter()
            .find(|r| (r.shown.id == machine || r.shown.name == machine) && r.active())
            .cloned()
            .ok_or_else(|| RpcError::new("not_found", format!("no machine {machine}")))?;
        self.retire(&r.shown.id, "removed on request".into());
        Ok(true)
    }

    /// Removes machine `id` now, or once its running commands end.
    fn retire(&self, id: &str, reason: String) {
        let busy = self.get(id).is_some_and(|r| r.shown.running > 0);
        if busy {
            self.update(id, |r| r.down_after = Some(reason.clone()));
        } else {
            self.remove(id, reason);
        }
    }

    /// Project `key` no longer uses cloud machines: they go once their
    /// commands end.
    pub fn project_off(&self, key: &str) {
        let ids: Vec<(String, String)> = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.shown.project_key == key && r.active())
            .map(|r| (r.shown.id.clone(), r.shown.project.clone()))
            .collect();
        for (id, project) in ids {
            self.retire(&id, format!("{project} no longer uses cloud machines"));
        }
    }

    /// Whether provider `provider` has machines that are not gone yet.
    pub fn has_machines(&self, provider: &str) -> bool {
        self.records
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.shown.provider == provider && r.active())
    }

    /// Provider `provider` is being removed: its machines go first.
    pub fn provider_off(&self, provider: &str) {
        let ids: Vec<String> = self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.shown.provider == provider && r.active())
            .map(|r| r.shown.id.clone())
            .collect();
        for id in ids {
            self.retire(&id, "its provider was removed".into());
        }
    }

    /// Removes machine `id`: it leaves the candidates, its device is
    /// revoked, its worker retires, and the provider destroys it.
    pub fn remove(&self, id: &str, reason: String) {
        let Some(r) = self.get(id) else { return };
        if matches!(r.shown.state.as_str(), "removing" | "removed" | "failed") {
            return;
        }
        self.update(id, |r| {
            r.set_state("removing");
            r.shown.reason = Some(reason.clone());
        });
        let Some(me) = self.me.lock().unwrap().upgrade() else {
            return;
        };
        let id = id.to_string();
        tokio::spawn(async move { me.removing(id).await });
    }

    async fn removing(self: Arc<Self>, id: String) {
        let Some(r) = self.get(&id) else { return };
        if let Some(device) = &r.device {
            let _ = self.mobile.revoke(device);
        }
        if let Some(conn) = r.worker.as_ref().and_then(|w| self.workers.conn(w)) {
            let _ = conn
                .request(
                    m::WORKER_RETIRE,
                    serde_json::json!({}),
                    Duration::from_secs(10),
                )
                .await;
        }
        if let Some(provider_id) = r.provider_id.clone() {
            let Ok(provider) = self.provider(&r.shown.provider) else {
                return;
            };
            let started = now_ms();
            let mut wait = destroy_backoff();
            let mut tries = 0;
            loop {
                let gone = match provider.destroy(&provider_id).await {
                    Ok(()) => provider
                        .get(&provider_id)
                        .await
                        .map(|i| i.state == MachineState::Gone),
                    Err(e) => Err(e),
                };
                match gone {
                    Ok(true) => break,
                    Ok(false) => {}
                    Err(e) => {
                        tries += 1;
                        if tries >= 3 {
                            let message = destroy_error(&e);
                            self.update(&id, |r| {
                                r.shown.error = Some(message.clone());
                                r.shown.error_since.get_or_insert(started);
                            });
                        }
                    }
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(300));
            }
        }
        let now = now_ms();
        moonlet_cloud::usage::add(&mut self.usage.lock().unwrap(), r.created_at, now);
        self.update(&id, |r| {
            r.set_state("removed");
            r.removed_at = Some(now);
            r.shown.error = None;
            r.shown.error_since = None;
        });
        // A provider being removed goes once its last machine has.
        if !self.has_machines(&r.shown.provider) {
            self.settings.drop_pending(&r.shown.provider);
        }
    }

    /// The sweep: machines labelled with this central host that moonlet has
    /// lost track of, or is removing, are destroyed; records of machines
    /// the provider no longer has are dropped.
    pub async fn sweep(&self) {
        let f = self.settings.file();
        let mut providers: Vec<String> = f.providers.keys().cloned().collect();
        if self.fake.is_some() && !providers.contains(&"fake".to_string()) {
            providers.push("fake".into());
        }
        for id in providers {
            let Ok(provider) = self.provider(&id) else {
                continue;
            };
            let host = BTreeMap::from([("moonlet-host".to_string(), f.host_id.clone())]);
            let Ok(listed) = provider.list(&host).await else {
                continue;
            };
            let records: Vec<(String, moonlet_cloud::sweep::Recorded)> = self
                .records
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.shown.provider == id && r.shown.state != "failed")
                .map(|r| {
                    let state = match r.shown.state.as_str() {
                        "creating" => moonlet_cloud::sweep::Recorded::Creating {
                            call_started: r.call_started,
                        },
                        "removing" | "removed" => moonlet_cloud::sweep::Recorded::Removing,
                        _ => moonlet_cloud::sweep::Recorded::Kept,
                    };
                    (r.shown.id.clone(), state)
                })
                .collect();
            let found: Vec<(String, Option<String>)> = listed
                .iter()
                .map(|l| (l.id.clone(), l.labels.get("moonlet-machine").cloned()))
                .collect();
            let plan = moonlet_cloud::sweep::sweep(&records, &found, now_ms());
            for pid in plan.destroy {
                let _ = provider.destroy(&pid).await;
            }
            if !plan.drop.is_empty() {
                self.records.lock().unwrap().retain(|r| {
                    !(plan.drop.contains(&r.shown.id)
                        && r.shown.provider == id
                        && r.shown.state != "removed")
                });
                self.changed();
            }
        }
    }
}

/// When ready machine `r` is removed for its idleness: after `idle`
/// minutes from ready or from its last command's end. None while it runs a
/// command, or before it ran one a command waits on.
fn idle_until(r: &Record, idle: u32) -> Option<u64> {
    if r.shown.state != "ready" || r.shown.running > 0 || (r.waiting > 0 && r.last_end.is_none()) {
        return None;
    }
    let since = r
        .last_end
        .unwrap_or(0)
        .max(r.ready_at.unwrap_or(r.shown.since));
    Some(since + u64::from(idle) * minute())
}

fn step(id: &str, label: String) -> CloudStep {
    CloudStep {
        step: id.into(),
        label,
        state: "pending".into(),
        took_ms: None,
        error: None,
    }
}

/// `12.5` or `40`, as a usage line reads.
fn hours_text(h: f64) -> String {
    let r = (h * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{r:.0}")
    } else {
        format!("{r:.1}")
    }
}

/// "Hetzner answered 503 Service Unavailable", as a removal error reads.
fn destroy_error(e: &CloudError) -> String {
    e.to_string()
}

/// Whether `program` is on this daemon's PATH.
fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(program).is_file()))
}

/// Whether `tailscale status --json` lists a peer named `name`.
fn tailnet_has(status: &serde_json::Value, name: &str) -> bool {
    status["Peer"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(_, p)| {
            p["HostName"]
                .as_str()
                .is_some_and(|h| h.eq_ignore_ascii_case(name))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_has_joined_once_tailscale_lists_its_peer() {
        // The shape of `tailscale status --json`, cut down.
        let status = serde_json::json!({
            "Self": { "HostName": "studio-mini", "DNSName": "studio-mini.tail1234.ts.net." },
            "Peer": {
                "nodekey:abc": { "HostName": "moonlet-shop-7k2q", "DNSName": "moonlet-shop-7k2q.tail1234.ts.net.", "Online": true },
                "nodekey:def": { "HostName": "Alex's MacBook Pro", "Online": false }
            }
        });
        assert!(tailnet_has(&status, "moonlet-shop-7k2q"));
        assert!(!tailnet_has(&status, "moonlet-shop-m3x9"));
        assert!(!tailnet_has(
            &serde_json::json!({ "Self": {} }),
            "moonlet-shop-7k2q"
        ));
    }
}
