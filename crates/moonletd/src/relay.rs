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

/// What a router may ask a runner, and a runner its router: the routing
/// methods of X62, nothing else.
const TO_RUNNER: [&str; 5] = [m::EXEC_PREPARE, m::EXEC_START, m::EXEC_CANCEL, m::SYNC_UPDATE, m::SYNC_CLOSING];
const TO_ROUTER: [&str; 5] = [m::SYNC_OPEN, m::SYNC_FETCH, m::SYNC_CLOSE, m::EXEC_DONE, m::SESSION_FILES_FETCH];

/// A router and a runner it sent `exec.prepare` to: only between those
/// do the runner's calls back go (X89).
type Pair = (String, String);

/// A run passed on: whose it is, and who runs it.
struct Passed {
    router: ClientId,
    router_id: String,
    run: u32,
    runner: String,
}

pub struct Relay {
    next: AtomicU32,
    runs: Mutex<HashMap<u32, Passed>>,
    /// Routers and the runners they last asked to prepare a routing copy,
    /// with when: a runner calls its router back only while that is recent
    /// or a run of that router's goes on there.
    prepared: Mutex<HashMap<Pair, std::time::Instant>>,
}

impl Relay {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            next: AtomicU32::new(FIRST_RELAY),
            runs: Mutex::default(),
            prepared: Mutex::default(),
        })
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
        // The relay run an `exec.done` ends.
        let mut done = None;
        match method {
            m::EXEC_START => {
                let run = params["run"].as_u64().ok_or_else(|| RpcError::new("invalid_params", "no run"))? as u32;
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                self.runs.lock().unwrap().insert(
                    id,
                    Passed {
                        router: conn.id,
                        router_id: from.clone(),
                        run,
                        runner: to.clone(),
                    },
                );
                params["run"] = Value::from(id);
            }
            m::EXEC_CANCEL => {
                let run = params["run"].as_u64().unwrap_or_default() as u32;
                let id = self
                    .runs
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, p)| p.router == conn.id && p.run == run && p.runner == to)
                    .map(|(id, _)| *id)
                    .ok_or_else(|| RpcError::new("not_found", "no such run"))?;
                params["run"] = Value::from(id);
            }
            m::EXEC_DONE => {
                let id = params["run"].as_u64().unwrap_or_default() as u32;
                let run = {
                    let runs = self.runs.lock().unwrap();
                    let p = runs
                        .get(&id)
                        .filter(|p| p.runner == from && p.router_id == to && p.router == target.id)
                        .ok_or_else(|| RpcError::new("not_found", "no such run"))?;
                    p.run
                };
                done = Some(id);
                params["run"] = Value::from(run);
            }
            _ => {}
        }
        // The pack the call names, sent to this host first, goes on.
        if let Some(t) = params["pack"].as_u64() {
            let pack = conn
                .take_pack(t as u32)
                .ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive"))?;
            params["pack"] = Value::from(target.send_pack(&pack)?);
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
        let mut reply = target
            .request_after_queue(m::PEER_CALL, serde_json::to_value(passed).unwrap(), timeout)
            .await?;
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
        if let Some(c) = workers.conn(&router) {
            c.tx.send(Frame::RunOutput { run, stream, data });
        }
        Ok(())
    }

    /// Relay run `id` ended: its `exec.done` went to the router.
    fn ended(&self, id: u32) {
        self.runs.lock().unwrap().remove(&id);
    }

    /// Member `runner` went away: each router whose command it ran hears
    /// so, and runs it again itself.
    /// Member `router` went away: the commands it routed through this host
    /// stop where they run, as a worker stops one when its central host's
    /// daemon stops (X62).
    pub fn router_gone(&self, workers: &Workers, router: &str) {
        let gone: Vec<(String, u32)> = {
            let mut runs = self.runs.lock().unwrap();
            let ids: Vec<u32> = runs.iter().filter(|(_, p)| p.router_id == router).map(|(id, _)| *id).collect();
            ids.into_iter()
                .filter_map(|id| runs.remove(&id).map(|p| (p.runner, id)))
                .collect()
        };
        self.prepared.lock().unwrap().retain(|(r, _), _| r != router);
        for (runner, id) in gone {
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

    pub fn runner_gone(&self, workers: &Workers, runner: &str) {
        let lost: Vec<(String, u32)> = {
            let mut runs = self.runs.lock().unwrap();
            let ids: Vec<u32> = runs.iter().filter(|(_, p)| p.runner == runner).map(|(id, _)| *id).collect();
            ids.into_iter()
                .filter_map(|id| runs.remove(&id))
                .map(|p| (p.router_id, p.run))
                .collect()
        };
        for (router, run) in lost {
            if let Some(c) = workers.conn(&router) {
                c.tx.send(Frame::Json(Message::event(m::EV_EXEC_LOST, serde_json::json!({ "run": run }))));
            }
        }
    }

}
