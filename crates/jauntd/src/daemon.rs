//! Daemon state and request dispatch.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use jaunt_core::fs::Watchers;
use jaunt_core::hooks::{self, HookPaths};
use jaunt_core::paths::{hostname, now_ms};
use jaunt_core::chat::runtime::{ChatCreate, ChatManager, chats_dir};
use jaunt_core::session::SessionManager;
use jaunt_core::terminal::TerminalManager;
use jaunt_core::{fs, git};
use jaunt_proto::methods as m;
use jaunt_proto::types::DaemonInfo;
use jaunt_proto::{PROTOCOL_VERSION, RpcError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::server::Conn;

pub struct Daemon {
    pub terminals: Arc<TerminalManager>,
    pub chats: Arc<ChatManager>,
    pub sessions: Arc<SessionManager>,
    watchers: Arc<Watchers>,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    handed_off: AtomicBool,
    upgrading: AtomicBool,
}

pub type HandlerResult = Result<Value, RpcError>;

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_params", e.to_string()))
}

fn ok<T: Serialize>(v: T) -> HandlerResult {
    serde_json::to_value(v).map_err(|e| RpcError::new("internal", e.to_string()))
}

/// Runs synchronous filesystem work off the async workers, so a large
/// directory walk does not stall other connections.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, RpcError> {
    tokio::task::spawn_blocking(f).await.map_err(internal)?.map_err(internal)
}

pub fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", format!("{e:#}"))
}

impl Daemon {
    pub fn new(socket: PathBuf, base_env: BTreeMap<String, String>) -> Arc<Self> {
        let (shutdown, _) = watch::channel(false);
        let terminals = TerminalManager::new(socket.clone(), base_env);
        let sessions = SessionManager::load(
            jaunt_core::paths::state_file(),
            jaunt_core::paths::home().join("worktrees"),
            terminals.clone(),
        );
        let chats = ChatManager::new(terminals.clone(), chats_dir(&jaunt_core::paths::home()));
        sessions.set_chats(chats.clone());
        let emitter = terminals.clone();
        let watchers = Watchers::new(Arc::new(move |m| emitter.emit(m)));
        Arc::new(Self {
            terminals,
            chats,
            sessions,
            watchers,
            started_at: now_ms(),
            shutdown,
            handed_off: AtomicBool::new(false),
            upgrading: AtomicBool::new(false),
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

    /// False if another upgrade is already running.
    pub fn begin_upgrade(&self) -> bool {
        !self.upgrading.swap(true, Ordering::SeqCst)
    }

    pub fn end_upgrade(&self) {
        self.upgrading.store(false, Ordering::SeqCst);
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
            terminals: self.terminals.len(),
        }
    }

    pub async fn handle(self: &Arc<Self>, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        let s = &self.terminals;
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
                // Claim the upgrade here, so a refused request is reported.
                if !self.begin_upgrade() {
                    return Err(RpcError::new("busy", "an upgrade is already in progress"));
                }
                let me = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::upgrade::hand_off_claimed(me, Some(r.binary)).await {
                        tracing::error!("upgrade failed, still serving: {e:#}");
                    }
                });
                ok(true)
            }
            m::TERMINAL_CREATE => {
                let req: m::TerminalCreate = params(p)?;
                jaunt_core::chat::check_mode(req.mode.as_deref()).map_err(internal)?;
                match req.session_id.clone() {
                    Some(id) => {
                        let ws = self.sessions.session(&id).map_err(internal)?;
                        ok(self.sessions.spawn_in(&ws, req).map_err(internal)?)
                    }
                    None if req.chat => ok(self
                        .chats
                        .create(ChatCreate {
                            cwd: req.cwd,
                            agent: req.agent.unwrap_or_default(),
                            model: req.model,
                            effort: req.effort,
                            mode: req.mode,
                            name: req.title.clone().unwrap_or_default(),
                            title: req.title,
                            session_id: None,
                            env: req.env,
                        })
                        .map_err(internal)?),
                    None => ok(s.create(req).map_err(internal)?),
                }
            }
            m::CHAT_STATE => {
                let r: m::TerminalRef = params(p)?;
                ok(self.chats.state(r.id).map_err(internal)?)
            }
            m::CHAT_SEND => {
                let r: m::ChatSend = params(p)?;
                self.chats.send(r.id, &r.text).map_err(internal)?;
                ok(true)
            }
            m::CHAT_PERMISSION => {
                let r: m::ChatPermission = params(p)?;
                self.chats
                    .permission(r.id, &r.ask, &r.decision, r.message.as_deref(), r.answers.as_ref())
                    .map_err(internal)?;
                ok(true)
            }
            m::CHAT_INTERRUPT => {
                let r: m::TerminalRef = params(p)?;
                self.chats.interrupt(r.id).map_err(internal)?;
                ok(true)
            }
            m::CHAT_SETTINGS => {
                let r: m::ChatSettings = params(p)?;
                ok(self.chats.settings(r.id, r.model, r.effort, r.mode).map_err(internal)?)
            }
            m::TERMINAL_LIST => ok(s.list()),
            m::TERMINAL_DETACH => {
                let r: m::TerminalRef = params(p)?;
                s.detach(r.id, conn.id);
                ok(true)
            }
            m::TERMINAL_RESIZE => {
                let r: m::TerminalResize = params(p)?;
                s.resize(r.id, r.cols, r.rows).map_err(internal)?;
                ok(true)
            }
            m::TERMINAL_KILL => {
                let r: m::TerminalKill = params(p)?;
                s.kill(r.id, r.remove).map_err(internal)?;
                ok(true)
            }
            m::TERMINAL_SET_CLASSIC => {
                let r: m::TerminalSetClassic = params(p)?;
                ok(s.set_classic(r.id, r.classic).map_err(internal)?)
            }
            m::TERMINAL_WRITE => {
                let r: m::TerminalWrite = params(p)?;
                s.write(r.id, r.data.into_bytes()).map_err(internal)?;
                ok(true)
            }
            m::TERMINAL_SEARCH => {
                let r: m::TerminalSearch = params(p)?;
                ok(s.search(r.id, &r.query, r.regex, r.case_sensitive)
                    .map_err(internal)?)
            }
            m::AGENT_REPORT => {
                let r: m::AgentReport = params(p)?;
                s.report(r.terminal, r.state, r.source, r.message, r.agent)
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

    /// Workspaces, projects, sessions, git and files.
    async fn handle_project(&self, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        let w = &self.sessions;
        match method {
            m::WORKSPACE_LIST => ok(w.list_workspaces()),
            m::WORKSPACE_CREATE => {
                let r: m::WorkspaceCreate = params(p)?;
                ok(w.create_workspace(&r.name).map_err(internal)?)
            }
            m::WORKSPACE_UPDATE => ok(w.update_workspace(params(p)?).map_err(internal)?),
            m::WORKSPACE_DELETE => {
                let r: m::IdRef = params(p)?;
                w.delete_workspace(&r.id).map_err(internal)?;
                ok(true)
            }
            m::WORKSPACE_ADD_PROJECT => {
                let r: m::WorkspaceAddProject = params(p)?;
                ok(w.workspace_add_project(&r.id, &r.path)
                    .await
                    .map_err(internal)?)
            }
            m::SHELL_HISTORY => {
                let r: m::ShellHistory = params(p)?;
                let entries = tokio::task::spawn_blocking(move || {
                    jaunt_core::history::read(r.shell.as_deref())
                })
                .await
                .map_err(internal)?;
                ok(entries)
            }
            m::GH_ISSUES | m::GH_PRS => {
                let r: m::GitPath = params(p)?;
                let kind = if method == m::GH_PRS { "pr" } else { "issue" };
                ok(git::gh_list(&path(&r.path), kind).await.map_err(internal)?)
            }
            m::PROJECT_ADD => {
                let r: m::ProjectAdd = params(p)?;
                ok(w.add_project(&r.path).await.map_err(internal)?)
            }
            m::PROJECT_LIST => ok(w.list_projects()),
            m::PROJECT_REMOVE => {
                let r: m::IdRef = params(p)?;
                w.remove_project(&r.id).map_err(internal)?;
                ok(true)
            }
            m::PROJECT_CONFIG => {
                let r: m::IdRef = params(p)?;
                ok(w.project_config(&r.id).map_err(internal)?)
            }
            m::PROJECT_CONFIG_FILE => {
                let r: m::IdRef = params(p)?;
                ok(w.project_config_file(&r.id).await.map_err(internal)?)
            }
            m::PROJECT_SET_CONFIG => {
                let r: m::ProjectSetConfig = params(p)?;
                ok(w.set_project_config(&r.id, &r.version, &r.config).await.map_err(internal)?)
            }
            m::SESSION_CREATE => ok(w.create_session(params(p)?).await.map_err(internal)?),
            m::SESSION_LIST => ok(w.list_sessions()),
            m::SESSION_ARCHIVE => {
                w.archive(params(p)?).await.map_err(internal)?;
                ok(true)
            }
            m::SESSION_UNARCHIVE => {
                let r: m::IdRef = params(p)?;
                ok(w.unarchive(&r.id).await.map_err(internal)?)
            }
            m::SESSION_UPDATE => ok(w.update(params(p)?).map_err(internal)?),
            m::SESSION_RUN => {
                let r: m::SessionRun = params(p)?;
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
                let dir = path(&r.path);
                let pr = git::pr_create(&dir, &r.title, &r.body, r.base.as_deref(), r.draft)
                    .await
                    .map_err(internal)?;
                w.set_pr(&dir, pr.number).map_err(internal)?;
                ok(pr)
            }
            m::GH_PR_STATUS => {
                let r: m::GitPath = params(p)?;
                ok(w.pr_status(&path(&r.path)).await.map_err(internal)?)
            }
            m::GH_PR_STACK => {
                let r: m::PrStackParams = params(p)?;
                ok(git::pr_stack(&path(&r.path), r.number)
                    .await
                    .map_err(internal)?)
            }
            m::FS_LIST => {
                let r: m::FsList = params(p)?;
                ok(blocking(move || fs::list(&r.path, r.show_ignored)).await?)
            }
            m::FS_FILES => {
                let r: m::FsFiles = params(p)?;
                let files = tokio::task::spawn_blocking(move || fs::files(&r.root, r.limit))
                    .await
                    .map_err(internal)?;
                ok(files.map_err(internal)?)
            }
            m::FS_READ => {
                let r: m::FsRead = params(p)?;
                ok(blocking(move || fs::read(&r.path, r.max_bytes)).await?)
            }
            m::FS_WRITE => {
                let r: m::FsWrite = params(p)?;
                blocking(move || fs::write(&r.path, &r.content)).await?;
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
    jaunt_core::terminal::expand_home(p)
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
