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
use moonlet_core::sync::{self as git_sync, ApplyError, Entry, Files, MAX_FILE};
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
        if let Some(k) = self
            .data
            .lock()
            .unwrap()
            .worker
            .iter()
            .find(|k| k.session == session && k.host == host)
        {
            return Ok(self.copy_of(k));
        }
        let kept = Kept {
            id: uuid::Uuid::new_v4().to_string(),
            host,
            session,
            ..Kept::default()
        };
        let id = kept.id.clone();
        self.data.lock().unwrap().worker.push(kept);
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
        if let Some(t) = fetched.pack {
            let pack = host
                .take_pack(t)
                .ok_or_else(|| Stop::Paused("the session's files did not arrive".into()))?;
            git_sync::unpack(&repo, &pack)
                .await
                .map_err(|e| Stop::Paused(format!("{e:#}")))?;
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
            let fallback = self
                .home
                .join("copies")
                .join(&k.host)
                .join(&opened.project)
                .join(dir);
            let path = copy_path(Path::new(&opened.path), fallback);
            git_sync::add_worktree(&repo, &path, &opened.branch, &fetched.head)
                .await
                .map_err(|e| Stop::Paused(format!("{e:#}")))?;
            self.update_kept(&k.id, |kept| kept.path = path.display().to_string());
            path
        };

        // The worktree is at the session's commit; its files follow.
        let host_name = k.host.clone();
        apply_tries(&path, &fetched.tree, &host_name).await?;
        git_sync::set_base_ref(&repo, &k.id, &fetched.tree)
            .await
            .map_err(|e| Stop::Paused(format!("{e:#}")))?;
        self.update_kept(&k.id, |kept| {
            kept.base = Some(fetched.tree.clone());
            kept.base_head = Some(fetched.head.clone());
            kept.too_big = fetched.too_big.clone();
            kept.differs.clear();
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
        let dir = self.home.join("clones").join(origin);
        if !dir.join(".git").exists() {
            git_sync::clone(url, &dir)
                .await
                .map_err(|e| Stop::Paused(format!("cannot clone {origin}: {e}")))?;
        }
        Ok(dir)
    }

    /// `sync.update` from the central host: its files and commit. Files
    /// changed here since the base keep this Mac's version and are listed
    /// as differing.
    pub async fn update(
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
            git_sync::unpack(&repo, &pack).await.map_err(internal)?;
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
            self.set_state(&req.copy, CopyState::InSync);
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

/// Where a copy goes: the session's own path when this Mac can make it and
/// nothing is there yet, else `fallback`.
fn copy_path(session: &Path, fallback: PathBuf) -> PathBuf {
    let free = match std::fs::read_dir(session) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    };
    let makeable = session.is_absolute()
        && session
            .parent()
            .is_some_and(|p| std::fs::create_dir_all(p).is_ok());
    if free && makeable {
        session.to_path_buf()
    } else {
        fallback
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
    for k in &kept {
        let state = if k.base.is_some() {
            CopyState::Waiting
        } else {
            CopyState::Copying
        };
        sync.states.lock().unwrap().insert(k.id.clone(), state);
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
        let home = tempfile::tempdir().unwrap();
        let fallback = home.path().join("copies/studio-mini/shop/fix-cart");
        let session = home
            .path()
            .join("Users/alex/.moonlet/worktrees/shop/fix-cart");
        assert_eq!(copy_path(&session, fallback.clone()), session);

        // An empty folder there is free too.
        std::fs::create_dir_all(&session).unwrap();
        assert_eq!(copy_path(&session, fallback.clone()), session);

        // Something there: the copy goes under copies/.
        std::fs::write(session.join("README.md"), "hi").unwrap();
        assert_eq!(copy_path(&session, fallback.clone()), fallback);

        // A path this Mac cannot make.
        let blocked = home.path().join("file");
        std::fs::write(&blocked, "").unwrap();
        assert_eq!(
            copy_path(&blocked.join("shop/fix-cart"), fallback.clone()),
            fallback
        );
        assert_eq!(
            copy_path(Path::new("worktrees/fix-cart"), fallback.clone()),
            fallback
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
