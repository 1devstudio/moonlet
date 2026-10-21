//! Clones started from Add project (X59). Each runs in the background,
//! reports git's progress as events, and becomes a project when it ends,
//! whether or not a window still waits for it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, bail};
use moonlet_core::repo_clone;
use moonlet_core::session::SessionManager;
use moonlet_core::terminal::TerminalManager;
use moonlet_proto::Message;
use moonlet_proto::methods::{self as m, RepoClone};
use moonlet_proto::types::{CloneDone, CloneJob, CloneProgress, Project};
use tokio::sync::oneshot;

pub struct Clones {
    running: Mutex<HashMap<String, Running>>,
    sessions: Arc<SessionManager>,
    terminals: Arc<TerminalManager>,
}

struct Running {
    path: String,
    /// Stops git; taken once git is done, when the clone can no longer be
    /// cancelled.
    cancel: Option<oneshot::Sender<()>>,
}

/// An id the app chose: letters, digits and `-`, up to 64.
fn checked_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 64
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || id.starts_with('-')
    {
        bail!("not a clone id: {id}");
    }
    Ok(id)
}

impl Clones {
    pub fn new(sessions: Arc<SessionManager>, terminals: Arc<TerminalManager>) -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(HashMap::new()),
            sessions,
            terminals,
        })
    }

    /// Starts cloning and answers at once; `repo.clone_progress` and
    /// `repo.clone_done` events follow.
    pub fn start(self: &Arc<Self>, r: RepoClone) -> Result<CloneJob> {
        checked_id(&r.id)?;
        repo_clone::checked_ref(&r.repo, r.ssh.as_deref())?;
        let path = repo_clone::clone_dest(&r.parent, &r.name)?;
        let shown = path.display().to_string();
        let mut running = self.running.lock().unwrap();
        if running.contains_key(&r.id) {
            bail!("a clone {} is running already", r.id);
        }
        if running.values().any(|c| c.path == shown) {
            bail!("{shown} is being cloned already");
        }
        if path.exists() {
            bail!("{shown} already exists");
        }
        let job = CloneJob {
            id: r.id.clone(),
            repo: r.repo.clone(),
            path: shown.clone(),
        };
        let (cancel, cancelled) = oneshot::channel();
        running.insert(
            job.id.clone(),
            Running {
                path: shown,
                cancel: Some(cancel),
            },
        );
        let me = self.clone();
        let task_job = job.clone();
        tokio::spawn(async move {
            let done = me.run(&task_job, r, path, cancelled).await;
            me.running.lock().unwrap().remove(&task_job.id);
            me.terminals
                .emit(Message::event(m::EV_REPO_CLONE_DONE, done));
        });
        Ok(job)
    }

    async fn run(
        &self,
        job: &CloneJob,
        r: RepoClone,
        path: PathBuf,
        cancelled: oneshot::Receiver<()>,
    ) -> CloneDone {
        let done = |project: Option<Project>, error: Option<String>, cancelled: bool| CloneDone {
            job: job.clone(),
            project,
            error,
            cancelled,
        };
        let gh = r.ssh.is_none() && repo_clone::gh_status().await.login.is_some();
        let clone = repo_clone::clone(&r.repo, r.ssh.as_deref(), gh, &path, |p| {
            let progress = CloneProgress {
                job: job.clone(),
                step: p.step,
                current: p.current,
                total: p.total,
                size: p.size,
                speed: p.speed,
            };
            self.terminals
                .emit(Message::event(m::EV_REPO_CLONE_PROGRESS, progress));
        });
        // Cancelling drops the clone, which kills git.
        let cloned = tokio::select! {
            r = clone => Some(r),
            Ok(()) = cancelled => None,
        };
        // From here on the clone cannot be cancelled.
        if let Some(c) = self.running.lock().unwrap().get_mut(&job.id) {
            c.cancel = None;
        }
        match cloned {
            None => {
                remove_clone_folder(&path).await;
                return done(None, None, true);
            }
            Some(Err(e)) => {
                remove_clone_folder(&path).await;
                return done(None, Some(format!("{e:#}")), false);
            }
            Some(Ok(())) => {}
        }
        let added = match &r.section_id {
            Some(id) => self.sessions.section_add_project(id, &job.path).await,
            None => self.sessions.add_project(&job.path).await,
        };
        match added {
            Ok(project) => done(Some(project), None, false),
            // The clone stays on disk: it is the user's now.
            Err(e) => done(
                None,
                Some(format!(
                    "cloned into {}, but adding it as a project failed: {e:#}",
                    job.path
                )),
                false,
            ),
        }
    }

    /// Stops a clone that is still running git; its `repo.clone_done`
    /// follows once its folder is removed.
    pub fn cancel(&self, id: &str) -> Result<()> {
        let mut running = self.running.lock().unwrap();
        let Some(c) = running.get_mut(id) else {
            bail!("no clone {id} is running");
        };
        match c.cancel.take() {
            Some(cancel) => {
                let _ = cancel.send(());
                Ok(())
            }
            None => bail!("the clone {id} is done and is being added"),
        }
    }
}

/// Removes a stopped clone's folder. A killed git may still be writing for
/// a moment, so a failed removal is tried again.
async fn remove_clone_folder(path: &Path) {
    for _ in 0..5 {
        match std::fs::remove_dir_all(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            _ => return,
        }
    }
    tracing::warn!("cannot remove the stopped clone at {}", path.display());
}
