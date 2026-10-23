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
    /// The worker's connection.
    conn: Arc<Conn>,
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
    /// Cancel signals of this machine's own runs going on here, by run.
    running: Mutex<HashMap<u32, Arc<Notify>>>,
    /// Cancel signals of runs this machine does for its central host, by
    /// the central host's run id: a namespace of their own.
    routed: Mutex<HashMap<u32, Arc<Notify>>>,
    /// Which connection started each of this central host's runs, so only
    /// it cancels one.
    owners: Mutex<HashMap<u32, ClientId>>,
    /// Runs this central host routed to a worker.
    remote: Mutex<HashMap<u32, Remote>>,
    /// The worker each run was given, and its session, from the moment it
    /// is picked: a slot is taken at once, and a worker runs one command
    /// of a session at a time, as it has one routing copy of it.
    claims: Mutex<HashMap<u32, (String, String)>>,
    /// Runs stopped before their command started, with the status they end
    /// with.
    stops: Mutex<HashMap<u32, i32>>,
    /// Routing copies a run is using on this worker.
    copies_in_use: Mutex<HashSet<String>>,
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
            running: Mutex::default(),
            routed: Mutex::default(),
            owners: Mutex::default(),
            remote: Mutex::default(),
            claims: Mutex::default(),
            stops: Mutex::default(),
            copies_in_use: Mutex::default(),
            going: Mutex::default(),
            skips: Mutex::default(),
            base_env,
            jobs,
        })
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
            let exited = ExecExited { run, status };
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
        loop {
            if let Some(status) = self.stopped(run, client) {
                return status;
            }
            let chosen = {
                // Picked and claimed at once, so two runs never both take
                // a worker's last slot, nor its copy of the session.
                let mut claims = self.claims.lock().unwrap();
                let candidates = self.candidates(plan, workers, &skipped, &claims);
                let Some(chosen) = heavy::pick(&candidates, plan.os, false).cloned() else {
                    break;
                };
                if chosen.kind != Kind::Linked {
                    break;
                }
                claims.insert(run, (chosen.id.clone(), plan.session.clone()));
                chosen
            };
            let name = workers
                .list()
                .into_iter()
                .find(|w| w.worker.id == chosen.id)
                .map(|w| w.worker.name)
                .unwrap_or_else(|| chosen.id.clone());
            let ran = self
                .remote(run, job, client, plan, &chosen, &name, workers, sync)
                .await;
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

    /// The machines that might run a command of `plan`: linked workers
    /// that take heavy commands, and this central host.
    fn candidates(
        &self,
        plan: &Plan,
        workers: &Workers,
        skipped: &HashSet<String>,
        claims: &HashMap<u32, (String, String)>,
    ) -> Vec<Candidate> {
        let mut out: Vec<Candidate> = workers
            .list()
            .into_iter()
            .filter(|w| w.worker.heavy && !skipped.contains(&w.worker.id))
            .filter(|w| {
                !claims
                    .values()
                    .any(|(id, s)| *id == w.worker.id && *s == plan.session)
            })
            .map(|w| Candidate {
                used: claims.values().filter(|(id, _)| *id == w.worker.id).count() as u32,
                id: w.worker.id,
                kind: Kind::Linked,
                os: w.worker.os,
                cores: w.worker.cores,
                load: w.load.unwrap_or(0.0),
                slots: w.worker.slots,
                rtt_ms: w.rtt_ms,
            })
            .collect();
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
        let conn = workers
            .conn(worker)
            .ok_or_else(|| Fail::Refused("gone".into(), "it went away".into()))?;
        let prepare = m::ExecPrepare {
            session: plan.session.clone(),
        };
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
                        || workers.conn(worker).is_none_or(|c| c.id != conn.id);
                    if gone {
                        self.remote.lock().unwrap().remove(&run);
                        let why = if workers.missed_pings(conn.id) {
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
        }
    }

    /// Output of a remote run, from the worker on connection `from`.
    pub fn forward(&self, from: ClientId, run: u32, stream: u8, data: Vec<u8>) {
        let target = {
            let remote = self.remote.lock().unwrap();
            remote
                .get(&run)
                .filter(|r| r.conn.id == from)
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
            .filter(|r| r.conn.id == from && r.copy == copy)
            .map(|r| r.outputs.clone())
    }

    /// `exec.done` from a worker: its changes are in; the run is over.
    /// `back_ms` is how long bringing them in took.
    pub fn done(&self, from: ClientId, run: u32, status: i32, brought: ExecBrought, back_ms: u64) {
        let mut remote = self.remote.lock().unwrap();
        if remote.get(&run).is_some_and(|r| r.conn.id == from)
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
        host: Arc<moonlet_link::Host>,
        slots: u32,
    ) -> Result<bool, RpcError> {
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
        let words_ok = !req.argv.is_empty() && heavy::route(&command, &approved.commands).is_some();
        if !words_ok || !req.env.keys().all(|k| approved.env.contains(k)) {
            return Err(RpcError::new(
                "not_approved",
                "not an approved heavy command here",
            ));
        }
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        let load = crate::link::load().unwrap_or(0.0);
        let cancel = Arc::new(Notify::new());
        // A slot and the copy are taken at once, before the copy is
        // checked, and given back on every refusal and at the end.
        let claim = {
            let mut routed = self.routed.lock().unwrap();
            if routed.contains_key(&req.run) {
                return Err(RpcError::new("busy", "that run is going on"));
            }
            if routed.len() as u32 >= slots || load >= 0.7 * f64::from(cores) {
                return Err(RpcError::new("busy", "no free slot"));
            }
            if !self.copies_in_use.lock().unwrap().insert(req.copy.clone()) {
                return Err(RpcError::new("busy", "a command of the session runs here"));
            }
            routed.insert(req.run, cancel.clone());
            Claim {
                runs: self.clone(),
                run: req.run,
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
            let raw = |stream: u8, data: Vec<u8>| host.send_run_output(run, stream, data).is_ok();
            let send = |stream: u8, data: Vec<u8>| {
                let out = rewriters[usize::from(stream == 2)]
                    .lock()
                    .unwrap()
                    .push(&data);
                out.is_empty() || raw(stream, out)
            };
            let connected = || matches!(host.info().status, moonlet_link::HostStatus::Connected);
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
        });
        Ok(true)
    }

    /// `exec.cancel` from the central host, on a worker.
    pub fn cancel_here(&self, run: u32) -> bool {
        match self.routed.lock().unwrap().get(&run) {
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
    run: u32,
    copy: String,
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.runs.routed.lock().unwrap().remove(&self.run);
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
    host: &moonlet_link::Host,
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
        .request(m::EXEC_DONE, serde_json::to_value(done).unwrap())
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
