//! Routed commands between two members, through their central host (X89).
//! A member that runs the session (the router) and the member that runs
//! its command (the runner) are not linked to each other: each calls the
//! other with `peer.call`, and this central host passes the call on with
//! the sender's worker id. It moves the packs the calls name from one
//! connection to the other, and gives each run a relay id of its own, so
//! the runner's output and `exec.done` find the router's run.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use moonlet_core::terminal::ClientId;
use moonlet_proto::methods as m;
use moonlet_proto::{Frame, Message, RpcError};
use serde_json::Value;

use moonlet_proto::types::ProjectIdentity;

use crate::machines::Machines;
use crate::server::Conn;
use crate::workers::Workers;

/// Relay ids start here, far from this host's own run ids, which a member
/// that is also this host's worker keys by the same link.
const FIRST_RELAY: u32 = 0x6000_0000;

/// How long after `exec.prepare` a runner may call its router back without
/// a run going on: a routing copy is made within the prepare's 10 minutes.
const PREPARED_FOR: Duration = Duration::from_secs(15 * 60);

/// How long a member's command for a cloud machine counts there while its
/// `exec.prepare` goes on: the prepare's own 10 minutes, and a minute more.
const PREPARING_FOR: Duration = Duration::from_secs(11 * 60);

/// Output queued for a router before a relay run's output is dropped.
const MAX_QUEUED: usize = 16 * 1024 * 1024;

/// What a router may ask a runner, and a runner its router: the routing
/// methods of X62, nothing else.
pub(crate) const TO_RUNNER: [&str; 5] = [m::EXEC_PREPARE, m::EXEC_START, m::EXEC_CANCEL, m::SYNC_UPDATE, m::SYNC_CLOSING];
const TO_ROUTER: [&str; 5] = [m::SYNC_OPEN, m::SYNC_FETCH, m::SYNC_CLOSE, m::EXEC_DONE, m::SESSION_FILES_FETCH];

/// A router and a runner it sent `exec.prepare` to: only between those
/// do the runner's calls back go (X89).
type Pair = (String, String);

/// A run passed on: whose it is, and who runs it.
struct Passed {
    router_id: String,
    run: u32,
    runner: String,
    /// Its count on the cloud machine that runs it (X63).
    hold: Option<u64>,
}

/// A member's command placed on one of this host's cloud machines, before
/// its start: its routing copy is being prepared or fenced. `copy` once
/// the prepare answered.
struct Placed {
    router: String,
    runner: String,
    copy: Option<String>,
    hold: u64,
    at: std::time::Instant,
}

pub struct Relay {
    next: AtomicU32,
    runs: Mutex<HashMap<u32, Passed>>,
    /// Relay runs whose output is being dropped for a slow router.
    dropping: Mutex<std::collections::HashSet<u32>>,
    /// Routers and the runners they last asked to prepare a routing copy,
    /// with when: a runner calls its router back only while that is recent
    /// or a run of that router's goes on there.
    prepared: Mutex<HashMap<Pair, std::time::Instant>>,
    /// Members' commands placed on cloud machines and not started yet.
    placed: Mutex<Vec<Placed>>,
    machines: Mutex<std::sync::Weak<Machines>>,
}

impl Relay {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            next: AtomicU32::new(FIRST_RELAY),
            runs: Mutex::default(),
            prepared: Mutex::default(),
            dropping: Mutex::default(),
            placed: Mutex::default(),
            machines: Mutex::new(std::sync::Weak::new()),
        })
    }

    /// The cloud machines, which count the members' commands they run.
    pub fn set_machines(&self, machines: std::sync::Weak<Machines>) {
        *self.machines.lock().unwrap() = machines;
    }

    fn machines(&self) -> Option<Arc<Machines>> {
        self.machines.lock().unwrap().upgrade()
    }

    /// Relay run `id` is over without its `exec.done`: it goes, and no
    /// longer counts on its machine.
    fn drop_run(&self, id: u32) {
        let gone = self.runs.lock().unwrap().remove(&id);
        self.release(gone.and_then(|p| p.hold));
    }

    /// The command of token `hold` no longer counts on its machine.
    fn release(&self, hold: Option<u64>) {
        if let (Some(token), Some(m)) = (hold, self.machines()) {
            m.run_ended(token);
        }
    }

    /// `peer.call` from member `from` on `conn`: passed on to member
    /// `call.to`, and its answer back.
    pub async fn call(
        &self,
        workers: &Workers,
        machines: &Machines,
        conn: &Arc<Conn>,
        from: String,
        from_cloud: bool,
        call: m::PeerCall,
    ) -> Result<Value, RpcError> {
        let to = call.to.clone().ok_or_else(|| RpcError::new("invalid_params", "to whom"))?;
        if call.from.is_some() {
            return Err(RpcError::new("invalid_params", "the central host names the sender"));
        }
        let method = call.method.as_str();
        let runner_side = TO_RUNNER.contains(&method);
        if !runner_side && !TO_ROUTER.contains(&method) {
            return Err(RpcError::new("forbidden", format!("{method} does not go between members")));
        }
        // A cloud machine only answers the member whose command it runs.
        if from_cloud && runner_side {
            return Err(RpcError::new("forbidden", "a cloud machine routes nothing"));
        }
        let unsupported = || RpcError::new("unsupported", format!("{to} takes no calls from other members"));
        let target = workers.conn(&to).ok_or_else(unsupported)?;
        let to_cloud = target.cloud.load(Ordering::Relaxed);
        if to_cloud {
            // One of this host's machines, for a member's command of the
            // machine's own project (X89, X63).
            let key = machines.key_of_worker(&to).ok_or_else(unsupported)?;
            if !runner_side {
                return Err(unsupported());
            }
            if method == m::EXEC_PREPARE {
                let wanted = serde_json::from_value::<ProjectIdentity>(call.params["identity"].clone())
                    .ok()
                    .and_then(|i| crate::heavy::key(&i));
                if wanted.as_deref() != Some(key.as_str()) {
                    return Err(RpcError::new("forbidden", "a cloud machine runs commands of its own project only"));
                }
            } else if !self.prepared_lately(&from, &to) {
                return Err(RpcError::new("forbidden", format!("{from} routed nothing to {to}")));
            }
        } else if !workers.list().iter().any(|w| w.worker.id == to && w.worker.peer) {
            return Err(unsupported());
        }
        // A runner calls back only a router that asked it to run something.
        if !runner_side && !self.prepared_lately(&to, &from) && !self.runs_for(&to, &from) {
            return Err(RpcError::new("forbidden", format!("{to} routed nothing to {from}")));
        }
        if method == m::EXEC_PREPARE {
            self.prepared
                .lock()
                .unwrap()
                .insert((from.clone(), to.clone()), std::time::Instant::now());
        }
        let mut params = call.params;
        // The relay run an `exec.done` ends, and the one an `exec.start`
        // makes.
        let mut done = None;
        let mut started = None;
        let mut ended_hold = None;
        let mut cancelled = None;
        // A member's command placed on a cloud machine counts there from
        // its prepare (X63).
        let preparing = (to_cloud && method == m::EXEC_PREPARE)
            .then(|| self.preparing(workers, &from, &to, &params))
            .flatten();
        match method {
            m::EXEC_START => {
                let run = params["run"].as_u64().ok_or_else(|| RpcError::new("invalid_params", "no run"))? as u32;
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                let hold = to_cloud.then(|| self.going_on(workers, &from, &to, &params)).flatten();
                self.runs.lock().unwrap().insert(
                    id,
                    Passed {
                        router_id: from.clone(),
                        run,
                        runner: to.clone(),
                        hold,
                    },
                );
                started = Some(id);
                params["run"] = Value::from(id);
            }
            m::EXEC_CANCEL => {
                let run = params["run"].as_u64().unwrap_or_default() as u32;
                let id = self
                    .runs
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, p)| p.router_id == from && p.run == run && p.runner == to)
                    .map(|(id, _)| *id)
                    .ok_or_else(|| RpcError::new("not_found", "no such run"))?;
                cancelled = Some(id);
                params["run"] = Value::from(id);
            }
            m::EXEC_DONE => {
                let id = params["run"].as_u64().unwrap_or_default() as u32;
                let run = {
                    let mut runs = self.runs.lock().unwrap();
                    let p = runs
                        .get_mut(&id)
                        .filter(|p| p.runner == from && p.router_id == to)
                        .ok_or_else(|| RpcError::new("not_found", "no such run"))?;
                    // It ended there: it stops counting once the router
                    // has taken its changes, or failed to.
                    ended_hold = p.hold.take();
                    p.run
                };
                done = Some(id);
                params["run"] = Value::from(run);
            }
            _ => {}
        }
        // The pack the call names, sent to this host first, goes on. A
        // call that goes no further counts nothing on a machine.
        if let Some(t) = params["pack"].as_u64() {
            let sent = conn
                .take_pack(t as u32)
                .ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive"))
                .and_then(|pack| target.send_pack(&pack));
            match sent {
                Ok(id) => params["pack"] = Value::from(id),
                Err(e) => {
                    self.release(ended_hold);
                    if let Some(hold) = preparing {
                        self.prepared_copy(hold, &Err(e.clone()));
                    }
                    if let Some(id) = started {
                        self.drop_run(id);
                    }
                    return Err(e);
                }
            }
        }
        let timeout = match method {
            m::EXEC_START | m::EXEC_CANCEL => Duration::from_secs(30),
            _ => Duration::from_secs(600),
        };
        let passed = m::PeerCall {
            to: None,
            from: Some(from),
            method: method.to_string(),
            params,
        };
        let reply = target
            .request_after_queue(m::PEER_CALL, serde_json::to_value(passed).unwrap(), timeout)
            .await;
        // A start the runner refused leaves nothing behind; one that timed
        // out stays until the router's cancel finds it.
        if let (Err(e), Some(id)) = (&reply, started)
            && e.code != "timeout"
        {
            self.drop_run(id);
        }
        self.release(ended_hold);
        if let Some(hold) = preparing {
            self.prepared_copy(hold, &reply);
        }
        // A cancelled run the cloud machine never had: nothing runs there,
        // and no `exec.done` comes for it.
        if to_cloud
            && method == m::EXEC_CANCEL
            && reply.as_ref().is_ok_and(|v| v.as_bool() == Some(false))
            && let Some(id) = cancelled
        {
            self.drop_run(id);
        }
        let mut reply = reply?;
        if let Some(id) = done {
            self.ended(id);
        }
        // A `sync.fetch` answer names the session's pack, on the router's
        // connection: it goes on to the runner.
        if method == m::SYNC_FETCH
            && let Some(t) = reply["pack"].as_u64()
        {
            let pack = target
                .take_pack(t as u32)
                .ok_or_else(|| RpcError::new("failed", "the session's files did not arrive"))?;
            reply["pack"] = Value::from(conn.send_pack(&pack)?);
        }
        Ok(reply)
    }

    /// Whether `router` asked `runner` to prepare a copy in the last
    /// [`PREPARED_FOR`]; older entries go.
    fn prepared_lately(&self, router: &str, runner: &str) -> bool {
        let mut prepared = self.prepared.lock().unwrap();
        prepared.retain(|_, at| at.elapsed() < PREPARED_FOR);
        prepared.contains_key(&(router.to_string(), runner.to_string()))
    }

    /// Whether a run of `router`'s goes on on `runner` now.
    fn runs_for(&self, router: &str, runner: &str) -> bool {
        self.runs
            .lock()
            .unwrap()
            .values()
            .any(|p| p.router_id == router && p.runner == runner)
    }

    /// Member `router`'s `exec.prepare` of a command for cloud machine
    /// `runner`: the command counts there from now. Gives its token.
    fn preparing(&self, workers: &Workers, router: &str, runner: &str, params: &Value) -> Option<u64> {
        let session = params["session_name"]
            .as_str()
            .or(params["session"].as_str())
            .unwrap_or_default()
            .to_string();
        let placed = m::CloudRun {
            session,
            host: Some(name_of(workers, router)),
            command: None,
            since: moonlet_core::paths::now_ms(),
        };
        let hold = self.machines()?.run_started(runner, placed, Some(PREPARING_FOR))?;
        let mut placed = self.placed.lock().unwrap();
        // Those the machine gave up on meanwhile.
        placed.retain(|p| p.at.elapsed() < PREPARING_FOR + PREPARED_FOR);
        placed.push(Placed {
            router: router.to_string(),
            runner: runner.to_string(),
            copy: None,
            hold,
            at: std::time::Instant::now(),
        });
        Some(hold)
    }

    /// The prepare of the command of token `hold` answered: with its copy
    /// ready, the command waits for its start, at most [`PREPARED_FOR`];
    /// otherwise the router runs it elsewhere, and it no longer counts.
    fn prepared_copy(&self, hold: u64, reply: &Result<Value, RpcError>) {
        let copy = reply
            .as_ref()
            .ok()
            .filter(|v| v["state"] == "ready")
            .and_then(|v| v["copy"].as_str());
        let mut placed = self.placed.lock().unwrap();
        let Some(i) = placed.iter().position(|p| p.hold == hold) else {
            // Its router went meanwhile.
            return;
        };
        let Some(copy) = copy else {
            placed.remove(i);
            drop(placed);
            self.release(Some(hold));
            return;
        };
        // One copy, one command at a time: an older prepare of it is over.
        let old: Vec<u64> = placed
            .iter()
            .filter(|p| p.hold != hold && p.router == placed[i].router && p.runner == placed[i].runner && p.copy.as_deref() == Some(copy))
            .map(|p| p.hold)
            .collect();
        placed[i].copy = Some(copy.to_string());
        placed.retain(|p| !old.contains(&p.hold));
        drop(placed);
        for t in old {
            self.release(Some(t));
        }
        if let Some(m) = self.machines() {
            m.run_expires(hold, PREPARED_FOR);
        }
    }

    /// Member `router`'s `exec.start` on cloud machine `runner`: the
    /// command prepared for it goes on counting as it runs, or, without
    /// one, counts from now. Gives its token.
    fn going_on(&self, workers: &Workers, router: &str, runner: &str, params: &Value) -> Option<u64> {
        let copy = params["copy"].as_str();
        let found = {
            let mut placed = self.placed.lock().unwrap();
            placed
                .iter()
                .position(|p| p.router == router && p.runner == runner && p.copy.is_some() && p.copy.as_deref() == copy)
                .map(|i| placed.remove(i).hold)
        };
        let session = params["session_name"].as_str().map(str::to_string);
        let argv: Vec<String> = serde_json::from_value(params["argv"].clone()).unwrap_or_default();
        let command = crate::heavy::quoted(&argv);
        let m = self.machines()?;
        // Prepared longer ago than the machine waited: it counts anew.
        if let Some(hold) = found
            && m.run_going(hold, session.clone(), command.clone())
        {
            return Some(hold);
        }
        let placed = m::CloudRun {
            session: session.clone().unwrap_or_default(),
            host: Some(name_of(workers, router)),
            command: None,
            since: moonlet_core::paths::now_ms(),
        };
        let hold = m.run_started(runner, placed, None)?;
        m.run_going(hold, session, command);
        Some(hold)
    }

    /// Output of relay run `id` from the member that runs it, on `from`:
    /// to the router, under its own run id. Gives `data` back when it is no
    /// relay run of that member's.
    pub fn output(&self, workers: &Workers, from: ClientId, id: u32, stream: u8, data: Vec<u8>) -> Result<(), Vec<u8>> {
        let (router, run) = {
            let runs = self.runs.lock().unwrap();
            let Some(p) = runs.get(&id) else { return Err(data) };
            if workers.conn(&p.runner).is_none_or(|c| c.id != from) {
                return Err(data);
            }
            (p.router_id.clone(), p.run)
        };
        let Some(c) = workers.conn(&router) else { return Ok(()) };
        // A router whose link cannot keep up: the output in between is
        // dropped, and the router hears where, rather than this host
        // queueing it without end (X89).
        let mut dropping = self.dropping.lock().unwrap();
        if c.tx.queued() > MAX_QUEUED {
            dropping.insert(id);
            return Ok(());
        }
        if dropping.remove(&id) {
            let line = "moonlet: output dropped here: the link to this session's host was too slow\n";
            c.tx.send(Frame::RunOutput { run, stream: 2, data: line.as_bytes().to_vec() });
        }
        c.tx.send(Frame::RunOutput { run, stream, data });
        Ok(())
    }

    /// Relay run `id` ended: its `exec.done` went to the router.
    fn ended(&self, id: u32) {
        self.runs.lock().unwrap().remove(&id);
    }

    /// Member `router` went away: the commands it routed through this host
    /// stop where they run, as a worker stops one when its central host's
    /// daemon stops (X62).
    pub fn router_gone(&self, workers: &Workers, router: &str) {
        let gone: Vec<(String, u32, Option<u64>)> = {
            let mut runs = self.runs.lock().unwrap();
            let ids: Vec<u32> = runs.iter().filter(|(_, p)| p.router_id == router).map(|(id, _)| *id).collect();
            ids.into_iter()
                .filter_map(|id| runs.remove(&id).map(|p| (p.runner, id, p.hold)))
                .collect()
        };
        self.prepared.lock().unwrap().retain(|(r, _), _| r != router);
        // Nothing of its runs there now: a cloud machine stops counting
        // them, so a member that went never keeps one, and its billing,
        // alive (X63).
        self.forget_placed(|p| p.router == router);
        for (_, _, hold) in &gone {
            self.release(*hold);
        }
        for (runner, id, _) in gone {
            let Some(c) = workers.conn(&runner) else { continue };
            let cancel = m::PeerCall {
                to: None,
                from: Some(router.to_string()),
                method: m::EXEC_CANCEL.into(),
                params: serde_json::json!({ "run": id }),
            };
            tokio::spawn(async move {
                let _ = c
                    .request(m::PEER_CALL, serde_json::to_value(cancel).unwrap(), Duration::from_secs(10))
                    .await;
            });
        }
    }

    /// Member `runner` went away: each router whose command it ran hears
    /// so, and runs it again itself.
    pub fn runner_gone(&self, workers: &Workers, runner: &str) {
        let lost: Vec<(String, u32, Option<u64>)> = {
            let mut runs = self.runs.lock().unwrap();
            let ids: Vec<u32> = runs.iter().filter(|(_, p)| p.runner == runner).map(|(id, _)| *id).collect();
            ids.into_iter()
                .filter_map(|id| runs.remove(&id))
                .map(|p| (p.router_id, p.run, p.hold))
                .collect()
        };
        self.forget_placed(|p| p.runner == runner);
        for (router, run, hold) in lost {
            self.release(hold);
            if let Some(c) = workers.conn(&router) {
                c.tx.send(Frame::Json(Message::event(m::EV_EXEC_LOST, serde_json::json!({ "run": run }))));
            }
        }
    }

    /// Commands placed on a cloud machine but not started, for which
    /// `which` holds, no longer count there.
    fn forget_placed(&self, which: impl Fn(&Placed) -> bool) {
        let holds: Vec<u64> = {
            let mut placed = self.placed.lock().unwrap();
            let holds = placed.iter().filter(|p| which(p)).map(|p| p.hold).collect();
            placed.retain(|p| !which(p));
            holds
        };
        for hold in holds {
            self.release(Some(hold));
        }
    }
}

/// Member `id`'s name, as the Workers page shows it.
fn name_of(workers: &Workers, id: &str) -> String {
    workers
        .list()
        .into_iter()
        .find(|w| w.worker.id == id)
        .map_or_else(|| id.to_string(), |w| w.worker.name)
}
