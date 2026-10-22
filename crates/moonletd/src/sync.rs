//! Live copies of sessions (X60, ADR 0009).
//!
//! A worker keeps a copy of a session on its central host: a worktree of
//! a repository on this Mac, made from the session's files and commits and
//! kept in sync while the link is up. Both sides snapshot their worktree
//! as a git tree ([`moonlet_core::sync`]) and remember the tree they last
//! agreed on, the base. The central host watches the session and sends
//! the worker what changed (`sync.update`); the worker applies it without
//! ever overwriting a file changed on this Mac, which stays as it is and
//! is listed as differing.
//!
//! Both roles keep their copies in `~/.moonlet/sync/copies.json`, and the
//! objects of each base under `refs/moonlet/sync/<copy id>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use moonlet_core::fs::Watchers;
use moonlet_core::session::SessionManager;
use moonlet_core::sync::{self as git_sync, ApplyError, Entry, Files, MAX_FILE, UnpackError};
use moonlet_proto::methods::{
    self as m, Copy, CopyState, SyncFetch, SyncFetched, SyncOpen, SyncOpened, SyncUpdate,
    SyncUpdated,
};
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
/// Tries at applying before giving up until the next change.
const APPLY_TRIES: usize = 5;

/// How long a copy that kept changing under an update waits before asking
/// the central host again.
const RETRY_AFTER: Duration = Duration::from_secs(1);

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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    worker: Vec<Kept>,
    #[serde(default)]
    central: Vec<Served>,
}

/// Why making or updating a copy stopped.
enum Stop {
    /// The link is down; try again when it is back.
    Offline,
    /// Wait for the user: the reason after "Paused: ".
    Paused(String),
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
}

impl LiveCopies {
    pub fn new(
        home: PathBuf,
        sessions: Arc<SessionManager>,
        link: Arc<WorkerLink>,
        workers: Arc<Workers>,
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
        let state = match &k.paused {
            Some(reason) => CopyState::Paused {
                reason: reason.clone(),
            },
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
            setup: None,
            differs: k.differs.clone(),
            too_big: k.too_big.clone(),
            diverged: None,
        }
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
        if let Some(k) = self.kept(id) {
            (self.emit)(Message::event(m::EV_SYNC_CHANGED, self.copy_of(&k)));
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

    fn pause(&self, id: &str, reason: String) {
        tracing::info!(copy = %id, "copy paused: {reason}");
        self.update_kept(id, |k| k.paused = Some(reason));
        self.changed(id);
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
        self.link.set_synced(self.data.lock().unwrap().worker.len());
        self.changed(&id);
        tokio::spawn(self.clone().make(id.clone()));
        Ok(self.copy_of(&self.kept(&id).unwrap()))
    }

    /// `sync.retry`: a paused copy tries again.
    pub fn retry(self: &Arc<Self>, id: &str) -> Result<Copy, RpcError> {
        let k = self
            .kept(id)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        self.update_kept(id, |k| k.paused = None);
        if k.base.is_none() {
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

    async fn ask_again(&self, id: &str) {
        let Some(host) = self.link.host() else { return };
        let req = SyncFetch {
            copy: id.to_string(),
            have: Vec::new(),
            again: true,
        };
        if let Err(e) = host
            .request(m::SYNC_FETCH, serde_json::to_value(req).unwrap())
            .await
        {
            tracing::debug!(copy = %id, "cannot ask for the session again: {}", e.message);
        }
    }

    /// The link to the central host is up: copies not made yet go on. The
    /// others wait for the central host's state, which it sends when this
    /// Mac registers.
    pub fn link_up(self: &Arc<Self>) {
        let kept = self.data.lock().unwrap().worker.clone();
        for k in kept {
            if k.paused.is_none() && k.base.is_none() {
                tokio::spawn(self.clone().make(k.id));
            }
        }
    }

    /// The link is down: copies wait for it.
    pub fn link_down(&self) {
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
            Ok(()) => self.set_state(&id, CopyState::InSync),
            Err(Stop::Offline) => self.set_state(&id, CopyState::Waiting),
            Err(Stop::Paused(reason)) => self.pause(&id, reason),
        }
    }

    async fn make_copy(&self, k: &Kept) -> Result<(), Stop> {
        let host = self.link.host().ok_or(Stop::Offline)?;
        let open = SyncOpen {
            copy: k.id.clone(),
            session: k.session.clone(),
        };
        let opened: SyncOpened = serde_json::from_value(
            host.request(m::SYNC_OPEN, serde_json::to_value(open).unwrap())
                .await?,
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
                .await?,
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
        if made
            && let Some(from) = made_from
        {
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
            kept.base_head = Some(fetched.head.clone());
            kept.too_big = fetched.too_big.clone();
            kept.differs = differs.clone();
            kept.made_from = None;
        });
        Ok(())
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
        if !dir.join(".git").exists() {
            git_sync::clone(url, &dir)
                .await
                .map_err(|e| Stop::Paused(format!("cannot clone {origin}: {e}")))?;
        }
        Ok(dir)
    }

    /// `sync.update` from the central host: its files and commit. Files
    /// changed here since the base keep this Mac's version and are listed
    /// as differing. An update that fails leaves the copy's state as it
    /// was; one the copy kept changing under stays syncing and asks the
    /// central host again.
    pub async fn update(
        self: &Arc<Self>,
        req: SyncUpdate,
        pack: Option<Vec<u8>>,
    ) -> Result<SyncUpdated, RpcError> {
        for id in [&req.tree, &req.base, &req.head] {
            if !git_sync::is_object_id(id) {
                return Err(RpcError::new(
                    "invalid_params",
                    format!("not an object id: {id}"),
                ));
            }
        }
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
        &self,
        req: SyncUpdate,
        pack: Option<Vec<u8>>,
    ) -> Result<SyncUpdated, RpcError> {
        let lock = self.lock(&req.copy);
        let _one = lock.lock().await;
        let k = self
            .kept(&req.copy)
            .ok_or_else(|| RpcError::new("not_found", "no such copy"))?;
        if let Some(reason) = &k.paused {
            return Err(RpcError::new("paused", reason.clone()));
        }
        // This Mac's base, even when the central host's differs: a reply it
        // never got leaves it at the one before.
        let base = k
            .base
            .clone()
            .ok_or_else(|| RpcError::new("copying", "the copy is not made yet"))?;
        let repo = PathBuf::from(&k.repo);
        let path = PathBuf::from(&k.path);
        if let Some(pack) = pack {
            match git_sync::unpack(&repo, &pack).await {
                Ok(()) => {}
                Err(UnpackError::Git(e)) => return Err(internal(format!("{e:#}"))),
                Err(e) => {
                    let why = refused(&k.host, &e);
                    self.pause(&req.copy, why.clone());
                    return Err(RpcError::new("paused", why));
                }
            }
        }
        let files = git_sync::read_files(&repo, &req.tree)
            .await
            .map_err(internal)?;
        if git_sync::unsafe_path(&files).is_some() {
            self.pause(&req.copy, outside(&k.host));
            return Err(RpcError::new("paused", outside(&k.host)));
        }

        let mut done = None;
        for _ in 0..APPLY_TRIES {
            let local = git_sync::snapshot(&path, MAX_FILE)
                .await
                .map_err(internal)?;
            let (target, new_base, differs) = if local.tree == base {
                (req.tree.clone(), req.tree.clone(), Vec::new())
            } else {
                let r = keep_local(&repo, &base, &req.tree, &local.tree)
                    .await
                    .map_err(internal)?;
                (r.worker, r.base, r.differs)
            };
            if target != local.tree {
                let files = changed_paths(&repo, &local.tree, &target).await;
                self.set_state(&req.copy, CopyState::Syncing { files });
                match git_sync::apply(&path, &local.tree, &target).await {
                    Ok(()) => {}
                    Err(ApplyError::Changed(_)) => continue,
                    Err(ApplyError::Unsafe(_)) => {
                        self.pause(&req.copy, outside(&k.host));
                        return Err(RpcError::new("paused", outside(&k.host)));
                    }
                    Err(ApplyError::Git(e)) => return Err(internal(format!("{e:#}"))),
                }
            }
            let mut too_big = req.too_big.clone();
            too_big.extend(local.too_big);
            too_big.sort();
            too_big.dedup();
            done = Some((target, new_base, differs, too_big));
            break;
        }
        let Some((target, new_base, differs, too_big)) = done else {
            return Err(RpcError::new("busy", "the copy kept changing"));
        };
        git_sync::set_base_ref(&repo, &req.copy, &new_base)
            .await
            .map_err(internal)?;
        // What the central host lacks of the new base: the versions this
        // Mac kept, as the base had them.
        let pack = git_sync::pack_objects(&repo, &[&new_base], &[&req.tree])
            .await
            .map_err(internal)?;
        let pack = if pack.is_empty() {
            None
        } else {
            let host = self
                .link
                .host()
                .ok_or_else(|| RpcError::new("disconnected", "the link closed"))?;
            Some(host.send_pack(&pack)?)
        };
        self.update_kept(&req.copy, |kept| {
            kept.base = Some(new_base.clone());
            kept.base_head = Some(req.head.clone());
            kept.differs = differs.clone();
            kept.too_big = too_big;
        });
        self.set_state(&req.copy, CopyState::InSync);
        self.changed(&req.copy);
        Ok(SyncUpdated {
            tree: target,
            base: new_base,
            differs,
            pack,
        })
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
        let pack = if pack.is_empty() {
            None
        } else {
            Some(conn.send_pack(&pack)?)
        };
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

    fn set_served_base(&self, id: &str, tree: &str, head: &str) {
        if let Some(s) = self
            .data
            .lock()
            .unwrap()
            .central
            .iter_mut()
            .find(|s| s.id == id)
        {
            s.base = Some(tree.to_string());
            s.base_head = Some(head.to_string());
        }
        self.save();
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
        let snap = git_sync::snapshot(path, MAX_FILE).await?;
        let head = git_sync::head(path).await?;
        if !always && snap.tree == base && head == base_head {
            return Ok(());
        }
        let pack = git_sync::pack_objects(path, &[&snap.tree, &head], &[base, base_head]).await?;
        let pack = if pack.is_empty() {
            None
        } else {
            Some(
                conn.send_pack(&pack)
                    .map_err(|e| anyhow::anyhow!(e.message))?,
            )
        };
        let req = SyncUpdate {
            copy: served.id.clone(),
            base: base.to_string(),
            tree: snap.tree.clone(),
            head: head.clone(),
            too_big: snap.too_big,
            pack,
        };
        let reply: SyncUpdated = serde_json::from_value(
            conn.request(m::SYNC_UPDATE, serde_json::to_value(req)?, UPDATE_TIMEOUT)
                .await
                .map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))?,
        )?;
        // The worker's new base: what it kept its own version of stays as
        // the base had it.
        if let Some(t) = reply.pack {
            let pack = conn
                .take_pack(t)
                .ok_or_else(|| anyhow::anyhow!("the worker's pack did not arrive"))?;
            git_sync::unpack(path, &pack).await?;
        }
        if git_sync::present(path, std::slice::from_ref(&reply.base))
            .await?
            .is_empty()
        {
            anyhow::bail!("the worker's base {} is not here", reply.base);
        }
        git_sync::set_base_ref(path, &served.id, &reply.base).await?;
        self.set_served_base(&served.id, &reply.base, &head);
        Ok(())
    }

    /// Watches a session's worktree; each change wakes its sending loop.
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
            loop {
                let Some(kick) = me
                    .upgrade()
                    .and_then(|s| s.kicks.lock().unwrap().get(&root).cloned())
                else {
                    return;
                };
                kick.notified().await;
                let Some(s) = me.upgrade() else { return };
                let ids: Vec<String> = s
                    .data
                    .lock()
                    .unwrap()
                    .central
                    .iter()
                    .filter(|c| Path::new(&c.path).canonicalize().ok().as_deref() == Some(&root))
                    .map(|c| c.id.clone())
                    .collect();
                for id in ids {
                    s.push(&id, false).await;
                }
            }
        });
    }

    fn kick(&self, root: &Path) {
        if let Some(k) = self.kicks.lock().unwrap().get(root) {
            k.notify_one();
        }
    }
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

/// Reconciles the central host's tree with this Mac's, keeping this Mac's
/// version of every file it changed: one the central host left alone too,
/// until the copy sends its changes. Those files differ.
async fn keep_local(
    repo: &Path,
    base: &str,
    central: &str,
    local: &str,
) -> anyhow::Result<git_sync::Reconciled<String>> {
    let base_f = git_sync::read_files(repo, base).await?;
    let local_f = git_sync::read_files(repo, local).await?;
    let mut central_f = git_sync::read_files(repo, central).await?;
    mark_local_changes(&base_f, &mut central_f, &local_f);
    let r = git_sync::reconcile(&base_f, &central_f, &local_f);
    Ok(git_sync::Reconciled {
        base: git_sync::write_files(repo, &r.base).await?,
        central: String::new(),
        worker: git_sync::write_files(repo, &r.worker).await?,
        differs: r.differs,
    })
}

/// Stands in a changed entry on the central side for each path only this
/// Mac changed, so reconciling keeps this Mac's version and the base's.
fn mark_local_changes(base: &Files, central: &mut Files, local: &Files) {
    let paths: Vec<String> = base.keys().chain(local.keys()).cloned().collect();
    for p in paths {
        let (b, c, l) = (base.get(&p), central.get(&p), local.get(&p));
        if l != b && c == b {
            central.insert(
                p,
                Entry {
                    mode: l.or(b).map_or("100644".into(), |e| e.mode.clone()),
                    oid: "0".repeat(40),
                },
            );
        }
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

/// `clones/<origin>` under `home`, one folder per part of the normalized
/// origin, with a port's `:` as `_`: `gitlab.example.com_8443/team/app`.
fn clone_dir(home: &Path, origin: &str) -> PathBuf {
    let base = home.join("clones");
    // Each origin's clone is a `repo` folder of its own, so `host/a` and
    // `host/a/b` never sit one inside the other.
    let dir = origin
        .split('/')
        .fold(base.clone(), |dir, part| {
            dir.join(segment(&part.replace(':', "_")))
        })
        .join("repo");
    debug_assert!(dir.starts_with(&base));
    dir
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
        sync.states
            .lock()
            .unwrap()
            .insert(k.id.clone(), CopyState::Waiting);
    }
    sync.link.set_synced(kept.len());
    for s in served {
        sync.watch(Path::new(&s.path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let outer = clone_dir(home, "git.example.com/acme");
        let inner = clone_dir(home, "git.example.com/acme/shop");
        assert!(!inner.starts_with(&outer) && !outer.starts_with(&inner));
    }

    #[test]
    fn a_copy_made_again_keeps_the_edits_made_in_it_meanwhile() {
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
        assert_eq!(
            clone_dir(home, "github.com/acme/shop"),
            Path::new("/Users/alex/.moonlet/clones/github.com/acme/shop/repo")
        );
        assert_eq!(
            clone_dir(home, "gitlab.example.com:8443/team/app"),
            Path::new("/Users/alex/.moonlet/clones/gitlab.example.com_8443/team/app/repo")
        );
        // Anything else is named by its hash.
        assert_eq!(
            clone_dir(home, "github.com/../../x"),
            Path::new(
                "/Users/alex/.moonlet/clones/github.com/5ec1f7e700f37c3d/5ec1f7e700f37c3d/x/repo"
            )
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
    fn a_path_in_the_home_folder_is_shown_from_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(tilde(&home.join("src/shop")), "~/src/shop");
        assert_eq!(tilde(Path::new("/opt/src/shop")), "/opt/src/shop");
    }

    fn e(oid: &str) -> Entry {
        Entry {
            mode: "100644".into(),
            oid: oid.repeat(40),
        }
    }

    fn files(list: &[(&str, &str)]) -> Files {
        list.iter().map(|(p, o)| (p.to_string(), e(o))).collect()
    }

    #[test]
    fn a_file_changed_only_on_this_mac_keeps_its_version_and_differs() {
        // base a; studio-mini adds new.ts and leaves cart.ts; this Mac
        // edits cart.ts and README.md; studio-mini also edits README.md.
        let base = files(&[("cart.ts", "a"), ("README.md", "a")]);
        let mut central = files(&[("cart.ts", "a"), ("README.md", "c"), ("new.ts", "n")]);
        let local = files(&[("cart.ts", "b"), ("README.md", "d")]);
        mark_local_changes(&base, &mut central, &local);
        let r = git_sync::reconcile(&base, &central, &local);
        assert_eq!(r.differs, ["README.md", "cart.ts"]);
        assert_eq!(
            r.worker,
            files(&[("cart.ts", "b"), ("README.md", "d"), ("new.ts", "n")])
        );
        assert_eq!(
            r.base,
            files(&[("cart.ts", "a"), ("README.md", "a"), ("new.ts", "n")])
        );
    }
}
