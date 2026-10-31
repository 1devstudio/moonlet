//! Copies of every member's sessions on the central host (X72, ADR 0014's
//! slice 3). A member sends each of its sessions one way: whenever the
//! worktree changes, its files as an X60 snapshot tree, its commit and its
//! branch, with only the git objects the central host lacks. The central
//! host keeps a read-only worktree of each, in its own clone of the
//! project, so its sessions can be read there while the member is away.
//!
//! The copy never offers changes back: the member owns the session. A copy
//! edited by hand is put back at the next update, and the edits are kept in
//! `sync-leftovers` (X60's folder).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use moonlet_core::fs::Watchers;
use moonlet_core::session::SessionManager;
use moonlet_core::sync as git_sync;
use moonlet_proto::methods as m;
use moonlet_proto::types::ProjectIdentity;
use moonlet_proto::{Message, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

use crate::link::WorkerLink;
use crate::sync::{
    clone_dir, clone_folder_ok, copies_dir, copy_path, free_folder, make_leftovers_folder, segment,
};

/// The watcher client id these watches go under.
const WATCH_CLIENT: u64 = u64::MAX - 72;
/// How long a member waits for its edits to settle before it sends them.
const QUIET: Duration = Duration::from_millis(300);
/// How often a member looks at its sessions with no file event: a commit
/// in a linked worktree changes nothing the file watcher sees.
const EVERY: Duration = Duration::from_secs(5);

/// Whether clone URL `url`, from a member, names `origin`, the project
/// identity's origin (X41), whatever its scheme and user.
fn clone_url_names(url: &str, origin: &str) -> bool {
    moonlet_core::identity::normalize_origin(url).as_deref() == Some(origin)
}

/// The branch a copy's worktree is on: its own, named after the session,
/// so a member never moves one of the central host's own branches.
fn copy_branch(session: &str) -> String {
    format!("moonlet-copy/{}", segment(session))
}

/// What the central host holds of one of this member's sessions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Sent {
    tree: String,
    head: String,
    branch: String,
}

/// A copy the central host keeps of another member's session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Held {
    owner: String,
    repo: String,
    /// The copy's worktree; empty until its first offer.
    #[serde(default)]
    path: String,
    #[serde(default)]
    tree: String,
    #[serde(default)]
    head: String,
    #[serde(default)]
    branch: String,
    /// The member's worktree, for the copy's folder.
    #[serde(default)]
    from_path: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    /// On a member: by session id.
    #[serde(default)]
    sent: BTreeMap<String, Sent>,
    /// On the central host: by session id.
    #[serde(default)]
    held: BTreeMap<String, Held>,
}

pub struct SessionCopies {
    home: PathBuf,
    file: PathBuf,
    sessions: Arc<SessionManager>,
    link: Arc<WorkerLink>,
    watchers: Arc<Watchers>,
    watched: Mutex<Vec<PathBuf>>,
    data: Mutex<Data>,
    kick: Notify,
    /// One round at a time on a member; one offer at a time on the
    /// central host.
    round: tokio::sync::Mutex<()>,
    apply: tokio::sync::Mutex<()>,
}

impl SessionCopies {
    pub fn new(
        home: &Path,
        sessions: Arc<SessionManager>,
        link: Arc<WorkerLink>,
    ) -> Arc<SessionCopies> {
        let file = home.join("session-copies.json");
        let data: Data = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Arc::new_cyclic(|me: &Weak<SessionCopies>| {
            let me = me.clone();
            let watchers = Watchers::new(Arc::new(move |msg| {
                if let (Some(s), Message::Event { name, .. }) = (me.upgrade(), msg)
                    && name == m::EV_FS_CHANGED
                {
                    s.kick();
                }
            }));
            SessionCopies {
                home: home.to_path_buf(),
                file,
                sessions,
                link,
                watchers,
                watched: Mutex::new(Vec::new()),
                data: Mutex::new(data),
                kick: Notify::new(),
                round: tokio::sync::Mutex::new(()),
                apply: tokio::sync::Mutex::new(()),
            }
        })
    }

    pub fn kick(&self) {
        self.kick.notify_one();
    }

    /// Sends this member's sessions to its central host whenever they
    /// change, for as long as the daemon runs.
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = me.round().await {
                    tracing::debug!("session copies: {e:#}");
                }
                let _ = tokio::time::timeout(EVERY, me.kick.notified()).await;
                tokio::time::sleep(QUIET).await;
            }
        });
    }

    fn save(&self, data: &Data) {
        let write = || -> Result<()> {
            let tmp = self.file.with_extension("tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
            std::fs::rename(&tmp, &self.file)?;
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!("cannot save {}: {e:#}", self.file.display());
        }
    }

    /// Where the central host keeps its copy of `session`, once made.
    pub fn copy_path(&self, session: &str) -> Option<String> {
        self.data
            .lock()
            .unwrap()
            .held
            .get(session)
            .map(|h| h.path.clone())
            .filter(|p| !p.is_empty())
    }

    // --- On a member -----------------------------------------------------

    /// One round: each of this member's live sessions whose files, commit
    /// or branch changed since the central host last took them is sent.
    async fn round(&self) -> Result<()> {
        let info = self.link.info();
        if info.central.is_none() || info.worker.cloud || !self.sessions.has_account() {
            return Ok(());
        }
        let _one = self.round.lock().await;
        let live: Vec<_> = self
            .sessions
            .list_sessions()
            .into_iter()
            .filter(|s| s.owner.is_none() && !s.archived && Path::new(&s.path).is_dir())
            .collect();
        self.watch_only(live.iter().map(|s| PathBuf::from(&s.path)).collect());
        let Some(host) = self.link.host() else {
            return Ok(());
        };
        for s in live {
            if let Err(e) = self.send(&host, &s).await {
                tracing::debug!(session = %s.id, "cannot send to the central host: {e:#}");
            }
        }
        Ok(())
    }

    /// Watches exactly `paths`.
    fn watch_only(&self, paths: Vec<PathBuf>) {
        let mut watched = self.watched.lock().unwrap();
        for p in watched.iter().filter(|p| !paths.contains(p)) {
            self.watchers
                .unwatch(&p.display().to_string(), WATCH_CLIENT);
        }
        for p in paths.iter().filter(|p| !watched.contains(p)) {
            if let Err(e) = self.watchers.watch(&p.display().to_string(), WATCH_CLIENT) {
                tracing::debug!("cannot watch {}: {e:#}", p.display());
            }
        }
        *watched = paths;
    }

    async fn send(
        &self,
        host: &moonlet_link::Host,
        s: &moonlet_proto::types::Session,
    ) -> Result<()> {
        let path = Path::new(&s.path);
        let tree = git_sync::snapshot(path, git_sync::MAX_FILE).await?.tree;
        let head = git_sync::head(path).await?;
        let branch = git_sync::branch(path)
            .await?
            .unwrap_or_else(|| s.branch.clone());
        let now = Sent { tree, head, branch };
        let before = self.data.lock().unwrap().sent.get(&s.id).cloned();
        if before.as_ref() == Some(&now) {
            return Ok(());
        }
        // The first time, or after the central host lost the copy, it says
        // what it has, so the pack leaves that out.
        let mut not: Vec<String> = Vec::new();
        match &before {
            Some(b) => not.extend([b.tree.clone(), b.head.clone()]),
            None => not.extend(self.open(host, s).await?),
        }
        match self.offer(host, s, &now, &not).await {
            Ok(()) => {}
            Err(e) if e.code == "not_open" => {
                let have = self.open(host, s).await?;
                self.offer(host, s, &now, &have)
                    .await
                    .map_err(|e| anyhow::anyhow!("{}", e.message))?;
            }
            Err(e) => anyhow::bail!("{}: {}", e.code, e.message),
        }
        let mut data = self.data.lock().unwrap();
        data.sent.insert(s.id.clone(), now);
        self.save(&data);
        Ok(())
    }

    async fn open(
        &self,
        host: &moonlet_link::Host,
        s: &moonlet_proto::types::Session,
    ) -> Result<Vec<String>> {
        let project = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| p.id == s.project_id)
            .context("the session's project is gone")?;
        let origin_url = moonlet_core::git::origin_url(Path::new(&project.path))
            .await
            .map(|u| git_sync::scrub_url(&u));
        let opened = host
            .request(
                m::SESSION_OPEN,
                serde_json::to_value(m::SessionOpen {
                    session: s.id.clone(),
                    path: s.path.clone(),
                    project: project.name.clone(),
                    origin_url,
                })?,
            )
            .await
            .map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))?;
        let opened: m::SessionOpened = serde_json::from_value(opened)?;
        Ok(opened.have)
    }

    async fn offer(
        &self,
        host: &moonlet_link::Host,
        s: &moonlet_proto::types::Session,
        now: &Sent,
        not: &[String],
    ) -> Result<(), RpcError> {
        let not: Vec<&str> = not
            .iter()
            .map(String::as_str)
            .filter(|o| git_sync::is_object_id(o))
            .collect();
        let pack = git_sync::pack_objects(Path::new(&s.path), &[&now.tree, &now.head], &not)
            .await
            .map_err(|e| RpcError::new("internal", e.to_string()))?;
        let pack = if pack.is_empty() {
            None
        } else {
            Some(host.send_pack(&pack)?)
        };
        host.request(
            m::SESSION_OFFER,
            serde_json::to_value(m::SessionOffer {
                session: s.id.clone(),
                tree: now.tree.clone(),
                head: now.head.clone(),
                branch: now.branch.clone(),
                pack,
            })
            .unwrap_or_default(),
        )
        .await?;
        Ok(())
    }

    // --- On the central host ----------------------------------------------

    /// The session record's owner, when it is `worker`: only a session's
    /// own member sends it.
    fn owned_by(
        &self,
        session: &str,
        worker: &str,
    ) -> Result<moonlet_core::account::Record, RpcError> {
        let record = self
            .sessions
            .session_records()
            .remove(session)
            .ok_or_else(|| RpcError::new("not_found", "no such session in the account"))?;
        if record.get("owner").and_then(Value::as_str) != Some(worker) {
            return Err(RpcError::new(
                "forbidden",
                "only the member that owns a session sends it",
            ));
        }
        Ok(record)
    }

    /// `session.open` from member `worker`: the repository the copy goes
    /// in, cloned when this host has no project of that identity.
    pub async fn opened(
        &self,
        worker: &str,
        r: m::SessionOpen,
    ) -> Result<m::SessionOpened, RpcError> {
        let record = self.owned_by(&r.session, worker)?;
        let held = self.data.lock().unwrap().held.get(&r.session).cloned();
        let repo = match held.filter(|h| Path::new(&h.repo).exists()) {
            Some(h) => PathBuf::from(h.repo),
            None => self.repo_for(&record, r.origin_url.as_deref()).await?,
        };
        {
            let mut data = self.data.lock().unwrap();
            let h = data.held.entry(r.session.clone()).or_default();
            h.owner = worker.to_string();
            h.repo = repo.display().to_string();
            h.from_path = r.path;
            h.project = r.project;
            self.save(&data);
        }
        Ok(m::SessionOpened {
            have: git_sync::have(&repo).await,
        })
    }

    async fn repo_for(
        &self,
        record: &moonlet_core::account::Record,
        origin_url: Option<&str>,
    ) -> Result<PathBuf, RpcError> {
        let identity: ProjectIdentity = record
            .get("project")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        if let Some(p) = self
            .sessions
            .list_projects()
            .into_iter()
            .find(|p| moonlet_core::identity::same_project(&p.identity, &identity))
        {
            return Ok(PathBuf::from(p.path));
        }
        let (Some(origin), Some(url)) = (identity.origin.as_deref(), origin_url) else {
            return Err(RpcError::new(
                "no_origin",
                "the session's project has no origin to clone from",
            ));
        };
        // The URL comes from the member: it is cloned only when it names the
        // origin of the project the record says, so it can never fill the
        // clone folder of one project with another repository.
        if !clone_url_names(url, origin) {
            return Err(RpcError::new(
                "refused",
                "the clone URL is not the project's origin",
            ));
        }
        let dir = clone_dir(&self.home, origin);
        if !clone_folder_ok(&self.home, &dir) {
            return Err(RpcError::new(
                "refused",
                "the clone folder is not a plain folder under clones",
            ));
        }
        if !dir.join(".git").exists() {
            git_sync::clone(url, &dir).await.map_err(|e| {
                RpcError::new("clone_failed", format!("cannot clone {origin}: {e}"))
            })?;
        }
        Ok(dir)
    }

    /// `session.offer` from member `worker`: takes its objects into the
    /// copy's repository, makes the copy's worktree the first time, and
    /// brings it to the member's files and commit.
    pub async fn offered(
        &self,
        worker: &str,
        r: m::SessionOffer,
        pack: Option<Vec<u8>>,
    ) -> Result<m::SessionOffered, RpcError> {
        self.owned_by(&r.session, worker)?;
        if !git_sync::is_object_id(&r.tree) || !git_sync::is_object_id(&r.head) {
            return Err(RpcError::new(
                "invalid_params",
                "a tree and a commit by their ids",
            ));
        }
        let _one = self.apply.lock().await;
        let held = self
            .data
            .lock()
            .unwrap()
            .held
            .get(&r.session)
            .cloned()
            .filter(|h| Path::new(&h.repo).exists())
            .ok_or_else(|| RpcError::new("not_open", "open the copy first"))?;
        let repo = PathBuf::from(&held.repo);
        if let Some(pack) = pack {
            git_sync::unpack(&repo, &pack)
                .await
                .map_err(|e| RpcError::new("refused", format!("{e:?}")))?;
        }
        let mut held = held;
        let dir = if held.path.is_empty() || !Path::new(&held.path).exists() {
            let dir = self.make_worktree(&r, &held).await?;
            held.path = dir.display().to_string();
            held.tree.clear();
            held.head = r.head.clone();
            held.branch = r.branch.clone();
            dir
        } else {
            PathBuf::from(&held.path)
        };
        self.bring(&dir, &mut held, &r).await?;
        held.tree = r.tree.clone();
        held.head = r.head.clone();
        held.branch = r.branch.clone();
        let mut data = self.data.lock().unwrap();
        data.held.insert(r.session.clone(), held);
        self.save(&data);
        Ok(m::SessionOffered {
            tree: r.tree,
            head: r.head,
        })
    }

    async fn make_worktree(&self, r: &m::SessionOffer, held: &Held) -> Result<PathBuf, RpcError> {
        let taken: Vec<PathBuf> = self
            .data
            .lock()
            .unwrap()
            .held
            .iter()
            .filter(|(id, h)| *id != &r.session && !h.path.is_empty())
            .map(|(_, h)| PathBuf::from(&h.path))
            .collect();
        let folder = Path::new(&held.from_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| segment(&r.session));
        let owner = self
            .sessions
            .member_names()
            .remove(&held.owner)
            .unwrap_or_else(|| held.owner.clone());
        let dir = copy_path(
            Path::new(&held.from_path),
            &self.home.join("worktrees"),
            &taken,
            free_folder(
                copies_dir(&self.home, &owner, &held.project, &folder),
                &taken,
            ),
        );
        git_sync::add_worktree(
            Path::new(&held.repo),
            &dir,
            &copy_branch(&r.session),
            &r.head,
        )
        .await
        .map_err(|e| RpcError::new("refused", format!("cannot make the copy: {e:?}")))?;
        Ok(dir)
    }

    /// Brings worktree `dir` to the offer's commit and files. Files edited
    /// in the copy since the last offer are saved to leftovers first.
    async fn bring(
        &self,
        dir: &Path,
        held: &mut Held,
        r: &m::SessionOffer,
    ) -> Result<(), RpcError> {
        let internal = |e: anyhow::Error| RpcError::new("internal", format!("{e:#}"));
        // The copy's branch is its own (`copy_branch`), never one of this
        // host's, so moving it, even back after an amend, touches nothing
        // else. The member's branch name stays in the session's record.
        let want = format!("refs/heads/{}", copy_branch(&r.session));
        let on = moonlet_core::git::git_text(dir, &["symbolic-ref", "-q", "HEAD"])
            .await
            .unwrap_or_default();
        if on.trim() != want {
            // Switched by hand to another branch, or detached: back onto the
            // copy's own branch, leaving that one where it is. Only refs
            // move here; the files follow below.
            moonlet_core::git::git(dir, &["update-ref", &want, &r.head])
                .await
                .map_err(internal)?;
            moonlet_core::git::git(dir, &["symbolic-ref", "HEAD", &want])
                .await
                .map_err(internal)?;
            moonlet_core::git::git(dir, &["reset", "-q"])
                .await
                .map_err(internal)?;
        } else {
            let at = git_sync::head(dir).await.map_err(internal)?;
            if at != r.head {
                git_sync::reset_branch(dir, &at, &r.head)
                    .await
                    .map_err(internal)?;
            }
        }
        let from = git_sync::snapshot(dir, git_sync::MAX_FILE)
            .await
            .map_err(internal)?
            .tree;
        if !held.tree.is_empty() && from != held.tree {
            self.keep_edits(dir, &held.tree, &from)
                .await
                .map_err(internal)?;
        }
        if from != r.tree {
            git_sync::apply(dir, &from, &r.tree)
                .await
                .map_err(|e| RpcError::new("internal", format!("cannot apply: {e:?}")))?;
        }
        Ok(())
    }

    /// Saves the files of `dir` that differ between tree `was` (the last
    /// offer) and `now` (the folder as it is) to a leftovers folder.
    async fn keep_edits(&self, dir: &Path, was: &str, now: &str) -> Result<()> {
        let a = git_sync::read_files(dir, was).await?;
        let b = git_sync::read_files(dir, now).await?;
        let changed: Vec<&String> = b.keys().filter(|p| a.get(*p) != b.get(*p)).collect();
        if changed.is_empty() {
            return Ok(());
        }
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let folder = make_leftovers_folder(&self.home.join("sync-leftovers"), &segment(&name))?;
        for p in changed {
            let to = folder.join(p);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(dir.join(p), &to)?;
        }
        tracing::info!(
            "kept edits made in the copy {} in {}",
            dir.display(),
            folder.display()
        );
        Ok(())
    }

    /// Removes the copies of sessions that are archived or gone from the
    /// account.
    pub async fn drop_ended(&self) {
        let records = self.sessions.session_records();
        let ended: Vec<(String, Held)> = self
            .data
            .lock()
            .unwrap()
            .held
            .iter()
            .filter(|(id, _)| {
                records
                    .get(*id)
                    .is_none_or(|r| r.get("archived").and_then(Value::as_bool).unwrap_or(false))
            })
            .map(|(id, h)| (id.clone(), h.clone()))
            .collect();
        for (id, h) in ended {
            let _one = self.apply.lock().await;
            if !h.path.is_empty() && Path::new(&h.path).exists() {
                let dir = Path::new(&h.path);
                if let Ok(now) = git_sync::snapshot(dir, git_sync::MAX_FILE).await
                    && !h.tree.is_empty()
                    && now.tree != h.tree
                {
                    let _ = self.keep_edits(dir, &h.tree, &now.tree).await;
                }
                if let Err(e) = git_sync::remove_worktree(Path::new(&h.repo), dir).await {
                    tracing::warn!("cannot remove the copy {}: {e:#}", dir.display());
                    continue;
                }
            }
            let mut data = self.data.lock().unwrap();
            data.held.remove(&id);
            self.save(&data);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_url_is_taken_only_for_the_projects_own_origin() {
        let origin = "github.com/acme/shop";
        assert!(clone_url_names("https://github.com/acme/shop.git", origin));
        assert!(clone_url_names("git@github.com:acme/shop.git", origin));
        assert!(!clone_url_names("https://github.com/evil/shop.git", origin));
        assert!(!clone_url_names(
            "https://evil.example/acme/shop.git",
            origin
        ));
        assert!(!clone_url_names("/Users/alex/src/other", origin));
    }
}
