//! Tasks on the phone (X76). The app shares each workspace's boards as a
//! snapshot the daemon keeps whole, in `~/.moonlet/tasks/<workspace>.json`,
//! and a phone asks the app to change tasks through a relay: the daemon
//! passes the request on and returns the app's first answer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use moonlet_proto::methods::{TasksAnswer, TasksRequestEvent, WorkspaceSnapshot};
use serde_json::Value;
use tokio::sync::oneshot;

/// The largest snapshot the daemon keeps.
pub const MAX_SNAPSHOT: usize = 4 * 1024 * 1024;
/// How long a phone's request waits for the app.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn dir() -> PathBuf {
    crate::paths::home().join("tasks")
}

/// A workspace id that is safe as a file name.
fn file_name(workspace: &str) -> Result<String> {
    if workspace.is_empty()
        || !workspace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("bad workspace id {workspace:?}");
    }
    Ok(format!("{workspace}.json"))
}

pub struct TaskSnapshots {
    dir: PathBuf,
    saved: Mutex<BTreeMap<String, Value>>,
}

impl TaskSnapshots {
    /// The snapshots saved in `dir`; one that does not parse is skipped.
    pub fn load(dir: PathBuf) -> Self {
        let mut saved = BTreeMap::new();
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Some(ws) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|_| path.extension().is_some_and(|e| e == "json"))
            else {
                continue;
            };
            match std::fs::read_to_string(&path)
                .map_err(anyhow::Error::from)
                .and_then(|t| Ok(serde_json::from_str::<Value>(&t)?))
            {
                Ok(v) => {
                    saved.insert(ws.to_string(), v);
                }
                Err(e) => tracing::warn!("skipping {}: {e:#}", path.display()),
            }
        }
        Self {
            dir,
            saved: Mutex::new(saved),
        }
    }

    /// Every workspace's snapshot, or `workspace`'s.
    pub fn get(&self, workspace: Option<&str>) -> Vec<WorkspaceSnapshot> {
        self.saved
            .lock()
            .unwrap()
            .iter()
            .filter(|(ws, _)| workspace.is_none_or(|w| w == ws.as_str()))
            .map(|(ws, v)| WorkspaceSnapshot {
                workspace: ws.clone(),
                snapshot: v.clone(),
            })
            .collect()
    }

    /// Saves `workspace`'s snapshot, readable only by the user.
    pub fn set(&self, workspace: &str, snapshot: Value) -> Result<()> {
        let name = file_name(workspace)?;
        let text = serde_json::to_vec(&snapshot)?;
        if text.len() > MAX_SNAPSHOT {
            bail!(
                "the snapshot is {} MB, over the {} MB a daemon keeps",
                text.len() / (1024 * 1024),
                MAX_SNAPSHOT / (1024 * 1024)
            );
        }
        let mut saved = self.saved.lock().unwrap();
        write_private(&self.dir.join(name), &text)?;
        saved.insert(workspace.to_string(), snapshot);
        Ok(())
    }

    /// Forgets `workspace`'s snapshot; true if it had one.
    pub fn remove(&self, workspace: &str) -> bool {
        let mut saved = self.saved.lock().unwrap();
        if let Ok(name) = file_name(workspace) {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
        saved.remove(workspace).is_some()
    }
}

/// Writes `file` through a temporary file, mode 0600.
fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = file.parent().context("no folder")?;
    std::fs::create_dir_all(dir)?;
    let tmp = file.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, file).with_context(|| format!("cannot save {}", file.display()))
}

pub struct TaskRelay {
    pending: Mutex<BTreeMap<u64, oneshot::Sender<TasksAnswer>>>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl TaskRelay {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: Mutex::new(BTreeMap::new()),
            next_id: AtomicU64::new(1),
            timeout,
        }
    }

    /// Sends `action` to the apps with `emit` and waits for the first
    /// answer. `apps` is false when no app is connected: it fails at once.
    pub async fn request(
        &self,
        workspace: String,
        action: Value,
        apps: bool,
        emit: impl FnOnce(&TasksRequestEvent),
    ) -> Result<Value> {
        if !apps {
            bail!("Open moonlet on the Mac to change tasks.");
        }
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id, tx);
        emit(&TasksRequestEvent {
            request_id,
            workspace,
            action,
        });
        let answer = tokio::time::timeout(self.timeout, rx).await;
        self.pending.lock().unwrap().remove(&request_id);
        match answer {
            Ok(Ok(a)) if a.ok => Ok(a.result.unwrap_or(Value::Null)),
            Ok(Ok(a)) => Err(anyhow!(
                a.error
                    .unwrap_or_else(|| "moonlet on the Mac refused.".into())
            )),
            _ => bail!("moonlet on the Mac did not answer."),
        }
    }

    /// An app's answer; the first one wins.
    pub fn answer(&self, answer: TasksAnswer) -> Result<()> {
        let tx = self
            .pending
            .lock()
            .unwrap()
            .remove(&answer.request_id)
            .ok_or_else(|| anyhow!("already answered"))?;
        let _ = tx.send(answer);
        Ok(())
    }
}
