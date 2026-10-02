//! Daemon state and request dispatch.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use jaunt_core::fs::Watchers;
use jaunt_core::hooks::{self, HookPaths};
use jaunt_core::paths::{hostname, now_ms};
use jaunt_core::session::SessionManager;
use jaunt_core::workspace::WorkspaceManager;
use jaunt_core::{fs, git};
use jaunt_proto::methods::{self as m, AttachResult};
use jaunt_proto::types::DaemonInfo;
use jaunt_proto::{PROTOCOL_VERSION, RpcError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::server::Conn;

pub struct Daemon {
    pub sessions: Arc<SessionManager>,
    pub workspaces: Arc<WorkspaceManager>,
    watchers: Arc<Watchers>,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    handed_off: AtomicBool,
}

pub type HandlerResult = Result<Value, RpcError>;

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_params", e.to_string()))
}

fn ok<T: Serialize>(v: T) -> HandlerResult {
    serde_json::to_value(v).map_err(|e| RpcError::new("internal", e.to_string()))
}

pub fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", format!("{e:#}"))
}

impl Daemon {
    pub fn new(socket: PathBuf, base_env: BTreeMap<String, String>) -> Arc<Self> {
        let (shutdown, _) = watch::channel(false);
        let sessions = SessionManager::new(socket.clone(), base_env);
        let workspaces = WorkspaceManager::load(
            jaunt_core::paths::state_file(),
            jaunt_core::paths::home().join("worktrees"),
            sessions.clone(),
        );
        let emitter = sessions.clone();
        let watchers = Watchers::new(Arc::new(move |m| emitter.emit(m)));
        Arc::new(Self {
            sessions,
            workspaces,
            watchers,
            started_at: now_ms(),
            shutdown,
            handed_off: AtomicBool::new(false),
        })
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    pub fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }

    pub fn handed_off(&self) -> bool {
        self.handed_off.load(Ordering::SeqCst)
    }

    pub fn set_handed_off(&self) {
        self.handed_off.store(true, Ordering::SeqCst);
    }

    pub fn on_disconnect(&self, client: u64) {
        self.watchers.release_client(client);
    }

    pub fn info(&self) -> DaemonInfo {
        DaemonInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
            pid: std::process::id(),
            host: hostname(),
            home: dirs_home(),
            started_at: self.started_at,
            sessions: self.sessions.len(),
        }
    }

    pub async fn handle(self: &Arc<Self>, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        let s = &self.sessions;
        match method {
            m::DAEMON_INFO => ok(self.info()),
            m::DAEMON_SHUTDOWN => {
                let me = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    me.request_shutdown();
                });
                ok(true)
            }
            m::DAEMON_UPGRADE => {
                #[derive(serde::Deserialize)]
                struct Req {
                    binary: PathBuf,
                }
                let r: Req = params(p)?;
                let me = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::upgrade::hand_off(me, Some(r.binary)).await {
                        tracing::error!("upgrade failed, still serving: {e:#}");
                    }
                });
                ok(true)
            }
            m::SESSION_CREATE => {
                let req: m::SessionCreate = params(p)?;
                match req.workspace_id.clone() {
                    Some(id) => {
                        let ws = self.workspaces.workspace(&id).map_err(internal)?;
                        ok(self.workspaces.spawn_in(&ws, req).map_err(internal)?)
                    }
                    None => ok(s.create(req).map_err(internal)?),
                }
            }
            m::SESSION_LIST => ok(s.list()),
            m::SESSION_ATTACH => {
                let a: m::SessionAttach = params(p)?;
                let size = a.cols.zip(a.rows);
                let (info, snapshot) = s
                    .attach(a.id, conn.id, conn.tx.clone(), size)
                    .map_err(internal)?;
                ok(AttachResult {
                    info,
                    snapshot: String::from_utf8_lossy(&snapshot).into_owned(),
                })
            }
            m::SESSION_DETACH => {
                let r: m::SessionRef = params(p)?;
                s.detach(r.id, conn.id);
                ok(true)
            }
            m::SESSION_RESIZE => {
                let r: m::SessionResize = params(p)?;
                s.resize(r.id, r.cols, r.rows).map_err(internal)?;
                ok(true)
            }
            m::SESSION_KILL => {
                let r: m::SessionKill = params(p)?;
                s.kill(r.id, r.remove).map_err(internal)?;
                ok(true)
            }
            m::SESSION_WRITE => {
                let r: m::SessionWrite = params(p)?;
                s.write(r.id, r.data.into_bytes()).map_err(internal)?;
                ok(true)
            }
            m::SESSION_SEARCH => {
                let r: m::SessionSearch = params(p)?;
                ok(s.search(r.id, &r.query, r.regex, r.case_sensitive)
                    .map_err(internal)?)
            }
            m::AGENT_REPORT => {
                let r: m::AgentReport = params(p)?;
                s.report(r.session, r.state, r.source, r.message, r.agent)
                    .map_err(internal)?;
                ok(true)
            }
            m::HOOKS_STATUS => ok(hooks::status(&HookPaths::default_paths()).map_err(internal)?),
            m::HOOKS_INSTALL => {
                let r: m::HooksInstall = params(p)?;
                let bin = jaunt_cli_path().map_err(internal)?;
                ok(
                    hooks::install(&HookPaths::default_paths(), &bin, r.claude, r.codex)
                        .map_err(internal)?,
                )
            }
            m::HOOKS_UNINSTALL => {
                ok(hooks::uninstall(&HookPaths::default_paths()).map_err(internal)?)
            }
            _ => self.handle_project(conn, method, p).await,
        }
    }

    /// Repos, workspaces, git and files.
    async fn handle_project(&self, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        let w = &self.workspaces;
        match method {
            m::REPO_ADD => {
                let r: m::RepoAdd = params(p)?;
                ok(w.add_repo(&r.path).await.map_err(internal)?)
            }
            m::REPO_LIST => ok(w.list_repos()),
            m::REPO_REMOVE => {
                let r: m::IdRef = params(p)?;
                w.remove_repo(&r.id).map_err(internal)?;
                ok(true)
            }
            m::REPO_CONFIG => {
                let r: m::IdRef = params(p)?;
                ok(w.repo_config(&r.id).map_err(internal)?)
            }
            m::WORKSPACE_CREATE => ok(w.create_workspace(params(p)?).await.map_err(internal)?),
            m::WORKSPACE_LIST => ok(w.list_workspaces()),
            m::WORKSPACE_ARCHIVE => {
                w.archive(params(p)?).await.map_err(internal)?;
                ok(true)
            }
            m::WORKSPACE_UNARCHIVE => {
                let r: m::IdRef = params(p)?;
                ok(w.unarchive(&r.id).await.map_err(internal)?)
            }
            m::WORKSPACE_UPDATE => ok(w.update(params(p)?).map_err(internal)?),
            m::WORKSPACE_RUN => {
                let r: m::WorkspaceRun = params(p)?;
                ok(w.run_script(&r.id, &r.script, r.cols, r.rows)
                    .await
                    .map_err(internal)?)
            }
            m::GIT_STATUS => {
                let r: m::GitPath = params(p)?;
                ok(git::status(&path(&r.path), r.base.as_deref())
                    .await
                    .map_err(internal)?)
            }
            m::GIT_FILE_VERSIONS => {
                let r: m::GitFile = params(p)?;
                ok(
                    git::file_versions(&path(&r.path), &r.file, r.base.as_deref(), r.staged)
                        .await
                        .map_err(internal)?,
                )
            }
            m::GIT_DIFF => {
                let r: m::GitFile = params(p)?;
                ok(
                    git::diff(&path(&r.path), &r.file, r.base.as_deref(), r.staged)
                        .await
                        .map_err(internal)?,
                )
            }
            m::GIT_STAGE | m::GIT_UNSTAGE | m::GIT_REVERT => {
                let r: m::GitFiles = params(p)?;
                let root = path(&r.path);
                match method {
                    m::GIT_STAGE => git::stage(&root, &r.files).await,
                    m::GIT_UNSTAGE => git::unstage(&root, &r.files).await,
                    _ => git::revert(&root, &r.files).await,
                }
                .map_err(internal)?;
                ok(true)
            }
            m::GIT_APPLY_PATCH => {
                let r: m::GitApplyPatch = params(p)?;
                git::apply_patch(&path(&r.path), &r.patch, r.cached, r.reverse)
                    .await
                    .map_err(internal)?;
                ok(true)
            }
            m::GIT_COMMIT => {
                let r: m::GitCommit = params(p)?;
                ok(git::commit(&path(&r.path), &r.message, r.all)
                    .await
                    .map_err(internal)?)
            }
            m::GIT_LOG => {
                let r: m::GitPath = params(p)?;
                ok(git::log(&path(&r.path), r.base.as_deref())
                    .await
                    .map_err(internal)?)
            }
            m::GIT_BRANCHES => {
                let r: m::GitPath = params(p)?;
                ok(git::branches(&path(&r.path)).await.map_err(internal)?)
            }
            m::GH_PR_CREATE => {
                let r: m::PrCreate = params(p)?;
                ok(git::pr_create(
                    &path(&r.path),
                    &r.title,
                    &r.body,
                    r.base.as_deref(),
                    r.draft,
                )
                .await
                .map_err(internal)?)
            }
            m::GH_PR_STATUS => {
                let r: m::GitPath = params(p)?;
                ok(git::pr_status(&path(&r.path)).await.map_err(internal)?)
            }
            m::FS_LIST => {
                let r: m::FsList = params(p)?;
                ok(fs::list(&r.path, r.show_ignored).map_err(internal)?)
            }
            m::FS_READ => {
                let r: m::FsRead = params(p)?;
                ok(fs::read(&r.path, r.max_bytes).map_err(internal)?)
            }
            m::FS_WRITE => {
                let r: m::FsWrite = params(p)?;
                fs::write(&r.path, &r.content).map_err(internal)?;
                ok(true)
            }
            m::FS_WATCH => {
                let r: m::FsPath = params(p)?;
                self.watchers.watch(&r.path, conn.id).map_err(internal)?;
                ok(true)
            }
            m::FS_UNWATCH => {
                let r: m::FsPath = params(p)?;
                self.watchers.unwatch(&r.path, conn.id);
                ok(true)
            }
            other => Err(RpcError::new(
                "unknown_method",
                format!("unknown method {other}"),
            )),
        }
    }
}

/// The `jaunt` CLI ships next to `jauntd` (app bundle `Contents/MacOS`,
/// `~/.jaunt/bin` on remote hosts, `target/*` in development).
fn jaunt_cli_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let bin = exe.with_file_name("jaunt");
    anyhow::ensure!(
        bin.exists(),
        "jaunt CLI not found next to jauntd at {}",
        bin.display()
    );
    Ok(bin)
}

fn path(p: &str) -> PathBuf {
    jaunt_core::session::expand_home(p)
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
