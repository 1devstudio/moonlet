//! Live copies of sessions (X60, ADR 0009).
//!
//! A worker keeps a copy of a session on its central host: a worktree of
//! a repository on this Mac, made from the session's files and commits and
//! kept in sync while the link is up. Both sides snapshot their worktree
//! as a git tree ([`moonlet_core::sync`]) and remember the tree they last
//! agreed on, the base. Each side watches its worktree. The central host
//! sends a worker what changed (`sync.update`), which the worker takes only
//! while its own files are still the base. A worker offers its changes
//! (`sync.offer`), and the central host decides: it reconciles the two
//! sides against the worker's base, applies its part, and answers what the
//! worker applies. A file changed differently on both sides keeps each
//! side's version and is listed as differing until `sync.resolve`.
//!
//! Both roles keep their copies in `~/.moonlet/sync/copies.json`, and the
//! objects of each base under `refs/moonlet/sync/<copy id>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use moonlet_core::fs::Watchers;
use moonlet_core::session::SessionManager;
use moonlet_core::sync::{self as git_sync, ApplyError, Files, HeadMove, MAX_FILE, UnpackError};
use moonlet_proto::methods::{
    self as m, CloseReason, Copy, CopyChanged, CopyRemoved, CopySetup, CopyState, Diverged, Keep,
    Resolution, SetupState, SyncClosing, SyncFetch, SyncFetched, SyncOffer, SyncOffered, SyncOpen,
    SyncOpened, SyncResolve, SyncStopped, SyncUpdate, SyncUpdated,
};
use moonlet_proto::types::ProjectIdentity;
use moonlet_proto::{Message, RpcError};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::link::WorkerLink;
use crate::server::Conn;
use crate::workers::Workers;

/// The watcher client id the central host's session watches go under.
const WATCH_CLIENT: u64 = u64::MAX;
/// How long the central host waits for a worker to apply an update.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(600);
/// How long archiving a session waits for a worker to save its copy.
const CLOSING_TIMEOUT: Duration = Duration::from_secs(30);
/// How long after its last copy goes the link stays open, so a reply to the
/// central host's `sync.closing` still goes out on it.
const LINK_CLOSE_DELAY: Duration = Duration::from_secs(1);
/// Tries at applying before giving up until the next change.
const APPLY_TRIES: usize = 5;
/// How often a watched worktree's commit and branch are looked at: a
/// commit in a linked worktree changes nothing the file watcher sees.
const HEAD_POLL: Duration = Duration::from_millis(500);

/// How long a copy that kept changing under an update waits before asking
/// the central host again.
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// The first wait before an offer the central host turned away is made
/// again; it doubles up to [`OFFER_WAIT_MAX`].
const OFFER_WAIT: Duration = Duration::from_millis(300);
const OFFER_WAIT_MAX: Duration = Duration::from_secs(5);

/// What an offer came to.
#[derive(Debug, PartialEq)]
enum Round {
    /// The central host took it, or there was nothing to offer.
    Made,
    /// The link is down; the copy waits for it.
    Offline,
    /// A side is off the session's branch; the copy waits for it.
    Held,
}

/// What follows an offer the central host turned away.
#[derive(Debug, PartialEq)]
enum OfferNext {
    /// The link is down; the copy waits for it.
    Wait,
    /// Made again after a pause.
    Retry,
    /// The copy pauses: it would be turned away again.
    Pause,
    /// Nothing to do until something changes.
    Stop,
}

/// How many times in a row an offer that fails (`failed` here, `internal`
/// on the central host) is tried.
const INTERNAL_TRIES: u32 = 5;

/// What follows an offer turned away with `code`, after `internal`
/// failures of this Mac's own in a row.
fn after_offer_error(code: &str, internal: u32) -> OfferNext {
    match code {
        "disconnected" => OfferNext::Wait,
        "refused" => OfferNext::Pause,
        "paused" | "not_found" | "not_ready" | "forbidden" | "invalid_params" => OfferNext::Stop,
        "failed" | "internal" if internal >= INTERNAL_TRIES => OfferNext::Stop,
        _ => OfferNext::Retry,
    }
}

/// Every id is a full object id: ids from the other side reach git.
fn object_ids(ids: &[&str]) -> Result<(), RpcError> {
    match ids.iter().find(|id| !git_sync::is_object_id(id)) {
        Some(id) => Err(RpcError::new(
            "invalid_params",
            format!("not an object id: {id}"),
        )),
        None => Ok(()),
    }
}

/// A copy this Mac keeps, as saved.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Kept {
    id: String,
    /// The central host's name.
    host: String,
    session: String,
    /// The copy's worktree; empty until it is made.
    #[serde(default)]
    path: String,
    /// The repository the worktree belongs to.
    #[serde(default)]
    repo: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    base_head: Option<String>,
    /// The last base the central host gave, so its objects stay out of a
    /// pack. `base` differs from it for files edited during a round: those
    /// keep the version the edit was made on.
    #[serde(default)]
    sent_base: Option<String>,
    /// The copy's files after the last round, so a change applied from the
    /// central host is not offered back.
    #[serde(default)]
    tree: Option<String>,
    #[serde(default)]
    differs: Vec<String>,
    #[serde(default)]
    too_big: Vec<String>,
    /// Why the copy waits for `sync.retry`.
    #[serde(default)]
    paused: Option<String>,
    /// The tree of the commit the worktree was made at, until the copy is
    /// finished: what the files were before anyone edited them there.
    #[serde(default)]
    made_from: Option<String>,
    /// The session's branch, which the copy is on too.
    #[serde(default)]
    branch: String,
    /// The copy's commit after the last round, so a commit is offered once.
    #[serde(default)]
    head: Option<String>,
    #[serde(default)]
    diverged: Option<Diverged>,
    /// Set when the copy is paused because a side left the branch: it then
    /// resumes by itself once that side is back on it.
    #[serde(default)]
    branch_pause: Option<Side>,
    /// The session's project, whose approved setup commands apply.
    #[serde(default)]
    identity: Option<ProjectIdentity>,
    #[serde(default)]
    setup: Option<CopySetup>,
    /// The session of the running setup's processes, so a daemon that
    /// stopped meanwhile ends them when it starts again.
    #[serde(default)]
    setup_sid: Option<u32>,
    /// When that session's leader started ([`moonlet_core::pty::process_start`]),
    /// so a process that later got its pid is never taken for it.
    #[serde(default)]
    setup_started: Option<u64>,
    /// The session's name on the central host, for the setup's
    /// `MOONLET_SESSION_NAME`.
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Side {
    Copy,
    Session,
}

/// A copy the central host serves, as saved.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Served {
    id: String,
    /// The worker's id.
    worker: String,
    session: String,
    /// The session's worktree.
    path: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    base_head: Option<String>,
    /// The session's files after the last round with this copy, so a
    /// change the copy offered is not sent back.
    #[serde(default)]
    central_tree: Option<String>,
    #[serde(default)]
    differs: Vec<String>,
    /// The session's branch.
    #[serde(default)]
    branch: String,
    /// The repository's common git dir, where the base's ref lives; kept,
    /// so the ref goes even once the session's worktree is gone.
    #[serde(default)]
    repo: String,
    /// The worker was told the session left its branch, and is told when it
    /// is back.
    #[serde(default)]
    off_branch_sent: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    worker: Vec<Kept>,
    #[serde(default)]
    central: Vec<Served>,
    /// Copies this Mac stopped keeping that their central host has not heard
    /// of yet; the link stays open until it has.
    #[serde(default)]
    closed: Vec<Closed>,
    /// Sessions this Mac started keeping because their project keeps new
    /// sessions in sync: once, so a copy the user stopped stays stopped.
    #[serde(default)]
    auto: Vec<String>,
}

/// A copy this Mac stopped keeping, for the central host it was made with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "ClosedSaved")]
struct Closed {
    copy: String,
    /// Empty for a stop saved before closes named their host: it goes to
    /// whichever host is central.
    host: String,
}

/// How a `Closed` is read: copies saved before they named their host are
/// plain ids.
#[derive(Deserialize)]
#[serde(untagged)]
enum ClosedSaved {
    Id(String),
    Full { copy: String, host: String },
}

impl From<ClosedSaved> for Closed {
    fn from(c: ClosedSaved) -> Self {
        match c {
            ClosedSaved::Id(copy) => Closed {
                copy,
                host: String::new(),
            },
            ClosedSaved::Full { copy, host } => Closed { copy, host },
        }
    }
}

/// This Mac's choices per project, by identity, in
/// `~/.moonlet/sync/projects.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProjectChoices {
    /// New sessions in the project get a copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    keep_new: bool,
    /// When `keep_new` went on, on this Mac's clock: sessions the central
    /// host made before then are not new. The two clocks are taken to agree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    keep_new_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    approved_setup: Vec<String>,
}

/// A setup started in its own session (`setsid`), so stopping it reaches
/// every process it started, also jobs its shell moved to their own group.
#[derive(Clone)]
struct SetupRun {
    sid: u32,
    run: u64,
    reaped: Arc<std::sync::atomic::AtomicBool>,
}

/// A project's key in `projects.json`: the central host's name, then the
/// project's origin and root commit. The identity alone is not enough:
/// another central host could claim it and have an approved setup run. A
/// project with no root commit has none, so nothing is remembered for it.
fn project_key(host: &str, id: &ProjectIdentity) -> Option<String> {
    // The identity comes from the central host. With no space in the origin
    // and a full hex root, the key reads one way only, from the right; the
    // host is this Mac's own name for it.
    let root = id.root.as_deref()?;
    if !matches!(root.len(), 40 | 64) || !root.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let origin = id.origin.as_deref().unwrap_or("");
    if origin.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    Some(format!("{host} {origin} {root}"))
}

/// Why making or updating a copy stopped.
enum Stop {
    /// The link is down; try again when it is back.
    Offline,
    /// Wait for the user: the reason after "Paused: ".
    Paused(String),
    /// The central host no longer has the session: the copy goes.
    Gone,
}

/// A request made while making a copy; `not_found` means the session went.
fn making(e: RpcError) -> Stop {
    if e.code == "not_found" {
        Stop::Gone
    } else {
        Stop::from(e)
    }
}

impl From<RpcError> for Stop {
    fn from(e: RpcError) -> Stop {
        match e.code.as_str() {
            "disconnected" | "timeout" => Stop::Offline,
            _ => Stop::Paused(e.message),
        }
    }
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", e.to_string())
}

pub struct LiveCopies {
    file: PathBuf,
    home: PathBuf,
    sessions: Arc<SessionManager>,
    link: Arc<WorkerLink>,
    workers: Arc<Workers>,
    emit: Box<dyn Fn(Message) + Send + Sync>,
    data: Mutex<Data>,
    /// Each kept copy's state; saved only when paused.
    states: Mutex<HashMap<String, CopyState>>,
    /// One at a time per kept copy, and per served session.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    watchers: Arc<Watchers>,
    /// Wakes the loop that sends a session's changes, by its folder.
    kicks: Mutex<HashMap<PathBuf, Arc<Notify>>>,
    /// Copies with an offer under way, and whether another should follow
    /// it: updates turned away meanwhile ask for one more, not one each.
    offering: Mutex<HashMap<String, bool>>,
    /// This Mac is registered with its central host: until then the host
    /// answers `sync.close` with `forbidden`, and the close must wait.
    registered: std::sync::atomic::AtomicBool,
    /// Each copy's last setup: its session, which run it is, and whether its
    /// leader was waited for. It stays until the next run or the copy goes,
    /// so jobs a setup left behind are stopped too.
    setups: Mutex<HashMap<String, SetupRun>>,
    runs: std::sync::atomic::AtomicU64,
    /// One writer of `projects.json` at a time.
    projects: Mutex<()>,
    /// The environment terminals get (the login shell's, without the
    /// daemon's own tokens): setups run in it too.
    base_env: std::collections::BTreeMap<String, String>,
}

impl LiveCopies {
    pub fn new(
        home: PathBuf,
        sessions: Arc<SessionManager>,
        link: Arc<WorkerLink>,
        workers: Arc<Workers>,
        base_env: std::collections::BTreeMap<String, String>,
        emit: impl Fn(Message) + Send + Sync + 'static,
    ) -> Arc<LiveCopies> {
        let file = home.join("sync").join("copies.json");
        let data: Data = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Arc::new_cyclic(|me: &Weak<LiveCopies>| {
            let me = me.clone();
            let watchers = Watchers::new(Arc::new(move |msg| {
                if let (Some(s), Message::Event { name, data }) = (me.upgrade(), msg)
                    && name == m::EV_FS_CHANGED
                    && let Some(root) = data.get("root").and_then(|r| r.as_str())
                {
                    s.kick(Path::new(root));
                }
            }));
            LiveCopies {
                file,
                home,
                sessions,
                link,
                workers,
                emit: Box::new(emit),
                data: Mutex::new(data),
                states: Mutex::new(HashMap::new()),
                locks: Mutex::new(HashMap::new()),
                watchers,
                kicks: Mutex::new(HashMap::new()),
                offering: Mutex::new(HashMap::new()),
                registered: std::sync::atomic::AtomicBool::new(false),
                setups: Mutex::new(HashMap::new()),
                runs: std::sync::atomic::AtomicU64::new(0),
                projects: Mutex::new(()),
                base_env,
            }
        })
    }

    fn save(&self) {
        let bytes = serde_json::to_vec_pretty(&*self.data.lock().unwrap()).unwrap();
        if let Err(e) = crate::mobile::write_private(&self.file, &bytes) {
            tracing::warn!("cannot write {}: {e:#}", self.file.display());
        }
    }

    fn lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    // ---- This Mac, keeping copies ----

    /// Why copy `k` waits for its central host when another host is this
    /// Mac's central host now: it talks to the host it was made with only,
    /// which would not know it and might be taken to have archived it.
    fn elsewhere(&self, k: &Kept) -> Option<String> {
        (self.link.central_name().as_deref() != Some(k.host.as_str()))
            .then(|| format!("{} is no longer this Mac's central host.", k.host))
    }

    /// The link's connection, when it goes to copy `k`'s central host.
    fn host_for(&self, k: &Kept) -> Option<Arc<moonlet_link::Host>> {
        self.elsewhere(k)
            .is_none()
            .then(|| self.link.host())
            .flatten()
    }

    fn kept(&self, id: &str) -> Option<Kept> {
        self.data
            .lock()
            .unwrap()
            .worker
            .iter()
            .find(|k| k.id == id)
            .cloned()
    }

    fn update_kept(&self, id: &str, f: impl FnOnce(&mut Kept)) {
        if let Some(k) = self
            .data
            .lock()
            .unwrap()
            .worker
            .iter_mut()
            .find(|k| k.id == id)
        {
            f(k);
        }
        self.save();
    }

    fn copy_of(&self, k: &Kept) -> Copy {
        let state = match k.paused.clone().or_else(|| self.elsewhere(k)) {
            Some(reason) => CopyState::Paused { reason },
            None => self
                .states
                .lock()
                .unwrap()
                .get(&k.id)
                .cloned()
                .unwrap_or(CopyState::Waiting),
        };
        Copy {
            id: k.id.clone(),
            host: k.host.clone(),
            session: k.session.clone(),
            path: k.path.clone(),
            state,
            setup: self.setup_of(k),
            differs: k.differs.clone(),
            too_big: k.too_big.clone(),
            diverged: k.diverged.clone(),
        }
    }

    /// Copy `k`'s setup as the app sees it: the command the copy's
    /// `.moonlet/config.toml` has now (the one running, while it runs), and
    /// whether that command was approved, so **Run setup again** knows to
    /// ask first.
    fn setup_of(&self, k: &Kept) -> Option<CopySetup> {
        let mut setup = k.setup.clone()?;
        if setup.state != SetupState::Running
            && let Some(now) = setup_command(Path::new(&k.path))
        {
            setup.command = now;
        }
        setup.approved = self.approved(k, &setup.command);
        Some(setup)
    }

    /// Whether `command` was approved for copy `k`'s project on its
    /// central host.
    fn approved(&self, k: &Kept, command: &str) -> bool {
        k.identity
            .as_ref()
            .and_then(|i| project_key(&k.host, i))
            .is_some_and(|key| {
                self.load_projects()
                    .get(&key)
                    .is_some_and(|p| p.approved_setup.iter().any(|c| c == command))
            })
    }

    /// `sync.list`: this Mac's copies.
    pub fn list(&self) -> Vec<Copy> {
        let kept = self.data.lock().unwrap().worker.clone();
        kept.iter().map(|k| self.copy_of(k)).collect()
    }

    /// Where this Mac's copies are, to leave out of its projects' worktrees.
    pub fn copy_paths(&self) -> Vec<PathBuf> {
        self.data
            .lock()
            .unwrap()
            .worker
            .iter()
            .filter(|k| !k.path.is_empty())
            .map(|k| PathBuf::from(&k.path))
            .collect()
    }

    fn changed(&self, id: &str) {
        self.changed_with(id, Vec::new());
    }

    /// `sync.changed`, with the paths that just started to differ.
    fn changed_with(&self, id: &str, newly_differing: Vec<String>) {
        if let Some(k) = self.kept(id) {
            let ev = CopyChanged {
                copy: self.copy_of(&k),
                newly_differing,
                removed: None,
            };
            (self.emit)(Message::event(m::EV_SYNC_CHANGED, ev));
        }
    }

    fn set_state(&self, id: &str, state: CopyState) {
        let old = self
            .states
            .lock()
            .unwrap()
            .insert(id.to_string(), state.clone());
        if old != Some(state) {
            self.changed(id);
        }
    }

    /// Pauses copy `id` until `sync.retry`. A pause for leaving the branch
    /// ([`Self::pause_branch`]) is replaced, so no later update lifts this
    /// one.
    fn pause(&self, id: &str, reason: String) {
        tracing::info!(copy = %id, "copy paused: {reason}");
        self.update_kept(id, |k| {
            k.paused = Some(reason);
            k.branch_pause = None;
        });
        self.changed(id);
    }

    /// Pauses copy `id` until `side` is back on the session's branch.
    fn pause_branch(&self, id: &str, side: Side, reason: String) {
        let Some(k) = self.kept(id) else { return };
        // Another pause waits for `sync.retry`, whatever the branch does.
        if k.paused.as_deref() == Some(reason.as_str())
            || (k.paused.is_some() && k.branch_pause.is_none())
        {
            return;
        }
        tracing::info!(copy = %id, "copy paused: {reason}");
        self.update_kept(id, |k| {
            k.paused = Some(reason);
            k.branch_pause = Some(side);
        });
        self.changed(id);
    }

    fn unpause(&self, id: &str) {
        self.update_kept(id, |k| {
            k.paused = None;
            k.branch_pause = None;
        });
        self.changed(id);
    }

    /// The session's branch for copy `k`. A copy saved before branches were
    /// kept has none: it takes the branch the copy is on.
    async fn branch_of(&self, k: &Kept, path: &Path) -> Result<String, RpcError> {
        if !k.branch.is_empty() {
            return Ok(k.branch.clone());
        }
        let now = git_sync::branch(path)
            .await
            .map_err(internal)?
            .ok_or_else(|| RpcError::new("paused", "the copy is on a detached HEAD"))?;
        self.update_kept(&k.id, |kept| kept.branch = now.clone());
        Ok(now)
    }

    /// Whether the copy at `path` is on its branch; pauses it if not.
    async fn on_branch(&self, k: &Kept, path: &Path) -> Result<bool, RpcError> {
        let now = git_sync::branch(path).await.map_err(internal)?;
        if k.branch.is_empty() || now.as_deref() == Some(k.branch.as_str()) {
            return Ok(true);
        }
        let reason = match now {
            Some(b) => format!("the copy is on {b}, not {}.", k.branch),
            None => format!("the copy is on a detached HEAD, not {}.", k.branch),
        };
        self.pause_branch(&k.id, Side::Copy, reason);
        Ok(false)
    }

    /// Pauses copy `k` because the session is on `off` (empty: detached).
    fn session_off_branch(&self, k: &Kept, off: &str) {
        let reason = if off.is_empty() {
            format!(
                "the session on {} is on a detached HEAD, not {}.",
                k.host, k.branch
            )
        } else {
            format!("the session on {} is on {off}, not {}.", k.host, k.branch)
        };
        self.pause_branch(&k.id, Side::Session, reason);
    }

    /// The copy's branch follows the central host's commit `central`: moved
    /// up when behind, left alone when ahead (the next offer brings it) or
    /// diverged, which the copy then reports. Gives whether the copy is
    /// ahead.
    async fn follow_head(&self, id: &str, path: &Path, central: &str) -> Result<bool, RpcError> {
        let Some(k) = self.kept(id) else {
            return Ok(false);
        };
        let mut own = git_sync::head(path).await.map_err(internal)?;
        let (own_in_central, central_in_own) = if own == central {
            (true, true)
        } else {
            (
                git_sync::is_ancestor(path, &own, central)
                    .await
                    .map_err(internal)?,
                git_sync::is_ancestor(path, central, &own)
                    .await
                    .map_err(internal)?,
            )
        };
        let mut ahead = false;
        let mut diverged = None;
        match git_sync::head_move(&own, central, own_in_central, central_in_own) {
            HeadMove::Same => {}
            HeadMove::Up => {
                let branch = self.branch_of(&k, path).await?;
                git_sync::fast_forward(path, &branch, &own, central)
                    .await
                    .map_err(internal)?;
                own = central.to_string();
            }
            HeadMove::Ahead => {
                // The central host has `central`; the next round must
                // bring this Mac's commits, so the copy's agreed head stays
                // there.
                ahead = true;
                own = central.to_string();
            }
            HeadMove::Diverged => {
                diverged = Some(Diverged {
                    ahead: git_sync::count(path, central, &own)
                        .await
                        .map_err(internal)?,
                    behind: git_sync::count(path, &own, central)
                        .await
                        .map_err(internal)?,
                });
            }
        }
        let was = k.diverged.clone();
        self.update_kept(id, |kept| {
            kept.head = Some(own);
            kept.diverged = diverged.clone();
        });
        if was != diverged {
            self.changed(id);
        }
        Ok(ahead)
    }

    /// `sync.start`: keeps `session` on the central host in sync here. A
    /// session already kept returns its copy.
    pub fn start(self: &Arc<Self>, session: String) -> Result<Copy, RpcError> {
        let host = self
            .link
            .central_name()
            .ok_or_else(|| RpcError::new("no_central_host", "this Mac has no central host"))?;
        let id = {
            // One lock for the look and the push: two starts at once make
            // one copy.
            let mut data = self.data.lock().unwrap();
            if let Some(k) = data
                .worker
                .iter()
                .find(|k| k.session == session && k.host == host)
            {
                let k = k.clone();
                drop(data);
                return Ok(self.copy_of(&k));
            }
            let kept = Kept {
                id: uuid::Uuid::new_v4().to_string(),
                host,
                session,
                ..Kept::default()
            };
            let id = kept.id.clone();
            data.worker.push(kept);
            id
        };
        self.save();
        self.states
            .lock()
            .unwrap()
            .insert(id.clone(), CopyState::Copying);
        self.link.set_synced(self.link_holders());
        self.changed(&id);
        tokio::spawn(self.clone().make(id.clone()));
        Ok(self.copy_of(&self.kept(&id).unwrap()))
    }

    /// `sync.retry`: a paused copy tries again.
    pub fn retry(self: &Arc<Self>, id: &str) -> Result<Copy, RpcError> {
        let k = self
            .kept(id)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        self.update_kept(id, |k| {
            k.paused = None;
            k.branch_pause = None;
        });
        if k.base.is_some() && !Path::new(&k.path).exists() {
            // Its folder was deleted here: made again from the session.
            self.update_kept(id, |k| {
                k.path.clear();
                k.base = None;
                k.base_head = None;
                k.tree = None;
                k.head = None;
                k.diverged = None;
                k.differs.clear();
            });
            self.set_state(id, CopyState::Copying);
            tokio::spawn(self.clone().make(id.to_string()));
        } else if k.base.is_none() {
            self.set_state(id, CopyState::Copying);
            tokio::spawn(self.clone().make(id.to_string()));
        } else {
            // The central host sends its state again.
            self.set_state(id, CopyState::Waiting);
            let me = self.clone();
            let id = id.to_string();
            tokio::spawn(async move { me.ask_again(&id).await });
        }
        Ok(self.copy_of(&self.kept(id).unwrap()))
    }

    /// Asks the central host for the session's state again. A copy it no
    /// longer serves is made again from the session, keeping its edits as a
    /// copy never finished does: only a session archived meanwhile, which
    /// `sync.open` then says, takes the copy away.
    async fn ask_again(self: &Arc<Self>, id: &str) {
        let Some(host) = self.kept(id).and_then(|k| self.host_for(&k)) else {
            return;
        };
        let req = SyncFetch {
            copy: id.to_string(),
            have: Vec::new(),
            again: true,
        };
        match host
            .request(m::SYNC_FETCH, serde_json::to_value(req).unwrap())
            .await
        {
            Ok(_) => {}
            Err(e) if e.code == "not_found" => {
                self.update_kept(id, |kept| {
                    kept.made_from = kept.base.take().or(kept.made_from.take());
                    kept.base_head = None;
                    kept.sent_base = None;
                    kept.tree = None;
                });
                tokio::spawn(self.clone().make(id.to_string()));
            }
            Err(e) => {
                tracing::debug!(copy = %id, "cannot ask for the session again: {}", e.message);
            }
        }
    }

    /// The link to the central host is up: copies not made yet go on. The
    /// others wait for the central host's state, which it sends when this
    /// Mac registers.
    pub fn link_up(self: &Arc<Self>) {
        self.registered
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.send_closed_soon();
        // Sessions made while the link was down.
        let me = self.clone();
        tokio::spawn(async move { me.fetch_sessions().await });
        let kept = self.data.lock().unwrap().worker.clone();
        for k in kept {
            if self.elsewhere(&k).is_some() {
                continue;
            }
            if k.paused.is_none() && k.base.is_none() {
                tokio::spawn(self.clone().make(k.id));
            } else if k.base.is_some() && !k.path.is_empty() {
                self.watch(Path::new(&k.path));
                // Archived while the link was down: the central host has
                // let it go.
                let me = self.clone();
                tokio::spawn(async move { me.ask_again(&k.id).await });
            }
        }
    }

    /// The link is down: copies wait for it.
    pub fn link_down(&self) {
        self.registered
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let ids: Vec<String> = self
            .data
            .lock()
            .unwrap()
            .worker
            .iter()
            .map(|k| k.id.clone())
            .collect();
        for id in ids {
            let waiting = !matches!(
                self.states.lock().unwrap().get(&id),
                Some(CopyState::Copying)
            );
            if waiting {
                self.set_state(&id, CopyState::Waiting);
            }
        }
    }

    /// Makes copy `id`, or carries on making it.
    async fn make(self: Arc<Self>, id: String) {
        let lock = self.lock(&id);
        let _one = lock.lock().await;
        let Some(k) = self.kept(&id) else { return };
        if k.base.is_some() || k.paused.is_some() {
            return;
        }
        self.set_state(&id, CopyState::Copying);
        match self.make_copy(&k).await {
            Ok(path) => {
                self.set_state(&id, CopyState::InSync);
                self.watch(&path);
                self.begin_setup(&id);
            }
            Err(Stop::Offline) => self.set_state(&id, CopyState::Waiting),
            Err(Stop::Paused(reason)) => self.pause(&id, reason),
            Err(Stop::Gone) => {
                drop(_one);
                if let Err(e) = self.remove(&id, CloseReason::Archived).await {
                    tracing::warn!(copy = %id, "cannot remove the copy: {}", e.message);
                }
            }
        }
    }

    async fn make_copy(&self, k: &Kept) -> Result<PathBuf, Stop> {
        let host = self.host_for(k).ok_or(Stop::Offline)?;
        let open = SyncOpen {
            copy: k.id.clone(),
            session: k.session.clone(),
        };
        let opened: SyncOpened = serde_json::from_value(
            host.request(m::SYNC_OPEN, serde_json::to_value(open).unwrap())
                .await
                .map_err(making)?,
        )
        .map_err(|e| Stop::Paused(e.to_string()))?;

        let repo = self.repo_for(k, &opened).await?;
        self.update_kept(&k.id, |kept| kept.repo = repo.display().to_string());
        git_sync::fetch_origin(&repo).await;
        let fetch = SyncFetch {
            copy: k.id.clone(),
            have: git_sync::have(&repo).await,
            again: false,
        };
        let fetched: SyncFetched = serde_json::from_value(
            host.request(m::SYNC_FETCH, serde_json::to_value(fetch).unwrap())
                .await
                .map_err(making)?,
        )
        .map_err(|e| Stop::Paused(e.to_string()))?;
        if ![&fetched.tree, &fetched.head, &opened.head]
            .into_iter()
            .all(|id| git_sync::is_object_id(id))
        {
            return Err(Stop::Paused(format!(
                "{} sent an invalid object id.",
                k.host
            )));
        }
        if let Some(t) = fetched.pack {
            let pack = host
                .take_pack(t)
                .ok_or_else(|| Stop::Paused("the session's files did not arrive".into()))?;
            git_sync::unpack(&repo, &pack)
                .await
                .map_err(|e| Stop::Paused(refused(&k.host, &e)))?;
        }

        let made = !k.path.is_empty() && Path::new(&k.path).exists();
        let path = if made {
            PathBuf::from(&k.path)
        } else {
            // A copy whose folder was deleted still holds its branch: that
            // worktree alone is forgotten, never the user's others.
            if let Some(there) = git_sync::checked_out(&repo, &opened.branch).await
                && !there.exists()
            {
                let _ = git_sync::forget_worktree(&repo, &there).await;
            }
            if let Some(there) = git_sync::checked_out(&repo, &opened.branch).await {
                return Err(Stop::Paused(format!(
                    "{} is checked out in {} on this Mac.",
                    opened.branch,
                    tilde(&there)
                )));
            }
            let dir = Path::new(&opened.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| opened.name.clone());
            let others: Vec<PathBuf> = self
                .data
                .lock()
                .unwrap()
                .worker
                .iter()
                .filter(|o| o.id != k.id && !o.path.is_empty())
                .map(|o| PathBuf::from(&o.path))
                .collect();
            let fallback = free_folder(
                copies_dir(&self.home, &k.host, &opened.project, &dir),
                &others,
            );
            let path = copy_path(
                Path::new(&opened.path),
                &self.home.join("worktrees"),
                &others,
                fallback,
            );
            let made_from = git_sync::commit_tree(&repo, &fetched.head)
                .await
                .map_err(|e| Stop::Paused(format!("{e:#}")))?;
            // Saved first, so a worktree made just before a crash is
            // found again rather than made a second time.
            self.update_kept(&k.id, |kept| {
                kept.path = path.display().to_string();
                kept.made_from = Some(made_from.clone());
            });
            if let Err(e) =
                git_sync::add_worktree(&repo, &path, &opened.branch, &fetched.head).await
            {
                self.update_kept(&k.id, |kept| {
                    kept.path.clear();
                    kept.made_from = None;
                });
                return Err(match e {
                    git_sync::WorktreeError::Ahead => Stop::Paused(format!(
                        "{} on this Mac has commits {}'s doesn't.",
                        opened.branch, k.host
                    )),
                    e => Stop::Paused(e.to_string()),
                });
            }
            path
        };

        // The worktree is at the session's commit; its files follow. A
        // worktree made before and edited since keeps those edits.
        let host_name = k.host.clone();
        let mut target = fetched.tree.clone();
        let mut base = fetched.tree.clone();
        let mut differs = Vec::new();
        let made_from = self.kept(&k.id).and_then(|kept| kept.made_from);
        if made && let Some(from) = made_from {
            let local = git_sync::snapshot(&path, MAX_FILE)
                .await
                .map_err(|e| Stop::Paused(format!("{e:#}")))?;
            if local.tree != from {
                let read = |t: String| {
                    let repo = repo.clone();
                    async move { git_sync::read_files(&repo, &t).await }
                };
                let (Ok(from_f), Ok(central_f), Ok(local_f)) = (
                    read(from).await,
                    read(fetched.tree.clone()).await,
                    read(local.tree).await,
                ) else {
                    return Err(Stop::Paused("cannot read the copy's files".into()));
                };
                let r = resume(&from_f, &central_f, &local_f);
                let write = |f: Files| {
                    let repo = repo.clone();
                    async move { git_sync::write_files(&repo, &f).await }
                };
                target = write(r.worker)
                    .await
                    .map_err(|e| Stop::Paused(format!("{e:#}")))?;
                base = write(r.base)
                    .await
                    .map_err(|e| Stop::Paused(format!("{e:#}")))?;
                differs = r.differs;
            }
        }
        apply_tries(&path, &target, &host_name).await?;
        git_sync::set_base_ref(&repo, &k.id, &base)
            .await
            .map_err(|e| Stop::Paused(format!("{e:#}")))?;
        self.update_kept(&k.id, |kept| {
            kept.base = Some(base.clone());
            // What the central host surely has: its own files.
            kept.sent_base = Some(fetched.tree.clone());
            kept.base_head = Some(fetched.head.clone());
            kept.tree = Some(fetched.tree.clone());
            kept.head = Some(fetched.head.clone());
            kept.branch = opened.branch.clone();
            kept.identity = Some(opened.identity.clone());
            kept.name = opened.name.clone();
            kept.too_big = fetched.too_big.clone();
            kept.differs = differs.clone();
            kept.made_from = None;
        });
        Ok(path)
    }

    /// The repository on this Mac the copy goes in: one already used, this
    /// Mac's own project with the same identity, or a clone of origin.
    async fn repo_for(&self, k: &Kept, opened: &SyncOpened) -> Result<PathBuf, Stop> {
        if !k.repo.is_empty() && Path::new(&k.repo).exists() {
            return Ok(PathBuf::from(&k.repo));
        }
        if let Some(p) = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| moonlet_core::identity::same_project(&p.identity, &opened.identity))
        {
            return Ok(PathBuf::from(p.path));
        }
        let (Some(origin), Some(url)) = (&opened.identity.origin, &opened.origin_url) else {
            return Err(Stop::Paused(format!(
                "add {p} on this Mac first. {h}'s {p} has no origin to clone from.",
                p = opened.project,
                h = k.host
            )));
        };
        let dir = clone_dir(&self.home, origin);
        if !clone_folder_ok(&self.home, &dir) {
            return Err(Stop::Paused(format!(
                "the clone folder for {origin} is not a plain folder under {}.",
                tilde(&self.home.join("clones"))
            )));
        }
        if !dir.join(".git").exists() {
            git_sync::clone(url, &dir)
                .await
                .map_err(|e| Stop::Paused(format!("cannot clone {origin}: {e}")))?;
        }
        Ok(dir)
    }

    /// `sync.update` from the central host: its files and commit. The copy
    /// takes them only while its own files are still the base; otherwise it
    /// offers its files instead, for the central host to reconcile. An
    /// update that fails leaves the copy's state as it was; one the copy
    /// kept changing under stays syncing and asks the central host again.
    pub async fn update(
        self: &Arc<Self>,
        req: SyncUpdate,
        pack: Option<Vec<u8>>,
    ) -> Result<SyncUpdated, RpcError> {
        object_ids(&[&req.tree, &req.base, &req.head])?;
        let copy = req.copy.clone();
        let before = self.states.lock().unwrap().get(&copy).cloned();
        let r = self.update_files(req, pack).await;
        match &r {
            Err(e) if e.code == "busy" => {
                let me = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(RETRY_AFTER).await;
                    me.ask_again(&copy).await;
                });
            }
            Err(_) => {
                let syncing = matches!(
                    self.states.lock().unwrap().get(&copy),
                    Some(CopyState::Syncing { .. })
                );
                if syncing {
                    self.set_state(&copy, before.unwrap_or(CopyState::InSync));
                }
            }
            Ok(_) => {}
        }
        r
    }

    async fn update_files(
        self: &Arc<Self>,
        req: SyncUpdate,
        pack: Option<Vec<u8>>,
    ) -> Result<SyncUpdated, RpcError> {
        let lock = self.lock(&req.copy);
        // An offer under way waits for the central host's session, which
        // this update holds: the update gives way, and an offer after it,
        // reconciled with the session as it is then, brings its changes.
        let Ok(_one) = lock.try_lock() else {
            self.offer_later(&req.copy);
            return Ok(SyncUpdated {
                applied: false,
                tree: None,
            });
        };
        let k = self
            .kept(&req.copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        let not_applied = SyncUpdated {
            applied: false,
            tree: None,
        };
        if let Some(off) = &req.off_branch {
            self.session_off_branch(&k, off);
            return Ok(not_applied);
        }
        if let Some(reason) = &k.paused {
            if k.branch_pause != Some(Side::Session) {
                return Err(RpcError::new("paused", reason.clone()));
            }
            // The session is back on its branch.
            self.unpause(&req.copy);
        }
        let path = PathBuf::from(&k.path);
        if self.gone(&path) {
            return Ok(not_applied);
        }
        if !self.on_branch(&k, &path).await? {
            return Ok(not_applied);
        }
        // This Mac's base, even when the central host's differs: a reply it
        // never got leaves it at the one before.
        let base = k
            .base
            .clone()
            .ok_or_else(|| RpcError::new("copying", "the copy is not made yet"))?;
        let repo = PathBuf::from(&k.repo);
        if let Some(pack) = pack {
            self.unpack_from_central(&k, &repo, &pack).await?;
        }
        self.check_paths(&k, &repo, &req.tree).await?;
        for _ in 0..APPLY_TRIES {
            let local = git_sync::snapshot(&path, MAX_FILE)
                .await
                .map_err(internal)?;
            if local.tree != base {
                // Changed here since the base: the central host decides.
                self.offer_later(&req.copy);
                return Ok(SyncUpdated {
                    applied: false,
                    tree: Some(local.tree),
                });
            }
            if req.tree != local.tree {
                let files = changed_paths(&repo, &local.tree, &req.tree).await;
                self.set_state(&req.copy, CopyState::Syncing { files });
                match git_sync::apply(&path, &local.tree, &req.tree).await {
                    Ok(()) => {}
                    Err(ApplyError::Changed(_)) => continue,
                    Err(ApplyError::Unsafe(_)) => return Err(self.pause_outside(&k)),
                    Err(ApplyError::Git(e)) => return Err(internal(format!("{e:#}"))),
                }
            }
            git_sync::set_base_ref(&repo, &req.copy, &req.tree)
                .await
                .map_err(internal)?;
            let mut too_big = req.too_big.clone();
            too_big.extend(local.too_big);
            too_big.sort();
            too_big.dedup();
            self.update_kept(&req.copy, |kept| {
                kept.base = Some(req.tree.clone());
                kept.sent_base = Some(req.tree.clone());
                kept.base_head = Some(req.head.clone());
                kept.tree = Some(req.tree.clone());
                kept.differs.clear();
                kept.too_big = too_big;
            });
            if self.follow_head(&req.copy, &path, &req.head).await? {
                // Commits here the central host lacks: an offer brings them.
                self.offer_later(&req.copy);
            }
            self.set_state(&req.copy, CopyState::InSync);
            self.changed(&req.copy);
            return Ok(SyncUpdated {
                applied: true,
                tree: Some(req.tree),
            });
        }
        Err(RpcError::new("busy", "the copy kept changing"))
    }

    /// Offers copy `id`'s files to the central host and applies what it
    /// decides; with `force`, also when they are as the last round left
    /// them, and with `resolve`, one differing path takes one side's
    /// version. A paused copy, or one not made yet, says so.
    async fn offer_changes(
        &self,
        id: &str,
        force: bool,
        resolve: Option<Resolution>,
    ) -> Result<Round, RpcError> {
        let lock = self.lock(id);
        let _one = lock.lock().await;
        let k = self
            .kept(id)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if let Some(reason) = &k.paused {
            return Err(RpcError::new("paused", reason.clone()));
        }
        let (Some(mut base), Some(mut base_head)) = (k.base.clone(), k.base_head.clone()) else {
            return Err(RpcError::new("not_ready", "the copy is not made yet"));
        };
        if let Some(res) = &resolve
            && !k.differs.contains(&res.path)
        {
            return Err(RpcError::new("invalid_params", "that path does not differ"));
        }
        let (mut resolve, mut force) = (resolve, force);
        let mut last = k.tree.clone();
        let mut sent_base = k.sent_base.clone().unwrap_or_else(|| base.clone());
        let mut last_head = k.head.clone();
        let mut differed = k.differs.clone();
        let repo = PathBuf::from(&k.repo);
        let path = PathBuf::from(&k.path);
        if self.gone(&path) {
            return Err(RpcError::new("paused", "the copy's folder is gone"));
        }
        for _ in 0..APPLY_TRIES {
            // Each round: a checkout meanwhile must not move the session.
            if !self.on_branch(&k, &path).await? {
                return Ok(Round::Held);
            }
            let local = git_sync::snapshot(&path, MAX_FILE)
                .await
                .map_err(internal)?;
            let head = git_sync::head(&path).await.map_err(internal)?;
            if !force
                && resolve.is_none()
                && last.as_deref() == Some(local.tree.as_str())
                && last_head.as_deref() == Some(head.as_str())
            {
                // As the last round left them: nothing is left to send.
                let syncing = matches!(
                    self.states.lock().unwrap().get(id),
                    Some(CopyState::Syncing { .. })
                );
                if syncing {
                    self.set_state(id, CopyState::InSync);
                }
                return Ok(Round::Made);
            }
            let Some(host) = self.host_for(&k) else {
                self.set_state(id, CopyState::Waiting);
                return Ok(Round::Offline);
            };
            let files = changed_paths(&repo, &base, &local.tree).await;
            if files > 0 {
                self.set_state(id, CopyState::Syncing { files });
            }
            // A base of the copy's own, after a round with edits in it, goes
            // along: the central host reconciles against it.
            let pack = git_sync::pack_objects(
                &repo,
                &[&local.tree, &head, &base],
                &[&sent_base, &base_head],
            )
            .await
            .map_err(internal)?;
            let req = SyncOffer {
                copy: id.to_string(),
                base: base.clone(),
                tree: local.tree.clone(),
                head,
                too_big: local.too_big.clone(),
                pack: send_pack(&pack, |p| host.send_pack(p))?,
                resolve: resolve.clone(),
            };
            let reply = match host
                .request(m::SYNC_OFFER, serde_json::to_value(req).unwrap())
                .await
            {
                Ok(v) => v,
                Err(e) if e.code == "disconnected" => {
                    self.set_state(id, CopyState::Waiting);
                    return Ok(Round::Offline);
                }
                Err(e) if e.code == "wrong_branch" => {
                    self.session_off_branch(&k, &e.message);
                    return Ok(Round::Held);
                }
                Err(e) => return Err(e),
            };
            let r: SyncOffered = serde_json::from_value(reply).map_err(internal)?;
            if let Err(e) = object_ids(&[&r.tree, &r.base, &r.head]) {
                let reason = format!("{} sent {}", k.host, e.message);
                self.pause(id, reason.clone());
                return Err(RpcError::new("paused", reason));
            }
            if let Some(t) = r.pack {
                let pack = host.take_pack(t).ok_or_else(|| {
                    RpcError::new("failed", "the central host's pack did not arrive")
                })?;
                self.unpack_from_central(&k, &repo, &pack).await?;
            }
            self.check_paths(&k, &repo, &r.tree).await?;
            // Edits made since the offer stay; the rest becomes the answer.
            let (now, new_base) = self
                .carry_over(&k, &repo, &path, &local.tree, &r.tree, &r.base)
                .await?;
            git_sync::set_base_ref(&repo, id, &new_base)
                .await
                .map_err(internal)?;
            let newly: Vec<String> = r
                .differs
                .iter()
                .filter(|p| !differed.contains(p))
                .cloned()
                .collect();
            self.update_kept(id, |kept| {
                kept.base = Some(new_base.clone());
                kept.sent_base = Some(r.base.clone());
                kept.base_head = Some(r.head.clone());
                kept.tree = Some(r.tree.clone());
                kept.differs = r.differs.clone();
                kept.too_big = r.too_big.clone();
            });
            // A commit made while the offer was out goes in another round.
            let ahead = self.follow_head(id, &path, &r.head).await?;
            if now == r.tree && !ahead {
                self.states
                    .lock()
                    .unwrap()
                    .insert(id.to_string(), CopyState::InSync);
                self.changed_with(id, newly);
                return Ok(Round::Made);
            }
            // Edited again meanwhile: the central host took the round, so
            // offer those edits against the new base, not the old one.
            self.changed_with(id, newly);
            (base, base_head, sent_base) = (new_base, r.head, r.base);
            last = Some(r.tree);
            last_head = self.kept(id).and_then(|k| k.head);
            differed = r.differs;
            (resolve, force) = (None, false);
        }
        Err(RpcError::new("busy", "the copy kept changing"))
    }

    /// Puts the central host's answer `answer` to the offer of `offered` in
    /// the copy, keeping each file edited since the offer as it is now.
    /// Gives the tree the copy then holds, and its base: the answer's base
    /// `answer_base`, except that a file kept keeps the version it was
    /// edited from, so the central host's change to it and the copy's edit
    /// both count.
    async fn carry_over(
        &self,
        k: &Kept,
        repo: &Path,
        path: &Path,
        offered: &str,
        answer: &str,
        answer_base: &str,
    ) -> Result<(String, String), RpcError> {
        let offered = git_sync::read_files(repo, offered)
            .await
            .map_err(internal)?;
        let answer = git_sync::read_files(repo, answer).await.map_err(internal)?;
        let based = git_sync::read_files(repo, answer_base)
            .await
            .map_err(internal)?;
        for _ in 0..APPLY_TRIES {
            let now = git_sync::snapshot(path, MAX_FILE).await.map_err(internal)?;
            let files = git_sync::read_files(repo, &now.tree)
                .await
                .map_err(internal)?;
            let target = git_sync::write_files(repo, &keep_edits(&offered, &files, &answer))
                .await
                .map_err(internal)?;
            let base = base_of_edits(&offered, &files, &based);
            let base = if base == based {
                answer_base.to_string()
            } else {
                git_sync::write_files(repo, &base).await.map_err(internal)?
            };
            if target == now.tree {
                return Ok((target, base));
            }
            match git_sync::apply(path, &now.tree, &target).await {
                Ok(()) => return Ok((target, base)),
                Err(ApplyError::Changed(_)) => continue,
                Err(ApplyError::Unsafe(_)) => return Err(self.pause_outside(k)),
                Err(ApplyError::Git(e)) => return Err(internal(format!("{e:#}"))),
            }
        }
        Err(RpcError::new("busy", "the copy kept changing"))
    }

    /// Offers copy `id` until the central host takes it or the link drops:
    /// one turned away is made again after [`OFFER_WAIT`], doubling up to
    /// [`OFFER_WAIT_MAX`]. The copy shows syncing meanwhile.
    async fn offer_until_taken(&self, id: &str, force: bool) {
        let mut wait = OFFER_WAIT;
        let mut internal = 0;
        loop {
            let e = match self.offer_changes(id, force, None).await {
                Ok(_) => return,
                Err(e) => e,
            };
            if matches!(e.code.as_str(), "failed" | "internal") {
                internal += 1;
            }
            match after_offer_error(&e.code, internal) {
                OfferNext::Retry => {
                    tracing::debug!(copy = %id, "offer turned away, again in {wait:?}: {}", e.message);
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(OFFER_WAIT_MAX);
                }
                OfferNext::Pause => {
                    let host = self.kept(id).map(|k| k.host).unwrap_or_default();
                    self.pause(
                        id,
                        format!("{host} refused the copy's files: {}", e.message),
                    );
                    return;
                }
                OfferNext::Wait => {
                    self.set_state(id, CopyState::Waiting);
                    return;
                }
                OfferNext::Stop => {
                    if matches!(e.code.as_str(), "failed" | "internal") {
                        tracing::warn!(copy = %id, "offer failed {internal} times: {}", e.message);
                    } else {
                        tracing::debug!(copy = %id, "offer not made: {}", e.message);
                    }
                    return;
                }
            }
        }
    }

    /// Offers copy `id` once the copy is free, whether or not it changed.
    fn offer_later(self: &Arc<Self>, id: &str) {
        {
            let mut offering = self.offering.lock().unwrap();
            if let Some(again) = offering.get_mut(id) {
                *again = true;
                return;
            }
            offering.insert(id.to_string(), false);
        }
        let me = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                me.offer_until_taken(&id, true).await;
                let mut offering = me.offering.lock().unwrap();
                if offering.get(&id) == Some(&true) {
                    offering.insert(id.clone(), false);
                } else {
                    offering.remove(&id);
                    break;
                }
            }
        });
    }

    /// `sync.resolve`: `path` takes `keep`'s version on both sides. Fails
    /// when it could not be done: `paused`, `not_ready`, `disconnected`
    /// while the link is down, `busy` when the copy kept changing.
    pub async fn resolve(&self, req: SyncResolve) -> Result<Copy, RpcError> {
        let resolution = Resolution {
            path: req.path,
            keep: req.keep,
        };
        let round = self
            .offer_changes(&req.copy, true, Some(resolution))
            .await?;
        let k = self
            .kept(&req.copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if round == Round::Offline {
            return Err(RpcError::new(
                "disconnected",
                format!("{} is not reachable", k.host),
            ));
        }
        Ok(self.copy_of(&k))
    }

    /// `sync.stop`: stops keeping copy `id` in sync and removes it from this
    /// Mac, after saving what would be lost.
    pub async fn stop(self: &Arc<Self>, id: &str) -> Result<SyncStopped, RpcError> {
        let Some(k) = self.kept(id) else {
            return Err(RpcError::new("not_found", "no such copy"));
        };
        let saved = self.remove(id, CloseReason::Stopped).await?;
        // Its central host lets the copy go now, or once it is linked again.
        self.data.lock().unwrap().closed.push(Closed {
            copy: id.to_string(),
            host: k.host,
        });
        self.save();
        self.send_closed_soon();
        Ok(saved)
    }

    fn send_closed_soon(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move { me.send_closed().await });
    }

    /// Tells the central host of the copies made with it that this Mac
    /// stopped keeping. Another host never hears of them: it would not know
    /// the copy, and its own host would keep serving it.
    async fn send_closed(&self) {
        if !self.registered.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(host) = self.link.host() else { return };
        let central = self.link.central_name();
        let closed: Vec<Closed> = self
            .data
            .lock()
            .unwrap()
            .closed
            .iter()
            .filter(|c| c.host.is_empty() || central.as_deref() == Some(c.host.as_str()))
            .cloned()
            .collect();
        for c in closed {
            let id = c.copy;
            let req = m::CopyRef { copy: id.clone() };
            match host
                .request(m::SYNC_CLOSE, serde_json::to_value(req).unwrap())
                .await
            {
                Ok(_) => {}
                Err(e) if e.code == "not_found" || e.code == "forbidden" => {}
                Err(_) => return,
            }
            self.data.lock().unwrap().closed.retain(|c| c.copy != id);
            self.save();
        }
        self.link.set_synced(self.link_holders());
    }

    /// What keeps the link open: the copies, those whose stop the central
    /// host has yet to hear of, and a project that keeps new sessions in
    /// sync, which needs the central host's news of them.
    fn link_holders(&self) -> usize {
        let keep_new = self.load_projects().values().any(|p| p.keep_new);
        let data = self.data.lock().unwrap();
        data.worker.len() + data.closed.len() + usize::from(keep_new)
    }

    /// `sync.closing` from the central host: the session is going away.
    pub async fn closing(self: &Arc<Self>, req: SyncClosing) -> Result<SyncStopped, RpcError> {
        if self.kept(&req.copy).is_none() {
            return Err(RpcError::new("not_found", "no such copy"));
        }
        self.remove(&req.copy, req.reason).await
    }

    /// Removes copy `id` from this Mac: saves what would be lost, removes
    /// its worktree (its branch stays) and the base's ref, and forgets it.
    /// `sync.changed` says so, with `reason`. When something cannot be
    /// saved, or the worktree cannot be removed, the copy stays, paused.
    async fn remove(
        self: &Arc<Self>,
        id: &str,
        reason: CloseReason,
    ) -> Result<SyncStopped, RpcError> {
        let lock = self.lock(id);
        let _one = lock.lock().await;
        let Some(k) = self.kept(id) else {
            return Ok(SyncStopped::default());
        };
        let saved = match self.save_leftovers(&k).await {
            Ok(saved) => saved,
            Err(Unsaved { path, error }) => {
                let why = format!("could not save {path} before removing the copy: {error}");
                self.pause(id, why.clone());
                return Err(RpcError::new("not_saved", why));
            }
        };
        self.end_setup(id);
        let path = PathBuf::from(&k.path);
        let repo = PathBuf::from(&k.repo);
        self.unwatch(&path);
        if !k.path.is_empty() && path.exists() {
            if let Err(e) = git_sync::remove_worktree(&repo, &path).await {
                let why = format!("could not remove the copy: {e:#}");
                self.pause(id, why.clone());
                self.watch(&path);
                return Err(RpcError::new("failed", why));
            }
        } else if !k.repo.is_empty() && !k.path.is_empty() {
            let _ = git_sync::forget_worktree(&repo, &path).await;
        }
        if !k.repo.is_empty() {
            let _ = git_sync::delete_base_ref(&repo, id).await;
        }
        let ev = CopyChanged {
            copy: self.copy_of(&k),
            newly_differing: Vec::new(),
            removed: Some(CopyRemoved {
                reason,
                saved: saved.clone(),
            }),
        };
        self.data.lock().unwrap().worker.retain(|w| w.id != id);
        self.save();
        self.states.lock().unwrap().remove(id);
        // The last copy gone closes the link, a moment later.
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(LINK_CLOSE_DELAY).await;
            if let Some(s) = me.upgrade() {
                s.link.set_synced(s.link_holders());
            }
        });
        (self.emit)(Message::event(m::EV_SYNC_CHANGED, ev));
        Ok(saved)
    }

    /// Saves the files of copy `k` that would be lost with it: those that
    /// differ, those changed here since the last round, and those only this
    /// Mac has (secrets, and files that stopped syncing). Plain ignored
    /// files, such as build output, are not saved. They go under
    /// `sync-leftovers/<copy folder>-<when>`, at their own paths; links are
    /// saved as links.
    async fn save_leftovers(&self, k: &Kept) -> Result<SyncStopped, Unsaved> {
        let path = PathBuf::from(&k.path);
        let dir = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| k.session.clone());
        let folder = leftovers_folder(&self.home.join("sync-leftovers"), &segment(&dir));
        let mut saved = SyncStopped {
            folder: folder.display().to_string(),
            leftovers: Vec::new(),
        };
        if k.path.is_empty() || !path.exists() {
            return Ok(saved);
        }
        let repo = PathBuf::from(&k.repo);
        // A copy not finished, or made again, compares with what it was made
        // from; failing that, with its commit.
        let base = match k.base.clone().or(k.made_from.clone()) {
            Some(b) => b,
            None => {
                let shown = tilde(&path);
                let head = git_sync::head(&path)
                    .await
                    .map_err(|e| Unsaved::new(&shown, format!("{e:#}")))?;
                git_sync::commit_tree(&repo, &head)
                    .await
                    .map_err(|e| Unsaved::new(&shown, format!("{e:#}")))?
            }
        };
        let base = &base;
        let shown = tilde(&path);
        let whole = |e: anyhow::Error| Unsaved::new(&shown, format!("{e:#}"));
        let local = git_sync::snapshot(&path, MAX_FILE).await.map_err(whole)?;
        let here = git_sync::read_files(&repo, &local.tree)
            .await
            .map_err(whole)?;
        let base = git_sync::read_files(&repo, base).await.map_err(whole)?;
        let only_here = git_sync::local_only(&path).await.map_err(whole)?;
        // Only paths this Mac's own git listed, so nothing the central host
        // named can reach outside the copy or the folder.
        let mut lost: std::collections::BTreeSet<String> = here
            .iter()
            .filter(|(p, e)| base.get(*p) != Some(*e) || k.differs.contains(p))
            .map(|(p, _)| p.clone())
            .collect();
        lost.extend(only_here);
        lost.extend(local.too_big);
        if lost.is_empty() {
            return Ok(saved);
        }
        // Nowhere to put them: the first file that would be lost says so.
        let first = lost.iter().next().cloned().unwrap_or_default();
        let folder = make_leftovers_folder(&self.home.join("sync-leftovers"), &segment(&dir))
            .map_err(|e| Unsaved::new(&first, e))?;
        saved.folder = folder.display().to_string();
        saved.leftovers = save_lost(&path, &folder, lost)?;
        if saved.leftovers.is_empty() {
            let _ = std::fs::remove_dir(&folder);
        }
        Ok(saved)
    }

    /// Stops watching a folder, and any watched folder that is gone.
    fn unwatch(&self, path: &Path) {
        let root = path.canonicalize().ok();
        let mut kicks = self.kicks.lock().unwrap();
        let dropped: Vec<PathBuf> = kicks
            .keys()
            .filter(|r| Some(*r) == root.as_ref() || !r.exists())
            .cloned()
            .collect();
        for r in dropped {
            kicks.remove(&r);
            self.watchers
                .unwatch(&r.display().to_string(), WATCH_CLIENT);
        }
    }

    /// Whether copy folder `path` was deleted on this Mac; if so, the
    /// copies whose folders are gone pause.
    fn gone(&self, path: &Path) -> bool {
        if path.exists() {
            return false;
        }
        self.pause_gone();
        true
    }

    /// Pauses the copies whose folders were deleted on this Mac; gives
    /// whether any was.
    fn pause_gone(&self) -> bool {
        let gone: Vec<Kept> = self
            .data
            .lock()
            .unwrap()
            .worker
            .iter()
            .filter(|k| k.base.is_some() && !k.path.is_empty() && !Path::new(&k.path).exists())
            .filter(|k| k.paused.is_none())
            .cloned()
            .collect();
        for k in &gone {
            self.pause(
                &k.id,
                format!("the copy at {} is gone.", tilde(Path::new(&k.path))),
            );
        }
        self.kicks.lock().unwrap().retain(|r, _| r.exists());
        !gone.is_empty()
    }

    // ---- Keeping new sessions in sync ----

    /// `sync.project_get`.
    pub fn project_get(&self, identity: &ProjectIdentity) -> m::ProjectSync {
        let keep_new = project_key(identity)
            .and_then(|key| self.load_projects().get(&key).map(|p| p.keep_new))
            .unwrap_or(false);
        m::ProjectSync { keep_new }
    }

    /// `sync.project_set`: new sessions in the project get a copy from now
    /// on, or no longer do. Copies already kept stay.
    pub fn project_set(
        self: &Arc<Self>,
        identity: &ProjectIdentity,
        keep_new: bool,
    ) -> Result<m::ProjectSync, RpcError> {
        let key = project_key(identity).ok_or_else(|| {
            RpcError::new(
                "no_identity",
                "the project has no commit to know it by on this Mac",
            )
        })?;
        self.update_projects(&key, |p| {
            if keep_new && !p.keep_new {
                p.keep_new_since = Some(moonlet_core::paths::now_ms());
            } else if !keep_new {
                p.keep_new_since = None;
            }
            p.keep_new = keep_new;
        });
        self.link.set_synced(self.link_holders());
        Ok(self.project_get(identity))
    }

    /// `sessions.changed` from the central host, over the link.
    pub fn sessions_changed(self: &Arc<Self>, data: serde_json::Value) {
        let Ok(sessions) = serde_json::from_value::<Vec<moonlet_proto::types::Session>>(data)
        else {
            return;
        };
        let me = self.clone();
        tokio::spawn(async move { me.keep_new_sessions(sessions).await });
    }

    /// Asks the central host for its sessions, to pick up new ones.
    async fn fetch_sessions(self: &Arc<Self>) {
        if !self.load_projects().values().any(|p| p.keep_new) {
            return;
        }
        let Some(host) = self.link.host() else { return };
        match host.request(m::SESSION_LIST, serde_json::json!({})).await {
            Ok(v) => {
                if let Ok(sessions) = serde_json::from_value(v) {
                    self.keep_new_sessions(sessions).await;
                }
            }
            Err(e) => tracing::debug!("cannot list the central host's sessions: {}", e.message),
        }
    }

    /// Starts keeping each new session of a project set to keep new
    /// sessions in sync: made since the setting went on, not archived, and
    /// not kept or stopped before.
    async fn keep_new_sessions(self: &Arc<Self>, sessions: Vec<moonlet_proto::types::Session>) {
        let lock = self.lock("keep-new");
        let _one = lock.lock().await;
        let choices = self.load_projects();
        let Some(since) = choices
            .values()
            .filter(|p| p.keep_new)
            .filter_map(|p| p.keep_new_since)
            .min()
        else {
            return;
        };
        let candidates: Vec<_> = {
            let data = self.data.lock().unwrap();
            sessions
                .into_iter()
                .filter(|s| !s.archived && s.created_at >= since)
                .filter(|s| !data.auto.contains(&s.id))
                .filter(|s| !data.worker.iter().any(|k| k.session == s.id))
                .collect()
        };
        if candidates.is_empty() {
            return;
        }
        let Some(host) = self.link.host() else { return };
        let projects: Vec<moonlet_proto::types::Project> = match host
            .request(m::PROJECT_LIST, serde_json::json!({}))
            .await
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
        {
            Some(p) => p,
            None => return,
        };
        for s in candidates {
            let Some(p) = projects.iter().find(|p| p.id == s.project_id) else {
                continue;
            };
            let wanted = project_key(&p.identity)
                .and_then(|key| choices.get(&key))
                .is_some_and(|c| c.keep_new && c.keep_new_since.is_some_and(|t| s.created_at >= t));
            if !wanted {
                continue;
            }
            self.data.lock().unwrap().auto.push(s.id.clone());
            self.save();
            if let Err(e) = self.start(s.id.clone()) {
                tracing::warn!(session = %s.id, "cannot keep a new session in sync: {}", e.message);
            }
        }
    }

    // ---- Setup in the copy ----

    fn load_projects(&self) -> std::collections::BTreeMap<String, ProjectChoices> {
        self.read_projects().unwrap_or_default()
    }

    /// `projects.json`: empty when there is none yet, an error when it
    /// cannot be read, so nothing writes over choices it failed to read.
    fn read_projects(&self) -> anyhow::Result<std::collections::BTreeMap<String, ProjectChoices>> {
        let file = self.home.join("sync").join("projects.json");
        match std::fs::read(&file) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| anyhow::anyhow!("{} cannot be read: {e}", file.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(anyhow::anyhow!("{}: {e}", file.display())),
        }
    }

    fn update_projects(
        &self,
        key: &str,
        f: impl FnOnce(&mut ProjectChoices),
    ) -> Result<(), RpcError> {
        let _one = self.projects.lock().unwrap();
        let mut all = self.read_projects().map_err(internal)?;
        f(all.entry(key.to_string()).or_default());
        let file = self.home.join("sync").join("projects.json");
        let bytes = serde_json::to_vec_pretty(&all).unwrap();
        crate::mobile::write_private(&file, &bytes)
            .map_err(|e| internal(format!("cannot write {}: {e:#}", file.display())))
    }

    fn set_setup(&self, id: &str, setup: Option<CopySetup>) {
        self.update_kept(id, |k| k.setup = setup);
        self.changed(id);
    }

    /// A copy just made: its setup runs when this exact command was
    /// approved for its project, and waits for the user otherwise.
    fn begin_setup(self: &Arc<Self>, id: &str) {
        let Some(k) = self.kept(id) else { return };
        let Some(command) = setup_command(Path::new(&k.path)) else {
            self.set_setup(id, None);
            return;
        };
        if self.approved(&k, &command) {
            self.run_setup_now(id, command);
        } else {
            self.set_setup(
                id,
                Some(CopySetup {
                    state: SetupState::NeedsApproval,
                    command,
                    approved: false,
                }),
            );
        }
    }

    /// `sync.run_setup`: the user approved `command`, which must still be
    /// the copy's setup; it is remembered for the project and runs.
    pub async fn run_setup(self: &Arc<Self>, copy: &str, command: &str) -> Result<Copy, RpcError> {
        // Not while the copy is being removed, nor two at once.
        let lock = self.lock(copy);
        let _one = lock.lock().await;
        let k = self
            .kept(copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if k.path.is_empty() {
            return Err(RpcError::new("not_ready", "the copy is not made yet"));
        }
        let Some(current) = setup_command(Path::new(&k.path)) else {
            return Err(RpcError::new("no_setup", "the copy has no setup script"));
        };
        if current != command {
            return Err(RpcError::new("setup_changed", current));
        }
        if let Some(key) = k.identity.as_ref().and_then(|i| project_key(&k.host, i)) {
            self.update_projects(&key, |p| {
                if !p.approved_setup.contains(&current) {
                    p.approved_setup.push(current.clone());
                }
            })?;
        }
        self.run_setup_now(copy, current);
        self.copy(copy)
    }

    /// Copy `id` as the app sees it, or `not_found` when it went meanwhile.
    fn copy(&self, id: &str) -> Result<Copy, RpcError> {
        self.kept(id)
            .map(|k| self.copy_of(&k))
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))
    }

    /// `sync.skip_setup`: a setup waiting for approval is not run.
    pub fn skip_setup(&self, copy: &str) -> Result<Copy, RpcError> {
        let k = self
            .kept(copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if let Some(setup) = k.setup
            && setup.state == SetupState::NeedsApproval
        {
            self.set_setup(
                copy,
                Some(CopySetup {
                    state: SetupState::Skipped,
                    ..setup
                }),
            );
        }
        self.copy(copy)
    }

    /// Runs `command` in copy `id` as X1 runs a setup, its output in
    /// `sync/logs/<id>.log`. A setup still running is stopped first. The
    /// process starts, and is recorded, before this returns, so a
    /// `sync.stop` right after finds it.
    fn run_setup_now(self: &Arc<Self>, id: &str, command: String) {
        self.end_setup(id);
        let Some(k) = self.kept(id) else { return };
        let run = self.runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let log = self
            .home
            .join("sync")
            .join("logs")
            .join(format!("{id}.log"));
        let started = self.spawn_setup(id, run, &k, &command, &log);
        let running = move |state| CopySetup {
            state,
            command: command.clone(),
            approved: false,
        };
        let (mut child, reaped) = match started {
            Ok(started) => started,
            Err(e) => {
                tracing::warn!(copy = %id, "cannot run setup: {e:#}");
                let _ = std::fs::write(&log, format!("cannot run setup: {e:#}\n"));
                self.set_setup(id, Some(running(SetupState::Failed { exit: -1 })));
                return;
            }
        };
        self.set_setup(id, Some(running(SetupState::Running)));
        let me = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let exit = match child.wait().await {
                Ok(status) => status.code().unwrap_or(-1),
                Err(_) => -1,
            };
            reaped.store(true, std::sync::atomic::Ordering::SeqCst);
            // A setup stopped or run again meanwhile reports nothing. The run
            // stays recorded, and its session too: jobs the setup left
            // running end when the copy goes or setup runs again.
            let setups = me.setups.lock().unwrap();
            if setups.get(&id).is_some_and(|s| s.run == run) {
                let state = if exit == 0 {
                    SetupState::Done
                } else {
                    SetupState::Failed { exit }
                };
                me.update_kept(&id, |k| k.setup = Some(running(state)));
                drop(setups);
                me.changed(&id);
            }
        });
    }

    fn spawn_setup(
        &self,
        id: &str,
        run: u64,
        k: &Kept,
        command: &str,
        log: &Path,
    ) -> anyhow::Result<(tokio::process::Child, Arc<std::sync::atomic::AtomicBool>)> {
        std::fs::create_dir_all(log.parent().unwrap())?;
        let out = std::fs::File::create(log)?;
        let err = out.try_clone()?;
        let mut cmd = tokio::process::Command::new(moonlet_core::pty::user_shell());
        cmd.args(["-lic", command])
            .current_dir(&k.path)
            .env_clear()
            .envs(&self.base_env)
            .envs([
                ("MOONLET_ROOT_PATH", k.repo.as_str()),
                ("MOONLET_SESSION_PATH", k.path.as_str()),
                ("MOONLET_SESSION_NAME", k.name.as_str()),
                ("MOONLET_BRANCH", k.branch.as_str()),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(out)
            .stderr(err);
        // SAFETY: setsid is async-signal-safe and touches no memory.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                // The daemon ignores SIGHUP and SIGPIPE; a setup must not.
                for sig in [libc::SIGPIPE, libc::SIGHUP] {
                    libc::signal(sig, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        let reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Some(pid) = child.id() {
            self.setups.lock().unwrap().insert(
                id.to_string(),
                SetupRun {
                    sid: pid,
                    run,
                    reaped: reaped.clone(),
                },
            );
            let started = moonlet_core::pty::process_start(pid);
            self.update_kept(id, |k| {
                k.setup_sid = Some(pid);
                k.setup_started = started;
            });
        }
        Ok((child, reaped))
    }

    /// Stops every process copy `id`'s setup started, as X1 stops a closed
    /// tab's script: SIGHUP, then SIGTERM after 1.5 s, then SIGKILL after
    /// 3 s more, until none is left in its session.
    fn end_setup(&self, id: &str) {
        let Some(s) = self.setups.lock().unwrap().remove(id) else {
            return;
        };
        // A setup still running when stopped reads as ended by a signal.
        self.update_kept(id, |k| {
            k.setup_sid = None;
            k.setup_started = None;
            if let Some(setup) = &mut k.setup
                && setup.state == SetupState::Running
            {
                setup.state = SetupState::Failed { exit: -1 };
            }
        });
        end_session(s.sid, s.reaped);
    }

    /// `sync.use_central_branch`: a diverged copy's branch moves to the
    /// central host's commit, and this Mac's commits stay on a branch of
    /// their own, `<branch>-this-mac`. The files stay as they are.
    pub async fn use_central_branch(self: &Arc<Self>, id: &str) -> Result<Copy, RpcError> {
        {
            let lock = self.lock(id);
            let _one = lock.lock().await;
            let k = self
                .kept(id)
                .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
            let Some(central) = k.base_head.clone().filter(|_| k.diverged.is_some()) else {
                return Err(RpcError::new(
                    "invalid_params",
                    "the branch has not diverged",
                ));
            };
            let path = PathBuf::from(&k.path);
            let repo = PathBuf::from(&k.repo);
            // Only the session's branch moves, never another one checked out.
            let branch = self.branch_of(&k, &path).await?;
            if git_sync::branch(&path).await.map_err(internal)?.as_deref() != Some(branch.as_str())
            {
                return Err(RpcError::new(
                    "paused",
                    format!("the copy is not on {branch}"),
                ));
            }
            let own = git_sync::head(&path).await.map_err(internal)?;
            let mut name = format!("{branch}-this-mac");
            let mut n = 1;
            while git_sync::branch_exists(&repo, &name).await {
                n += 1;
                name = format!("{branch}-this-mac-{n}");
            }
            git_sync::create_branch(&repo, &name, &own)
                .await
                .map_err(internal)?;
            if let Err(e) = git_sync::reset_branch(&path, &own, &central).await {
                // Nothing moved: the backup branch would only be clutter.
                let _ = git_sync::delete_branch(&repo, &name, &own).await;
                return Err(internal(e));
            }
            self.update_kept(id, |kept| {
                kept.head = Some(central.clone());
                kept.diverged = None;
            });
        }
        self.changed(id);
        // The files are as they were; the central host hears of the commit.
        self.offer_later(id);
        Ok(self.copy_of(&self.kept(id).unwrap()))
    }

    /// Takes in a pack from the central host; one git refuses pauses the copy.
    async fn unpack_from_central(
        &self,
        k: &Kept,
        repo: &Path,
        pack: &[u8],
    ) -> Result<(), RpcError> {
        match git_sync::unpack(repo, pack).await {
            Ok(()) => Ok(()),
            Err(UnpackError::Git(e)) => Err(internal(format!("{e:#}"))),
            Err(e) => {
                let why = refused(&k.host, &e);
                self.pause(&k.id, why.clone());
                Err(RpcError::new("paused", why))
            }
        }
    }

    /// Pauses the copy when `tree` reaches outside it.
    async fn check_paths(&self, k: &Kept, repo: &Path, tree: &str) -> Result<(), RpcError> {
        let files = git_sync::read_files(repo, tree).await.map_err(internal)?;
        if git_sync::unsafe_path(&files).is_some() {
            return Err(self.pause_outside(k));
        }
        Ok(())
    }

    fn pause_outside(&self, k: &Kept) -> RpcError {
        self.pause(&k.id, outside(&k.host));
        RpcError::new("paused", outside(&k.host))
    }

    // ---- The central host, serving copies ----

    fn served(&self, id: &str) -> Option<Served> {
        self.data
            .lock()
            .unwrap()
            .central
            .iter()
            .find(|s| s.id == id)
            .cloned()
    }

    /// The worker on `conn`, which must own `copy` if it is served already.
    fn owner(&self, conn: &Conn, copy: &str) -> Result<String, RpcError> {
        let worker = self
            .workers
            .worker_on(conn.id)
            .ok_or_else(|| RpcError::new("forbidden", "only a linked worker keeps copies"))?;
        if let Some(s) = self.served(copy)
            && s.worker != worker
        {
            return Err(RpcError::new("forbidden", "another worker's copy"));
        }
        Ok(worker)
    }

    /// `sync.open` from a worker: what it needs to make a copy of a session.
    pub async fn open(
        self: &Arc<Self>,
        conn: &Conn,
        req: SyncOpen,
    ) -> Result<SyncOpened, RpcError> {
        let worker = self.owner(conn, &req.copy)?;
        if req.copy.is_empty()
            || !req
                .copy
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(RpcError::new("invalid_params", "invalid copy id"));
        }
        let session = self
            .sessions
            .session(&req.session)
            .ok()
            .filter(|s| !s.archived)
            .ok_or_else(|| RpcError::new("not_found", "the session is gone"))?;
        let project = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == session.project_id)
            .ok_or_else(|| RpcError::new("not_found", "the session's project is gone"))?;
        let path = Path::new(&session.path);
        let head = git_sync::head(path).await.map_err(internal)?;
        let repo = git_sync::common_dir(path)
            .await
            .map(|d| d.display().to_string())
            .unwrap_or_default();
        let origin_url = moonlet_core::git::origin_url(Path::new(&project.path))
            .await
            .map(|u| git_sync::scrub_url(&u));
        {
            let mut data = self.data.lock().unwrap();
            data.central.retain(|s| s.id != req.copy);
            data.central.push(Served {
                id: req.copy.clone(),
                worker,
                session: session.id.clone(),
                path: session.path.clone(),
                base: None,
                base_head: None,
                central_tree: None,
                differs: Vec::new(),
                branch: session.branch.clone(),
                repo,
                off_branch_sent: false,
            });
        }
        self.save();
        self.watch(path);
        Ok(SyncOpened {
            path: session.path,
            branch: session.branch,
            head,
            name: session.name,
            project: project.name,
            identity: project.identity,
            origin_url,
        })
    }

    /// `sync.fetch` from a worker: the session's files and commit now, as
    /// the copy's base. With `again`, the worker asks for an update instead.
    pub async fn fetch(
        self: &Arc<Self>,
        conn: &Conn,
        req: SyncFetch,
    ) -> Result<SyncFetched, RpcError> {
        self.owner(conn, &req.copy)?;
        let served = self
            .served(&req.copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if req.again {
            let me = self.clone();
            tokio::spawn(async move { me.push(&req.copy, true).await });
            return Ok(SyncFetched {
                tree: String::new(),
                head: String::new(),
                too_big: Vec::new(),
                pack: None,
            });
        }
        let lock = self.lock(&format!("session:{}", served.path));
        let _one = lock.lock().await;
        let path = Path::new(&served.path);
        let snap = git_sync::snapshot(path, MAX_FILE).await.map_err(internal)?;
        let head = git_sync::head(path).await.map_err(internal)?;
        let have = git_sync::present(path, &req.have).await.map_err(internal)?;
        let have: Vec<&str> = have.iter().map(String::as_str).collect();
        let pack = git_sync::pack_objects(path, &[&snap.tree, &head], &have)
            .await
            .map_err(internal)?;
        let pack = send_pack(&pack, |p| conn.send_pack(p))?;
        git_sync::set_base_ref(path, &req.copy, &snap.tree)
            .await
            .map_err(internal)?;
        self.set_served_base(&req.copy, &snap.tree, &head);
        Ok(SyncFetched {
            tree: snap.tree,
            head,
            too_big: snap.too_big,
            pack,
        })
    }

    /// `sync.close` from a worker: it no longer keeps the copy.
    pub async fn close(&self, conn: &Conn, copy: &str) -> Result<bool, RpcError> {
        self.owner(conn, copy)?;
        self.forget(copy).await;
        Ok(true)
    }

    /// Forgets served copy `id` and its base's ref.
    async fn forget(&self, id: &str) {
        let Some(served) = self.served(id) else {
            return;
        };
        let repo = served_repo(&served);
        self.forget_served(&served, &repo).await;
    }

    /// Forgets `served`, deleting its base's ref in `repo` (the session's
    /// worktree, or its repository's git dir once the worktree is gone).
    /// The session stops being watched once it serves no copy.
    async fn forget_served(&self, served: &Served, repo: &Path) {
        let last = {
            let mut data = self.data.lock().unwrap();
            data.central.retain(|s| s.id != served.id);
            !data.central.iter().any(|s| s.path == served.path)
        };
        self.save();
        let _ = git_sync::delete_base_ref(repo, &served.id).await;
        if last {
            self.unwatch(Path::new(&served.path));
        }
    }

    /// Session `session` is about to be archived: what [`Self::archived`]
    /// needs once it is, read while its worktree is still there.
    pub async fn archiving(&self, session: &str) -> Archiving {
        let served: Vec<Served> = self
            .data
            .lock()
            .unwrap()
            .central
            .iter()
            .filter(|s| s.session == session)
            .cloned()
            .collect();
        let mut copies = Vec::new();
        for s in served {
            let repo = match s.repo.is_empty() {
                false => PathBuf::from(&s.repo),
                true => git_sync::common_dir(Path::new(&s.path))
                    .await
                    .unwrap_or_else(|_| PathBuf::from(&s.path)),
            };
            copies.push((s, repo));
        }
        Archiving {
            session: session.to_string(),
            copies,
        }
    }

    /// The session was archived: each linked worker removes its copy,
    /// saving what would be lost, and one that is offline hears so when it
    /// links again. Nothing waits for the workers. The session then serves
    /// no copies.
    pub fn archived(self: &Arc<Self>, archiving: Archiving) {
        // A copy opened while the archive ran is let go too.
        let mut copies = archiving.copies;
        let late: Vec<Served> = self
            .data
            .lock()
            .unwrap()
            .central
            .iter()
            .filter(|s| s.session == archiving.session && !copies.iter().any(|(c, _)| c.id == s.id))
            .cloned()
            .collect();
        copies.extend(late.into_iter().map(|s| {
            let repo = served_repo(&s);
            (s, repo)
        }));
        for (s, repo) in copies {
            if let Some(conn) = self.workers.conn(&s.worker) {
                let req = SyncClosing {
                    copy: s.id.clone(),
                    reason: CloseReason::Archived,
                };
                tokio::spawn(async move {
                    let _ = conn
                        .request(
                            m::SYNC_CLOSING,
                            serde_json::to_value(req).unwrap(),
                            CLOSING_TIMEOUT,
                        )
                        .await;
                });
            }
            let me = self.clone();
            tokio::spawn(async move { me.forget_served(&s, &repo).await });
        }
    }

    /// Copy `id` and the session agree on `tree` and `head`.
    fn set_served_base(&self, id: &str, tree: &str, head: &str) {
        self.update_served(id, |s| {
            s.base = Some(tree.to_string());
            s.base_head = Some(head.to_string());
            s.central_tree = Some(tree.to_string());
            s.differs.clear();
        });
    }

    fn update_served(&self, id: &str, f: impl FnOnce(&mut Served)) {
        if let Some(s) = self
            .data
            .lock()
            .unwrap()
            .central
            .iter_mut()
            .find(|s| s.id == id)
        {
            f(s);
        }
        self.save();
    }

    /// `sync.offer` from a worker: reconciles its files with the session's
    /// against the worker's base, applies the session's part, and answers
    /// the worker's. The other copies of the session get the change.
    pub async fn reconcile_offer(
        self: &Arc<Self>,
        conn: &Conn,
        req: SyncOffer,
        pack: Option<Vec<u8>>,
    ) -> Result<SyncOffered, RpcError> {
        self.owner(conn, &req.copy)?;
        object_ids(&[&req.tree, &req.base, &req.head])?;
        let served = self
            .served(&req.copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        let lock = self.lock(&format!("session:{}", served.path));
        let _one = lock.lock().await;
        let path = Path::new(&served.path);
        if let Some(off) = off_branch(path, &served.branch).await.map_err(internal)? {
            // The worker pauses; the session's return to its branch tells it.
            self.update_served(&req.copy, |s| s.off_branch_sent = true);
            return Err(RpcError::new("wrong_branch", off));
        }
        if let Some(pack) = pack {
            git_sync::unpack(path, &pack)
                .await
                .map_err(|e| RpcError::new("refused", e.to_string()))?;
        }
        // The worker's base: a reply it never got leaves it at the one before.
        let base = if git_sync::present(path, std::slice::from_ref(&req.base))
            .await
            .map_err(internal)?
            .is_empty()
        {
            served
                .base
                .clone()
                .ok_or_else(|| RpcError::new("copying", "the copy is not made yet"))?
        } else {
            req.base.clone()
        };
        let worker = git_sync::read_files(path, &req.tree)
            .await
            .map_err(internal)?;
        if git_sync::unsafe_path(&worker).is_some() {
            return Err(RpcError::new("forbidden", "a path outside the session"));
        }
        let base_files = git_sync::read_files(path, &base).await.map_err(internal)?;
        let mut done = None;
        for _ in 0..APPLY_TRIES {
            let snap = git_sync::snapshot(path, MAX_FILE).await.map_err(internal)?;
            let central = git_sync::read_files(path, &snap.tree)
                .await
                .map_err(internal)?;
            let mut b = base_files.clone();
            if let Some(res) = &req.resolve {
                // The kept side's version stands as unchanged since the
                // base, so the other side's, as changed, gives way to it.
                let unchanged = match res.keep {
                    Keep::Central => worker.get(&res.path),
                    Keep::Worker => central.get(&res.path),
                };
                match unchanged {
                    Some(e) => b.insert(res.path.clone(), e.clone()),
                    None => b.remove(&res.path),
                };
            }
            let r = git_sync::reconcile(&b, &central, &worker);
            let central_tree = git_sync::write_files(path, &r.central)
                .await
                .map_err(internal)?;
            if central_tree != snap.tree {
                match git_sync::apply(path, &snap.tree, &central_tree).await {
                    Ok(()) => {}
                    Err(ApplyError::Changed(_)) => continue,
                    Err(ApplyError::Unsafe(_)) => {
                        return Err(RpcError::new("forbidden", "a path outside the session"));
                    }
                    Err(ApplyError::Git(e)) => return Err(internal(format!("{e:#}"))),
                }
            }
            let worker_tree = git_sync::write_files(path, &r.worker)
                .await
                .map_err(internal)?;
            let new_base = git_sync::write_files(path, &r.base)
                .await
                .map_err(internal)?;
            done = Some((central_tree, worker_tree, new_base, r.differs, snap.too_big));
            break;
        }
        let Some((central_tree, worker_tree, new_base, differs, mut too_big)) = done else {
            return Err(RpcError::new("busy", "the session kept changing"));
        };
        // The session's branch moves up to the copy's commits.
        let mut head = git_sync::head(path).await.map_err(internal)?;
        // A copy saved before branches were kept names none: its commits
        // wait rather than move `refs/heads/`.
        if req.head != head
            && !served.branch.is_empty()
            && git_sync::is_ancestor(path, &head, &req.head)
                .await
                .map_err(internal)?
        {
            git_sync::fast_forward(path, &served.branch, &head, &req.head)
                .await
                .map_err(internal)?;
            head = req.head.clone();
        }
        git_sync::set_base_ref(path, &req.copy, &new_base)
            .await
            .map_err(internal)?;
        self.update_served(&req.copy, |s| {
            s.base = Some(new_base.clone());
            s.base_head = Some(head.clone());
            s.central_tree = Some(central_tree.clone());
            s.differs = differs.clone();
        });
        let not = git_sync::present(path, &[req.tree.clone(), base.clone(), req.head.clone()])
            .await
            .map_err(internal)?;
        let not: Vec<&str> = not.iter().map(String::as_str).collect();
        let pack = git_sync::pack_objects(path, &[&worker_tree, &new_base, &head], &not)
            .await
            .map_err(internal)?;
        let pack = send_pack(&pack, |p| conn.send_pack(p))?;
        // The session's other copies get what this one brought.
        let others: Vec<String> = self
            .data
            .lock()
            .unwrap()
            .central
            .iter()
            .filter(|s| s.path == served.path && s.id != req.copy)
            .map(|s| s.id.clone())
            .collect();
        for id in others {
            let me = self.clone();
            tokio::spawn(async move { me.push(&id, false).await });
        }
        too_big.extend(req.too_big);
        too_big.sort();
        too_big.dedup();
        Ok(SyncOffered {
            from: req.tree,
            tree: worker_tree,
            base: new_base,
            head,
            differs,
            too_big,
            pack,
        })
    }

    /// A worker linked: it gets the state of each of its copies, changed or
    /// not, so it knows it is in sync.
    pub fn worker_linked(self: &Arc<Self>, worker: &str) {
        let ids: Vec<String> = self
            .data
            .lock()
            .unwrap()
            .central
            .iter()
            .filter(|s| s.worker == worker && s.base.is_some())
            .map(|s| s.id.clone())
            .collect();
        for id in ids {
            if let Some(s) = self.served(&id) {
                self.watch(Path::new(&s.path));
            }
            let me = self.clone();
            tokio::spawn(async move { me.push(&id, true).await });
        }
    }

    /// Sends copy `id`'s worker what changed in its session since their
    /// base; with `always`, also when nothing did.
    async fn push(&self, id: &str, always: bool) {
        let Some(served) = self.served(id) else {
            return;
        };
        let lock = self.lock(&format!("session:{}", served.path));
        let _one = lock.lock().await;
        // Again under the lock: the base may have moved meanwhile.
        let Some(served) = self.served(id) else {
            return;
        };
        let (Some(base), Some(base_head)) = (served.base.clone(), served.base_head.clone()) else {
            return;
        };
        let Some(conn) = self.workers.conn(&served.worker) else {
            return;
        };
        let path = Path::new(&served.path);
        if let Err(e) = self
            .push_to(&conn, &served, path, &base, &base_head, always)
            .await
        {
            if e.downcast_ref::<RpcError>()
                .is_some_and(|e| e.code == "not_found")
            {
                // The worker no longer keeps it.
                drop(_one);
                self.forget(id).await;
                return;
            }
            tracing::debug!(copy = %id, "update not sent: {e:#}");
        }
    }

    async fn push_to(
        &self,
        conn: &Conn,
        served: &Served,
        path: &Path,
        base: &str,
        base_head: &str,
        always: bool,
    ) -> anyhow::Result<()> {
        if let Some(off) = off_branch(path, &served.branch).await? {
            if !served.off_branch_sent {
                let req = SyncUpdate {
                    copy: served.id.clone(),
                    base: base.to_string(),
                    tree: base.to_string(),
                    head: base_head.to_string(),
                    too_big: Vec::new(),
                    pack: None,
                    off_branch: Some(off),
                };
                conn.request(m::SYNC_UPDATE, serde_json::to_value(req)?, UPDATE_TIMEOUT)
                    .await
                    .map_err(anyhow::Error::from)?;
                self.update_served(&served.id, |s| s.off_branch_sent = true);
            }
            return Ok(());
        }
        // Back on the branch: the paused worker hears so.
        let always = always || served.off_branch_sent;
        let snap = git_sync::snapshot(path, MAX_FILE).await?;
        let head = git_sync::head(path).await?;
        if !always
            && served.central_tree.as_deref() == Some(snap.tree.as_str())
            && head == base_head
        {
            return Ok(());
        }
        let pack = git_sync::pack_objects(path, &[&snap.tree, &head], &[base, base_head]).await?;
        let pack =
            send_pack(&pack, |p| conn.send_pack(p)).map_err(|e| anyhow::anyhow!(e.message))?;
        let req = SyncUpdate {
            copy: served.id.clone(),
            base: base.to_string(),
            tree: snap.tree.clone(),
            head: head.clone(),
            too_big: snap.too_big,
            pack,
            off_branch: None,
        };
        let reply: SyncUpdated = serde_json::from_value(
            conn.request_after_queue(m::SYNC_UPDATE, serde_json::to_value(req)?, UPDATE_TIMEOUT)
                .await
                .map_err(anyhow::Error::from)?,
        )?;
        // Heard only when the worker took the update or answered with its
        // files; one busy elsewhere hears it again next time.
        if served.off_branch_sent && (reply.applied || reply.tree.is_some()) {
            self.update_served(&served.id, |s| s.off_branch_sent = false);
        }
        // Taken: both are at the session's files. Otherwise the worker
        // offers its own, and that round decides.
        if reply.applied {
            git_sync::set_base_ref(path, &served.id, &snap.tree).await?;
            self.set_served_base(&served.id, &snap.tree, &head);
        }
        Ok(())
    }

    /// Watches a session's worktree on the central host, or a copy's on this
    /// Mac; each change wakes its loop, which sends the session's changes
    /// to its copies or offers the copy's.
    fn watch(self: &Arc<Self>, path: &Path) {
        let Ok(root) = path.canonicalize() else {
            return;
        };
        {
            let mut kicks = self.kicks.lock().unwrap();
            if kicks.contains_key(&root) {
                return;
            }
            kicks.insert(root.clone(), Arc::new(Notify::new()));
        }
        if let Err(e) = self
            .watchers
            .watch(&root.display().to_string(), WATCH_CLIENT)
        {
            tracing::warn!("cannot watch {}: {e:#}", root.display());
        }
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut last: Option<(Option<String>, Option<String>)> = None;
            loop {
                let Some(kick) = me
                    .upgrade()
                    .and_then(|s| s.kicks.lock().unwrap().get(&root).cloned())
                else {
                    return;
                };
                let kicked = tokio::time::timeout(HEAD_POLL, kick.notified())
                    .await
                    .is_ok();
                // A commit or a checkout changes no file the watcher sees.
                let now = (
                    git_sync::head(&root).await.ok(),
                    git_sync::branch(&root).await.ok().flatten(),
                );
                let Some(s) = me.upgrade() else { return };
                if s.gone(&root) {
                    return;
                }
                // A side can leave its branch and come back between two
                // looks; a copy waiting on a branch is looked at every time.
                if !kicked && last.as_ref() == Some(&now) && !s.waits_on_branch(&root) {
                    continue;
                }
                last = Some(now);
                let at_root = |p: &str| Path::new(p).canonicalize().ok().as_deref() == Some(&root);
                let (served, kept): (Vec<String>, Vec<String>) = {
                    let data = s.data.lock().unwrap();
                    (
                        data.central
                            .iter()
                            .filter(|c| at_root(&c.path))
                            .map(|c| c.id.clone())
                            .collect(),
                        data.worker
                            .iter()
                            .filter(|k| at_root(&k.path))
                            .map(|k| k.id.clone())
                            .collect(),
                    )
                };
                for id in served {
                    s.push(&id, false).await;
                }
                for id in kept {
                    let force = s.resume_on_branch(&id, &root).await;
                    s.offer_until_taken(&id, force).await;
                }
            }
        });
    }

    /// Whether a copy at `root`, kept or served, waits for a side to be back
    /// on the session's branch.
    fn waits_on_branch(&self, root: &Path) -> bool {
        let at_root = |p: &str| Path::new(p).canonicalize().ok().as_deref() == Some(root);
        let data = self.data.lock().unwrap();
        data.central
            .iter()
            .any(|c| c.off_branch_sent && at_root(&c.path))
            || data
                .worker
                .iter()
                .any(|k| k.branch_pause == Some(Side::Copy) && at_root(&k.path))
    }

    /// A copy paused because it left the session's branch resumes once it is
    /// back on it; gives whether it did.
    async fn resume_on_branch(&self, id: &str, path: &Path) -> bool {
        let Some(k) = self.kept(id) else { return false };
        if k.branch_pause != Some(Side::Copy) {
            return false;
        }
        let back = git_sync::branch(path)
            .await
            .ok()
            .flatten()
            .is_some_and(|b| b == k.branch);
        if back {
            self.unpause(id);
        }
        back
    }

    fn kick(&self, root: &Path) {
        if let Some(k) = self.kicks.lock().unwrap().get(root) {
            k.notify_one();
        }
    }
}

/// The copy's setup command, exactly as its `.moonlet/config.toml` has it;
/// none when blank.
fn setup_command(copy: &Path) -> Option<String> {
    moonlet_core::project_config::load(copy, String::new())
        .config
        .setup
        .filter(|c| !c.trim().is_empty())
}

/// Applies `target` to the copy at `path` from a fresh snapshot, trying
/// again while the copy changes under it.
async fn apply_tries(path: &Path, target: &str, host: &str) -> Result<(), Stop> {
    for _ in 0..APPLY_TRIES {
        let local = git_sync::snapshot(path, MAX_FILE)
            .await
            .map_err(|e| Stop::Paused(format!("{e:#}")))?;
        if local.tree == target {
            return Ok(());
        }
        match git_sync::apply(path, &local.tree, target).await {
            Ok(()) => return Ok(()),
            Err(ApplyError::Changed(_)) => continue,
            Err(ApplyError::Unsafe(_)) => return Err(Stop::Paused(outside(host))),
            Err(ApplyError::Git(e)) => return Err(Stop::Paused(format!("{e:#}"))),
        }
    }
    Err(Stop::Paused(
        "the copy kept changing while it was made".into(),
    ))
}

/// Sends `pack` with `send` and gives its transfer id; none when empty.
fn send_pack(
    pack: &[u8],
    send: impl FnOnce(&[u8]) -> Result<u32, RpcError>,
) -> Result<Option<u32>, RpcError> {
    if pack.is_empty() {
        Ok(None)
    } else {
        send(pack).map(Some)
    }
}

/// The central host's `answer` to an offer of `offered`, with each file
/// edited since the offer (as it is `now`) kept as it is now.
fn keep_edits(
    offered: &git_sync::Files,
    now: &git_sync::Files,
    answer: &git_sync::Files,
) -> git_sync::Files {
    let mut out = answer.clone();
    for path in offered.keys().chain(now.keys()) {
        if offered.get(path) != now.get(path) {
            match now.get(path) {
                Some(e) => out.insert(path.clone(), e.clone()),
                None => out.remove(path),
            };
        }
    }
    out
}

/// The base after a round: `answer_base`, the central host's, except that
/// each file edited since the offer of `offered` (as `now` shows) keeps the
/// version it had in the offer, the one the edit was made on.
fn base_of_edits(
    offered: &git_sync::Files,
    now: &git_sync::Files,
    answer_base: &git_sync::Files,
) -> git_sync::Files {
    let mut out = answer_base.clone();
    for path in offered.keys().chain(now.keys()) {
        if offered.get(path) != now.get(path) {
            match offered.get(path) {
                Some(e) => out.insert(path.clone(), e.clone()),
                None => out.remove(path),
            };
        }
    }
    out
}

/// The branch the session at `path` is on when it is not `branch` (empty
/// for a detached `HEAD`), or `None` when it is.
async fn off_branch(path: &Path, branch: &str) -> anyhow::Result<Option<String>> {
    let now = git_sync::branch(path).await?;
    Ok(match now {
        Some(b) if branch.is_empty() || b == branch => None,
        Some(b) => Some(b),
        None => Some(String::new()),
    })
}

fn outside(host: &str) -> String {
    format!("{host} sent a path outside the copy.")
}

/// Why a copy pauses over a pack from `host` that git refused.
fn refused(host: &str, e: &UnpackError) -> String {
    match e {
        UnpackError::Unsafe(_) => outside(host),
        e => format!("{host} sent files git refuses: {e}"),
    }
}

/// Reconciles a copy made before and never finished: `made_from` (the
/// worktree's files when it was made) against the central host's files and
/// the copy's own. Files only this Mac changed keep its version and stay a
/// change against the base, so they are offered rather than taken as
/// agreed.
fn resume(made_from: &Files, central: &Files, local: &Files) -> git_sync::Reconciled<Files> {
    let mut r = git_sync::reconcile(made_from, central, local);
    let edited: Vec<&String> = made_from
        .keys()
        .chain(local.keys())
        .filter(|p| local.get(*p) != made_from.get(*p) && !r.differs.contains(*p))
        .collect();
    for p in edited {
        match made_from.get(p) {
            Some(e) => r.base.insert(p.clone(), e.clone()),
            None => r.base.remove(p),
        };
    }
    r
}

/// How many files differ between two trees.
async fn changed_paths(repo: &Path, a: &str, b: &str) -> u32 {
    let (Ok(a), Ok(b)) = (
        git_sync::read_files(repo, a).await,
        git_sync::read_files(repo, b).await,
    ) else {
        return 0;
    };
    a.keys()
        .chain(b.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|p| a.get(*p) != b.get(*p))
        .count() as u32
}

/// Where a copy goes: the session's own path when it is
/// `<worktrees>/<project>/<session>` on this Mac, nothing is there yet, no
/// repository holds it and no other copy has it, else `fallback`. The path
/// comes from the central host, so it may never point elsewhere on this Mac,
/// not by `..` nor through a symlink, nor into a repository's own folder.
fn copy_path(session: &Path, worktrees: &Path, taken: &[PathBuf], fallback: PathBuf) -> PathBuf {
    let shaped = session.strip_prefix(worktrees).is_ok_and(|rest| {
        rest.components().count() == 2
            && rest
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
    });
    let in_a_repository = || {
        [worktrees, session.parent().unwrap_or(worktrees), session]
            .iter()
            .any(|p| p.join(".git").exists())
    };
    let other_copy = || {
        taken
            .iter()
            .any(|t| t.starts_with(session) || session.starts_with(t))
    };
    if shaped && !in_a_repository() && !other_copy() && inside(session, worktrees) && free(session)
    {
        session.to_path_buf()
    } else {
        fallback
    }
}

/// Whether absolute `path` is below `root`, with symlinks resolved, making
/// the parent folders it needs only once that holds.
fn inside(path: &Path, root: &Path) -> bool {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return false;
    }
    let Ok(rest) = path.strip_prefix(root) else {
        return false;
    };
    if rest.as_os_str().is_empty() || std::fs::create_dir_all(root).is_err() {
        return false;
    }
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    // The deepest folder that exists, resolved; the rest is made below it.
    let mut existing = path.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return false;
        }
    }
    let Ok(real) = existing.canonicalize() else {
        return false;
    };
    let below = real.join(path.strip_prefix(&existing).unwrap_or(Path::new("")));
    if !below.starts_with(&root) || below == root {
        return false;
    }
    path.parent()
        .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
}

/// `copies/<host>/<project>/<session>` under `home`. The names come from
/// the central host, so each is one plain folder name (see [`segment`]).
fn copies_dir(home: &Path, host: &str, project: &str, session: &str) -> PathBuf {
    let base = home.join("copies");
    let dir = base
        .join(segment(host))
        .join(segment(project))
        .join(segment(session));
    debug_assert!(dir.starts_with(&base));
    dir
}

/// `dir`, or `dir-2`, `dir-3` and so on: the first that is empty or missing
/// and that no other copy holds.
fn free_folder(dir: PathBuf, taken: &[PathBuf]) -> PathBuf {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    std::iter::once(dir.clone())
        .chain((2..).map(|n| dir.with_file_name(format!("{name}-{n}"))))
        .find(|d| free(d) && !taken.contains(d))
        .unwrap()
}

/// `clones/<host>/<16 hex digits of the origin's SHA-256>` under `home`,
/// with a port's `:` as `_`: one folder per origin, never inside another's
/// whatever the central host names, `github.com/acme/shop/repo` included.
fn clone_dir(home: &Path, origin: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let host = origin
        .split('/')
        .next()
        .unwrap_or_default()
        .replace(':', "_");
    let hash: String = Sha256::digest(origin.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    let base = home.join("clones");
    let dir = base.join(segment(&host)).join(hash);
    debug_assert!(dir.starts_with(&base));
    dir
}

/// A clone folder found on disk may be used: it lies under `home`'s
/// `clones` and no folder on the way there, itself included, is a link.
fn clone_folder_ok(home: &Path, dir: &Path) -> bool {
    let base = home.join("clones");
    let Ok(rest) = dir.strip_prefix(&base) else {
        return false;
    };
    let mut at = base.clone();
    if at
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return false;
    }
    for part in rest.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return false;
        }
        at.push(part);
        match at.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    true
}

/// `name` as one folder name: itself when it is up to 100 of
/// `[A-Za-z0-9._-]` and not `.` or `..`, else the first 16 hex digits of
/// its SHA-256, so nothing a peer sends can leave the folder it goes in.
fn segment(name: &str) -> String {
    let plain = !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if plain {
        return name.to_string();
    }
    use sha2::{Digest, Sha256};
    Sha256::digest(name.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Nothing at `path`, or an empty folder.
fn free(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// A session's copies, read before it is archived.
pub struct Archiving {
    session: String,
    copies: Vec<(Served, PathBuf)>,
}

/// Where served copy `s`'s base ref lives: its repository's git dir, or the
/// session's worktree for one saved before that was kept.
fn served_repo(s: &Served) -> PathBuf {
    PathBuf::from(if s.repo.is_empty() { &s.path } else { &s.repo })
}

/// A file that could not be saved before a copy went, and why.
#[derive(Debug)]
struct Unsaved {
    path: String,
    error: String,
}

impl Unsaved {
    fn new(path: &str, error: impl std::fmt::Display) -> Self {
        Self {
            path: path.to_string(),
            error: error.to_string(),
        }
    }
}

/// A folder under `root` for `name`'s leftovers, named for now:
/// `fix-cart-20261021-184500`, then `-2`, `-3`… when that is taken.
fn leftovers_folder(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{name}-{}", local_stamp()))
}

/// Makes the leftovers folder: `leftovers_folder`'s name, or the first of
/// `-2`, `-3`… nobody made yet. Made with `create_dir`, so two copies
/// stopped in the same second never share one.
fn make_leftovers_folder(root: &Path, name: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let first = leftovers_folder(root, name);
    let mut folder = first.clone();
    let mut n = 2;
    loop {
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                folder = PathBuf::from(format!("{}-{n}", first.display()));
                n += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Now on this Mac's clock, as `20261021-184500`.
fn local_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as libc::time_t);
    // SAFETY: `localtime_r` writes only into `tm`, which outlives the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// Saves `lost`, paths in copy `root`, under `folder` at the same paths;
/// gives those saved.
fn save_lost(
    root: &Path,
    folder: &Path,
    lost: impl IntoIterator<Item = String>,
) -> Result<Vec<String>, Unsaved> {
    let mut saved = Vec::new();
    for p in lost {
        // A path below a link names what the link points at, not the copy.
        if below_link(root, Path::new(&p)) {
            continue;
        }
        let from = root.join(&p);
        let Ok(meta) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        save_one(&from, folder, Path::new(&p), meta.file_type().is_symlink())
            .map_err(|e| Unsaved::new(&p, e))?;
        saved.push(p);
    }
    Ok(saved)
}

/// Whether a folder on the way from `root` to `rel` is a link.
fn below_link(root: &Path, rel: &Path) -> bool {
    rel.ancestors()
        .skip(1)
        .filter(|a| !a.as_os_str().is_empty())
        .any(|a| std::fs::symlink_metadata(root.join(a)).is_ok_and(|m| m.file_type().is_symlink()))
}

/// Copies `from` to `rel` under `folder`, making the folders on the way and
/// refusing one that is a link; a link is copied as the link, never as what
/// it points at.
fn save_one(from: &Path, folder: &Path, rel: &Path, link: bool) -> std::io::Result<()> {
    let mut dir = folder.to_path_buf();
    std::fs::create_dir_all(&dir)?;
    for part in rel.parent().into_iter().flat_map(Path::components) {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} is not a folder",
                    dir.display()
                )));
            }
            Err(_) => std::fs::create_dir(&dir)?,
        }
    }
    let to = folder.join(rel);
    if link {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Ends every process in session `sid` as X1 ends a closed tab's script:
/// SIGHUP, then SIGTERM after 1.5 s, then SIGKILL after 3 s more, until
/// none is left. `reaped` says the session's leader was waited for.
/// Ends a setup's session recorded before this daemon started. Its leader
/// is signalled only while it is the process that started at `started`; a
/// leader gone leaves its session's id unused by anyone else while members
/// remain, so those are ended.
fn end_recorded_session(sid: u32, started: Option<u64>) {
    let leader = moonlet_core::pty::process_start(sid);
    let gone = leader.is_none();
    if !gone && (started.is_none() || leader != started) {
        tracing::info!(
            sid,
            "a setup's recorded session is now another process's; left alone"
        );
        return;
    }
    end_session(sid, Arc::new(std::sync::atomic::AtomicBool::new(gone)));
}

fn end_session(sid: u32, reaped: Arc<std::sync::atomic::AtomicBool>) {
    use moonlet_core::pty::signal_session;
    use nix::sys::signal::Signal;
    let reaped = move || reaped.load(std::sync::atomic::Ordering::SeqCst);
    if signal_session(sid, Signal::SIGHUP, reaped()) {
        moonlet_core::pty::escalate_session(sid, reaped);
    }
}

/// `path` with the home folder as `~`.
fn tilde(path: &Path) -> String {
    match dirs::home_dir().and_then(|h| path.strip_prefix(h).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// Loads the copies: this Mac's wait for the link, which opens for them;
/// the central host watches the sessions it serves.
pub fn spawn(daemon: Arc<crate::daemon::Daemon>) {
    let sync = daemon.sync.clone();
    let (kept, served) = {
        let data = sync.data.lock().unwrap();
        (data.worker.clone(), data.central.clone())
    };
    // Every copy waits for the link; one not made yet says it copies only
    // once `make` really starts.
    for k in &kept {
        // The daemon stopped during a setup: its processes, in a session of
        // their own, outlived it, so they end now.
        if let Some(sid) = k.setup_sid {
            end_recorded_session(sid, k.setup_started);
        }
        let failed = k
            .setup
            .as_ref()
            .filter(|s| s.state == SetupState::Running)
            .map(|setup| CopySetup {
                state: SetupState::Failed { exit: -1 },
                command: setup.command.clone(),
                approved: false,
            });
        if k.setup_sid.is_some() || failed.is_some() {
            sync.update_kept(&k.id, |k| {
                if let Some(failed) = failed {
                    k.setup = Some(failed);
                }
                k.setup_sid = None;
                k.setup_started = None;
            });
        }
        sync.states
            .lock()
            .unwrap()
            .insert(k.id.clone(), CopyState::Waiting);
    }
    sync.link.set_synced(sync.link_holders());
    for s in served {
        sync.watch(Path::new(&s.path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_leftovers_folders_made_at_once_are_two() {
        let root = tempfile::tempdir().unwrap();
        let a = make_leftovers_folder(root.path(), "fix-cart").unwrap();
        let b = make_leftovers_folder(root.path(), "fix-cart").unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        let a_name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            b.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&a_name)
        );
    }

    #[test]
    fn an_offer_turned_away_waits_retries_pauses_or_stops_by_why() {
        use OfferNext::*;
        assert_eq!(after_offer_error("disconnected", 0), Wait);
        // A slow answer is not a dropped link: the offer is made again.
        assert_eq!(after_offer_error("timeout", 0), Retry);
        assert_eq!(after_offer_error("busy", 0), Retry);
        // The central host refusing the copy's files lasts: say so.
        assert_eq!(after_offer_error("refused", 0), Pause);
        for code in [
            "paused",
            "not_found",
            "not_ready",
            "forbidden",
            "invalid_params",
        ] {
            assert_eq!(after_offer_error(code, 0), Stop, "{code}");
        }
        // Failures, here or on the central host, are tried a few times.
        for code in ["failed", "internal"] {
            assert_eq!(after_offer_error(code, 0), Retry, "{code}");
            assert_eq!(after_offer_error(code, INTERNAL_TRIES - 1), Retry, "{code}");
            assert_eq!(after_offer_error(code, INTERNAL_TRIES), Stop, "{code}");
        }
    }

    #[test]
    fn only_full_object_ids_pass_from_the_other_side() {
        let id = "4171b03ff0d2bd434751f17bc9d34da784f97e72";
        assert!(object_ids(&[id, id]).is_ok());
        for bad in ["HEAD", "--all", "4171b03f", ""] {
            let e = object_ids(&[id, bad]).unwrap_err();
            assert_eq!(e.code, "invalid_params", "{bad}");
        }
    }

    #[test]
    fn stops_saved_before_they_named_their_host_still_load() {
        let data: Data = serde_json::from_str(
            r#"{ "closed": ["7d3f1c2a", { "copy": "5b0c7a3e", "host": "studio-mini" }] }"#,
        )
        .unwrap();
        assert_eq!(
            data.closed,
            vec![
                Closed {
                    copy: "7d3f1c2a".into(),
                    host: String::new()
                },
                Closed {
                    copy: "5b0c7a3e".into(),
                    host: "studio-mini".into()
                },
            ]
        );
    }

    #[test]
    fn leftovers_never_follow_a_link_out_of_the_copy() {
        let root = tempfile::tempdir().unwrap();
        let copy = root.path().join("copy");
        let outside = root.path().join("outside-dir");
        std::fs::create_dir_all(&copy).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "not the copy's").unwrap();
        std::fs::write(copy.join("a.txt"), "mine").unwrap();
        std::os::unix::fs::symlink(&outside, copy.join("link")).unwrap();
        let folder = root.path().join("leftovers");

        let saved = save_lost(
            &copy,
            &folder,
            ["a.txt", "link", "link/secret"].map(String::from),
        )
        .unwrap();

        assert_eq!(saved, ["a.txt", "link"]);
        assert_eq!(
            std::fs::read_to_string(folder.join("a.txt")).unwrap(),
            "mine"
        );
        assert_eq!(std::fs::read_link(folder.join("link")).unwrap(), outside);
        let listing: Vec<_> = std::fs::read_dir(&outside)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(listing, ["secret"]);
    }

    #[test]
    fn leftovers_are_never_written_through_a_link_in_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let copy = root.path().join("copy");
        let outside = root.path().join("outside-dir");
        std::fs::create_dir_all(copy.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(copy.join("sub/b.txt"), "mine").unwrap();
        let folder = root.path().join("leftovers");
        std::fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("sub")).unwrap();

        let e = save_lost(&copy, &folder, ["sub/b.txt".to_string()]).unwrap_err();

        assert_eq!(e.path, "sub/b.txt");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn a_copy_takes_the_sessions_path_when_it_is_free() {
        let root = tempfile::tempdir().unwrap();
        let worktrees = root.path().join("Users/alex/.moonlet/worktrees");
        let fallback = root
            .path()
            .join("Users/alex/.moonlet/copies/studio-mini/shop/fix-cart");
        let session = root
            .path()
            .join("Users/alex/.moonlet/worktrees/shop/fix-cart");
        assert_eq!(
            copy_path(&session, &worktrees, &[], fallback.clone()),
            session
        );

        // An empty folder there is free too.
        std::fs::create_dir_all(&session).unwrap();
        assert_eq!(
            copy_path(&session, &worktrees, &[], fallback.clone()),
            session
        );

        // Something there: the copy goes under copies/.
        std::fs::write(session.join("README.md"), "hi").unwrap();
        assert_eq!(
            copy_path(&session, &worktrees, &[], fallback.clone()),
            fallback
        );

        // A relative path.
        assert_eq!(
            copy_path(
                Path::new("worktrees/fix-cart"),
                &worktrees,
                &[],
                fallback.clone()
            ),
            fallback
        );
    }

    #[test]
    fn a_copy_takes_the_sessions_path_only_inside_this_macs_worktrees() {
        let root = tempfile::tempdir().unwrap();
        let worktrees = root.path().join("Users/alex/.moonlet/worktrees");
        std::fs::create_dir_all(&worktrees).unwrap();
        let fallback = root
            .path()
            .join("Users/alex/.moonlet/copies/studio-mini/shop/fix-cart");

        // Elsewhere in the home folder.
        let ssh = root.path().join("Users/alex/.ssh");
        assert_eq!(copy_path(&ssh, &worktrees, &[], fallback.clone()), fallback);
        // Back out of the worktrees with `..`.
        let back = root.path().join("Users/alex/.moonlet/worktrees/../.ssh");
        assert_eq!(
            copy_path(&back, &worktrees, &[], fallback.clone()),
            fallback
        );
        // The worktrees folder itself.
        assert_eq!(
            copy_path(&worktrees, &worktrees, &[], fallback.clone()),
            fallback
        );
        // Through a symlink in the worktrees that points outside them.
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, worktrees.join("shop")).unwrap();
        let through = root
            .path()
            .join("Users/alex/.moonlet/worktrees/shop/fix-cart");
        assert_eq!(
            copy_path(&through, &worktrees, &[], fallback.clone()),
            fallback
        );

        // Nothing was made for the refused paths.
        assert!(!ssh.exists());
        assert!(!root.path().join("Users/alex/.moonlet/.ssh").exists());
    }

    #[test]
    fn a_copy_takes_only_a_project_and_session_folder_no_repository_holds() {
        let root = tempfile::tempdir().unwrap();
        let worktrees = root.path().join("Users/alex/.moonlet/worktrees");
        std::fs::create_dir_all(&worktrees).unwrap();
        let fallback = root
            .path()
            .join("Users/alex/.moonlet/copies/studio-mini/shop/fix-cart");
        let at = |rest: &str| worktrees.join(rest);

        assert_eq!(
            copy_path(&at("shop/fix-cart"), &worktrees, &[], fallback.clone()),
            at("shop/fix-cart")
        );
        // One folder too few, or too many.
        assert_eq!(
            copy_path(&at("shop"), &worktrees, &[], fallback.clone()),
            fallback
        );
        assert_eq!(
            copy_path(&at("shop/fix-cart/sub"), &worktrees, &[], fallback.clone()),
            fallback
        );
        // Another copy's folder.
        assert_eq!(
            copy_path(
                &at("shop/fix-cart"),
                &worktrees,
                &[at("shop/fix-cart")],
                fallback.clone()
            ),
            fallback
        );
        // A project folder that is a repository itself.
        std::fs::create_dir_all(at("web/.git")).unwrap();
        assert_eq!(
            copy_path(&at("web/fix-cart"), &worktrees, &[], fallback.clone()),
            fallback
        );
    }

    #[test]
    fn a_copy_under_copies_takes_the_first_free_folder() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("copies/studio-mini/shop/fix-cart");
        assert_eq!(free_folder(dir.clone(), &[]), dir);
        // Something left there, and another copy holding the next name.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.txt"), "old\n").unwrap();
        let second = home.path().join("copies/studio-mini/shop/fix-cart-2");
        assert_eq!(
            free_folder(dir.clone(), &[second]),
            home.path().join("copies/studio-mini/shop/fix-cart-3")
        );
        // An empty folder is free.
        std::fs::remove_file(dir.join("old.txt")).unwrap();
        assert_eq!(free_folder(dir.clone(), &[]), dir);
    }

    #[test]
    fn one_origins_clone_never_sits_inside_anothers() {
        let home = Path::new("/Users/alex/.moonlet");
        for (a, b) in [
            ("git.example.com/acme", "git.example.com/acme/shop"),
            ("github.com/acme/shop", "github.com/acme/shop/repo"),
        ] {
            let (a, b) = (clone_dir(home, a), clone_dir(home, b));
            assert!(!a.starts_with(&b) && !b.starts_with(&a), "{a:?} {b:?}");
        }
    }

    #[test]
    fn a_clone_folder_is_used_only_inside_clones_with_no_link_on_the_way() {
        let home = tempfile::tempdir().unwrap();
        let clones = home.path().join("clones");
        let dir = clone_dir(home.path(), "github.com/acme/shop");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(clone_folder_ok(home.path(), &dir));
        // A link among its folders could point the clone anywhere.
        let elsewhere = tempfile::tempdir().unwrap();
        let linked = clones.join("gitlab.com");
        std::os::unix::fs::symlink(elsewhere.path(), &linked).unwrap();
        assert!(!clone_folder_ok(
            home.path(),
            &linked.join("0123456789abcdef")
        ));
        // Nor is anything outside clones.
        assert!(!clone_folder_ok(home.path(), elsewhere.path()));
    }

    #[test]
    fn a_copy_made_again_keeps_the_edits_made_in_it_meanwhile() {
        let files = |list: &[(&str, &str)]| -> Files {
            list.iter()
                .map(|(p, o)| {
                    (
                        p.to_string(),
                        moonlet_core::sync::Entry {
                            mode: "100644".into(),
                            oid: o.repeat(40),
                        },
                    )
                })
                .collect()
        };
        // The worktree was made at a (`made_from`) and never finished;
        // since then studio-mini edited README.md and added new.ts, and
        // this Mac edited cart.ts and README.md.
        let made_from = files(&[("cart.ts", "a"), ("README.md", "a")]);
        let central = files(&[("cart.ts", "a"), ("README.md", "c"), ("new.ts", "n")]);
        let local = files(&[("cart.ts", "b"), ("README.md", "d")]);
        let r = resume(&made_from, &central, &local);
        assert_eq!(r.differs, ["README.md"]);
        assert_eq!(
            r.worker,
            files(&[("cart.ts", "b"), ("README.md", "d"), ("new.ts", "n")])
        );
        // cart.ts stays a change of this Mac's against the base.
        assert_eq!(
            r.base,
            files(&[("cart.ts", "a"), ("README.md", "a"), ("new.ts", "n")])
        );
    }

    #[test]
    fn folders_named_by_the_central_host_stay_under_copies_and_clones() {
        let home = Path::new("/Users/alex/.moonlet");
        assert_eq!(
            copies_dir(home, "studio-mini", "shop", "fix-cart"),
            Path::new("/Users/alex/.moonlet/copies/studio-mini/shop/fix-cart")
        );
        // The host, then the first 16 hex digits of the origin's SHA-256
        // (`printf %s <origin> | shasum -a 256`).
        assert_eq!(
            clone_dir(home, "github.com/acme/shop"),
            Path::new("/Users/alex/.moonlet/clones/github.com/c566806a55dcd4dd")
        );
        assert_eq!(
            clone_dir(home, "gitlab.example.com:8443/team/app"),
            Path::new("/Users/alex/.moonlet/clones/gitlab.example.com_8443/fb0fecc8a6b28086")
        );
        assert_eq!(
            clone_dir(home, "github.com/../../x"),
            Path::new("/Users/alex/.moonlet/clones/github.com/8eca46d8c5ef6dac")
        );
        assert_eq!(
            copies_dir(home, "studio-mini", "..", "a/b c"),
            Path::new("/Users/alex/.moonlet/copies/studio-mini/5ec1f7e700f37c3d/0af99a6091695385")
        );
        assert_eq!(
            copies_dir(home, "", "shop", "fix-cart"),
            Path::new("/Users/alex/.moonlet/copies/e3b0c44298fc1c14/shop/fix-cart")
        );
        assert_eq!(
            copies_dir(home, "Alex's MacBook", "shop", "fix-cart"),
            Path::new("/Users/alex/.moonlet/copies/a8d87d4efcf00ec4/shop/fix-cart")
        );
        let long = copies_dir(home, "studio-mini", &"a".repeat(101), "fix-cart");
        assert_eq!(long.parent().unwrap().file_name().unwrap().len(), 16);
        assert_eq!(
            copies_dir(home, "studio-mini", &"a".repeat(100), "fix-cart"),
            home.join("copies/studio-mini")
                .join("a".repeat(100))
                .join("fix-cart")
        );
    }

    #[test]
    fn an_answer_keeps_the_files_edited_since_the_offer() {
        let e = |oid: &str| git_sync::Entry {
            mode: "100644".into(),
            oid: oid.into(),
        };
        let files = |list: &[(&str, &str)]| -> git_sync::Files {
            list.iter().map(|(p, o)| (p.to_string(), e(o))).collect()
        };
        // Offered: cart a, notes n, old o. The central host answered with
        // its own new.md and took the offer. Since the offer, this Mac
        // edited cart to c and deleted old.
        let offered = files(&[("cart", "a"), ("notes", "n"), ("old", "o")]);
        let now = files(&[("cart", "c"), ("notes", "n")]);
        let answer = files(&[("cart", "a"), ("new.md", "w"), ("notes", "n"), ("old", "o")]);
        assert_eq!(
            keep_edits(&offered, &now, &answer),
            files(&[("cart", "c"), ("new.md", "w"), ("notes", "n")])
        );
        // Nothing edited since: the answer as it is.
        assert_eq!(keep_edits(&offered, &offered, &answer), answer);
    }

    #[test]
    fn a_file_edited_during_a_round_keeps_the_base_it_was_edited_from() {
        let e = |oid: &str| git_sync::Entry {
            mode: "100644".into(),
            oid: oid.into(),
        };
        let files = |list: &[(&str, &str)]| -> git_sync::Files {
            list.iter().map(|(p, o)| (p.to_string(), e(o))).collect()
        };
        // Offered with cart at a. The central host had changed cart to g
        // and the answer's base took g. Meanwhile this Mac edited cart to
        // c, deleted old, and made new.
        let offered = files(&[("cart", "a"), ("notes", "n"), ("old", "o")]);
        let now = files(&[("cart", "c"), ("new", "x"), ("notes", "n")]);
        let answer_base = files(&[("cart", "g"), ("notes", "n"), ("old", "o"), ("theirs", "t")]);
        assert_eq!(
            base_of_edits(&offered, &now, &answer_base),
            files(&[("cart", "a"), ("notes", "n"), ("old", "o"), ("theirs", "t")])
        );
        // Nothing edited since: the answer's base as it is.
        assert_eq!(base_of_edits(&offered, &offered, &answer_base), answer_base);
    }

    #[test]
    fn a_project_key_is_made_only_from_an_origin_without_spaces_and_a_full_root() {
        let id = |origin: Option<&str>, root: Option<&str>| ProjectIdentity {
            origin: origin.map(String::from),
            root: root.map(String::from),
        };
        let root = "4171b03ff0d2bd434751f17bc9d34da784f97e72";
        assert_eq!(
            project_key(
                "Alex's Mac mini",
                &id(Some("github.com/acme/shop"), Some(root))
            )
            .as_deref(),
            Some("Alex's Mac mini github.com/acme/shop 4171b03ff0d2bd434751f17bc9d34da784f97e72")
        );
        assert_eq!(
            project_key("studio-mini", &id(None, Some(root))).as_deref(),
            Some("studio-mini  4171b03ff0d2bd434751f17bc9d34da784f97e72")
        );
        // A central host could otherwise make one project's key read as another's.
        assert_eq!(
            project_key("studio-mini", &id(Some("acme shop"), Some(root))),
            None
        );
        assert_eq!(
            project_key(
                "studio-mini",
                &id(Some("github.com/acme/shop"), Some("4171b03 x"))
            ),
            None
        );
        assert_eq!(
            project_key(
                "studio-mini",
                &id(Some("github.com/acme/shop"), Some("4171b03f"))
            ),
            None
        );
        assert_eq!(
            project_key("studio-mini", &id(Some("github.com/acme/shop"), None)),
            None
        );
    }

    #[test]
    fn a_path_in_the_home_folder_is_shown_from_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(tilde(&home.join("src/shop")), "~/src/shop");
        assert_eq!(tilde(Path::new("/opt/src/shop")), "/opt/src/shop");
    }
}
