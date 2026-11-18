//! The central host's linked workers (X41, ADR 0009).
//!
//! A worker connects over the tailnet listener like any paired device,
//! says `moonletd-worker` in its hello and sends `worker.register`. The
//! list lives in memory only: it reflects live connections and is rebuilt
//! as workers come back after a restart. Which paired device owns each
//! worker id is saved in `workers.json`, so a restart never frees an id for
//! another device to take (X68). A sleeping laptop does not close
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
/// How long macOS holds a sleep at most once it told the daemon (X73): a
/// worker that still answers this long after it said it is going to sleep
/// did not sleep.
const SLEEP_HOLD_LIMIT_MS: u64 = 30_000;

/// What a worker said of its sleep (X73): when it said it is going to
/// sleep, and whether it went silent since.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sleep {
    pub at: u64,
    pub silent: bool,
}

/// What the central host hears of a worker that may be asleep (X73).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Heard {
    /// It says it is going to sleep, on the connection it is linked on
    /// now (one from before it linked again is not heard at all).
    Sleeping,
    /// It says it is awake again.
    Awake,
    /// It linked, on a new connection or the same one again.
    Linked,
    /// A ping to it was answered, or not.
    Ping { answered: bool },
}

/// The sleep mark of a worker after the central host hears `heard` at
/// `now` (ms, X73). A second notice keeps the first. A ping
/// missed after the notice makes it silent: asleep from then on. Linking,
/// saying it is awake, answering a ping once silent, or answering one
/// later than macOS holds a sleep, ends the mark: it is awake.
pub fn heard(mark: Option<Sleep>, heard: Heard, now: u64) -> Option<Sleep> {
    match heard {
        Heard::Sleeping => Some(mark.unwrap_or(Sleep { at: now, silent: false })),
        Heard::Awake | Heard::Linked => None,
        Heard::Ping { answered: false } => mark.map(|m| Sleep { silent: true, ..m }),
        Heard::Ping { answered: true } => mark.filter(|m| !m.silent && now.saturating_sub(m.at) < SLEEP_HOLD_LIMIT_MS),
    }
}

struct Entry {
    info: WorkerInfo,
    conn: Arc<Conn>,
}

pub struct Workers {
    list: Mutex<HashMap<String, Entry>>,
    /// The paired device each worker id first registered from: another
    /// device may not take that id over while that one is paired.
    owners: Mutex<HashMap<String, String>>,
    /// Where `owners` is saved.
    owners_file: std::path::PathBuf,
    /// Connections dropped because their worker stopped answering pings,
    /// so a job can say why its worker went away (X62), each with when its
    /// worker last answered one (ms): it has been away since then (X73).
    missed: Mutex<HashMap<u64, u64>>,
    /// When each worker that is not linked now last went away (ms), so the
    /// central host waits before it continues its sessions (X73).
    gone_since: Mutex<HashMap<String, u64>>,
    /// The workers that said they are going to sleep and have not been
    /// back since (X73). In memory only: after a restart the central host
    /// waits the 30 s again, as a worker may have woken meanwhile with no
    /// way to say so.
    sleeping: Mutex<HashMap<String, Sleep>>,
    /// When this daemon started: a worker not linked since went away then
    /// at the latest.
    started: u64,
    ping_every: Duration,
    emit: Box<dyn Fn(Message) + Send + Sync>,
    /// Called with each worker id that goes away (X89).
    on_gone: Mutex<Vec<Arc<dyn Fn(&str) + Send + Sync>>>,
}

impl Workers {
    pub fn new(owners_file: std::path::PathBuf, emit: impl Fn(Message) + Send + Sync + 'static) -> Workers {
        // Tests only: a shorter ping interval, so a missed ping shows quickly.
        let ping_every = std::env::var("MOONLET_WORKER_PING_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(PING_EVERY, Duration::from_millis);
        Workers {
            list: Mutex::new(HashMap::new()),
            owners: Mutex::new(
                std::fs::read(&owners_file)
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                    .unwrap_or_default(),
            ),
            owners_file,
            missed: Mutex::default(),
            gone_since: Mutex::default(),
            sleeping: Mutex::default(),
            started: now_ms(),
            ping_every,
            emit: Box::new(emit),
            on_gone: Mutex::default(),
        }
    }

    /// Calls `f` with each worker id that goes away from now on (X89).
    pub fn on_gone(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        self.on_gone.lock().unwrap().push(Arc::new(f));
    }

    /// Sends event `message` to every linked worker but cloud machines and
    /// the one on connection `except`: the account's changes go to its
    /// members alone (X68), never to phones or apps.
    pub fn send_to_members(&self, message: Message, except: Option<u64>) {
        let conns: Vec<Arc<Conn>> = self
            .list
            .lock()
            .unwrap()
            .values()
            .filter(|e| Some(e.conn.id) != except && !e.conn.cloud.load(std::sync::atomic::Ordering::Relaxed))
            .map(|e| e.conn.clone())
            .collect();
        for conn in conns {
            conn.tx.send(moonlet_proto::Frame::Json(message.clone()));
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
        let mut owners = self.owners.lock().unwrap();
        // What it said of its sleep goes with it (X73).
        let mut sleeping = self.sleeping.lock().unwrap();
        sleeping.retain(|id, _| owners.get(id).is_none_or(|owner| owner != device));
        drop(sleeping);
        owners.retain(|_, owner| owner != device);
        self.save_owners(&owners);
    }

    fn save_owners(&self, owners: &HashMap<String, String>) {
        let saved = serde_json::to_vec_pretty(owners).map_err(anyhow::Error::from).and_then(|b| crate::mobile::write_private(&self.owners_file, &b));
        if let Err(e) = saved {
            tracing::warn!("cannot save {}: {e:#}", self.owners_file.display());
        }
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
        paired: impl Fn(&str) -> bool,
    ) -> Result<(), RpcError> {
        let id = worker.id.clone();
        if conn.is_gone() {
            return Err(RpcError::new("disconnected", "the connection closed"));
        }
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
            match owners.get(&id) {
                Some(owner) if owner == device => {}
                // A device removed meanwhile owns nothing any more.
                Some(owner) if paired(owner) => {
                    return Err(RpcError::new("forbidden", "another Mac links with this worker id"));
                }
                _ => {
                    owners.insert(id.clone(), device.to_string());
                    self.save_owners(&owners);
                }
            }
        }
        let old = {
            let mut list = self.list.lock().unwrap();
            // A connection that closed as the register came in: its
            // close is marked before `disconnected` takes this lock, so
            // either that drops the entry or this never makes it.
            if conn.is_gone() {
                return Err(RpcError::new("disconnected", "the connection closed"));
            }
            // Registering again on the same connection keeps what its pings
            // measured; a new connection starts afresh.
            let kept = list
                .get(&id)
                .filter(|o| o.conn.id == conn.id)
                .map(|o| (o.info.connected_since, o.info.rtt_ms, o.info.load, o.info.used));
            let (connected_since, rtt_ms, load, used) = kept.unwrap_or((now_ms(), None, None, None));
            list.insert(
                id.clone(),
                Entry {
                    info: WorkerInfo {
                        worker,
                        connected_since,
                        rtt_ms,
                        load,
                        used,
                        running: Vec::new(),
                    },
                    conn: conn.clone(),
                },
            )
        };
        self.gone_since.lock().unwrap().remove(&id);
        self.hear(&id, Heard::Linked);
        let again = old.as_ref().is_some_and(|o| o.conn.id == conn.id);
        if let Some(old) = old
            && !again
        {
            old.conn.close();
            // What it ran on the old connection is lost (X89).
            let gone: Vec<_> = self.on_gone.lock().unwrap().clone();
            for f in &gone {
                f(&id);
            }
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
        let removed: Vec<String> = {
            let mut list = self.list.lock().unwrap();
            let gone: Vec<String> = list.iter().filter(|(_, e)| e.conn.id == conn).map(|(id, _)| id.clone()).collect();
            list.retain(|_, e| e.conn.id != conn);
            gone
        };
        // A worker that stopped answering went away at its last answer,
        // not three missed pings later (X73).
        let since = self.missed.lock().unwrap().get(&conn).copied().unwrap_or_else(now_ms);
        self.gone_since.lock().unwrap().extend(removed.iter().map(|id| (id.clone(), since)));
        if !removed.is_empty() {
            self.changed();
        }
        let gone: Vec<_> = self.on_gone.lock().unwrap().clone();
        for id in &removed {
            for f in &gone {
                f(id);
            }
        }
    }

    /// The paired device worker id `id` belongs to: the device its Mac's
    /// daemon links with.
    pub fn owner(&self, id: &str) -> Option<String> {
        self.owners.lock().unwrap().get(id).cloned()
    }

    /// The connection of the linked worker `id` (X60).
    pub fn conn(&self, id: &str) -> Option<Arc<Conn>> {
        self.list.lock().unwrap().get(id).map(|e| e.conn.clone())
    }

    /// Whether worker `id`, linked on `conn`, answers a ping now, within
    /// 3 s (a second in tests' short pings): a message or an answer for
    /// one of its sessions goes to it only then, so a link gone silent, as
    /// a lid closing leaves it, never holds one for the minute a request
    /// waits, nor gets it later (X73). A worker that said it is going to
    /// sleep and does not answer is asleep from then on.
    pub async fn answers(&self, id: &str, conn: &Conn) -> bool {
        let wait = self.ping_every.clamp(Duration::from_secs(1), Duration::from_secs(3));
        let sent = now_ms();
        let answered = conn.request(m::WORKER_PING, serde_json::json!({}), wait).await.is_ok();
        // A ping late behind a frame the worker was sending meanwhile, as
        // a pack in its sleep's hold, says nothing of its sleep.
        let busy = !answered && conn.heard_at() >= sent;
        if self.current(id, conn.id) && !busy {
            self.hear(id, Heard::Ping { answered });
        }
        answered
    }

    /// The worker on connection `conn` says it is going to sleep, or
    /// (`asleep` false) is awake again (X73). Whether a worker is linked
    /// on `conn` to say so.
    pub fn said_sleep(&self, conn: u64, asleep: bool) -> bool {
        let Some(id) = self.worker_on(conn) else { return false };
        self.hear(&id, if asleep { Heard::Sleeping } else { Heard::Awake });
        true
    }

    /// Applies what was heard of worker `id`'s sleep; a mark set or ended
    /// tells the clients, so a phone reads the session list again.
    fn hear(&self, id: &str, h: Heard) {
        let changed = {
            let mut sleeping = self.sleeping.lock().unwrap();
            let was = sleeping.get(id).copied();
            let now = heard(was, h, now_ms());
            match now {
                Some(mark) => sleeping.insert(id.to_string(), mark),
                None => sleeping.remove(id),
            };
            was.is_some() != now.is_some()
        };
        if changed {
            self.changed();
        }
    }

    /// When worker `id` said it is going to sleep, while it has not been
    /// back since (X73).
    pub fn said_asleep_at(&self, id: &str) -> Option<u64> {
        self.sleeping.lock().unwrap().get(id).map(|m| m.at)
    }

    /// Whether worker `id` is asleep as far as this host knows (X73): it
    /// said it is going to sleep, and has gone silent since or is not
    /// linked. Such a worker's sessions continue here without the 30 s
    /// wait; one that still answers is in the middle of its sleep's hold,
    /// or did not sleep, and is reachable.
    pub fn asleep(&self, id: &str) -> bool {
        self.hold_asleep(id).is_some()
    }

    /// Holds what this host knows of worker `id`'s sleep while it is
    /// [`Self::asleep`], so nothing heard of it changes that until the
    /// hold is dropped (X73): a session taken over under it has its new
    /// owner recorded before the waking worker's word is answered, and so
    /// before the worker asks who owns it. None while it is not asleep.
    pub fn hold_asleep(&self, id: &str) -> Option<std::sync::MutexGuard<'_, HashMap<String, Sleep>>> {
        let sleeping = self.sleeping.lock().unwrap();
        let linked = self.list.lock().unwrap().contains_key(id);
        sleeping.get(id).is_some_and(|m| m.silent || !linked).then_some(sleeping)
    }

    /// [`Self::asleep`], after a ping to a worker that said it is going to
    /// sleep and is still linked: one that answers it is awake, or in the
    /// middle of its sleep's hold, and reachable.
    pub async fn asleep_now(&self, id: &str) -> bool {
        let marked = self.sleeping.lock().unwrap().contains_key(id);
        if marked && let Some(conn) = self.conn(id) {
            self.answers(id, &conn).await;
        }
        self.asleep(id)
    }

    /// Since when worker `id` has not been linked (ms, X73); none while it
    /// is.
    pub fn unreachable_since(&self, id: &str) -> Option<u64> {
        let list = self.list.lock().unwrap();
        if list.contains_key(id) {
            return None;
        }
        Some(self.gone_since.lock().unwrap().get(id).copied().unwrap_or(self.started))
    }

    /// Whether worker `id` has been unlinked at some time after `t` (ms,
    /// X73): it is not linked now, or its link was made after `t`.
    pub fn away_since(&self, id: &str, t: u64) -> bool {
        self.list.lock().unwrap().get(id).is_none_or(|e| e.info.connected_since > t)
    }

    /// Whether connection `conn` was dropped for missed pings.
    pub fn missed_pings(&self, conn: u64) -> bool {
        self.missed.lock().unwrap().contains_key(&conn)
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
    // When the worker last answered a ping (ms); its link counts from now.
    let mut answered = now_ms();
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
                answered = now_ms();
                if let Some(w) = workers.upgrade()
                    && w.current(&id, conn.id)
                {
                    w.hear(&id, Heard::Ping { answered: true });
                }
                let rtt = sent.elapsed().as_millis() as u64;
                if let Some(w) = workers.upgrade()
                    && let Some(e) = w.list.lock().unwrap().get_mut(&id)
                    && e.conn.id == conn.id
                {
                    e.info.rtt_ms = Some(rtt);
                    e.info.load = answer["load"].as_f64();
                    e.info.used = answer["used"].as_u64().map(|n| n as u32);
                    e.info.running = serde_json::from_value(answer["running"].clone()).unwrap_or_default();
                }
            }
            Err(e) => {
                missed += 1;
                // One ping missed can be a busy link, as in the middle of
                // a sleep's hold, and so can one missed behind a frame the
                // worker was sending meanwhile; two in a row with nothing
                // heard are a silent one (X73).
                let sent_ms = now_ms().saturating_sub(sent.elapsed().as_millis() as u64);
                if missed >= 2
                    && conn.heard_at() < sent_ms
                    && let Some(w) = workers.upgrade()
                    && w.current(&id, conn.id)
                {
                    w.hear(&id, Heard::Ping { answered: false });
                }
                tracing::debug!(worker = %id, missed, "worker.ping failed: {}", e.message);
                if missed >= MISSES {
                    tracing::info!(worker = %id, "the worker stopped answering; dropping it");
                    if let Some(w) = workers.upgrade() {
                        w.missed.lock().unwrap().insert(conn.id, answered);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// X73: what the central host keeps of a member's sleep notice, as it
    /// hears the member next. The notice at 1790000000000 ms.
    #[test]
    fn a_sleep_notice_holds_until_the_member_is_heard_awake_or_answers_past_macos_hold() {
        const AT: u64 = 1_790_000_000_000;
        let said = Some(Sleep { at: AT, silent: false });
        let silent = Some(Sleep { at: AT, silent: true });
        // The notice; twice, the first stays.
        assert_eq!(heard(None, Heard::Sleeping, AT), said);
        assert_eq!(heard(said, Heard::Sleeping, AT + 4_000), said);
        // Pings answered during the sleep's hold keep it; a missed one
        // makes it silent, asleep from then on.
        assert_eq!(heard(said, Heard::Ping { answered: true }, AT + 20_000), said);
        assert_eq!(heard(said, Heard::Ping { answered: false }, AT + 26_000), silent);
        assert_eq!(heard(silent, Heard::Ping { answered: false }, AT + 36_000), silent);
        // Back: an answer once silent, still answering past the 30 s macOS
        // holds a sleep, saying it is awake, or linking again.
        assert_eq!(heard(silent, Heard::Ping { answered: true }, AT + 600_000), None);
        assert_eq!(heard(said, Heard::Ping { answered: true }, AT + 30_000), None);
        assert_eq!(heard(silent, Heard::Awake, AT + 600_000), None);
        assert_eq!(heard(said, Heard::Linked, AT + 3_000), None);
        // Nothing said: nothing kept.
        assert_eq!(heard(None, Heard::Ping { answered: false }, AT), None);
        assert_eq!(heard(None, Heard::Awake, AT), None);
    }

    /// A register that comes in as its connection closes, as one sent just
    /// before a link is turned off: it is refused, and lists nothing, or the
    /// central host would list a worker nothing can reach until its pings
    /// fail.
    #[tokio::test]
    async fn a_worker_registering_on_a_connection_that_closed_is_not_listed() {
        let home = tempfile::tempdir().unwrap();
        let workers = Arc::new(Workers::new(home.path().join("worker-owners.json"), |_| {}));
        let closed = crate::server::Conn::detached(7, "moonlet-worker", None);
        let worker: WorkerRegister = serde_json::from_value(serde_json::json!({
            "id": "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37",
            "name": "Alex's MacBook Pro",
            "os": "macos",
            "arch": "arm64",
            "cores": 10,
            "version": "0.1.43",
            "projects": [],
        }))
        .unwrap();
        let refused = workers.register(closed, "d1", worker, |_| true).unwrap_err();
        assert_eq!(refused.code, "disconnected");
        assert!(workers.list().is_empty(), "{:?}", workers.list());
    }
}
