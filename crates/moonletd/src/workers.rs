//! The central host's linked workers (X41, ADR 0009).
//!
//! A worker connects over the tailnet listener like any paired device,
//! says `moonletd-worker` in its hello and sends `worker.register`. The
//! list lives in memory only: it reflects live connections and is rebuilt
//! as workers come back after a restart. A sleeping laptop does not close
//! its connection, so the central host pings every worker and drops one
//! that misses three pings in a row.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use moonlet_core::paths::now_ms;
use moonlet_proto::{Message, RpcError};
use moonlet_proto::methods::{self as m, WorkerInfo, WorkerRegister};

use crate::server::Conn;

/// How often a worker is pinged.
const PING_EVERY: Duration = Duration::from_secs(10);
/// Missed pings in a row before a worker is dropped.
const MISSES: u32 = 3;

struct Entry {
    info: WorkerInfo,
    conn: Arc<Conn>,
}

pub struct Workers {
    list: Mutex<HashMap<String, Entry>>,
    /// The paired device each worker id first registered from, since this
    /// daemon started: another device may not take that id over.
    owners: Mutex<HashMap<String, String>>,
    /// Connections dropped because their worker stopped answering pings,
    /// so a job can say why its worker went away (X62).
    missed: Mutex<std::collections::HashSet<u64>>,
    ping_every: Duration,
    emit: Box<dyn Fn(Message) + Send + Sync>,
}

impl Workers {
    pub fn new(emit: impl Fn(Message) + Send + Sync + 'static) -> Workers {
        // Tests only: a shorter ping interval, so a missed ping shows quickly.
        let ping_every = std::env::var("MOONLET_WORKER_PING_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(PING_EVERY, Duration::from_millis);
        Workers {
            list: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            missed: Mutex::default(),
            ping_every,
            emit: Box::new(emit),
        }
    }

    pub fn list(&self) -> Vec<WorkerInfo> {
        let mut out: Vec<WorkerInfo> = self
            .list
            .lock()
            .unwrap()
            .values()
            .map(|e| e.info.clone())
            .collect();
        out.sort_by(|a, b| (&a.worker.name, &a.worker.id).cmp(&(&b.worker.name, &b.worker.id)));
        out
    }

    fn changed(&self) {
        (self.emit)(Message::event(m::EV_WORKERS_CHANGED, self.list()));
    }

    /// Releases the worker ids a paired device held, once it is removed: the
    /// same Mac pairing again is a new device, and links with its old id.
    pub fn forget_device(&self, device: &str) {
        self.owners.lock().unwrap().retain(|_, owner| owner != device);
    }

    /// Lists the worker on `conn`, the connection of paired device `device`.
    /// A worker that links again with the same id replaces its older
    /// connection, which is closed; a worker id belongs to the device that
    /// first registered it.
    pub fn register(
        self: &Arc<Self>,
        conn: Arc<Conn>,
        device: &str,
        worker: WorkerRegister,
    ) -> Result<(), RpcError> {
        let id = worker.id.clone();
        // One worker per connection: a second id would leave the first
        // listed against a connection that no longer speaks for it.
        if self
            .list
            .lock()
            .unwrap()
            .iter()
            .any(|(other, e)| e.conn.id == conn.id && *other != id)
        {
            return Err(RpcError::new(
                "forbidden",
                "this connection already links another worker",
            ));
        }
        {
            let mut owners = self.owners.lock().unwrap();
            let owner = owners.entry(id.clone()).or_insert_with(|| device.to_string());
            if owner != device {
                return Err(RpcError::new("forbidden", "another Mac links with this worker id"));
            }
        }
        let old = {
            let mut list = self.list.lock().unwrap();
            // Registering again on the same connection keeps what its pings
            // measured; a new connection starts afresh.
            let kept = list
                .get(&id)
                .filter(|o| o.conn.id == conn.id)
                .map(|o| (o.info.connected_since, o.info.rtt_ms, o.info.load));
            let (connected_since, rtt_ms, load) = kept.unwrap_or((now_ms(), None, None));
            list.insert(
                id.clone(),
                Entry {
                    info: WorkerInfo {
                        worker,
                        connected_since,
                        rtt_ms,
                        load,
                    },
                    conn: conn.clone(),
                },
            )
        };
        let again = old.as_ref().is_some_and(|o| o.conn.id == conn.id);
        if let Some(old) = old
            && !again
        {
            old.conn.close();
        }
        self.changed();
        // Registering again on the same connection keeps its ping loop.
        if !again {
            tokio::spawn(ping_loop(Arc::downgrade(self), id, conn));
        }
        Ok(())
    }

    /// Drops the workers on a connection that closed.
    pub fn disconnected(&self, conn: u64) {
        let removed = {
            let mut list = self.list.lock().unwrap();
            let before = list.len();
            list.retain(|_, e| e.conn.id != conn);
            before != list.len()
        };
        if removed {
            self.changed();
        }
    }

    /// The connection of the linked worker `id` (X60).
    pub fn conn(&self, id: &str) -> Option<Arc<Conn>> {
        self.list.lock().unwrap().get(id).map(|e| e.conn.clone())
    }

    /// Whether connection `conn` was dropped for missed pings.
    pub fn missed_pings(&self, conn: u64) -> bool {
        self.missed.lock().unwrap().contains(&conn)
    }

    /// The id of the worker linked on connection `conn` (X60).
    pub fn worker_on(&self, conn: u64) -> Option<String> {
        self.list
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| e.conn.id == conn)
            .map(|(id, _)| id.clone())
    }

    /// Whether `id` is still listed on `conn`.
    fn current(&self, id: &str, conn: u64) -> bool {
        self.list
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|e| e.conn.id == conn)
    }
}

/// Pings the worker `id` on `conn` until it goes away; three missed pings
/// in a row close its connection.
async fn ping_loop(workers: std::sync::Weak<Workers>, id: String, conn: Arc<Conn>) {
    let mut missed = 0;
    loop {
        let Some(w) = workers.upgrade() else { return };
        if !w.current(&id, conn.id) {
            return;
        }
        let every = w.ping_every;
        drop(w);
        let sent = Instant::now();
        match conn
            .request(m::WORKER_PING, serde_json::json!({}), every)
            .await
        {
            Ok(answer) => {
                missed = 0;
                let rtt = sent.elapsed().as_millis() as u64;
                if let Some(w) = workers.upgrade()
                    && let Some(e) = w.list.lock().unwrap().get_mut(&id)
                    && e.conn.id == conn.id
                {
                    e.info.rtt_ms = Some(rtt);
                    e.info.load = answer["load"].as_f64();
                }
            }
            Err(e) => {
                missed += 1;
                tracing::debug!(worker = %id, missed, "worker.ping failed: {}", e.message);
                if missed >= MISSES {
                    tracing::info!(worker = %id, "the worker stopped answering; dropping it");
                    if let Some(w) = workers.upgrade() {
                        w.missed.lock().unwrap().insert(conn.id);
                    }
                    conn.close();
                    if let Some(w) = workers.upgrade() {
                        w.disconnected(conn.id);
                    }
                    return;
                }
            }
        }
        // Wait out the rest of the interval after a quick reply.
        let rest = every.saturating_sub(sent.elapsed());
        tokio::time::sleep(rest).await;
    }
}
