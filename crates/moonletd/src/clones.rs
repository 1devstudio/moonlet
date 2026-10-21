//! Clones started from Add project (X59). Each runs in the background,
//! reports git's progress as events, and becomes a project when it ends,
//! whether or not a window still waits for it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, bail};
use moonlet_core::repo_clone;
use moonlet_core::session::SessionManager;
use moonlet_core::terminal::TerminalManager;
use moonlet_proto::Message;
use moonlet_proto::methods::{self as m, RepoClone};
use moonlet_proto::types::{CloneDone, CloneJob, CloneProgress, Project};
use tokio::task::JoinHandle;

pub struct Clones {
    running: Mutex<HashMap<String, Running>>,
    next: AtomicU64,
    sessions: Arc<SessionManager>,
    terminals: Arc<TerminalManager>,
}

struct Running {
    job: CloneJob,
    task: JoinHandle<()>,
}

impl Clones {
    pub fn new(sessions: Arc<SessionManager>, terminals: Arc<TerminalManager>) -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            sessions,
            terminals,
        })
    }

    /// Starts cloning and answers at once; `repo.clone_progress` and
    /// `repo.clone_done` events follow.
    pub fn start(self: &Arc<Self>, r: RepoClone) -> Result<CloneJob> {
        repo_clone::checked_repo(&r.repo)?;
        if let Some(ssh) = &r.ssh {
            repo_clone::checked_ssh(ssh, &r.repo)?;
        }
        let path = repo_clone::clone_dest(&r.parent, &r.name)?;
        let shown = path.display().to_string();
        let mut running = self.running.lock().unwrap();
        if running.values().any(|c| c.job.path == shown) {
            bail!("{shown} is being cloned already");
        }
        if path.exists() {
            bail!("{shown} already exists");
        }
        let job = CloneJob {
            id: format!("clone-{}", self.next.fetch_add(1, Ordering::SeqCst)),
            repo: r.repo.clone(),
            path: shown,
        };
        let me = self.clone();
        let task = tokio::spawn({
            let job = job.clone();
            async move {
                let done = me.run(&job, r, path).await;
                me.running.lock().unwrap().remove(&job.id);
                me.terminals
                    .emit(Message::event(m::EV_REPO_CLONE_DONE, done));
            }
        });
        running.insert(
            job.id.clone(),
            Running {
                job: job.clone(),
                task,
            },
        );
        Ok(job)
    }

    async fn run(&self, job: &CloneJob, r: RepoClone, path: PathBuf) -> CloneDone {
        let done = |project: Option<Project>, error: Option<String>| CloneDone {
            id: job.id.clone(),
            repo: job.repo.clone(),
            path: job.path.clone(),
            project,
            error,
            cancelled: false,
        };
        let gh = r.ssh.is_none() && repo_clone::gh_status().await.login.is_some();
        let cloned = repo_clone::clone(&r.repo, r.ssh.as_deref(), gh, &path, |p| {
            let progress = CloneProgress {
                id: job.id.clone(),
                repo: job.repo.clone(),
                path: job.path.clone(),
                step: p.step,
                current: p.current,
                total: p.total,
                size: p.size,
                speed: p.speed,
            };
            self.terminals
                .emit(Message::event(m::EV_REPO_CLONE_PROGRESS, progress));
        })
        .await;
        if let Err(e) = cloned {
            remove(&path).await;
            return done(None, Some(format!("{e:#}")));
        }
        // A clone that cannot be added stays on disk: it is the user's now.
        let added = match &r.section_id {
            Some(id) => self.sessions.section_add_project(id, &job.path).await,
            None => self.sessions.add_project(&job.path).await,
        };
        match added {
            Ok(project) => done(Some(project), None),
            Err(e) => done(None, Some(format!("{e:#}"))),
        }
    }

    /// Stops a running clone and removes its folder.
    pub async fn cancel(&self, id: &str) -> Result<()> {
        let Some(c) = self.running.lock().unwrap().remove(id) else {
            bail!("no clone {id} is running");
        };
        c.task.abort();
        // A clone that ended meanwhile has reported itself and is kept.
        if c.task.await.is_ok() {
            return Ok(());
        }
        remove(&PathBuf::from(&c.job.path)).await;
        let done = CloneDone {
            id: c.job.id,
            repo: c.job.repo,
            path: c.job.path,
            project: None,
            error: None,
            cancelled: true,
        };
        self.terminals
            .emit(Message::event(m::EV_REPO_CLONE_DONE, done));
        Ok(())
    }
}

/// Removes a clone's folder. A killed git may still be writing for a
/// moment, so a failed removal is tried again.
async fn remove(path: &PathBuf) {
    for _ in 0..5 {
        match std::fs::remove_dir_all(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            _ => return,
        }
    }
    tracing::warn!("cannot remove the cancelled clone at {}", path.display());
}
