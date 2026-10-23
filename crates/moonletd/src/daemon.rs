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
use moonlet_core::{fs, git, git_settings};
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
    /// Design systems and designs under `~/.moonlet/design` (X64, X65).
    design: moonlet_core::design::store::Store,
    /// One sync agent start at a time per design system (X64).
    design_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    reads: TerminalReads,
    watchers: Arc<Watchers>,
    started_at: u64,
    shutdown: watch::Sender<bool>,
    handed_off: AtomicBool,
    upgrading: AtomicBool,
    /// Last `claude auth status` per profile id (`None`: the default), X33.
    accounts: Mutex<HashMap<Option<String>, moonlet_proto::types::ProfileAccount>>,
    /// A `claude update` is running (X36).
    claude_updating: AtomicBool,
    /// Phone access over Tailscale (X39).
    pub mobile: Arc<crate::mobile::Mobile>,
    /// Clones started from Add project (X59).
    clones: Arc<crate::clones::Clones>,
    /// This Mac's link to its central host (X41).
    pub link: Arc<crate::link::WorkerLink>,
    /// The workers linked to this daemon as their central host (X41).
    pub workers: Arc<crate::workers::Workers>,
    /// Live copies: this Mac's of sessions on its central host, and the
    /// ones this daemon serves as a central host (X60).
    pub sync: Arc<crate::sync::LiveCopies>,
    /// Approved heavy commands and routing decisions (X62).
    heavy: Arc<crate::heavy::Heavy>,
    /// Cloud workers' settings and machines (X63).
    cloud: Arc<crate::cloud::CloudSettings>,
    pub machines: Arc<crate::machines::Machines>,
    /// Heavy commands running on this machine or routed to its workers (X62).
    pub runs: Arc<crate::exec::Runs>,
    /// Every session's routed commands, with their output (X62).
    jobs: Arc<crate::jobs::Jobs>,
}

pub type HandlerResult = Result<Value, RpcError>;

/// A raised flag, lowered when dropped: also when the request that raised
/// it ends early.
struct Flag<'a>(&'a AtomicBool);

impl<'a> Flag<'a> {
    /// None when the flag is already up.
    fn raise(flag: &'a AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Flag(flag))
    }
}

impl Drop for Flag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The name the `moonlet` CLI gives in its hello; agents reach the daemon
/// through it.
pub const CLI_CLIENT: &str = "moonlet-cli";

/// Refuses what only the Mac's own app may do, such as managing `what`:
/// never a paired device over the tailnet, nor an agent's `moonlet` CLI.
pub(crate) fn app_only(conn: &Conn, what: &str) -> Result<(), RpcError> {
    if conn.phone.is_some() {
        return Err(RpcError::new("forbidden", format!("manage {what} from the Mac")));
    }
    if conn.client == CLI_CLIENT {
        return Err(RpcError::new("forbidden", format!("only the moonlet app manages {what}")));
    }
    Ok(())
}

/// What a cloud machine may call on its central host (X63).
const CLOUD_METHODS: &[&str] = &[
    m::WORKER_REGISTER,
    m::WORKER_STEP,
    m::SYNC_OPEN,
    m::SYNC_FETCH,
    m::SYNC_OFFER,
    m::SYNC_CLOSE,
    m::EXEC_DONE,
];

/// Jobs hold commands' output: the app and paired devices read and stop
/// them, never an agent's CLI nor a worker (X62).
fn jobs_reader(conn: &Conn) -> Result<(), RpcError> {
    if conn.client == CLI_CLIENT || conn.client == crate::link::WORKER_CLIENT {
        return Err(RpcError::new("forbidden", "only the moonlet app manages jobs"));
    }
    Ok(())
}

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

/// moonlet's hook and skill paths with Claude's in profile folder `dir` (X33).
fn profile_hooks(dir: &str) -> HookPaths {
    HookPaths::default_paths().with_claude_dir(Path::new(dir))
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
        // Profiles' skills too (X33), under the same rule as the default's.
        if !own_home {
            for p in sessions.list_profiles() {
                match hooks::refresh_skills(&profile_hooks(&p.path)) {
                    Ok(updated) => updated.iter().for_each(|path| tracing::info!("updated the moonlet skill at {}", path.display())),
                    Err(e) => tracing::warn!("cannot update the moonlet skill in {}: {e:#}", p.path),
                }
            }
        }
        let emitter = terminals.clone();
        let watchers = Watchers::new(Arc::new(move |m| emitter.emit(m)));
        // Tests shorten how long a read waits for the user (X31).
        let read_timeout = std::env::var("MOONLET_TERMINAL_READ_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(terminal_read::DEFAULT_TIMEOUT, std::time::Duration::from_millis);
        let reads = TerminalReads::new(terminals.clone(), read_timeout);
        let emitter = terminals.clone();
        let mobile = Arc::new(crate::mobile::Mobile::load(crate::mobile::Mobile::default_file(), move |m| emitter.emit(m)));
        let clones = crate::clones::Clones::new(sessions.clone(), terminals.clone());
        let emitter = terminals.clone();
        let link = crate::link::WorkerLink::new(
            crate::link::LinkStore::load(moonlet_core::paths::home().join("link.json"), &crate::link::computer_name()),
            sessions.clone(),
            move |m| emitter.emit(m),
        );
        let emitter = terminals.clone();
        let workers = Arc::new(crate::workers::Workers::new(move |m| emitter.emit(m)));
        let emitter = terminals.clone();
        let sync = crate::sync::LiveCopies::new(
            moonlet_core::paths::home(),
            sessions.clone(),
            link.clone(),
            workers.clone(),
            terminals.base_env().clone(),
            move |m| emitter.emit(m),
        );
        link.set_sync(Arc::downgrade(&sync));
        let heavy = crate::heavy::Heavy::new(&moonlet_core::paths::home(), sessions.clone());
        let emitter = terminals.clone();
        let jobs = Arc::new(crate::jobs::Jobs::load(
            moonlet_core::paths::home().join("jobs"),
            move |m| emitter.emit(m),
        ));
        let runs = crate::exec::Runs::new(terminals.base_env().clone(), jobs.clone());
        let cloud = Arc::new(crate::cloud::CloudSettings::load(&moonlet_core::paths::home()));
        let emitter = terminals.clone();
        let machines = crate::machines::Machines::new(
            &moonlet_core::paths::home(),
            cloud.clone(),
            mobile.clone(),
            link.clone(),
            workers.clone(),
            sessions.clone(),
            move |m| emitter.emit(m),
        );
        runs.set_machines(Arc::downgrade(&machines));
        link.set_runs(Arc::downgrade(&runs));
        Arc::new(Self {
            heavy,
            cloud,
            machines,
            runs,
            jobs,
            clones,
            terminals,
            chats,
            sessions,
            design: moonlet_core::design::store::Store::new(&moonlet_core::paths::home()),
            design_locks: Mutex::new(HashMap::new()),
            reads,
            watchers,
            started_at: now_ms(),
            shutdown,
            handed_off: AtomicBool::new(false),
            upgrading: AtomicBool::new(false),
            accounts: Mutex::new(HashMap::new()),
            claude_updating: AtomicBool::new(false),
            mobile,
            link,
            workers,
            sync,
        })
    }

    /// Profiles with their last known account and hook state (X33).
    fn profile_infos(&self) -> Vec<moonlet_proto::types::ProfileInfo> {
        let accounts = self.accounts.lock().unwrap().clone();
        self.sessions
            .list_profiles()
            .into_iter()
            .map(|p| {
                let hooks_installed = hooks::status(&profile_hooks(&p.path)).is_ok_and(|s| s.claude_installed);
                moonlet_proto::types::ProfileInfo { account: accounts.get(&Some(p.id.clone())).cloned(), hooks_installed, profile: p }
            })
            .collect()
    }

    /// Refuses all but the Mac's app and a paired Mac over the tailnet
    /// (X61): never a phone, nor an agent's CLI.
    fn app_or_paired_mac(&self, conn: &Conn, what: &str) -> Result<(), RpcError> {
        // A paired Mac's daemon linked as a worker is not its app.
        if conn.client == crate::link::WORKER_CLIENT {
            return Err(RpcError::new("forbidden", format!("only the moonlet app manages {what}")));
        }
        let Some(device) = conn.phone.as_deref() else {
            return app_only(conn, what);
        };
        let mac = self
            .mobile
            .status()
            .devices
            .iter()
            .any(|d| d.id == device && d.kind == m::DeviceKind::Desktop);
        if !mac {
            return app_only(conn, what);
        }
        Ok(())
    }

    /// Refuses all but those who may change the worker link: the Mac's app,
    /// or a paired Mac over the tailnet (X61), which may not set `central`,
    /// as that hands over a token. A phone and an agent's CLI may not.
    fn link_managers_only(&self, conn: &Conn, sets_central: bool) -> Result<(), RpcError> {
        self.app_or_paired_mac(conn, "the link")?;
        if sets_central && conn.phone.is_some() {
            return Err(RpcError::new(
                "forbidden",
                "a paired Mac cannot set the central host; pair with it instead",
            ));
        }
        Ok(())
    }

    /// Every change to profiles or their accounts sends the full list, as
    /// `profile.list` returns it.
    fn emit_profiles(&self) {
        self.terminals.emit(Message::event(m::EV_PROFILES_CHANGED, self.profile_infos()));
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
        self.workers.disconnected(client);
    }

    pub fn info(&self) -> DaemonInfo {
        DaemonInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
            pid: std::process::id(),
            host: hostname(),
            home: dirs_home(),
            data_dir: moonlet_core::paths::home().display().to_string(),
            started_at: self.started_at,
            terminals: self.terminals.len(),
        }
    }

    pub async fn handle(self: &Arc<Self>, conn: &Arc<Conn>, method: &str, p: Value) -> HandlerResult {
        // A cloud machine reaches only what a worker needs (X63).
        if let Some(device) = conn.phone.as_deref()
            && self.machines.machine_of(device).is_some()
            && !CLOUD_METHODS.contains(&method)
        {
            return Err(RpcError::new("forbidden", "a cloud machine only runs heavy commands"));
        }
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
                            settings: None,
                            workspace: None,
                        })
                        .map_err(internal)?),
                    None => ok(s.create(req).map_err(internal)?),
                }
            }
            m::CHAT_STATE => {
                let r: m::TerminalRef = params(p)?;
                ok(self.chats.state(r.id).map_err(internal)?)
            }
            m::CHAT_SUMMARIES => ok(self
                .chats
                .summaries()
                .into_iter()
                .map(|(id, state)| serde_json::json!({ "id": id, "state": state }))
                .collect::<Vec<_>>()),
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
            m::CHAT_SEND_NOW => {
                let r: m::ChatSendNow = params(p)?;
                self.chats.send_now(r.id, r.message.as_deref()).map_err(internal)?;
                ok(true)
            }
            m::CHAT_UNQUEUE => {
                let r: m::ChatUnqueue = params(p)?;
                self.chats.unqueue(r.id, &r.message).map_err(internal)?;
                ok(true)
            }
            m::CHAT_ASIDE => {
                let r: m::ChatAside = params(p)?;
                ok(self.chats.aside(r.id, &r.text).await.map_err(internal)?)
            }
            m::CHAT_STOP_AGENT => {
                let r: m::ChatStopAgent = params(p)?;
                self.chats.stop_agent(r.id, &r.agent).map_err(internal)?;
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
                        hooks::install(&profile_hooks(&p.path), &bin, true, false).map_err(internal)?;
                    }
                }
                ok(status)
            }
            m::HOOKS_UNINSTALL => {
                let status = hooks::uninstall(&HookPaths::default_paths()).map_err(internal)?;
                for p in self.sessions.list_profiles() {
                    hooks::uninstall(&profile_hooks(&p.path)).map_err(internal)?;
                }
                ok(status)
            }
            m::MOBILE_HOSTS => ok(self.mobile.hosts()),
            m::MOBILE_UNPAIR => match &conn.phone {
                Some(device) => {
                    self.mobile.unpair(device)?;
                    self.workers.forget_device(device);
                    ok(true)
                }
                None => Err(RpcError::new("invalid_params", "not a paired device")),
            },
            method if method.starts_with("mobile.") => self.handle_mobile(conn, method, p),
            method if method.starts_with("design.") => self.handle_design(conn, method, p).await,
            m::REPO_GH_STATUS => ok(moonlet_core::repo_clone::gh_status().await),
            m::REPO_LOOKUP => {
                let r: m::RepoRef = params(p)?;
                ok(moonlet_core::repo_clone::lookup(&r.repo, r.ssh.as_deref()).await.map_err(internal)?)
            }
            m::REPO_LIST => {
                let folders: Vec<String> = self.sessions.list_projects().into_iter().map(|p| p.path).collect();
                let added = moonlet_core::repo_clone::folder_repos(&folders).await;
                ok(moonlet_core::repo_clone::user_repos(&added).await.map_err(internal)?)
            }
            m::REPO_CLONE_TARGET => {
                let r: m::RepoCloneTarget = params(p)?;
                ok(moonlet_core::repo_clone::clone_target(&r.repo, &r.parent, &r.name).await.map_err(internal)?)
            }
            m::REPO_CLONE => ok(self.clones.start(params(p)?).map_err(internal)?),
            m::REPO_CLONE_CANCEL => {
                let r: m::IdRef = params(p)?;
                self.clones.cancel(&r.id).map_err(internal)?;
                ok(true)
            }
            m::LINK_GET => ok(self.link.info()),
            // A phone or an agent's CLI could otherwise point this Mac's link
            // at a host of its choosing. A paired Mac may, as it can already
            // run commands here (X61), but never hands over a token.
            m::LINK_SET => {
                // Checked before the params are read, so a phone learns
                // nothing from them, and again on what was read: serde also
                // takes the params as an array, which has no "central" key.
                self.link_managers_only(conn, false)?;
                let r: m::LinkSet = params(p)?;
                self.link_managers_only(conn, r.central.is_some())?;
                ok(self.link.set(r, &crate::mobile::tailscale_addresses())?)
            }
            m::LINK_RETRY => {
                self.link_managers_only(conn, false)?;
                self.link.retry();
                ok(self.link.info())
            }
            m::LINK_JOIN => {
                // `moonletd join` on a fresh cloud machine (X63).
                app_only(conn, "the link")?;
                let r: m::LinkJoin = params(p)?;
                ok(self.link.join(r, &crate::mobile::tailscale_addresses()).await?)
            }
            m::LINK_PAIR => {
                self.link_managers_only(conn, false)?;
                let r: m::LinkPair = params(p)?;
                ok(self.link.pair(r, &crate::mobile::tailscale_addresses()).await?)
            }
            m::HEAVY_GET => {
                let r: m::HeavyGet = params(p)?;
                ok(self.heavy.get(&r.project)?)
            }
            m::HEAVY_SET => {
                let r: m::HeavySet = params(p)?;
                ok(self.heavy.set(&r.project, &r.heavy)?)
            }
            // An agent could otherwise approve the commands it adds (X62).
            m::HEAVY_APPROVE => {
                self.app_or_paired_mac(conn, "heavy commands")?;
                let r: m::HeavyApprove = params(p)?;
                match (&r.project, &r.identity) {
                    (Some(_), _) => ok(self.heavy.approve(r)?),
                    // On a worker: a project of its central host (X62).
                    (None, Some(identity)) => {
                        let approval = m::HeavyApproval {
                            commands: crate::heavy::sorted(&r.commands),
                            env: crate::heavy::sorted(&r.env),
                        };
                        self.sync.approve_heavy(identity, approval)?;
                        // Its central host no longer says it has not approved.
                        self.link.register_again();
                        ok(true)
                    }
                    (None, None) => Err(RpcError::new("invalid_params", "give project or identity")),
                }
            }
            m::EXEC_RUN => {
                let r: m::ExecRun = params(p)?;
                let checked = self
                    .heavy
                    .check_run(&r.session, &r.argv, &r.cwd, &r.env)
                    .map_err(crate::exec::refused)?;
                let mut env = self.terminals.base_env().clone();
                env.extend(checked.env.clone());
                env.insert("MOONLET_ROUTED".into(), "1".into());
                env.insert("MOONLET_SESSION".into(), r.session.clone());
                let me = self.link.info().worker;
                let session = self.sessions.session(&r.session).ok();
                let plan = crate::exec::Plan {
                    session: r.session,
                    worktree: checked.worktree.display().to_string(),
                    project: checked.project.clone(),
                    project_id: session.as_ref().map(|s| s.project_id.clone()).unwrap_or_default(),
                    session_name: session.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                    cloud: session.as_ref().is_some_and(|s| s.cloud),
                    tool_use_id: r.tool_use_id.clone(),
                    argv: r.argv.clone(),
                    cwd_rel: checked.cwd_rel,
                    env: checked.env,
                    local: crate::exec::Command { argv: r.argv, cwd: checked.cwd, env },
                    os: checked.os,
                    outputs: checked.outputs,
                    host: me.name,
                    slots: me.slots,
                };
                ok(self.runs.start(conn.clone(), plan, self.workers.clone(), self.sync.clone()))
            }
            m::CLOUD_GET => ok(self.cloud.info(self.machines.provider_infos())),
            m::CLOUD_TYPES => {
                let r: m::CloudTypes = params(p)?;
                ok(self.machines.types(&r.provider, &r.location).await?)
            }
            m::CLOUD_MACHINES => ok(self.machines.list()),
            // Agents may start and remove machines: the limits bound them.
            m::CLOUD_UP => {
                let r: m::CloudUp = params(p)?;
                ok(self.machines.up(&r.project, r.session)?)
            }
            m::CLOUD_DOWN => {
                let r: m::CloudDown = params(p)?;
                ok(self.machines.down(&r.machine)?)
            }
            m::WORKER_STEP => {
                let machine = conn.phone.as_deref().and_then(|d| self.machines.machine_of(d));
                let Some(machine) = machine else {
                    return Err(RpcError::new("forbidden", "only a cloud machine reports its steps"));
                };
                let r: m::WorkerStep = params(p)?;
                self.machines.step(&machine, r);
                ok(true)
            }
            // It uses the OAuth client's secret: as cloud.set.
            m::CLOUD_CHECK => {
                self.app_or_paired_mac(conn, "cloud workers")?;
                ok(self.machines.check_tailscale().await?)
            }
            m::CLOUD_SET => {
                // Tokens and limits: never an agent's CLI nor a phone.
                self.app_or_paired_mac(conn, "cloud workers")?;
                let r: m::CloudSet = params(p)?;
                // Projects turned off and providers removed: their machines go.
                let off: Vec<String> = r
                    .projects
                    .iter()
                    .flatten()
                    .filter(|(_, p)| p.is_none())
                    .map(|(k, _)| k.clone())
                    .collect();
                let gone: Vec<String> = r
                    .providers
                    .iter()
                    .flatten()
                    .filter(|(_, p)| p.is_none())
                    .map(|(k, _)| k.clone())
                    .collect();
                let machines = self.machines.clone();
                let info = self.cloud.set(r, self.machines.provider_infos(), &|p| machines.has_machines(p))?;
                for key in off {
                    self.machines.project_off(&key);
                }
                for provider in gone {
                    self.machines.provider_off(&provider);
                }
                ok(info)
            }
            m::EXEC_SETUPS => {
                app_only(conn, "setup")?;
                ok(self.sync.run_setups())
            }
            m::EXEC_STATUS => {
                jobs_reader(conn)?;
                let me = self.link.info().worker;
                let host = m::ExecHost {
                    name: me.name,
                    os: crate::link::os().into(),
                    cores: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
                    load: crate::link::load(),
                    slots: me.slots,
                    used: 0,
                };
                ok(self.runs.status(host))
            }
            m::EXEC_CANCEL => {
                let r: m::ExecCancel = params(p)?;
                ok(self.runs.cancel(conn.id, r.run).await)
            }
            // A worker's run ended: its changes come into the session
            // before `moonlet exec` hears the exit status (X62).
            m::EXEC_DONE => {
                if conn.client != crate::link::WORKER_CLIENT || conn.phone.is_none() {
                    return Err(RpcError::new("forbidden", "only a worker ends a run"));
                }
                let r: m::ExecDone = params(p)?;
                let Some(outputs) = self.runs.runs_on(conn.id, r.run, &r.copy) else {
                    return Err(RpcError::new("not_found", "no such run"));
                };
                let host = self.link.info().worker.name;
                let began = std::time::Instant::now();
                let brought = match r.pack {
                    Some(t) => conn
                        .take_pack(t)
                        .ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive")),
                    None => Ok(Vec::new()),
                };
                let brought = match brought {
                    Ok(pack) => {
                        let pack = r.pack.map(|_| pack);
                        self.sync.run_back(conn, &r, pack, &host, &outputs).await
                    }
                    Err(e) => Err(e),
                };
                let back_ms = began.elapsed().as_millis() as u64;
                // The run ends either way: its client is told what was lost.
                let ended = brought.clone().unwrap_or_else(|e| m::ExecBrought {
                    notes: vec![format!("cannot bring back the run's changes: {}", e.message)],
                    ..Default::default()
                });
                self.runs.done(conn.id, r.run, r.status, ended, back_ms);
                ok(brought?)
            }
            m::JOB_LIST => {
                jobs_reader(conn)?;
                let r: m::JobList = params(p)?;
                ok(self.jobs.list(&r.session))
            }
            m::JOB_OUTPUT => {
                jobs_reader(conn)?;
                let r: m::JobOutputGet = params(p)?;
                ok(self.jobs.read(&r.job, r.from).ok_or_else(|| RpcError::new("not_found", "no such job"))?)
            }
            m::JOB_STOP => {
                jobs_reader(conn)?;
                let r: m::JobRef = params(p)?;
                ok(self.runs.stop_job(&r.job).await)
            }
            m::JOB_STOP_ALL => {
                jobs_reader(conn)?;
                let r: m::JobList = params(p)?;
                ok(self.runs.stop_session(&r.session).await)
            }
            // A job waits for a machine only once cloud workers come (X63).
            m::JOB_RUN_HERE => {
                jobs_reader(conn)?;
                let r: m::JobRef = params(p)?;
                ok(self.runs.run_here(&r.job)?)
            }
            m::EXEC_ROUTE => {
                let r: m::ExecRoute = params(p)?;
                ok(self.heavy.route(&r))
            }
            m::WORKER_LIST => ok(self.workers.list()),
            m::WORKER_REGISTER => {
                // Only a worker's daemon, over the tailnet with a paired
                // device's token, registers.
                let Some(device) = conn.phone.as_deref().filter(|_| conn.client == crate::link::WORKER_CLIENT) else {
                    return Err(RpcError::new("forbidden", "only a worker registers"));
                };
                if !self.mobile.is_paired(device) {
                    return Err(RpcError::new("forbidden", "this Mac is no longer paired"));
                }
                let r: m::WorkerRegister = params(p)?;
                let id = r.id.clone();
                self.workers.register(conn.clone(), device, r)?;
                self.sync.worker_linked(&id);
                if let Some(machine) = self.machines.machine_of(device) {
                    self.machines.registered(&machine, &id);
                }
                // It may have approved meanwhile: the next run asks again.
                self.runs.forget_not_approved(&id);
                ok(true)
            }
            // A copy clones and writes on this Mac: only its app starts one
            // (X60). Anyone may list them.
            m::SYNC_START => {
                app_only(conn, "sync")?;
                let r: m::SyncStart = params(p)?;
                ok(self.sync.start(r.session)?)
            }
            m::SYNC_LIST => ok(self.sync.list()),
            m::SYNC_PROJECT_GET => {
                let r: m::SyncProject = params(p)?;
                ok(self.sync.project_get(&r.identity))
            }
            m::SYNC_DECLINE => {
                app_only(conn, "sync")?;
                let r: m::SyncStart = params(p)?;
                self.sync.decline(r.session);
                ok(true)
            }
            m::SYNC_PROJECT_SET => {
                // Like the link itself: from this Mac's app only.
                app_only(conn, "sync")?;
                let r: m::SyncProjectSet = params(p)?;
                ok(self.sync.project_set(&r.identity, r.keep_new)?)
            }
            m::SYNC_RUN_SETUP | m::SYNC_SKIP_SETUP => {
                // The user approves what runs on this Mac: not a paired
                // device, nor an agent through the CLI.
                app_only(conn, "setup")?;
                if method == m::SYNC_RUN_SETUP {
                    let r: m::SyncRunSetup = params(p)?;
                    ok(self.sync.run_setup(&r.copy, &r.command).await?)
                } else {
                    let r: m::CopyRef = params(p)?;
                    ok(self.sync.skip_setup(&r.copy)?)
                }
            }
            m::SYNC_RETRY => {
                app_only(conn, "sync")?;
                let r: m::CopyRef = params(p)?;
                ok(self.sync.retry(&r.copy)?)
            }
            m::SYNC_RESOLVE => {
                app_only(conn, "sync")?;
                let r: m::SyncResolve = params(p)?;
                ok(self.sync.resolve(r).await?)
            }
            m::SYNC_USE_CENTRAL_BRANCH => {
                app_only(conn, "sync")?;
                let r: m::CopyRef = params(p)?;
                ok(self.sync.use_central_branch(&r.copy).await?)
            }
            m::SYNC_STOP => {
                app_only(conn, "sync")?;
                let r: m::CopyRef = params(p)?;
                ok(self.sync.stop(&r.copy).await?)
            }
            m::SYNC_OPEN | m::SYNC_FETCH | m::SYNC_OFFER | m::SYNC_CLOSE => {
                // Only a worker's daemon, over the tailnet (X60).
                if conn.phone.is_none() || conn.client != crate::link::WORKER_CLIENT {
                    return Err(RpcError::new("forbidden", "only a worker keeps copies"));
                }
                match method {
                    m::SYNC_OPEN => {
                        let r: m::SyncOpen = params(p)?;
                        // A cloud machine (X63) opens copies of its own project only.
                        let machine = conn.phone.as_deref().and_then(|d| self.machines.machine_of(d));
                        match machine {
                            Some(machine) => self.machines.may_open(&machine, &r.session)?,
                            // A cloud connection whose device is gone (its
                            // machine is being removed) opens nothing.
                            None if conn.cloud.load(std::sync::atomic::Ordering::Relaxed) => {
                                return Err(RpcError::new("forbidden", "this machine is being removed"));
                            }
                            None => {}
                        }
                        ok(self.sync.open(conn, r).await?)
                    }
                    m::SYNC_FETCH => ok(self.sync.fetch(conn, params(p)?).await?),
                    m::SYNC_CLOSE => {
                        let r: m::CopyRef = params(p)?;
                        ok(self.sync.close(conn, &r.copy).await?)
                    }
                    _ => {
                        let r: m::SyncOffer = params(p)?;
                        let pack = match r.pack {
                            Some(t) => Some(conn.take_pack(t).ok_or_else(|| {
                                RpcError::new("invalid_params", "the pack did not arrive")
                            })?),
                            None => None,
                        };
                        ok(self.sync.reconcile_offer(conn, r, pack).await?)
                    }
                }
            }
            _ => self.handle_project(conn, method, p).await,
        }
    }

    /// Phone access (X39): managed from the Mac's app only, never from a
    /// phone or an agent's `moonlet` CLI.
    fn handle_mobile(self: &Arc<Self>, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        app_only(conn, "phones")?;
        match method {
            m::MOBILE_STATUS => ok(self.mobile.status()),
            m::MOBILE_SET_ENABLED => {
                let r: m::MobileSetEnabled = params(p)?;
                self.mobile.set_enabled(r.enabled);
                ok(self.mobile.status())
            }
            m::MOBILE_PAIR_START => {
                let r = params::<Option<m::MobilePairStart>>(p)?.unwrap_or_default();
                ok(self.mobile.pair_start(r.kind)?)
            }
            m::MOBILE_PAIR_CANCEL => {
                self.mobile.pair_cancel();
                ok(true)
            }
            m::MOBILE_REVOKE => {
                let r: m::IdRef = params(p)?;
                self.mobile.revoke(&r.id)?;
                self.workers.forget_device(&r.id);
                ok(true)
            }
            _ => Err(RpcError::new("unknown_method", format!("unknown method {method}"))),
        }
    }

    /// Design systems (X64).
    async fn handle_design(&self, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        // The app and the agents' CLI on this Mac, never a paired device.
        if conn.phone.is_some() {
            return Err(RpcError::new("forbidden", "manage design systems from the Mac"));
        }
        use moonlet_core::design::store::{self, Settle, Source};
        let store = self.design.clone();
        // Design folders belong to a moonlet workspace (ADR 0013).
        let workspace = p.get("workspace").and_then(Value::as_str).unwrap_or_default();
        if !self.sessions.list_workspaces().iter().any(|w| w.id == workspace) {
            return Err(RpcError::new("invalid_params", format!("no workspace \"{workspace}\"")));
        }
        match method {
            m::DESIGN_SYSTEMS => {
                let r: m::DesignWorkspace = params(p)?;
                ok(blocking(move || store.systems(&r.workspace)).await?)
            }
            m::DESIGN_SYSTEM_CREATE => {
                let r: m::DesignSystemCreate = params(p)?;
                let projects = self.sessions.list_projects();
                let mut sources = Vec::new();
                for pick in &r.sources {
                    let Some(p) = projects.iter().find(|p| p.id == pick.project) else {
                        return Err(RpcError::new("invalid_params", format!("no project {}", pick.project)));
                    };
                    sources.push(Source {
                        project: p.id.clone(),
                        path: p.path.clone(),
                        identity: p.identity.clone(),
                        subdir: pick.subdir.clone(),
                        commit: None,
                    });
                }
                let (workspace, start) = (r.workspace.clone(), r.agent);
                let slug = blocking(move || store.create_system(&r.workspace, &r.name, sources, now_ms())).await?;
                let (agent, agent_error) = match start {
                    // The system exists either way; the app shows why its agent did not start.
                    true => match self.start_sync_agent(&workspace, &slug).await {
                        Ok(id) => (Some(id), None),
                        Err(e) => (None, Some(format!("{e:#}"))),
                    },
                    false => (None, None),
                };
                ok(serde_json::json!({"slug": slug, "agent": agent, "agent_error": agent_error}))
            }
            m::DESIGN_SYSTEM_SYNC => {
                let r: m::DesignSystemRef = params(p)?;
                let agent = self.start_sync_agent(&r.workspace, &r.slug).await.map_err(internal)?;
                ok(serde_json::json!({"agent": agent}))
            }
            m::DESIGN_SYSTEM_REMOVE => {
                let r: m::DesignSystemRef = params(p)?;
                self.stop_sync_agent(&r.workspace, &r.slug);
                blocking(move || store.remove_system(&r.workspace, &r.slug)).await?;
                ok(true)
            }
            m::DESIGN_SYSTEM_PROGRESS => {
                let r: m::DesignProgress = params(p)?;
                blocking(move || store.progress(&r.workspace, &r.slug, &r.step, r.summary.as_deref())).await?;
                ok(true)
            }
            m::DESIGN_SYSTEM_SYNCED => {
                let r: m::DesignSystemRef = params(p)?;
                let record = self.design.record(&r.workspace, &r.slug).map_err(internal)?;
                // Every source gets an entry: one whose HEAD cannot be read
                // gets none, so no stale commit stays recorded.
                let mut commits = Vec::new();
                for s in &record.sources {
                    commits.push((s.project.clone(), git::head(Path::new(&s.path)).await.ok()));
                }
                blocking(move || store.synced(&r.workspace, &r.slug, &commits, now_ms())).await?;
                ok(true)
            }
            m::DESIGN_CHECK => {
                let r: m::DesignSystemRef = params(p)?;
                ok(blocking(move || store.check_system(&r.workspace, &r.slug)).await?)
            }
            m::DESIGN_FILE => {
                let r: m::DesignFile = params(p)?;
                let path = blocking(move || store.resolve(&r.workspace, &r.path)).await?;
                ok(serde_json::json!({"path": path, "content_type": store::content_type(&path)}))
            }
            m::DESIGN_SETTLE => {
                let r: m::DesignSettle = params(p)?;
                let choice: Settle = serde_json::from_value(Value::String(r.choice.clone()))
                    .map_err(|_| RpcError::new("invalid_params", format!("unknown choice {}", r.choice)))?;
                blocking(move || store.settle(&r.workspace, &r.slug, &r.card, choice)).await?;
                ok(true)
            }
            _ => Err(RpcError::new("unknown_method", format!("unknown method {method}"))),
        }
    }

    /// Asks a design system's sync agent to build it, or to sync it again
    /// (X64). Its chat is reused while it exists; otherwise a new one starts in
    /// the workspace's Claude profile, with the sources read only.
    async fn start_sync_agent(&self, workspace: &str, slug: &str) -> anyhow::Result<u32> {
        use moonlet_core::design::{agent, anchor, store};
        // One start or sync at a time per system, so two never make two agents.
        let lock = self.design_locks.lock().unwrap().entry(format!("{workspace}/{slug}")).or_default().clone();
        let _held = lock.lock().await;
        // The folders and the chat come from the record moonlet keeps outside
        // the system's folder, never from files the agent can edit. Reading and
        // hashing the sources runs off the async workers.
        let (store, ws, sl) = (self.design.clone(), workspace.to_string(), slug.to_string());
        let (dir, record, launch) = blocking(move || {
            let dir = store.system_dir(&ws, &sl)?.canonicalize()?;
            let config = store.config(&ws, &sl)?;
            let record = store.record(&ws, &sl)?;
            let mut sources = Vec::new();
            for root in store::source_roots(&record) {
                let real = root.canonicalize().map_err(|e| anyhow::anyhow!("{}: {e}", root.display()))?;
                sources.push(real.display().to_string());
            }
            let bin = moonlet_cli_path()?;
            let synced = dir.join(anchor::FILE).is_file();
            let status = if synced { anchor::status(&dir, &store::source_roots(&record), &config.exceptions())? } else { Vec::new() };
            let task = if synced { agent::Task::Resync(&status) } else { agent::Task::Build };
            let launch = agent::sync_launch(&dir, &config, &sources, &bin, task)?;
            Ok((dir, record, launch))
        })
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        // What the chat starts with: a chat started with other folders or
        // rules (a source moved) is replaced, not reused.
        let fingerprint = format!("{}\n{}", launch.settings, launch.add_dirs.join("\n"));
        let ours = |id: u32| {
            self.terminals.list().into_iter().any(|t| t.id == id && t.chat && t.session_id.is_none() && t.title == launch.title && Path::new(&t.cwd) == dir)
        };
        if let Some(id) = record.agent.filter(|id| ours(*id)) {
            if record.agent_launch.as_deref() == Some(fingerprint.as_str()) {
                self.chats.send(id, &launch.prompt, &[])?;
                return Ok(id);
            }
            let _ = self.terminals.kill(id, true);
        }
        let info = self.chats.create(ChatCreate {
            cwd: launch.cwd,
            agent: "claude".into(),
            model: None,
            effort: None,
            mode: Some(launch.mode),
            name: launch.title.clone(),
            title: Some(launch.title.clone()),
            session_id: None,
            env: Default::default(),
            add_dirs: launch.add_dirs,
            settings: Some(launch.settings),
            workspace: Some(workspace.to_string()),
        })?;
        self.design.set_agent(workspace, slug, info.id, &fingerprint)?;
        self.chats.send(info.id, &launch.prompt, &[])?;
        Ok(info.id)
    }

    /// Stops a design system's sync agent, when it still is that system's.
    fn stop_sync_agent(&self, workspace: &str, slug: &str) {
        let (Ok(record), Ok(dir), Ok(config)) =
            (self.design.record(workspace, slug), self.design.system_dir(workspace, slug), self.design.config(workspace, slug))
        else {
            return;
        };
        let dir = dir.canonicalize().unwrap_or(dir);
        let title = format!("Design · {}", config.name);
        if let Some(id) = record.agent
            && self.terminals.list().into_iter().any(|t| t.id == id && t.chat && t.session_id.is_none() && t.title == title && Path::new(&t.cwd) == dir)
        {
            let _ = self.terminals.kill(id, true);
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
                // Without its hooks, agents in the profile report no state
                // (A2), so a profile they cannot go into is not kept.
                let installed = moonlet_cli_path().and_then(|bin| hooks::install(&profile_hooks(&profile.path), &bin, true, false));
                if let Err(e) = installed {
                    let _ = w.delete_profile(&profile.id);
                    return Err(internal(e));
                }
                self.emit_profiles();
                ok(profile)
            }
            m::PROFILE_UPDATE => {
                let r: m::ProfileUpdate = params(p)?;
                let profile = w.update_profile(&r.id, r.name.as_deref()).map_err(internal)?;
                self.emit_profiles();
                ok(profile)
            }
            m::PROFILE_DELETE => {
                let r: m::IdRef = params(p)?;
                w.delete_profile(&r.id).map_err(internal)?;
                self.accounts.lock().unwrap().remove(&Some(r.id));
                self.emit_profiles();
                ok(true)
            }
            m::PROFILE_STATUS => {
                let r: m::ProfileStatus = params(p)?;
                let dir = match &r.id {
                    Some(id) => Some(w.profile(id).map_err(internal)?.path),
                    None => None,
                };
                let account = moonlet_core::profiles::account(self.terminals.base_env(), dir.as_deref()).await.map_err(internal)?;
                self.accounts.lock().unwrap().insert(r.id, account.clone());
                self.emit_profiles();
                ok(account)
            }
            m::CLAUDE_VERSION => {
                let version = moonlet_core::claude_update::installed(self.terminals.base_env()).await;
                let updating = self.claude_updating.load(Ordering::SeqCst);
                ok(moonlet_proto::types::ClaudeVersion { version, updating })
            }
            m::CLAUDE_UPDATE => {
                let Some(_running) = Flag::raise(&self.claude_updating) else {
                    return Err(RpcError::new("busy", "Claude Code is already updating"));
                };
                let run = moonlet_core::claude_update::update(self.terminals.base_env(), |line| {
                    let line = moonlet_proto::types::ClaudeUpdateLine { line: line.into() };
                    self.terminals.emit(Message::event(m::EV_CLAUDE_UPDATE_OUTPUT, line));
                })
                .await;
                let result = match run {
                    Ok((success, output)) => moonlet_proto::types::ClaudeUpdateResult { ok: success, output },
                    Err(e) => moonlet_proto::types::ClaudeUpdateResult { ok: false, output: format!("Error: {e:#}\n") },
                };
                self.terminals.emit(Message::event(m::EV_CLAUDE_UPDATE_DONE, &result));
                ok(result)
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
            m::GH_WHOAMI => ok(git::gh_whoami().await.map_err(internal)?),
            m::GH_TASK_UPDATE => {
                let r: m::GhTaskUpdate = params(p)?;
                git::gh_task_update(&path(&r.path), r.number, r.assign_me, r.close, r.reopen).await.map_err(internal)?;
                ok(true)
            }
            m::GH_ISSUE_COMMENTS => {
                let r: m::GhIssueComments = params(p)?;
                ok(moonlet_core::gh_issues::gh_issue_comments(&path(&r.path), r.number).await.map_err(internal)?)
            }
            m::GH_ISSUE_COMMENT => {
                let r: m::GhIssueComment = params(p)?;
                moonlet_core::gh_issues::gh_issue_comment(&path(&r.path), r.number, &r.body).await.map_err(internal)?;
                ok(true)
            }
            m::GH_TASK => {
                let r: m::GhTaskGet = params(p)?;
                ok(git::gh_task(&path(&r.path), &r.repo, r.number).await.map_err(internal)?)
            }
            m::GH_TASKS => {
                let r: m::GhTasks = params(p)?;
                ok(git::gh_tasks(&path(&r.path), r.mine).await.map_err(internal)?)
            }
            m::GH_PROJECTS => {
                let r: m::GhProjects = params(p)?;
                ok(moonlet_core::gh_projects::gh_projects(&r.owners)
                    .await
                    .map_err(internal)?)
            }
            m::GH_CREATE_OPTIONS => {
                let r: m::GhCreateOptions = params(p)?;
                ok(moonlet_core::gh_issues::gh_create_options(&r.repo)
                    .await
                    .map_err(internal)?)
            }
            m::GH_ISSUE_CREATE => {
                let r: m::GhIssueCreate = params(p)?;
                ok(moonlet_core::gh_issues::gh_issue_create(
                    &r.repo,
                    &r.title,
                    &r.body,
                    &r.assignee,
                    &r.labels,
                )
                .await
                .map_err(internal)?)
            }
            m::GH_PROJECT_ADD => {
                let r: m::GhProjectAdd = params(p)?;
                ok(moonlet_core::gh_projects::gh_project_add(&r.project, &r.content)
                    .await
                    .map_err(internal)?)
            }
            m::GH_PROJECT_MOVE => {
                let r: m::GhProjectMove = params(p)?;
                moonlet_core::gh_projects::gh_project_move(
                    &r.project,
                    &r.item,
                    &r.field,
                    r.option.as_deref(),
                )
                .await
                .map_err(internal)?;
                ok(true)
            }
            m::GH_SCOPES => ok(moonlet_core::gh_projects::gh_scopes()
                .await
                .map_err(internal)?),
            m::GH_PROJECT_ITEMS => {
                let r: m::GhProjectItems = params(p)?;
                ok(
                    moonlet_core::gh_projects::gh_project_items(&r.owner, r.number, r.mine)
                        .await
                        .map_err(internal)?,
                )
            }
            m::GH_PR_CONTEXT => {
                let r: m::GhPrContext = params(p)?;
                ok(git::gh_pr_context(&path(&r.path), r.number).await.map_err(internal)?)
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
            m::PROJECT_IDENTITY => {
                let r: m::GitPath = params(p)?;
                ok(moonlet_core::identity::identity(&path(&r.path)).await)
            }
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
            m::PROJECT_WORKTREE_REMOVE => {
                let r: m::ProjectWorktree = params(p)?;
                w.remove_worktree(&r.id, &r.path).await.map_err(internal)?;
                ok(true)
            }
            m::PROJECT_WORKTREES => {
                let r: m::IdRef = params(p)?;
                // This Mac's copies of remote sessions are moonlet's own (X60).
                let real = |p: &std::path::Path| std::fs::canonicalize(p).ok();
                let copies: Vec<_> = self.sync.copy_paths().iter().filter_map(|p| real(p)).collect();
                let mut list = w.project_worktrees(&r.id).await.map_err(internal)?;
                list.retain(|t| real(std::path::Path::new(&t.path)).is_none_or(|p| !copies.contains(&p)));
                ok(list)
            }
            m::SESSION_CREATE => ok(w.create_session(params(p)?).await.map_err(internal)?),
            m::SESSION_LIST => ok(w.list_sessions()),
            m::SESSION_ARCHIVE => {
                let r: m::SessionArchive = params(p)?;
                let id = r.id.clone();
                // Its live copies go once it is archived, never holding the
                // archive up; what they need is read first (X60).
                let archiving = self.sync.archiving(&id).await;
                let done = w.archive(r).await.map_err(internal)?;
                self.sync.archived(archiving);
                self.jobs.forget(&id);
                self.reads.clear_grant(&id);
                ok(done)
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
            m::GIT_UNPUSHED => {
                let r: m::GitUnpushed = params(p)?;
                ok(git::unpushed(&path(&r.path), r.branch.as_deref(), r.merged_head.as_deref())
                    .await
                    .map_err(internal)?)
            }
            m::GIT_PUSH => {
                let r: m::GitUnpushed = params(p)?;
                git::push(&path(&r.path), r.branch.as_deref(), r.merged_head.as_deref()).await.map_err(internal)?;
                ok(true)
            }
            m::GIT_SETTINGS => ok(git_settings::load(&git_settings::path())),
            m::GIT_SET_SETTINGS => {
                let saved = git_settings::update(&git_settings::path(), p).map_err(internal)?;
                self.terminals.emit(Message::event(m::EV_GIT_SETTINGS_CHANGED, &saved));
                ok(saved)
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
            m::FS_WRITE_INSIDE => {
                let r: m::FsWriteInside = params(p)?;
                blocking(move || fs::write_inside(&r.root, &r.path, &r.content)).await?;
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
