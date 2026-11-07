//! Routed commands (X62). On the central host, `exec.run` picks the free
//! worker with the lowest load, fences its routing copy to the session,
//! starts the command there and forwards its output to `moonlet exec`; with
//! no free worker, or when the worker goes away mid-run, the command runs
//! here. On a worker, `exec.start` runs a command in its routing copy and
//! sends the run's changes back with `exec.done`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use moonlet_core::heavy::{self, Candidate, Kind};
use moonlet_core::terminal::ClientId;
use moonlet_proto::methods::{
    self as m, ExecBrought, ExecDone, ExecExited, ExecPrepared, ExecRunStarted, ExecStart, Job,
    JobEvent, JobPhase, JobState, JobWorker,
};
use moonlet_proto::types::HeavyOs;
use moonlet_proto::{Frame, Message, RpcError};
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use tokio::io::AsyncReadExt;
use tokio::sync::{Notify, oneshot};

use crate::jobs::Jobs;
use crate::peer::Peer;
use crate::server::Conn;
use crate::sync::LiveCopies;
use crate::workers::Workers;

/// How long a cancelled command has between SIGTERM and SIGKILL.
const GRACE: Duration = Duration::from_secs(5);
/// How long output may still come once the command has exited: a process
/// it left in the background that keeps the pipes open is then stopped.
const DRAIN: Duration = Duration::from_secs(1);
/// Output queued for a client that is not reading, before the command is
/// held back until it reads.
const MAX_QUEUED: usize = 4 * 1024 * 1024;
/// How long a worker has to make its routing copy.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a member's session waits for its central host's cloud machine
/// (X89).
const CENTRAL_CLOUD_WAIT: Duration = Duration::from_secs(20 * 60);
/// How long the host that routed a run has to take its changes.
const DONE_TIMEOUT: Duration = Duration::from_secs(600);

/// What to run, already checked.
pub struct Command {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// A routed command one of this central host's workers runs.
struct Remote {
    /// The `moonlet exec` connection the output goes to.
    client: Arc<Conn>,
    /// Its job.
    job: String,
    /// The routing copy the run was fenced on.
    copy: String,
    /// The `outputs` checked when the run started: the session's config
    /// may say otherwise by the time the run ends.
    outputs: Vec<String>,
    /// The worker's connection, or this member's link to its central host
    /// (X89).
    conn: Peer,
    done: Option<oneshot::Sender<(i32, ExecBrought, u64)>>,
}

/// A run of this central host's, for stopping it from its job.
struct Going {
    job: String,
    session: String,
    client: Arc<Conn>,
    /// Stopped from the Jobs panel.
    stopped: bool,
}

pub struct Runs {
    next: AtomicU32,
    /// The central host's cloud machines (X63).
    machines: Mutex<std::sync::Weak<crate::machines::Machines>>,
    /// Cancel signals of this machine's own runs going on here, by run.
    running: Mutex<HashMap<u32, Arc<Notify>>>,
    /// Cancel signals of runs this machine does for other hosts, by the
    /// connection they came on and that host's run id: a namespace of
    /// each host's own (X89).
    routed: Mutex<HashMap<(ClientId, u32), Arc<Notify>>>,
    /// Which connection started each of this central host's runs, so only
    /// it cancels one.
    owners: Mutex<HashMap<u32, ClientId>>,
    /// Runs this central host routed to a worker.
    remote: Mutex<HashMap<u32, Remote>>,
    /// The worker each run was given, and its session, from the moment it
    /// is picked: a slot is taken at once, and a worker runs one command
    /// of a session at a time, as it has one routing copy of it.
    claims: Mutex<HashMap<u32, (String, String)>>,
    /// Runs whose member, reached through the central host, went away, as
    /// the central host said (X89).
    lost: Mutex<HashSet<u32>>,
    /// Runs stopped before their command started, with the status they end
    /// with.
    stops: Mutex<HashMap<u32, i32>>,
    /// Runs waiting for a cloud machine that the Jobs panel asked to run on
    /// the central host now (X63).
    here_now: Mutex<HashSet<u32>>,
    /// Routing copies a run is using on this worker.
    copies_in_use: Mutex<HashSet<String>>,
    /// What this host runs for other hosts, by connection and run (X89).
    serving: Mutex<HashMap<(ClientId, u32), m::Serving>>,
    /// This central host's runs going on, wherever they run, by run.
    going: Mutex<HashMap<u32, Going>>,
    /// Why a worker was last skipped for a project, by worker and project,
    /// and when.
    skips: Mutex<HashMap<(String, String), (String, String, u64)>>,
    /// The daemon's own environment, which commands start from.
    base_env: BTreeMap<String, String>,
    jobs: Arc<Jobs>,
}

/// Everything a run on the central host needs to know.
pub struct Plan {
    pub session: String,
    /// The session's worktree.
    pub worktree: String,
    pub argv: Vec<String>,
    /// The working directory, relative to the session's worktree.
    pub cwd_rel: String,
    /// The approved variables of `moonlet exec`'s environment.
    pub env: BTreeMap<String, String>,
    pub local: Command,
    pub os: HeavyOs,
    /// Ignored paths brought back after a run.
    pub outputs: Vec<String>,
    /// This machine's name.
    pub host: String,
    pub slots: u32,
    pub tool_use_id: Option<String>,
    /// The project's name, for the Workers page's skip reasons.
    pub project: String,
    /// The project's id.
    pub project_id: String,
    pub session_name: String,
    /// The session asked for the cloud (X63).
    pub cloud: bool,
    /// The project's setup command, from its main checkout, for a routing
    /// copy that has none of its own (X89).
    pub setup: Option<String>,
    /// The project's identity, for the central host's cloud machines of
    /// it (X89).
    pub identity: Option<moonlet_proto::types::ProjectIdentity>,
}

/// How waiting for a cloud machine ended.
enum CloudWait {
    Ready,
    Stopped(i32),
    /// Run on the central host, saying this first.
    Here(String),
}

/// `m:ss`.
fn clock(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

enum Fail {
    /// The worker would not run it, with its code and why: the next one is
    /// tried.
    Refused(String, String),
    /// The worker went away mid-run: why.
    Gone(&'static str),
    /// Stopped before the command started, ending with this status.
    Stopped(i32),
}

impl Runs {
    pub fn new(base_env: BTreeMap<String, String>, jobs: Arc<Jobs>) -> Arc<Self> {
        Arc::new(Self {
            next: AtomicU32::new(0),
            machines: Mutex::new(std::sync::Weak::new()),
            running: Mutex::default(),
            routed: Mutex::default(),
            owners: Mutex::default(),
            remote: Mutex::default(),
            claims: Mutex::default(),
            stops: Mutex::default(),
            lost: Mutex::default(),
            here_now: Mutex::default(),
            copies_in_use: Mutex::default(),
            serving: Mutex::default(),
            going: Mutex::default(),
            skips: Mutex::default(),
            base_env,
            jobs,
        })
    }

    /// The cloud machines, which routing starts and sends commands to (X63).
    pub fn set_machines(&self, machines: std::sync::Weak<crate::machines::Machines>) {
        *self.machines.lock().unwrap() = machines;
    }

    fn machines(&self) -> Option<Arc<crate::machines::Machines>> {
        self.machines.lock().unwrap().upgrade()
    }

    /// `exec.run` on the central host: starts `plan` for `client`, as a
    /// job of its session.
    pub fn start(
        self: &Arc<Self>,
        client: Arc<Conn>,
        plan: Plan,
        workers: Arc<Workers>,
        sync: Arc<LiveCopies>,
    ) -> ExecRunStarted {
        let run = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.owners.lock().unwrap().insert(run, client.id);
        let job = self.jobs.start(Job {
            id: uuid::Uuid::new_v4().to_string(),
            session: plan.session.clone(),
            command: plan
                .argv
                .iter()
                .map(|w| crate::heavy::quote(w))
                .collect::<Vec<_>>()
                .join(" "),
            tool_use_id: plan.tool_use_id.clone(),
            state: JobState::Running {
                worker: plan.host.clone(),
            },
            started_at: 0,
            ended_at: None,
            phases: Vec::new(),
            timeline: Vec::new(),
            worker: None,
            brought: Vec::new(),
            outputs: Vec::new(),
            leftovers: Vec::new(),
            leftovers_folder: None,
            env: plan.env.keys().cloned().collect(),
            summary: None,
            output_bytes: 0,
        });
        self.going.lock().unwrap().insert(
            run,
            Going {
                job: job.clone(),
                session: plan.session.clone(),
                client: client.clone(),
                stopped: false,
            },
        );
        let started = ExecRunStarted {
            run,
            host: plan.host.clone(),
        };
        let runs = self.clone();
        tokio::spawn(async move {
            let status = runs.route(run, &job, &client, &plan, &workers, &sync).await;
            runs.owners.lock().unwrap().remove(&run);
            runs.stops.lock().unwrap().remove(&run);
            let stopped = runs
                .going
                .lock()
                .unwrap()
                .remove(&run)
                .is_some_and(|g| g.stopped);
            runs.jobs.update(&job, |j| {
                event(j, format!("Exited {status} · status went to Claude"), None);
                j.phases.push(JobPhase {
                    name: "Exit status to Claude".into(),
                    took_ms: Some(0),
                });
            });
            let state = if stopped {
                JobState::Stopped { exit: status }
            } else {
                JobState::Done { exit: status }
            };
            runs.jobs.finish(&job, state, Some(&plan.worktree));
            let exited = ExecExited {
                run,
                status,
                log: runs.jobs.log(&job).map(|p| p.display().to_string()),
            };
            client
                .tx
                .send(Frame::Json(Message::event(m::EV_EXEC_EXITED, exited)));
        });
        started
    }

    /// Output of run `run` of job `job`: to `moonlet exec` and the job.
    fn emit(&self, run: u32, job: &str, client: &Conn, stream: u8, data: Vec<u8>) -> bool {
        self.jobs.output(job, stream, &data);
        client.tx.send(Frame::RunOutput { run, stream, data })
    }

    /// Runs `plan` on the freest worker, or here, and gives its status.
    async fn route(
        self: &Arc<Self>,
        run: u32,
        job: &str,
        client: &Arc<Conn>,
        plan: &Plan,
        workers: &Workers,
        sync: &Arc<LiveCopies>,
    ) -> i32 {
        let say = |text: String| {
            self.emit(
                run,
                job,
                client,
                2,
                format!("moonlet: {text}\n").into_bytes(),
            )
        };
        let mut skipped = HashSet::new();
        let mut rerun = false;
        // A member's own central host, and the other members reached
        // through it, when they take the member's heavy commands (X89).
        let mut linked = self.link_candidates(sync, plan).await;
        // A session that asked for the cloud waits for its machine (X63).
        let mut wait_note = None;
        // A member's session takes its central host's ready machine (X89).
        let cloud_ready = linked.iter().any(|(c, _)| c.kind == Kind::Cloud);
        // A member's session that asked for the cloud waits for its central
        // host's machine of the project (X89).
        if plan.cloud
            && !cloud_ready
            && let (Some(central @ Peer::Link(_)), Some(identity)) = (sync.central_peer(), plan.identity.clone())
        {
            match self.wait_for_central_cloud(run, job, client, plan, sync, &central, identity).await {
                CloudWait::Ready => linked = self.link_candidates(sync, plan).await,
                CloudWait::Stopped(status) => return status,
                CloudWait::Here(note) => wait_note = Some(note),
            }
        } else if plan.cloud
            && !cloud_ready
            && let Some(m) = self.machines()
            && m.workers_for(&plan.project_id).is_empty()
        {
            match self.wait_for_cloud(run, job, client, plan, &m).await {
                CloudWait::Ready => {}
                CloudWait::Stopped(status) => return status,
                CloudWait::Here(note) => wait_note = Some(note),
            }
        }
        if let Some(note) = wait_note {
            say(note);
        } else {
            loop {
                if let Some(status) = self.stopped(run, client) {
                    return status;
                }
                let chosen = {
                    // Picked and claimed at once, so two runs never both take
                    // a worker's last slot, nor its copy of the session.
                    let mut claims = self.claims.lock().unwrap();
                    let candidates = self.candidates(plan, workers, &skipped, &claims, &linked);
                    let chosen = heavy::pick(&candidates, plan.os, plan.cloud).cloned();
                    // None fits, the central host included: it is busy too.
                    let all_busy = chosen.is_none();
                    let Some(chosen) = chosen.filter(|c| c.kind != Kind::Central) else {
                        // It runs here. With every machine busy, the central
                        // host too, a project that allows it gets a cloud
                        // machine for the next command (X63).
                        if all_busy && let Some(m) = self.machines() {
                            m.overflow(&plan.project_id);
                        }
                        // A member asks its central host, whose machines
                        // they are (X89).
                        if all_busy
                            && let (Some(peer @ Peer::Link(_)), Some(identity)) = (sync.central_peer(), plan.identity.clone())
                        {
                            tokio::spawn(async move {
                                let ask = m::CloudOverflow { identity, asked: false };
                                let _ = peer
                                    .request(m::CLOUD_OVERFLOW, serde_json::to_value(ask).unwrap(), Duration::from_secs(10))
                                    .await;
                            });
                        }
                        break;
                    };
                    claims.insert(run, (chosen.id.clone(), plan.session.clone()));
                    chosen
                };
                let name = workers
                    .list()
                    .into_iter()
                    .find(|w| w.worker.id == chosen.id)
                    .map(|w| w.worker.name)
                    .or_else(|| linked.iter().find(|(c, _)| c.id == chosen.id).map(|(_, n)| n.clone()))
                    .unwrap_or_else(|| chosen.id.clone());
                // This host's own machine; a member's session reaches its
                // central host's through it (X89), which keeps their count.
                let machines = (chosen.kind == Kind::Cloud)
                    .then(|| self.machines())
                    .flatten()
                    .filter(|m| m.cloud_workers().contains(&chosen.id));
                if let Some(m) = &machines {
                    m.run_started(&chosen.id);
                    // Its first command of the session copies the session there.
                    if !m.has_copy(&chosen.id, &plan.session) {
                        say(format!("Copying {} to {name}…", plan.session_name));
                    }
                }
                let ran = self
                    .remote(run, job, client, plan, &chosen, &name, workers, sync)
                    .await;
                if let Some(m) = &machines {
                    m.run_ended(&chosen.id);
                    if ran.is_ok() {
                        m.copied(&chosen.id, &plan.session);
                    }
                }
                self.claims.lock().unwrap().remove(&run);
                match ran {
                    Ok((status, brought, back_ms)) => {
                        self.skips
                            .lock()
                            .unwrap()
                            .remove(&(chosen.id.clone(), plan.project.clone()));
                        for note in &brought.notes {
                            say(note.clone());
                        }
                        if !brought.leftovers.is_empty() {
                            say(format!(
                                "{} changed on {} during the run; the run's version is in {}",
                                brought.leftovers.join(", "),
                                plan.host,
                                tilde(brought.folder.as_deref().unwrap_or_default())
                            ));
                        }
                        self.jobs.update(job, |j| {
                            j.phases.push(JobPhase {
                                name: "Brought back".into(),
                                took_ms: Some(back_ms),
                            });
                            j.brought = brought.files.clone();
                            j.outputs = brought.outputs.clone();
                            j.leftovers = brought.leftovers.clone();
                            j.leftovers_folder = brought.folder.clone();
                        });
                        return status;
                    }
                    Err(Fail::Refused(why, detail)) => {
                        tracing::debug!(worker = %name, "a worker refused a routed command: {why}: {detail}");
                        self.skips.lock().unwrap().insert(
                            (chosen.id.clone(), plan.project.clone()),
                            (why, detail, moonlet_core::paths::now_ms()),
                        );
                        skipped.insert(chosen.id);
                    }
                    Err(Fail::Gone(why)) => {
                        // A stopped run is not run again.
                        let stopped = self.stops.lock().unwrap().get(&run).copied();
                        if let Some(status) = stopped {
                            say(format!("{name} went away."));
                            self.jobs.update(job, |j| {
                                event(j, format!("{name} went away"), Some(why.to_string()))
                            });
                            return status;
                        }
                        say(format!("{name} went away. Running again on {}.", plan.host));
                        self.jobs.update(job, |j| {
                            event(
                                j,
                                format!("{name} went away"),
                                Some(format!("{why} That run's changes were dropped.")),
                            );
                        });
                        self.jobs
                            .mark(job, &format!("──── run 2 · {} ────\n", plan.host));
                        rerun = true;
                        break;
                    }
                    Err(Fail::Stopped(status)) => return status,
                }
            }
        }
        if let Some(status) = self.stopped(run, client) {
            return status;
        }
        // Here, on the central host.
        let used = self.running.lock().unwrap().len() as u32;
        self.jobs.update(job, |j| {
            j.state = JobState::Running {
                worker: plan.host.clone(),
            };
            let text = if rerun {
                format!("Ran again on {}, from the same files", plan.host)
            } else {
                format!("Started on {}", plan.host)
            };
            event(j, text, None);
            j.worker = Some(JobWorker {
                name: plan.host.clone(),
                kind: "central".into(),
                load: crate::link::load().unwrap_or(0.0),
                cores: cores(),
                slot: used + 1,
                slots: plan.slots,
                rtt_ms: None,
                copy: None,
            });
        });
        say(format!("running on {}", plan.host));
        let began = std::time::Instant::now();
        let status = self.here(run, job, client, &plan.local).await;
        self.jobs.update(job, |j| {
            j.phases.push(JobPhase {
                name: format!("Ran on {}", plan.host),
                took_ms: Some(began.elapsed().as_millis() as u64),
            });
        });
        status
    }

    /// Waits for the project's cloud machine, starting one if none is on
    /// its way, and says so every 10 s.
    async fn wait_for_cloud(
        &self,
        run: u32,
        job: &str,
        client: &Arc<Conn>,
        plan: &Plan,
        m: &Arc<crate::machines::Machines>,
    ) -> CloudWait {
        let say = |text: String| {
            self.emit(
                run,
                job,
                client,
                2,
                format!("moonlet: {text}\n").into_bytes(),
            )
        };
        let no_machine = |why: String| {
            CloudWait::Here(format!(
                "no cloud machine ({why}). Running on {}.",
                plan.host
            ))
        };
        let (id, name) = match m.for_session(&plan.project_id, &plan.session) {
            Ok(found) => found,
            Err(e) => return no_machine(e.message),
        };
        self.jobs.update(job, |j| {
            j.state = JobState::Waiting {
                r#for: name.clone(),
            }
        });
        m.wait_begin(&id);
        let started = std::time::Instant::now();
        let mut said = None;
        let outcome = loop {
            if let Some(status) = self.stopped(run, client) {
                break CloudWait::Stopped(status);
            }
            if self.here_now.lock().unwrap().remove(&run) {
                break CloudWait::Here(format!(
                    "running on {} instead, as asked from the Jobs panel",
                    plan.host
                ));
            }
            let waited = started.elapsed().as_secs();
            if said.is_none_or(|s: u64| waited >= s + 10) {
                said = Some(waited - waited % 10);
                say(format!("waiting for {name} to start ({})", clock(waited)));
            }
            match m.state_of(&id) {
                Some((state, _)) if state == "ready" => {
                    // Run-now and this step take the same lock: asked
                    // first, it runs here; after, the job no longer waits.
                    let mut asked = self.here_now.lock().unwrap();
                    if asked.remove(&run) {
                        break CloudWait::Here(format!(
                            "running on {} instead, as asked from the Jobs panel",
                            plan.host
                        ));
                    }
                    self.jobs.update(job, |j| {
                        j.state = JobState::Running {
                            worker: name.clone(),
                        }
                    });
                    break CloudWait::Ready;
                }
                Some((state, reason))
                    if matches!(state.as_str(), "removing" | "removed" | "failed") =>
                {
                    break no_machine(reason.unwrap_or_else(|| format!("{name} is gone")));
                }
                None => break no_machine(format!("{name} is gone")),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        m.wait_end(&id);
        outcome
    }

    /// Waits for the central host's cloud machine of the session's project,
    /// which it starts if none is on its way, saying so every 10 s (X89),
    /// as [`Runs::wait_for_cloud`] does for this host's own machines.
    #[allow(clippy::too_many_arguments)]
    async fn wait_for_central_cloud(
        &self,
        run: u32,
        job: &str,
        client: &Arc<Conn>,
        plan: &Plan,
        sync: &LiveCopies,
        central: &Peer,
        identity: moonlet_proto::types::ProjectIdentity,
    ) -> CloudWait {
        let say = |text: String| {
            self.emit(run, job, client, 2, format!("moonlet: {text}\n").into_bytes())
        };
        let ask = m::CloudOverflow { identity, asked: true };
        let name = match central
            .request(m::CLOUD_OVERFLOW, serde_json::to_value(ask).unwrap(), Duration::from_secs(30))
            .await
        {
            Ok(v) => v["name"].as_str().unwrap_or("a cloud machine").to_string(),
            Err(e) => return CloudWait::Here(format!("no cloud machine ({}). Running on {}.", e.message, plan.host)),
        };
        self.jobs.update(job, |j| {
            j.state = JobState::Waiting { r#for: name.clone() }
        });
        let started = std::time::Instant::now();
        let mut said = None;
        let mut checked = std::time::Instant::now();
        loop {
            if let Some(status) = self.stopped(run, client) {
                return CloudWait::Stopped(status);
            }
            if self.here_now.lock().unwrap().remove(&run) {
                return CloudWait::Here(format!(
                    "running on {} instead, as asked from the Jobs panel",
                    plan.host
                ));
            }
            let waited = started.elapsed().as_secs();
            if said.is_none_or(|s: u64| waited >= s + 10) {
                said = Some(waited - waited % 10);
                say(format!("waiting for {name} to start ({})", clock(waited)));
            }
            if checked.elapsed() >= Duration::from_secs(1) {
                checked = std::time::Instant::now();
                if self.link_candidates(sync, plan).await.iter().any(|(c, _)| c.kind == Kind::Cloud) {
                    self.jobs.update(job, |j| {
                        j.state = JobState::Running { worker: name.clone() }
                    });
                    return CloudWait::Ready;
                }
            }
            if started.elapsed() > CENTRAL_CLOUD_WAIT {
                return CloudWait::Here(format!("no cloud machine ({name} did not start). Running on {}.", plan.host));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// `job.run_here`: job `job`, waiting for a cloud machine, runs on the
    /// central host now (X63).
    pub fn run_here(&self, job: &str) -> Result<bool, RpcError> {
        // Held while the job is checked: see `wait_for_cloud`.
        let mut asked = self.here_now.lock().unwrap();
        let waiting = self
            .jobs
            .get(job)
            .is_some_and(|j| matches!(j.state, JobState::Waiting { .. }));
        let run = self
            .going
            .lock()
            .unwrap()
            .iter()
            .find(|(_, g)| g.job == job)
            .map(|(run, _)| *run);
        match (waiting, run) {
            (true, Some(run)) => {
                asked.insert(run);
                Ok(true)
            }
            _ if self.jobs.get(job).is_none() => Err(RpcError::new("not_found", "no such job")),
            _ => Err(RpcError::new(
                "not_waiting",
                "the job is not waiting for a machine",
            )),
        }
    }

    /// This member's central host, and the other members it reaches
    /// through it (`worker.peers`), as candidates with their names (X89):
    /// those that take other hosts' heavy commands. None on a central host,
    /// and from one before X89.
    async fn link_candidates(&self, sync: &LiveCopies, plan: &Plan) -> Vec<(Candidate, String)> {
        let Some(peer @ Peer::Link(_)) = sync.central_peer() else {
            return Vec::new();
        };
        let ask = |method: &'static str, params: serde_json::Value| {
            let peer = peer.clone();
            async move {
                peer.request(method, params, Duration::from_secs(2))
                    .await
                    .ok()
            }
        };
        // With the project's identity: its ready cloud machines too.
        let peers = serde_json::to_value(m::WorkerPeers { identity: plan.identity.clone() }).unwrap();
        let (central, others) = tokio::join!(
            ask(m::WORKER_STATUS, serde_json::json!({})),
            ask(m::WORKER_PEERS, peers)
        );
        let central = central.and_then(|v| serde_json::from_value::<m::WorkerStatus>(v).ok());
        let others = others
            .and_then(|v| serde_json::from_value::<Vec<m::WorkerStatus>>(v).ok())
            .unwrap_or_default();
        central
            .into_iter()
            .chain(others)
            .filter(|s| s.heavy)
            .map(|s| {
                if s.cloud {
                    sync.offered(&s.id);
                }
                let c = Candidate {
                    id: s.id,
                    kind: if s.cloud { Kind::Cloud } else { Kind::Linked },
                    os: s.os,
                    cores: s.cores,
                    load: s.load,
                    slots: s.slots,
                    used: s.used,
                    rtt_ms: s.rtt_ms,
                };
                (c, s.name)
            })
            .collect()
    }

    /// `worker.status` on a central host, for a member (X89): whether it
    /// takes other hosts' heavy commands, and its load and slots now.
    pub fn status_for_members(&self, me: &m::LinkWorker) -> m::WorkerStatus {
        m::WorkerStatus {
            id: me.id.clone(),
            name: me.name.clone(),
            heavy: me.enabled,
            os: crate::link::os().into(),
            cores: cores(),
            load: crate::link::load().unwrap_or(0.0),
            slots: me.slots,
            used: self.used_here(),
            rtt_ms: None,
            cloud: false,
        }
    }

    /// Routed commands this host runs now, for itself and others (X89).
    pub fn used_here(&self) -> u32 {
        (self.routed.lock().unwrap().len() + self.running.lock().unwrap().len()) as u32
    }

    /// The machines that might run a command of `plan`: linked workers
    /// that take heavy commands, this member's central host when it does
    /// (`central`, X89), and this host, the session's.
    fn candidates(
        &self,
        plan: &Plan,
        workers: &Workers,
        skipped: &HashSet<String>,
        claims: &HashMap<u32, (String, String)>,
        linked: &[(Candidate, String)],
    ) -> Vec<Candidate> {
        // Cloud machines run only their own project's commands (X63).
        let (cloud, mine) = match self.machines() {
            Some(m) => (m.cloud_workers(), m.workers_for(&plan.project_id)),
            None => (Vec::new(), Vec::new()),
        };
        let mut out: Vec<Candidate> = workers
            .list()
            .into_iter()
            .filter(|w| w.worker.heavy && !skipped.contains(&w.worker.id))
            .filter(|w| !cloud.contains(&w.worker.id) || mine.contains(&w.worker.id))
            .filter(|w| {
                !claims
                    .values()
                    .any(|(id, s)| *id == w.worker.id && *s == plan.session)
            })
            .map(|w| Candidate {
                used: claims.values().filter(|(id, _)| *id == w.worker.id).count() as u32,
                kind: if mine.contains(&w.worker.id) {
                    Kind::Cloud
                } else {
                    Kind::Linked
                },
                id: w.worker.id,
                os: w.worker.os,
                cores: w.worker.cores,
                load: w.load.unwrap_or(0.0),
                slots: w.worker.slots,
                rtt_ms: w.rtt_ms,
            })
            .collect();
        for (c, _) in linked {
            if skipped.contains(&c.id) || claims.values().any(|(id, s)| *id == c.id && *s == plan.session) {
                continue;
            }
            let mut c = c.clone();
            c.used += claims.values().filter(|(id, _)| *id == c.id).count() as u32;
            out.push(c);
        }
        out.push(Candidate {
            id: plan.host.clone(),
            kind: Kind::Central,
            os: crate::link::os().into(),
            cores: cores(),
            load: crate::link::load().unwrap_or(0.0),
            slots: plan.slots,
            used: self.running.lock().unwrap().len() as u32,
            rtt_ms: None,
        });
        out
    }

    /// Runs `plan` on worker `chosen`: prepares and fences its routing
    /// copy, starts the command and waits for `exec.done`. Gives the
    /// status, what came back and how long bringing it back took.
    #[allow(clippy::too_many_arguments)]
    async fn remote(
        self: &Arc<Self>,
        run: u32,
        job: &str,
        client: &Arc<Conn>,
        plan: &Plan,
        chosen: &Candidate,
        name: &str,
        workers: &Workers,
        sync: &Arc<LiveCopies>,
    ) -> Result<(i32, ExecBrought, u64), Fail> {
        let worker = chosen.id.as_str();
        let conn = sync
            .peer_for(worker)
            .ok_or_else(|| Fail::Refused("gone".into(), "it went away".into()))?;
        let prepare = m::ExecPrepare {
            session: plan.session.clone(),
            setup: plan.setup.clone(),
            identity: plan.identity.clone(),
        };
        sync.expect_open(worker, &plan.session);
        let prepared: ExecPrepared = self
            .unless_stopped(
                run,
                client,
                conn.request(
                    m::EXEC_PREPARE,
                    serde_json::to_value(prepare).unwrap(),
                    PREPARE_TIMEOUT,
                ),
            )
            .await?
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .ok_or_else(|| Fail::Refused("failed".into(), "it could not make its copy".into()))?;
        if prepared.state != "ready" {
            let why = prepared
                .reason
                .clone()
                .unwrap_or_else(|| match prepared.state.as_str() {
                    "setup_pending" => "waiting for setup approval".into(),
                    "making" => "making its copy".into(),
                    other => other.into(),
                });
            return Err(Fail::Refused(prepared.state, why));
        }
        let fencing = std::time::Instant::now();
        let (tree, head, session_path) = self
            .unless_stopped(
                run,
                client,
                sync.fence(&prepared.copy, worker, &plan.session),
            )
            .await?
            .map_err(|e| Fail::Refused(e.code, e.message))?;
        let fenced_ms = fencing.elapsed().as_millis() as u64;
        if let Some(status) = self.stopped(run, client) {
            return Err(Fail::Stopped(status));
        }
        let (tx, mut rx) = oneshot::channel();
        self.remote.lock().unwrap().insert(
            run,
            Remote {
                client: client.clone(),
                job: job.to_string(),
                copy: prepared.copy.clone(),
                outputs: plan.outputs.clone(),
                conn: conn.clone(),
                done: Some(tx),
            },
        );
        let start = ExecStart {
            run,
            copy: prepared.copy,
            argv: plan.argv.clone(),
            cwd: plan.cwd_rel.clone(),
            env: plan.env.clone(),
            tree,
            head,
            session_path,
            outputs: plan.outputs.clone(),
            session_name: Some(plan.session_name.clone()),
        };
        let started = conn
            .request(
                m::EXEC_START,
                serde_json::to_value(start).unwrap(),
                Duration::from_secs(30),
            )
            .await;
        if let Err(e) = started {
            self.remote.lock().unwrap().remove(&run);
            return Err(Fail::Refused(e.code, e.message));
        }
        let kind = if chosen.os == "macos" { "mac" } else { "host" };
        self.jobs.update(job, |j| {
            j.state = JobState::Running {
                worker: name.to_string(),
            };
            event(j, format!("Started on {name}"), None);
            j.phases.push(JobPhase {
                name: "Copy matched the session".into(),
                took_ms: Some(fenced_ms),
            });
            j.worker = Some(JobWorker {
                name: name.to_string(),
                kind: kind.into(),
                load: chosen.load,
                cores: chosen.cores,
                slot: chosen.used + 1,
                slots: chosen.slots,
                rtt_ms: chosen.rtt_ms,
                copy: prepared.path.clone(),
            });
        });
        self.emit(
            run,
            job,
            client,
            2,
            format!("moonlet: running on {name}\n").into_bytes(),
        );
        // Stopped while it was being started: the worker stops it now.
        if self.stops.lock().unwrap().contains_key(&run) {
            self.cancel_remote(run).await;
        }
        let began = std::time::Instant::now();
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut cancelled = false;
        loop {
            tokio::select! {
                done = &mut rx => {
                    let (status, brought, back_ms) = done.map_err(|_| Fail::Gone("Its link closed."))?;
                    let ran = (began.elapsed().as_millis() as u64).saturating_sub(back_ms);
                    self.jobs.update(job, |j| {
                        j.phases.push(JobPhase { name: format!("Ran on {name}"), took_ms: Some(ran) });
                    });
                    return Ok((status, brought, back_ms));
                }
                _ = tick.tick() => {
                    let gone = conn.is_gone()
                        || match &conn {
                            Peer::Conn(c) => workers.conn(worker).is_none_or(|w| w.id != c.id),
                            Peer::Link(_) => false,
                            // The central host says the member running it
                            // went away (X89).
                            Peer::Relay(..) => self.lost.lock().unwrap().remove(&run),
                        };
                    if gone {
                        self.remote.lock().unwrap().remove(&run);
                        let why = if workers.missed_pings(conn.id()) {
                            "It missed 3 pings."
                        } else {
                            "Its link closed."
                        };
                        return Err(Fail::Gone(why));
                    }
                    if client.is_gone() && !cancelled {
                        cancelled = true;
                        self.cancel_remote(run).await;
                    }
                }
            }
        }
    }

    async fn cancel_remote(&self, run: u32) {
        let conn = self
            .remote
            .lock()
            .unwrap()
            .get(&run)
            .map(|r| r.conn.clone());
        if let Some(conn) = conn {
            let _ = conn
                .request(
                    m::EXEC_CANCEL,
                    serde_json::json!({ "run": run }),
                    Duration::from_secs(10),
                )
                .await;
        }
    }

    /// Runs `cmd` here for `client` and gives its status.
    async fn here(self: &Arc<Self>, run: u32, job: &str, client: &Arc<Conn>, cmd: &Command) -> i32 {
        let cancel = Arc::new(Notify::new());
        self.running.lock().unwrap().insert(run, cancel.clone());
        if self.stops.lock().unwrap().contains_key(&run) {
            cancel.notify_one();
        }
        let send = |stream: u8, data: Vec<u8>| self.emit(run, job, client, stream, data);
        let full = || client.tx.queued() > MAX_QUEUED && !client.is_gone();
        let status = execute(cmd, &|| client.is_gone(), &full, &cancel, &send).await;
        self.running.lock().unwrap().remove(&run);
        status
    }

    /// Stops run `run`, here or on its worker, to end with `status`. A run
    /// still being prepared never starts its command.
    async fn stop(&self, run: u32, status: i32) -> bool {
        self.stops.lock().unwrap().entry(run).or_insert(status);
        let here = self.running.lock().unwrap().get(&run).cloned();
        if let Some(n) = here {
            n.notify_one();
        } else if self.remote.lock().unwrap().contains_key(&run) {
            self.cancel_remote(run).await;
        }
        true
    }

    /// The status run `run` ends with when it was stopped, or its client
    /// went away, before its command started.
    fn stopped(&self, run: u32, client: &Conn) -> Option<i32> {
        let stopped = self.stops.lock().unwrap().get(&run).copied();
        stopped.or_else(|| client.is_gone().then_some(130))
    }

    /// `f`'s result, unless run `run` is stopped first.
    async fn unless_stopped<T>(
        &self,
        run: u32,
        client: &Conn,
        f: impl std::future::Future<Output = T>,
    ) -> Result<T, Fail> {
        tokio::pin!(f);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                v = &mut f => return Ok(v),
                _ = tick.tick() => {
                    if let Some(status) = self.stopped(run, client) {
                        return Err(Fail::Stopped(status));
                    }
                }
            }
        }
    }

    /// Forgets that worker `worker` had not approved a project's heavy
    /// commands, once it registers again.
    pub fn forget_not_approved(&self, worker: &str) {
        self.skips
            .lock()
            .unwrap()
            .retain(|(w, _), (reason, _, _)| !(w == worker && reason == "not_approved"));
    }

    /// `exec.cancel` from connection `conn`: stops its run `run`.
    pub async fn cancel(&self, conn: ClientId, run: u32) -> bool {
        if self.owners.lock().unwrap().get(&run) != Some(&conn) {
            return false;
        }
        self.stop(run, 130).await
    }

    /// `job.stop`: stops the run of job `job`, saying so in its output.
    pub async fn stop_job(&self, job: &str) -> bool {
        let found = {
            let mut going = self.going.lock().unwrap();
            going
                .iter_mut()
                .find(|(_, g)| g.job == job)
                .map(|(run, g)| {
                    g.stopped = true;
                    (*run, g.client.clone())
                })
        };
        let Some((run, client)) = found else {
            return false;
        };
        self.emit(
            run,
            job,
            &client,
            2,
            b"moonlet: stopped from the Jobs panel\n".to_vec(),
        );
        self.stop(run, 143).await
    }

    /// `job.stop_all`: stops every run of `session`; gives how many.
    pub async fn stop_session(&self, session: &str) -> u32 {
        let jobs: Vec<String> = self
            .going
            .lock()
            .unwrap()
            .values()
            .filter(|g| g.session == session)
            .map(|g| g.job.clone())
            .collect();
        let mut n = 0;
        for job in jobs {
            if self.stop_job(&job).await {
                n += 1;
            }
        }
        n
    }

    /// `exec.status`: `host`, this machine; the routed commands going on;
    /// why workers were skipped in the last hour.
    pub fn status(&self, host: m::ExecHost) -> m::ExecStatus {
        let running = self
            .going
            .lock()
            .unwrap()
            .values()
            .filter_map(|g| self.jobs.get(&g.job))
            .filter_map(|j| match &j.state {
                JobState::Running { worker } => Some(m::ExecRunning {
                    job: j.id.clone(),
                    session: j.session.clone(),
                    command: j.command.clone(),
                    worker: worker.clone(),
                    started_at: j.started_at,
                }),
                _ => None,
            })
            .collect();
        let hour_ago = moonlet_core::paths::now_ms().saturating_sub(3_600_000);
        let mut skips: Vec<m::ExecSkip> = self
            .skips
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (_, _, at))| *at > hour_ago)
            .map(|((worker, project), (reason, detail, _))| m::ExecSkip {
                worker: worker.clone(),
                project: project.clone(),
                reason: reason.clone(),
                detail: Some(detail.clone()),
            })
            .collect();
        skips.sort_by(|a, b| (&a.worker, &a.project).cmp(&(&b.worker, &b.project)));
        m::ExecStatus {
            host: m::ExecHost {
                used: self.running.lock().unwrap().len() as u32,
                ..host
            },
            running,
            skips,
            routed: self.routed.lock().unwrap().len() as u32,
            serving: self.serving_now(),
        }
    }

    /// What this host runs for other hosts now, oldest first (X89).
    pub fn serving_now(&self) -> Vec<m::Serving> {
        let mut out: Vec<m::Serving> = self.serving.lock().unwrap().values().cloned().collect();
        out.sort_by_key(|s| s.started_at);
        out
    }

    /// Output of a remote run, from the worker on connection `from`.
    pub fn forward(&self, from: ClientId, run: u32, stream: u8, data: Vec<u8>) {
        let target = {
            let remote = self.remote.lock().unwrap();
            remote
                .get(&run)
                .filter(|r| r.conn.id() == from)
                .map(|r| (r.client.clone(), r.job.clone()))
        };
        if let Some((client, job)) = target {
            self.emit(run, &job, &client, stream, data);
        }
    }

    /// The `outputs` of `run`, when the worker on connection `from` runs
    /// it in `copy`.
    pub fn runs_on(&self, from: ClientId, run: u32, copy: &str) -> Option<Vec<String>> {
        self.remote
            .lock()
            .unwrap()
            .get(&run)
            .filter(|r| r.conn.id() == from && r.copy == copy)
            .map(|r| r.outputs.clone())
    }

    /// `exec.done` from a worker: its changes are in; the run is over.
    /// `back_ms` is how long bringing them in took.
    pub fn done(&self, from: ClientId, run: u32, status: i32, brought: ExecBrought, back_ms: u64) {
        let mut remote = self.remote.lock().unwrap();
        if remote.get(&run).is_some_and(|r| r.conn.id() == from)
            && let Some(mut r) = remote.remove(&run)
            && let Some(tx) = r.done.take()
        {
            let _ = tx.send((status, brought, back_ms));
        }
    }

    /// `exec.start` on a worker: checks the command against this machine's
    /// own approval, slots, load and the fence, then runs it in the routing
    /// copy and sends its changes back with `exec.done`.
    pub async fn start_here(
        self: &Arc<Self>,
        req: ExecStart,
        sync: Arc<LiveCopies>,
        host: Peer,
        slots: u32,
        cloud: bool,
    ) -> Result<bool, RpcError> {
        let from = host.id();
        // A cloud machine runs what the central host that made it approved
        // (X63); any other worker keeps its own approval.
        if !cloud {
            let approved = sync.heavy_approval(&req.copy).ok_or_else(|| {
                RpcError::new(
                    "not_approved",
                    "this machine has not approved the project's heavy commands",
                )
            })?;
            let command = req
                .argv
                .iter()
                .map(|w| crate::heavy::quote(w))
                .collect::<Vec<_>>()
                .join(" ");
            let words_ok =
                !req.argv.is_empty() && heavy::route(&command, &approved.commands).is_some();
            if !words_ok || !req.env.keys().all(|k| approved.env.contains(k)) {
                return Err(RpcError::new(
                    "not_approved",
                    "not an approved heavy command here",
                ));
            }
        }
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        let load = crate::link::load().unwrap_or(0.0);
        let cancel = Arc::new(Notify::new());
        // A slot and the copy are taken at once, before the copy is
        // checked, and given back on every refusal and at the end.
        let claim = {
            let mut routed = self.routed.lock().unwrap();
            if routed.contains_key(&(from, req.run)) {
                return Err(RpcError::new("busy", "that run is going on"));
            }
            // Slots count every routed command this host runs, for its own
            // sessions too (X89).
            let used = routed.len() + self.running.lock().unwrap().len();
            if used as u32 >= slots || load >= 0.7 * f64::from(cores) {
                return Err(RpcError::new("busy", "no free slot"));
            }
            if !self.copies_in_use.lock().unwrap().insert(req.copy.clone()) {
                return Err(RpcError::new("busy", "a command of the session runs here"));
            }
            routed.insert((from, req.run), cancel.clone());
            let (host, session) = sync.run_copy_for(&req.copy).unwrap_or_default();
            self.serving.lock().unwrap().insert(
                (from, req.run),
                m::Serving {
                    host,
                    session: req.session_name.clone().unwrap_or(session),
                    command: req.argv.iter().map(|w| crate::heavy::quote(w)).collect::<Vec<_>>().join(" "),
                    started_at: moonlet_core::paths::now_ms(),
                },
            );
            Claim {
                runs: self.clone(),
                run: (from, req.run),
                copy: req.copy.clone(),
            }
        };
        let copy = sync.run_copy_at(&req.copy, &req.tree, &req.head).await?;
        let rel = Path::new(&req.cwd);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| c == std::path::Component::ParentDir)
        {
            return Err(RpcError::new(
                "invalid_params",
                "the folder is outside the copy",
            ));
        }
        // Canonical, so a link inside the copy cannot lead out of it.
        let (Ok(root), Ok(cwd)) = (copy.canonicalize(), copy.join(rel).canonicalize()) else {
            return Err(RpcError::new(
                "invalid_params",
                "no such folder in the copy",
            ));
        };
        if !cwd.starts_with(&root) || !cwd.is_dir() {
            return Err(RpcError::new(
                "invalid_params",
                "the folder is outside the copy",
            ));
        }
        // The central host names the outputs: checked here as well.
        let outputs = moonlet_proto::types::HeavyConfig {
            outputs: req.outputs.clone(),
            ..Default::default()
        };
        heavy::check(&outputs).map_err(|e| RpcError::new("invalid_params", e))?;
        let mut env = self.base_env.clone();
        env.extend(req.env.clone());
        env.insert("MOONLET_ROUTED".into(), "1".into());
        // As on the central host: the session the command runs for.
        if let Some(session) = sync.run_copy_session(&req.copy) {
            env.insert("MOONLET_SESSION".into(), session);
        }
        if !found(&req.argv[0], &cwd, env.get("PATH").map(String::as_str)) {
            return Err(RpcError::new(
                "missing_tool",
                format!("missing {}", req.argv[0]),
            ));
        }
        tokio::spawn(async move {
            let run = req.run;
            let cmd = Command {
                argv: req.argv.clone(),
                cwd,
                env,
            };
            // The copy's path, as given and canonical, reads as the
            // session's in the output.
            let copy_path = sync.run_copy_path(&req.copy).unwrap_or_default();
            let canonical = copy_path
                .canonicalize()
                .unwrap_or_else(|_| copy_path.clone());
            let (plain, canon) = (
                copy_path.display().to_string(),
                canonical.display().to_string(),
            );
            let pairs = [
                (plain.as_str(), req.session_path.as_str()),
                (canon.as_str(), req.session_path.as_str()),
            ];
            let rewriters = [
                Mutex::new(heavy::Rewriter::new(&pairs)),
                Mutex::new(heavy::Rewriter::new(&pairs)),
            ];
            let raw = |stream: u8, data: Vec<u8>| host.send_run_output(run, stream, data);
            let send = |stream: u8, data: Vec<u8>| {
                let out = rewriters[usize::from(stream == 2)]
                    .lock()
                    .unwrap()
                    .push(&data);
                out.is_empty() || raw(stream, out)
            };
            let connected = || !host.is_gone();
            // The link has no queue to read yet: a worker does not hold back.
            let status = execute(&cmd, &|| !connected(), &|| false, &cancel, &send).await;
            for (i, r) in rewriters.iter().enumerate() {
                let rest = r.lock().unwrap().finish();
                if !rest.is_empty() {
                    raw(if i == 0 { 1 } else { 2 }, rest);
                }
            }
            let lock = sync.run_lock(&req.copy);
            let _one = lock.lock().await;
            if connected() {
                let say = |text: String| send(2, format!("moonlet: {text}\n").into_bytes());
                let copy = sync.run_copy_path(&req.copy).unwrap_or_default();
                let outputs =
                    match collect_outputs(&copy, &req.outputs, outputs_limit(), &say).await {
                        Ok(t) => t,
                        Err(e) => {
                            say(format!("cannot bring back outputs: {e:#}"));
                            None
                        }
                    };
                let fence = (req.tree.clone(), req.head.clone());
                send_back(&sync, &host, run, &req.copy, status, outputs, fence, &say).await;
            }
            // Its changes went back, or the run was abandoned: the copy
            // returns to its fence either way.
            sync.reset_run(&req.copy).await;
            drop(claim);
            sync.drop_run_copy_if_off(&req.copy);
        });
        Ok(true)
    }

    /// `exec.done` from the machine that ran run `run` for this host, on
    /// `peer`: its changes come into the session before `moonlet exec`
    /// hears the exit status (X62), whichever side of the link ran it
    /// (X89). `host` is this machine's name.
    pub async fn take_done(&self, sync: &LiveCopies, peer: &Peer, r: m::ExecDone, host: &str) -> Result<ExecBrought, RpcError> {
        let Some(outputs) = self.runs_on(peer.id(), r.run, &r.copy) else {
            return Err(RpcError::new("not_found", "no such run"));
        };
        let began = std::time::Instant::now();
        let brought = match r.pack {
            Some(t) => peer
                .take_pack(t)
                .ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive")),
            None => Ok(Vec::new()),
        };
        let brought = match brought {
            Ok(pack) => {
                let pack = r.pack.map(|_| pack);
                sync.run_back(peer, &r, pack, host, &outputs).await
            }
            Err(e) => Err(e),
        };
        let back_ms = began.elapsed().as_millis() as u64;
        // The run ends either way: its client is told what was lost.
        let ended = brought.clone().unwrap_or_else(|e| ExecBrought {
            notes: vec![format!("cannot bring back the run's changes: {}", e.message)],
            ..Default::default()
        });
        self.done(peer.id(), r.run, r.status, ended, back_ms);
        brought
    }

    /// `exec.lost` from the central host: the member that ran run `run` of
    /// this host went away, and the run goes on here (X89).
    pub fn lost(&self, run: u32) {
        if self.remote.lock().unwrap().contains_key(&run) {
            self.lost.lock().unwrap().insert(run);
        }
    }

    /// `exec.cancel` from the host that routed run `run` here, on the
    /// connection `from` it came on.
    pub fn cancel_here(&self, from: ClientId, run: u32) -> bool {
        match self.routed.lock().unwrap().get(&(from, run)) {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        }
    }
}

/// A run's slot and routing copy on a worker, given back when dropped.
struct Claim {
    runs: Arc<Runs>,
    run: (ClientId, u32),
    copy: String,
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.runs.routed.lock().unwrap().remove(&self.run);
        self.runs.serving.lock().unwrap().remove(&self.run);
        self.runs.copies_in_use.lock().unwrap().remove(&self.copy);
    }
}

fn cores() -> u32 {
    std::thread::available_parallelism().map_or(1, |n| n.get() as u32)
}

/// Adds `text` to job `j`'s timeline, now.
fn event(j: &mut Job, text: String, detail: Option<String>) {
    j.timeline.push(JobEvent {
        at: moonlet_core::paths::now_ms(),
        text,
        detail,
    });
}

/// Sends the central host routing copy `copy`'s changes after run `run`.
/// When they cannot be read or sent, the run still ends, with none: the
/// fence's `tree` and `head` and no pack.
#[allow(clippy::too_many_arguments)]
async fn send_back(
    sync: &LiveCopies,
    host: &Peer,
    run: u32,
    copy: &str,
    status: i32,
    outputs: Option<String>,
    (fence_tree, fence_head): (String, String),
    say: &impl Fn(String) -> bool,
) {
    let changes = sync
        .run_changes(copy, outputs.as_deref())
        .await
        .map_err(|e| format!("{e:#}"))
        .and_then(|(tree, head, pack)| {
            if pack.is_empty() {
                return Ok((tree, head, None));
            }
            let t = host.send_pack(&pack).map_err(|e| e.message)?;
            Ok((tree, head, Some(t)))
        });
    let (tree, head, pack, outputs) = match changes {
        Ok((tree, head, pack)) => (tree, head, pack, outputs),
        Err(e) => {
            say(format!("cannot bring back the run's changes: {e}"));
            (fence_tree, fence_head, None, None)
        }
    };
    let done = ExecDone {
        run,
        copy: copy.to_string(),
        status,
        tree,
        head,
        pack,
        outputs,
    };
    if let Err(e) = host
        .request(m::EXEC_DONE, serde_json::to_value(done).unwrap(), DONE_TIMEOUT)
        .await
    {
        tracing::warn!(
            run,
            "the central host did not take the run's changes: {}",
            e.message
        );
    }
}

/// The most bytes of `outputs` brought back after a run: 1 GiB, or
/// `MOONLET_TEST_OUTPUTS_LIMIT` in tests.
fn outputs_limit() -> u64 {
    std::env::var("MOONLET_TEST_OUTPUTS_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1 << 30)
}

/// One file of a run's outputs, found before anything is stored.
enum Found {
    File {
        rel: String,
        abs: PathBuf,
        exec: bool,
    },
    Link {
        rel: String,
        target: Vec<u8>,
    },
}

/// The run's `outputs` in routing copy `copy`, stored as a tree in its
/// repository: plain files as they are, links as links, never followed.
/// An `outputs` path that is itself a link, or outputs over `limit`, stay
/// on the worker, and `say` says so.
async fn collect_outputs(
    copy: &Path,
    outputs: &[String],
    limit: u64,
    say: &(impl Fn(String) -> bool + Sync),
) -> anyhow::Result<Option<String>> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let mut found = Vec::new();
    let mut total: u64 = 0;
    for out in outputs {
        let out = out.trim_end_matches('/');
        let root = copy.join(out);
        if std::fs::symlink_metadata(&root).is_err() {
            continue;
        }
        // A link anywhere on the way, the path itself included, could lead
        // out of the copy.
        if through_link(copy, out) {
            say(format!("{out} is a symbolic link; not brought back"));
            continue;
        }
        let mut stack = vec![(root, out.trim_end_matches('/').to_string())];
        while let Some((abs, rel)) = stack.pop() {
            let meta = std::fs::symlink_metadata(&abs)?;
            let kind = meta.file_type();
            if kind.is_symlink() {
                let target = std::fs::read_link(&abs)?;
                found.push(Found::Link {
                    rel,
                    target: target.as_os_str().as_bytes().to_vec(),
                });
            } else if kind.is_dir() {
                for entry in std::fs::read_dir(&abs)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    stack.push((entry.path(), format!("{rel}/{name}")));
                }
            } else if kind.is_file() {
                total += meta.len();
                found.push(Found::File {
                    rel,
                    abs,
                    exec: meta.permissions().mode() & 0o111 != 0,
                });
            }
        }
    }
    if total > limit {
        say(format!(
            "outputs are {}, over the {} limit; not brought back",
            crate::jobs::size(total),
            crate::jobs::size(limit)
        ));
        return Ok(None);
    }
    if found.is_empty() {
        return Ok(None);
    }
    let mut files = moonlet_core::sync::Files::new();
    for f in found {
        let (rel, entry) = match f {
            Found::File { rel, abs, exec } => {
                let bytes = std::fs::read(&abs)?;
                let oid = moonlet_core::sync::hash_bytes(copy, &bytes).await?;
                let mode = if exec { "100755" } else { "100644" };
                (
                    rel,
                    moonlet_core::sync::Entry {
                        mode: mode.into(),
                        oid,
                    },
                )
            }
            Found::Link { rel, target } => {
                let oid = moonlet_core::sync::hash_bytes(copy, &target).await?;
                (
                    rel,
                    moonlet_core::sync::Entry {
                        mode: "120000".into(),
                        oid,
                    },
                )
            }
        };
        files.insert(rel, entry);
    }
    Ok(Some(moonlet_core::sync::write_files(copy, &files).await?))
}

/// Whether a component of `rel` below `root`, `rel` itself included, is a
/// symbolic link.
pub fn through_link(root: &Path, rel: &str) -> bool {
    let mut at = root.to_path_buf();
    Path::new(rel).components().any(|part| {
        at = at.join(part);
        std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink())
    })
}

/// Whether `program` can be started from `cwd` with `path`.
fn found(program: &str, cwd: &Path, path: Option<&str>) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |p: &Path| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if program.contains('/') {
        return runnable(&cwd.join(program));
    }
    // A relative entry, or an empty one, is looked up from `cwd`, as the
    // command will be.
    path.unwrap_or("/usr/bin:/bin")
        .split(':')
        .any(|d| runnable(&cwd.join(d).join(program)))
}

/// `path` with the home folder as `~`.
fn tilde(path: &str) -> String {
    match dirs::home_dir().and_then(|h| Path::new(path).strip_prefix(h).ok().map(Path::to_path_buf))
    {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.to_string(),
    }
}

/// Runs `cmd` to its end and returns its exit status. It stops the command
/// when `cancel` is notified or `gone` says the run's listener went away,
/// and holds it back while `full` says its listener is not reading.
async fn execute(
    cmd: &Command,
    gone: &(impl Fn() -> bool + Sync),
    full: &(impl Fn() -> bool + Sync),
    cancel: &Notify,
    send: &(impl Fn(u8, Vec<u8>) -> bool + Sync),
) -> i32 {
    let mut child = match tokio::process::Command::new(&cmd.argv[0])
        .args(&cmd.argv[1..])
        .current_dir(&cmd.cwd)
        .env_clear()
        .envs(&cmd.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group, so stopping it reaches every process it starts.
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            send(
                2,
                format!("moonlet: cannot run {}: {e}\n", cmd.argv[0]).into_bytes(),
            );
            return 127;
        }
    };
    let group = child.id().map(|id| Pid::from_raw(id as i32));
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let pumps = async { tokio::join!(pump(out, 1, send, full), pump(err, 2, send, full)) };
    tokio::pin!(pumps);
    let mut pumped = false;
    let (status, stopped) = {
        let mut stopping: Option<tokio::time::Instant> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                status = child.wait() => break (status, stopping.is_some()),
                _ = &mut pumps, if !pumped => pumped = true,
                _ = cancel.notified(), if stopping.is_none() => {
                    signal(group, Signal::SIGTERM);
                    stopping = Some(tokio::time::Instant::now());
                }
                _ = tick.tick() => {
                    if stopping.is_none() && gone() {
                        signal(group, Signal::SIGTERM);
                        stopping = Some(tokio::time::Instant::now());
                    }
                    if stopping.is_some_and(|t| t.elapsed() >= GRACE) {
                        signal(group, Signal::SIGKILL);
                    }
                }
            }
        }
    };
    // A process it forked just as the group was stopped may have missed
    // the signal, and would hold the output open: none outlives a stop.
    if stopped {
        signal(group, Signal::SIGKILL);
    }
    // What it left running in the background ends with it.
    if !pumped && tokio::time::timeout(DRAIN, &mut pumps).await.is_err() {
        signal(group, Signal::SIGKILL);
        let _ = tokio::time::timeout(DRAIN, &mut pumps).await;
    }
    match status {
        Ok(s) => {
            use std::os::unix::process::ExitStatusExt;
            s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))
        }
        Err(e) => {
            send(2, format!("moonlet: lost the command: {e}\n").into_bytes());
            125
        }
    }
}

fn signal(group: Option<Pid>, sig: Signal) {
    if let Some(g) = group {
        let _ = nix::sys::signal::killpg(g, sig);
    }
}

/// Sends what `from` writes as `stream` until it closes. While `full`, it
/// reads no more, so the command waits for a client that is not reading.
async fn pump(
    from: Option<impl tokio::io::AsyncRead + Unpin>,
    stream: u8,
    send: &(impl Fn(u8, Vec<u8>) -> bool + Sync),
    full: &(impl Fn() -> bool + Sync),
) {
    let Some(mut from) = from else { return };
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        while full() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                send(stream, buf[..n].to_vec());
            }
        }
    }
}

/// The error `exec.run` gives a call it refuses.
pub fn refused(reason: &str) -> RpcError {
    RpcError::new("not_routable", reason.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_on_a_relative_path_entry_is_found_from_the_folder_it_runs_in() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("bin")).unwrap();
        let tool = dir.path().join("bin/shop-tool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(found("shop-tool", dir.path(), Some("bin:/usr/bin")));
        // An empty entry is the folder itself.
        assert!(found(
            "shop-tool",
            &dir.path().join("bin"),
            Some("/usr/bin::")
        ));
        assert!(!found("shop-tool", dir.path(), Some("/usr/bin")));
    }
}
