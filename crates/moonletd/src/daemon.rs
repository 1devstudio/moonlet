//! Daemon state and request dispatch.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use moonlet_core::fs::Watchers;
use moonlet_core::hooks::{self, HookPaths};
use moonlet_core::paths::{hostname, now_ms};
use moonlet_core::chat::runtime::{ChatCreate, ChatManager, chats_dir};
use moonlet_core::session::SessionManager;
use moonlet_core::terminal::TerminalManager;
use moonlet_core::terminal_read::{self, TerminalReads};
use moonlet_core::{fs, git};
use moonlet_proto::methods as m;
use moonlet_proto::types::DaemonInfo;
use moonlet_proto::{Message, PROTOCOL_VERSION, RpcError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::server::Conn;

pub struct Daemon {
    pub terminals: Arc<TerminalManager>,
    pub chats: Arc<ChatManager>,
    pub sessions: Arc<SessionManager>,
    reads: TerminalReads,
    watchers: Arc<Watchers>,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    handed_off: AtomicBool,
    upgrading: AtomicBool,
    /// Last `claude auth status` per profile id (`""`: the default), X33.
    accounts: Mutex<HashMap<String, moonlet_proto::types::ProfileAccount>>,
}

pub type HandlerResult = Result<Value, RpcError>;

/// The name the `moonlet` CLI gives in its hello; agents reach the daemon
/// through it.
pub const CLI_CLIENT: &str = "moonlet-cli";

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
    pub fn new(socket: PathBuf, mut base_env: BTreeMap<String, String>) -> Arc<Self> {
        // Agents call the CLI as "$MOONLET_BIN" (X22): it is not on PATH.
        if let Ok(bin) = moonlet_cli_path() {
            base_env.insert("MOONLET_BIN".into(), bin.display().to_string());
        }
        // A daemon with its own data folder (tests, e2e, a custom setup)
        // passes it on, so `moonlet` in its terminals uses the same one and
        // never moves the user's ~/.jaunt (X27).
        let own_home = std::env::var_os("MOONLET_HOME").is_some() || std::env::var_os("JAUNT_HOME").is_some();
        if own_home {
            base_env.insert("MOONLET_HOME".into(), moonlet_core::paths::home().display().to_string());
        } else {
            // A new moonlet teaches agents its new commands (X31). A daemon
            // with its own data folder leaves the user's skills alone.
            match hooks::refresh_skills(&HookPaths::default_paths()) {
                Ok(updated) => {
                    for path in updated {
                        tracing::info!("updated the moonlet skill at {}", path.display());
                    }
                }
                Err(e) => tracing::warn!("cannot update the moonlet skill: {e:#}"),
            }
        }
        let (shutdown, _) = watch::channel(false);
        let terminals = TerminalManager::new(socket.clone(), base_env);
        let sessions = SessionManager::load(
            moonlet_core::paths::state_file(),
            moonlet_core::paths::home().join("worktrees"),
            terminals.clone(),
        );
        let chats = ChatManager::new(terminals.clone(), chats_dir(&moonlet_core::paths::home()));
        sessions.set_chats(chats.clone());
        let emitter = terminals.clone();
        let watchers = Watchers::new(Arc::new(move |m| emitter.emit(m)));
        // Tests shorten how long a read waits for the user (X31).
        let read_timeout = std::env::var("MOONLET_TERMINAL_READ_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(terminal_read::DEFAULT_TIMEOUT, std::time::Duration::from_millis);
        let reads = TerminalReads::new(terminals.clone(), read_timeout);
        Arc::new(Self {
            terminals,
            chats,
            sessions,
            reads,
            watchers,
            started_at: now_ms(),
            shutdown,
            handed_off: AtomicBool::new(false),
            upgrading: AtomicBool::new(false),
            accounts: Mutex::new(HashMap::new()),
        })
    }

    /// Profiles with their last known account and hook state (X33).
    fn profile_infos(&self) -> Vec<moonlet_proto::types::ProfileInfo> {
        let accounts = self.accounts.lock().unwrap().clone();
        self.sessions
            .list_profiles()
            .into_iter()
            .map(|p| {
                let paths = HookPaths::default_paths().with_claude_dir(Path::new(&p.path));
                let hooks_installed = hooks::status(&paths).is_ok_and(|s| s.claude_installed);
                moonlet_proto::types::ProfileInfo { account: accounts.get(&p.id).cloned(), hooks_installed, profile: p }
            })
            .collect()
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
                moonlet_core::chat::check_mode(req.mode.as_deref()).map_err(internal)?;
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
                            add_dirs: req.add_dirs,
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
                self.chats.send(r.id, &r.text, &r.images).map_err(internal)?;
                ok(true)
            }
            m::CHAT_PERMISSION => {
                let r: m::ChatPermission = params(p)?;
                self.chats
                    .permission(r.id, &r.ask, &r.decision, r.message.as_deref(), r.answers.as_ref(), r.mode.as_deref())
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
            m::CHAT_MCP => {
                let r: m::ChatMcp = params(p)?;
                self.chats.mcp(r.id, &r.action, r.server.as_deref()).map_err(internal)?;
                ok(true)
            }
            m::CHAT_ADD_DIR => {
                let r: m::ChatAddDir = params(p)?;
                ok(self.chats.add_dir(r.id, &r.path).map_err(internal)?)
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
            m::TERMINAL_READ => {
                let r: m::TerminalRead = params(p)?;
                ok(self.reads.read(r).await.map_err(internal)?)
            }
            m::TERMINAL_READ_LIST => {
                let r: m::TerminalRef = params(p)?;
                ok(self.reads.readable(r.id).map_err(internal)?.1)
            }
            m::TERMINAL_READ_ANSWER | m::TERMINAL_READ_REQUESTS if conn.client == CLI_CLIENT => {
                // An agent must not approve its own read, nor see the waiting
                // text, with `moonlet rpc` (X31).
                Err(RpcError::new("forbidden", "only the moonlet app answers read requests"))
            }
            m::TERMINAL_READ_ANSWER => {
                let r: m::ReadAnswer = params(p)?;
                self.reads.answer(r).map_err(internal)?;
                ok(true)
            }
            m::TERMINAL_READ_REQUESTS => ok(self.reads.requests()),
            m::TERMINAL_READ_GRANTS => ok(self.reads.grants()),
            m::TERMINAL_READ_GRANT_CLEAR => {
                let r: m::ReadGrantClear = params(p)?;
                self.reads.clear_grant(&r.session_id);
                ok(true)
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
                let bin = moonlet_cli_path().map_err(internal)?;
                let status = hooks::install(&HookPaths::default_paths(), &bin, r.claude, r.codex).map_err(internal)?;
                // And into every Claude profile's folder (X33).
                if r.claude {
                    for p in self.sessions.list_profiles() {
                        hooks::install(&HookPaths::default_paths().with_claude_dir(Path::new(&p.path)), &bin, true, false)
                            .map_err(internal)?;
                    }
                }
                ok(status)
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
            m::PROFILE_LIST => ok(self.profile_infos()),
            m::PROFILE_CREATE => {
                let r: m::ProfileCreate = params(p)?;
                let profile = w.create_profile(&r.name, r.path.as_deref()).map_err(internal)?;
                let bin = moonlet_cli_path().map_err(internal)?;
                // Without its hooks, agents in the profile report no state (A2).
                hooks::install(&HookPaths::default_paths().with_claude_dir(Path::new(&profile.path)), &bin, true, false)
                    .map_err(internal)?;
                ok(profile)
            }
            m::PROFILE_UPDATE => {
                let r: m::ProfileUpdate = params(p)?;
                ok(w.update_profile(&r.id, r.name.as_deref()).map_err(internal)?)
            }
            m::PROFILE_DELETE => {
                let r: m::IdRef = params(p)?;
                w.delete_profile(&r.id).map_err(internal)?;
                self.accounts.lock().unwrap().remove(&r.id);
                ok(true)
            }
            m::PROFILE_STATUS => {
                let r: m::ProfileStatus = params(p)?;
                let dir = match &r.id {
                    Some(id) => Some(w.list_profiles().into_iter().find(|p| &p.id == id).ok_or_else(|| internal("no such Claude profile"))?.path),
                    None => None,
                };
                let account = moonlet_core::profiles::account(self.terminals.base_env(), dir.as_deref()).await.map_err(internal)?;
                self.accounts.lock().unwrap().insert(r.id.clone().unwrap_or_default(), account.clone());
                self.terminals.emit(Message::event(m::EV_PROFILES_CHANGED, self.profile_infos()));
                ok(account)
            }
            m::WORKSPACE_LIST => ok(w.list_workspaces()),
            m::WORKSPACE_CREATE => ok(w.create_workspace(params(p)?).map_err(internal)?),
            m::WORKSPACE_UPDATE => ok(w.update_workspace(params(p)?).map_err(internal)?),
            m::WORKSPACE_DELETE => {
                let r: m::IdRef = params(p)?;
                w.delete_workspace(&r.id).map_err(internal)?;
                ok(true)
            }
            m::SECTION_LIST => ok(w.list_sections()),
            m::SECTION_CREATE => {
                let r: m::SectionCreate = params(p)?;
                ok(w.create_section(&r.workspace_id, &r.name).map_err(internal)?)
            }
            m::SECTION_UPDATE => ok(w.update_section(params(p)?).map_err(internal)?),
            m::SECTION_DELETE => {
                let r: m::IdRef = params(p)?;
                w.delete_section(&r.id).map_err(internal)?;
                ok(true)
            }
            m::SECTION_MOVE => {
                let r: m::SectionMove = params(p)?;
                w.move_section(&r.id, &r.workspace_id).map_err(internal)?;
                ok(true)
            }
            m::SECTION_ADD_PROJECT => {
                let r: m::SectionAddProject = params(p)?;
                ok(w.section_add_project(&r.id, &r.path)
                    .await
                    .map_err(internal)?)
            }
            m::SECTION_REMOVE_PROJECT => {
                let r: m::SectionRemoveProject = params(p)?;
                w.section_remove_project(&r.id, &r.project_id)
                    .map_err(internal)?;
                ok(true)
            }
            m::SHELL_HISTORY => {
                let r: m::ShellHistory = params(p)?;
                let entries = tokio::task::spawn_blocking(move || {
                    moonlet_core::history::read(r.shell.as_deref())
                })
                .await
                .map_err(internal)?;
                ok(entries)
            }
            m::SHELL_COMMANDS => {
                let r: m::ShellCommands = params(p)?;
                // The terminal's own PATH when its shell reported one, which
                // includes what rc files added; else the login shell's.
                let path = r
                    .terminal
                    .and_then(|id| self.terminals.shell_path(id))
                    .or_else(|| self.terminals.base_env().get("PATH").cloned())
                    .unwrap_or_default();
                let shell = r.shell.unwrap_or_else(|| {
                    let login = moonlet_core::pty::user_shell();
                    login.rsplit('/').next().unwrap_or("zsh").to_string()
                });
                let names = tokio::task::spawn_blocking(move || moonlet_core::commands::list(&path, &shell))
                    .await
                    .map_err(internal)?;
                ok(names)
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
                let r: m::SessionArchive = params(p)?;
                let id = r.id.clone();
                w.archive(r).await.map_err(internal)?;
                self.reads.clear_grant(&id);
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
            m::GIT_BASE_STATUS => {
                let r: m::GitBase = params(p)?;
                ok(git::base_status(&path(&r.path), &r.branch, r.fetch)
                    .await
                    .map_err(internal)?)
            }
            m::GIT_ORIGIN_URL => {
                let r: m::GitPath = params(p)?;
                ok(git::origin_url(&path(&r.path)).await)
            }
            m::GIT_PULL_BASE => {
                let r: m::GitBase = params(p)?;
                ok(git::pull_base(&path(&r.path), &r.branch)
                    .await
                    .map_err(internal)?)
            }
            m::GH_PR_CREATE => {
                let r: m::PrCreate = params(p)?;
                let dir = path(&r.path);
                let pr = git::pr_create(&dir, &r.title, &r.body, r.base.as_deref(), r.draft)
                    .await
                    .map_err(internal)?;
                // The PR exists either way; a failed save only means it is
                // found again by the next `gh.pr_status`.
                if let Err(e) = w.set_pr(&dir, pr.number) {
                    tracing::warn!(pr = pr.number, "could not record the session's PR: {e:#}");
                }
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

/// The `moonlet` CLI ships next to `moonletd` (app bundle `Contents/MacOS`,
/// `~/.moonlet/bin` on remote hosts, `target/*` in development).
fn moonlet_cli_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let bin = exe.with_file_name("moonlet");
    anyhow::ensure!(
        bin.exists(),
        "moonlet CLI not found next to moonletd at {}",
        bin.display()
    );
    Ok(bin)
}

fn path(p: &str) -> PathBuf {
    moonlet_core::terminal::expand_home(p)
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
