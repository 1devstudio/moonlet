//! Daemon state and request dispatch.

use moonlet_core::account::log_owner;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use moonlet_core::design::history::Take;
use moonlet_core::design::place::{DesignAt, Place};
use moonlet_core::fs::Watchers;
use moonlet_core::hooks::{self, HookPaths};
use moonlet_core::paths::{hostname, now_ms};
use moonlet_core::chat::runtime::{ChatCreate, ChatManager, chats_dir};
use moonlet_core::session::SessionManager;
use moonlet_core::terminal::TerminalManager;
use moonlet_core::terminal_read::{self, TerminalReads};
use moonlet_core::tasks::{TaskRelay, TaskSnapshots};
use moonlet_core::{fs, git, git_settings, tasks};
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
    /// Design systems and workspace designs on every member (X71).
    pub copies: Arc<crate::copies::DesignCopies>,
    /// Copies of every member's sessions on the central host (X72).
    pub session_copies: Arc<crate::session_copies::SessionCopies>,
    /// One look at a time for sessions another member now owns (X73).
    letting_go: tokio::sync::Mutex<()>,
    /// Per design system (X64): one start of its agent, or one change of its
    /// record or folder, at a time.
    design_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Announces changes under `~/.moonlet/design` as `design.changed` (X64).
    _design_watch: Option<moonlet_core::design::watch::Watching>,
    /// Each workspace design's edits by hand saved since its last snapshot
    /// (X65): what they did, and how many saves, so only the last save's
    /// wait takes the snapshot.
    hand_edits: Mutex<HashMap<String, HandEdits>>,
    /// The watches of the sessions' worktrees that hold session designs,
    /// by session, which announce their changes as `design.changed` (X65).
    session_watches: Mutex<HashMap<String, moonlet_core::design::watch::Watching>>,
    /// How long edits by hand stop before their snapshot is taken: 10 s, or
    /// `MOONLET_DESIGN_QUIET_MS` (tests).
    edits_quiet: std::time::Duration,
    /// Tests only, `MOONLET_DESIGN_TURNS_HELD`: while the file it names is
    /// there, the snapshots of design agents' steps wait in line, as one
    /// waits behind another design's slow snapshot, so a start is heard late.
    turns_held: Option<PathBuf>,
    /// The app that renders design cards, and the cards it is rendering (X64).
    renders: crate::render::Renders,
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
    /// Board snapshots the app shares, and the phone's requests to it (X76).
    task_snapshots: Arc<TaskSnapshots>,
    task_relay: TaskRelay,
    /// Connections of the moonlet app, oldest first, to send a phone's task requests to (X76).
    apps: Mutex<BTreeMap<u64, moonlet_core::terminal::ClientTx>>,
}

pub type HandlerResult = Result<Value, RpcError>;

/// How long edits by hand stop before their snapshot is taken (X65).
const EDITS_QUIET: std::time::Duration = std::time::Duration::from_secs(10);

/// A design's edits by hand saved since its last snapshot (X65).
#[derive(Default)]
struct HandEdits {
    /// What each save did, as the app said with it, in the order they were
    /// saved, each with whether the design's agent worked as it was saved:
    /// those go with its turn, also when the daemon hears it start only
    /// after them.
    edits: Vec<(bool, String)>,
    /// One was saved while the agent did not work.
    before: bool,
    /// One was saved while the agent worked.
    in_turn: bool,
    /// Saves so far: a wait that ends after a later save takes nothing.
    saves: u64,
    /// The wait for them to stop, the latest save's: a later save cancels it.
    quiet: Option<tokio::task::AbortHandle>,
}

impl HandEdits {
    /// What all of them did, in the order they were saved.
    fn all(&self) -> Vec<String> {
        self.edits.iter().map(|(_, e)| e.clone()).collect()
    }
}

/// A design's locks (X65), each guarding one thing.
#[derive(Debug, Clone, Copy)]
enum DesignLock {
    /// One start of its agent, or one removal, at a time.
    Agent,
    /// One change of its `comments.json` at a time, so two never read the
    /// same pins and the later write drops the earlier one's; its own, so a
    /// comment never waits for an agent to start.
    Comments,
    /// One save of its pages by moonlet at a time, `design.write_page` or
    /// `check --fix`, so a save's check of the version it was made over and
    /// its replace are never split by another of moonlet's (another writer,
    /// such as the design's agent, does not take it: see
    /// `Store::write_page`). Taken before [`DesignLock::History`].
    Pages,
    /// One snapshot or restore at a time, so two never take the same number.
    History,
    /// One update of a session design's copies of its design system.
    System,
}

/// Whose turn a design's snapshots follow (X65): a workspace design's own
/// agent's, or a session's agent's for its session designs (entry 12).
#[derive(Debug, Clone, PartialEq, Eq)]
enum TurnOf {
    Design { workspace: String, slug: String },
    Session(String),
}

/// The turn an agent's terminal works in for the design snapshots, if any:
/// a workspace design's agent (its tag), or a session's structured agent.
fn turn_of(t: &moonlet_proto::types::TerminalInfo) -> Option<TurnOf> {
    use moonlet_proto::types::{DesignAgentKind, TerminalKind};
    match &t.design {
        Some(d) if d.kind == DesignAgentKind::Design => Some(TurnOf::Design { workspace: d.workspace.clone(), slug: d.slug.clone() }),
        Some(_) => None,
        None => t.session_id.clone().filter(|_| t.chat && t.kind == TerminalKind::Agent).map(TurnOf::Session),
    }
}

/// What a design's agent does, for the design's snapshots (X65).
#[derive(Debug, Clone, Copy)]
enum AgentStep {
    /// It starts working: the edits by hand not kept yet are kept first.
    Starts,
    /// It ends a turn: the turn's snapshot.
    EndsTurn,
}

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

/// A design system's or a workspace design's key in the daemon's maps.
fn design_key(workspace: &str, slug: &str) -> String {
    format!("{workspace}/{slug}")
}

/// The design calls that name one design (X65), as a [`m::DesignRef`]:
/// the design they name lets them through, not a workspace they claim.
const DESIGN_ADDRESSED: &[&str] = &[
    m::DESIGN_REMOVE,
    m::DESIGN_OPEN,
    m::DESIGN_VIEWPORT,
    m::DESIGN_COMMENTS,
    m::DESIGN_COMMENT_PUT,
    m::DESIGN_COMMENT_RESOLVE,
    m::DESIGN_PAGE,
    m::DESIGN_WRITE_PAGE,
    m::DESIGN_KIT,
    m::DESIGN_HISTORY,
    m::DESIGN_SNAPSHOT_RESTORE,
    m::DESIGN_SYSTEM_UPDATE,
];

/// The design calls that gate what their own parsed params name (X65):
/// `design.check`, a design system's workspace or a design, and
/// `design.file`, a workspace's file or a session design's.
const DESIGN_SELF_GATED: &[&str] = &[m::DESIGN_CHECK, m::DESIGN_FILE];

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
/// The name the moonlet app gives in its hello.
pub const APP_CLIENT: &str = "moonlet-app";

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_params", e.to_string()))
}

fn ok<T: Serialize>(v: T) -> HandlerResult {
    serde_json::to_value(v).map_err(|e| RpcError::new("internal", e.to_string()))
}

/// Design calls that work on a copy of another member's item (X71): they
/// read it, or make a new item of this member's own. Every other call that
/// names a design system or workspace design is refused on a copy.
const ON_COPIES: &[&str] = &[
    m::DESIGN_SYSTEMS,
    m::DESIGN_SYSTEM_CREATE,
    m::DESIGN_LIST,
    m::DESIGN_CARDS,
    m::DESIGN_FILE,
    m::DESIGN_COMMENTS,
    m::DESIGN_HISTORY,
    m::DESIGN_PAGE,
    m::DESIGN_KIT,
    m::DESIGN_DETECT,
    m::DESIGN_OPEN,
    m::DESIGN_CREATE,
    m::DESIGN_COPY,
    m::DESIGN_MOVE,
    // A card's screenshot for the app, in the folder's `.cache/`, which
    // copies leave out.
    m::DESIGN_SNAP,
    m::DESIGN_RENDER_READY,
    m::DESIGN_RENDER_DONE,
];

/// The design system or workspace design a design call names, when the
/// call is one a copy refuses (X71).
fn changed_item(method: &str, p: &Value) -> Option<moonlet_core::design::replica::Item> {
    use moonlet_core::design::replica::Item;
    if ON_COPIES.contains(&method) {
        return None;
    }
    let text = |v: &Value, f: &str| v.get(f).and_then(Value::as_str).map(String::from);
    // A design's check names it in `design`, and reads it unless it fixes
    // its ids; a design system's check rewrites its generated files.
    if method == m::DESIGN_CHECK {
        if let Some(design) = p.get("design").filter(|d| !d.is_null()) {
            let fix = p.get("fix").and_then(Value::as_bool).unwrap_or(false);
            return fix.then(|| Some(Item::design(&text(design, "workspace")?, &text(design, "slug")?))).flatten();
        }
        return Some(Item::system(&text(p, "workspace")?, &text(p, "slug")?));
    }
    let (workspace, slug) = (text(p, "workspace")?, text(p, "slug")?);
    let system = method.starts_with("design.system.") || method == m::DESIGN_SETTLE;
    Some(if system { Item::system(&workspace, &slug) } else { Item::design(&workspace, &slug) })
}

/// Adds who owns an item to its listing (X71): `owner` is null for this
/// member's own, else `{worker, name}`, and `owner_agent` says whether
/// the owner's agent works on it.
fn add_owner(v: &mut Value, owner: Option<(String, String, bool)>) {
    match owner {
        Some((worker, name, agent)) => {
            v["owner"] = serde_json::json!({ "worker": worker, "name": name });
            v["owner_agent"] = Value::Bool(agent);
        }
        None => {
            v["owner"] = Value::Null;
            v["owner_agent"] = Value::Bool(false);
        }
    }
}

/// The chat of a design system's sync agent, while it still is that
/// system's: the chat its record names, still a sessionless chat in its
/// folder (X64). Never found through its title, which comes from the name the
/// agent may change in `config.toml`.
fn system_agent(
    store: &moonlet_core::design::store::Store,
    terminals: &[moonlet_proto::types::TerminalInfo],
    workspace: &str,
    slug: &str,
) -> Option<u32> {
    let record = store.record(workspace, slug).ok()?;
    let dir = store.system_dir(workspace, slug).ok()?;
    folder_agent(terminals, record.agent, &dir)
}

/// The recorded chat of a design system's or a design's agent, while it is
/// still a sessionless chat in that folder (X64, X65).
fn folder_agent(terminals: &[moonlet_proto::types::TerminalInfo], recorded: Option<u32>, dir: &Path) -> Option<u32> {
    let id = recorded?;
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    terminals
        .iter()
        .any(|t| t.id == id && t.chat && t.session_id.is_none() && Path::new(&t.cwd) == dir)
        .then_some(id)
}

/// A session's structured agent: the chat its session design's
/// edits and snapshots wait for (X65).
fn session_agent(terminals: &[moonlet_proto::types::TerminalInfo], session: &str) -> Option<u32> {
    terminals
        .iter()
        .find(|t| t.chat && t.kind == moonlet_proto::types::TerminalKind::Agent && t.session_id.as_deref() == Some(session))
        .map(|t| t.id)
}

/// Runs synchronous filesystem work off the async workers, so a large
/// directory walk does not stall other connections.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, RpcError> {
    tokio::task::spawn_blocking(f).await.map_err(internal)?.map_err(store_error)
}

/// What the design store's error means to the caller: a design system the
/// workspace does not have, a viewport that is none, a comment that names
/// no element or pin, a page name that names no page, or a snapshot the
/// design does not have, is a bad parameter
/// (X65); a page saved over a version no longer on disk is `stale`;
/// anything else failed.
fn store_error(e: anyhow::Error) -> RpcError {
    use moonlet_core::design::{comments, designs, history, pages, project, session};
    if e.is::<designs::NoSystem>()
        || e.is::<designs::BadViewport>()
        || e.is::<comments::BadComment>()
        || e.is::<pages::BadPage>()
        || e.is::<history::NoSnapshot>()
        || e.is::<project::NoProjectDesign>()
        || e.is::<session::DesignTaken>()
    {
        return RpcError::new("invalid_params", e.to_string());
    }
    if e.is::<pages::Stale>() {
        return RpcError::new("stale", e.to_string());
    }
    // Said plainly, with no path: the canvas's did-not-load bar shows it,
    // and the design's agent is sent it (X65). Its cause goes to the log.
    if e.is::<pages::Unreadable>() {
        tracing::warn!("cannot read a design's page: {e:#}");
        return RpcError::new("unreadable", e.to_string());
    }
    internal(e)
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
        // Where agents without a workspace profile keep their conversations:
        // the terminals' environment decides, not the daemon's own (X72).
        let claude_dir = base_env
            .get(moonlet_core::profiles::CONFIG_DIR_VAR)
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(base_env.get("HOME").cloned().unwrap_or_default()).join(".claude"));
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
        // Tests shorten how long a phone's task request waits for the app (X76).
        let tasks_timeout = std::env::var("MOONLET_TASKS_REQUEST_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(tasks::REQUEST_TIMEOUT, std::time::Duration::from_millis);
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
        let workers = Arc::new(crate::workers::Workers::new(moonlet_core::paths::home().join("workers.json"), move |m| emitter.emit(m)));
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
        // Announces changes under `~/.moonlet/design` as `design.changed` (X64).
        let design_watch = {
            let store = moonlet_core::design::store::Store::new(&moonlet_core::paths::home());
            let terms = terminals.clone();
            store
                .root()
                .and_then(|root| {
                    moonlet_core::design::watch::start(root, move |changes| {
                        for change in changes {
                            terms.emit(Message::event(m::EV_DESIGN_CHANGED, change));
                        }
                    })
                })
                .inspect_err(|e| tracing::warn!("cannot watch the design folder: {e:#}"))
                .ok()
        };
        let copies = crate::copies::DesignCopies::new(&moonlet_core::paths::home(), sessions.clone(), link.clone());
        let session_copies = crate::session_copies::SessionCopies::new(
            &moonlet_core::paths::home(),
            sessions.clone(),
            link.clone(),
            chats.clone(),
            claude_dir,
            terminals.clone(),
        );
        Arc::new(Self {
            copies,
            session_copies,
            letting_go: tokio::sync::Mutex::new(()),
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
            _design_watch: design_watch,
            hand_edits: Mutex::new(HashMap::new()),
            session_watches: Mutex::new(HashMap::new()),
            edits_quiet: std::env::var("MOONLET_DESIGN_QUIET_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .map_or(EDITS_QUIET, std::time::Duration::from_millis),
            turns_held: std::env::var_os("MOONLET_DESIGN_TURNS_HELD").map(PathBuf::from),
            renders: Default::default(),
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
            task_snapshots: Arc::new(TaskSnapshots::load(tasks::dir())),
            task_relay: TaskRelay::new(tasks_timeout),
            apps: Mutex::new(BTreeMap::new()),
        })
    }

    /// Refuses to message the agent of a design system or design another
    /// member owns now (X71): until this member's round stops it, its
    /// turns would change a copy.
    fn not_a_copys_agent(&self, id: u32) -> Result<(), RpcError> {
        use moonlet_core::design::replica::Item;
        let Some(t) = self.terminals.list().into_iter().find(|t| t.id == id) else { return Ok(()) };
        let Some(d) = t.design else { return Ok(()) };
        let item = match d.kind {
            moonlet_proto::types::DesignAgentKind::Design => Item::design(&d.workspace, &d.slug),
            _ => Item::system(&d.workspace, &d.slug),
        };
        match self.copies.owner_of(&item) {
            Some((_, owner, _)) => Err(RpcError::new("not_owner", format!("{} is a copy from {owner}: its agent runs there", d.slug))),
            None => Ok(()),
        }
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

    /// Cloud settings with where the central host's machines reach it: its
    /// tailnet addresses and port, for the page's policy snippet (X63).
    fn reached(&self, mut info: m::CloudInfo) -> m::CloudInfo {
        info.listening = self.mobile.listening();
        info.port = self.mobile.status().port;
        info
    }

    /// Whether paired device `device` is a phone, not a Mac or a cloud machine.
    pub(crate) fn is_phone(&self, device: &str) -> bool {
        self.mobile.kind_of(device) == Some(m::DeviceKind::Phone)
    }

    /// Refuses all but who approves what runs on this Mac (X60, X62): its
    /// app, or a paired phone, where the user confirms with Face ID (X40).
    /// Never a paired Mac, a worker, nor an agent through the CLI.
    fn app_or_paired_phone(&self, conn: &Conn) -> Result<(), RpcError> {
        match conn.phone.as_deref() {
            Some(device) if self.is_phone(device) => Ok(()),
            _ => app_only(conn, "setup"),
        }
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

    /// Whether `conn` is the moonlet app, which acts for the user: on this
    /// Mac, or on a Mac paired with it over the tailnet (X76). Like X31's
    /// reads, this trusts the name the client gives in its hello.
    pub fn is_app(&self, conn: &Conn) -> bool {
        conn.client == APP_CLIENT
            && conn
                .phone
                .as_deref()
                .is_none_or(|d| self.mobile.kind_of(d) == Some(m::DeviceKind::Desktop))
    }

    pub fn on_connect(&self, conn: &Conn) {
        if self.is_app(conn) {
            // Under the lock, so phones hear opens and closes in their order.
            let mut apps = self.apps.lock().unwrap();
            apps.insert(conn.id, conn.tx.clone());
            // The phone's waiting moves go once moonlet is open (X76).
            if apps.len() == 1 {
                self.terminals.emit(Message::event(m::EV_TASKS_APP, &m::TasksApp { open: true }));
            }
        }
    }

    pub fn on_disconnect(&self, client: u64) {
        self.watchers.release_client(client);
        self.workers.disconnected(client);
        self.renders.disconnected(client);
        let mut apps = self.apps.lock().unwrap();
        if apps.remove(&client).is_some() {
            // Its requests end now, not at the timeout.
            self.task_relay.closed(client);
            if apps.is_empty() {
                self.terminals.emit(Message::event(m::EV_TASKS_APP, &m::TasksApp { open: false }));
            }
        }
    }

    /// Forgets the boards of workspaces gone by any way, an account's
    /// changes from another member included (X68, X76).
    /// One that cannot be removed is kept, and logged: it hides no other.
    fn prune_boards(&self) {
        let live: std::collections::HashSet<String> = self.sessions.list_workspaces().into_iter().map(|w| w.id).collect();
        for ws in self.task_snapshots.workspaces() {
            if !live.contains(&ws)
                && let Err(e) = self.forget_boards(&ws)
            {
                tracing::warn!("cannot remove the boards of workspace {ws}: {}", e.message);
            }
        }
    }

    /// Removes a deleted or merged workspace's boards, and tells the phones (X76).
    fn forget_boards(&self, workspace: &str) -> Result<(), RpcError> {
        if self.task_snapshots.remove(workspace).map_err(internal)? {
            self.terminals.emit(Message::event(m::EV_TASKS_CHANGED, serde_json::json!({ "workspace": workspace, "snapshot": null })));
        }
        Ok(())
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

    /// `daemon.update` (X69) from `client` (unknown before `hello`) on paired
    /// `device`'s connection, or on the local socket without one. Only the
    /// Mac's own app and a paired Mac may ask: never a phone, an agent's CLI
    /// or a worker's link. The caller starts the handoff once its reply is on
    /// its way.
    pub async fn update_from(
        self: &Arc<Self>,
        client: Option<&str>,
        device: Option<&str>,
        p: Value,
    ) -> Result<(moonlet_proto::types::DaemonUpdated, crate::update::Handoff), RpcError> {
        if client.is_some_and(|c| c == CLI_CLIENT || c == crate::link::WORKER_CLIENT) {
            return Err(RpcError::new("forbidden", "update moonlet from the app"));
        }
        if device.is_some_and(|d| self.mobile.kind_of(d) != Some(moonlet_proto::methods::DeviceKind::Desktop)) {
            return Err(RpcError::new("forbidden", "update moonlet from a Mac"));
        }
        let r: m::DaemonUpdate = params(p)?;
        crate::update::update(self, &r.version).await
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
                // Stopping mid-handoff would drop the sessions on their way
                // to the new daemon (X69, S3).
                if self.upgrading.load(Ordering::SeqCst) {
                    return Err(RpcError::new("busy", "an update is handing this daemon's sessions over"));
                }
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
            m::DAEMON_UPDATE => {
                let (reply, handoff) = self.update_from(Some(&conn.client), conn.phone.as_deref(), p).await?;
                // The connection's writer sends the reply after this returns.
                handoff.start_after(crate::update::REPLY_GRACE);
                ok(reply)
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
                            design: None,
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
                self.not_a_copys_agent(r.id)?;
                self.keep_before_message(r.id).await;
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
            m::SESSION_ATTACH | m::SESSION_DETACH => {
                if conn.client == crate::link::WORKER_CLIENT || conn.client == CLI_CLIENT || conn.cloud.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(RpcError::new("forbidden", "only an app or a phone follows another member's session"));
                }
                if method == m::SESSION_DETACH {
                    let r: m::SessionDetach = params(p)?;
                    self.session_copies.detach(conn.id, Some(r.relay));
                    return ok(true);
                }
                let r: m::SessionAttach = params(p)?;
                let owner = self
                    .sessions
                    .session_records()
                    .remove(&r.session)
                    .and_then(|rec| rec.get("owner").and_then(Value::as_str).map(str::to_string))
                    .ok_or_else(|| RpcError::new("not_found", "no such session in the account"))?;
                let member = self.workers.conn(&owner).ok_or_else(|| {
                    let name = self.sessions.member_names().remove(&owner).unwrap_or(owner.clone());
                    RpcError::new("owner_offline", format!("{name} is not reachable"))
                })?;
                self.session_copies.attach(conn, &member, r).await
            }
            m::SESSION_CONTINUE_HERE => {
                if conn.client == crate::link::WORKER_CLIENT || conn.client == CLI_CLIENT || conn.cloud.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(RpcError::new("forbidden", "only an app or a phone continues a session here"));
                }
                let r: m::SessionContinueHere = params(p)?;
                ok(self.continue_here(&r.session, "could not be reached").await?)
            }
            m::SESSION_FORWARD => {
                // The central host's apps and phones (X72): never a worker,
                // a cloud machine or an agent's CLI.
                if conn.client == crate::link::WORKER_CLIENT || conn.client == CLI_CLIENT || conn.cloud.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(RpcError::new("forbidden", "only an app or a phone follows another member's session"));
                }
                Box::pin(self.forward(conn, params(p)?)).await
            }
            m::SESSION_OPEN | m::SESSION_OFFER | m::SESSION_CHAT | m::SESSION_TRANSCRIPT | m::SESSION_CHECKPOINT | m::SESSION_EVENT => {
                // Only a linked Mac's daemon, as for `design.offer` (X72).
                let refused = || RpcError::new("forbidden", "only a member of the account sends its sessions");
                let device = conn.phone.as_deref().ok_or_else(refused)?;
                let mac = self.mobile.kind_of(device) == Some(m::DeviceKind::Desktop);
                let cloud = conn.cloud.load(std::sync::atomic::Ordering::Relaxed);
                let worker = self.workers.worker_on(conn.id).filter(|_| mac && !cloud).ok_or_else(refused)?;
                if !self.sessions.has_account() {
                    return Err(RpcError::new("no_account", "this host shares no account"));
                }
                if method == m::SESSION_OPEN {
                    ok(self.session_copies.opened(&worker, params(p)?).await?)
                } else if method == m::SESSION_CHAT {
                    ok(self.session_copies.chat_offered(&worker, params(p)?)?)
                } else if method == m::SESSION_TRANSCRIPT {
                    let r: m::SessionTranscript = params(p)?;
                    let bytes = conn.take_pack(r.pack).ok_or_else(|| RpcError::new("invalid_params", "the bytes did not arrive"))?;
                    ok(self.session_copies.transcript_offered(&worker, r, &bytes)?)
                } else if method == m::SESSION_EVENT {
                    ok(self.session_copies.event_offered(&worker, params(p)?)?)
                } else if method == m::SESSION_CHECKPOINT {
                    ok(self.session_copies.checkpoint_offered(&worker, params(p)?).await?)
                } else {
                    let r: m::SessionOffer = params(p)?;
                    let pack = match r.pack {
                        Some(t) => Some(conn.take_pack(t).ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive"))?),
                        None => None,
                    };
                    ok(self.session_copies.offered(&worker, r, pack).await?)
                }
            }
            m::DESIGN_OFFER | m::DESIGN_FETCH => {
                // Only a linked Mac's daemon, as for `account.sync` (X71).
                let refused = || RpcError::new("forbidden", "only a member of the account keeps design copies");
                let device = conn.phone.as_deref().ok_or_else(refused)?;
                let mac = self.mobile.kind_of(device) == Some(m::DeviceKind::Desktop);
                let cloud = conn.cloud.load(std::sync::atomic::Ordering::Relaxed);
                if !mac || cloud || self.workers.worker_on(conn.id).is_none() {
                    return Err(refused());
                }
                // A linked Mac is a member of this host's account (X68), and
                // a host sharing none keeps no copies.
                if !self.sessions.has_account() {
                    return Err(RpcError::new("no_account", "this host shares no account"));
                }
                if method == m::DESIGN_OFFER {
                    let r: m::DesignOffer = params(p)?;
                    let pack = match r.pack {
                        Some(t) => Some(conn.take_pack(t).ok_or_else(|| RpcError::new("invalid_params", "the pack did not arrive"))?),
                        None => None,
                    };
                    ok(self.copies.offered(&r.tree, pack).await?)
                } else {
                    let r: m::DesignFetch = params(p)?;
                    let pack = self.copies.pack_for(&r.tree, &r.have).await?;
                    let pack = if pack.is_empty() { None } else { Some(conn.send_pack(&pack)?) };
                    ok(m::DesignFetched { pack })
                }
            }
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
            m::CLOUD_GET => ok(self.reached(self.cloud.info(self.machines.provider_infos()))),
            m::CLOUD_TYPES => {
                let r: m::CloudTypes = params(p)?;
                ok(self.machines.types(&r.provider, &r.location).await?)
            }
            m::CLOUD_LOCATIONS => {
                let r: m::CloudProvider = params(p)?;
                ok(self.machines.locations(&r.provider).await?)
            }
            m::CLOUD_IMAGES => {
                let r: m::CloudProvider = params(p)?;
                ok(self.machines.images(&r.provider).await?)
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
                ok(self.reached(info))
            }
            m::EXEC_SETUPS => {
                self.app_or_paired_phone(conn)?;
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
            m::ACCOUNT_SYNC => {
                // Only a linked Mac's daemon: a paired Mac's connection that
                // registered as a worker, never a phone, nor an agent's CLI,
                // whatever client name they give (X68). Cloud machines never
                // get here (`CLOUD_METHODS`).
                let refused = || RpcError::new("forbidden", "only a member of the account syncs it");
                let device = conn.phone.as_deref().ok_or_else(refused)?;
                let mac = self.mobile.kind_of(device) == Some(m::DeviceKind::Desktop);
                let Some(worker) = self.workers.worker_on(conn.id).filter(|_| mac) else {
                    return Err(refused());
                };
                if !self.sessions.has_account() {
                    return Err(RpcError::new("no_account", "this host shares no account"));
                }
                let mut r: m::AccountSync = params(p)?;
                // A member sends the changes it made, whose logs are named
                // after its worker id: never another member's, whose numbers
                // it could otherwise take first. A central host that lost its
                // log has every member's work in its state already.
                // Names are read whole, `<worker id>.<6 letters or digits>`,
                // and no worker id this host's own logs ever had is one a
                // member may claim: they are no secret, as every version
                // names them.
                let sent = r.changes.len();
                let own: Vec<String> = self.sessions.account_names().iter().filter_map(|n| log_owner(n).map(String::from)).collect();
                let claims_this_host = worker == self.link.info().worker.id || own.contains(&worker);
                r.changes.retain(|c| !claims_this_host && log_owner(&c.stamp.member) == Some(worker.as_str()));
                if r.changes.len() < sent {
                    tracing::warn!(worker = %worker, "dropped {} account changes stamped as another member", sent - r.changes.len());
                }
                // The other members take what this host newly kept from
                // here; the one that sent them already has them.
                let taken = self.sessions.apply_account(r.changes);
                // A workspace another member removed or merged takes its boards along (X76).
                self.prune_boards();
                if !taken.is_empty() {
                    self.workers.send_to_members(Message::event(m::EV_ACCOUNT_CHANGED, m::AccountChanged { changes: taken }), Some(conn.id));
                }
                ok(m::AccountSynced {
                    changes: self.sessions.account_changes_for(&r.version),
                    version: self.sessions.account_version(),
                    account: Some(self.link.account_info().account),
                })
            }
            m::ACCOUNT_GET => ok(self.link.account_info()),
            m::WORKER_REGISTER => {
                // Only a worker's daemon, over the tailnet with a paired
                // device's token, registers.
                let Some(device) = conn.phone.as_deref().filter(|_| conn.client == crate::link::WORKER_CLIENT) else {
                    return Err(RpcError::new("forbidden", "only a worker registers"));
                };
                // A Mac's daemon or a cloud machine: never a phone, which
                // could otherwise take a Mac's worker id first.
                match self.mobile.kind_of(device) {
                    None => return Err(RpcError::new("forbidden", "this Mac is no longer paired")),
                    Some(m::DeviceKind::Phone) => return Err(RpcError::new("forbidden", "only a Mac or a cloud machine registers")),
                    Some(_) => {}
                }
                let r: m::WorkerRegister = params(p)?;
                let id = r.id.clone();
                let mobile = self.mobile.clone();
                self.workers.register(conn.clone(), device, r, |owner| mobile.is_paired(owner))?;
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
                // The user approves what runs on this Mac: from its app or
                // a paired phone, not a paired Mac, nor an agent through
                // the CLI.
                self.app_or_paired_phone(conn)?;
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
    async fn handle_design(self: &Arc<Self>, conn: &Conn, method: &str, p: Value) -> HandlerResult {
        // The app and the agents' CLI on this Mac, never a paired device.
        if conn.phone.is_some() {
            return Err(RpcError::new("forbidden", "manage design systems from the Mac"));
        }
        use moonlet_core::design::store::{self, Settle, Source};
        // The app renders cards for the render check and snapshots (X64).
        match method {
            m::DESIGN_RENDER_READY => {
                app_only(conn, "design rendering")?;
                self.renders.ready(conn.id, conn.tx.clone());
                return ok(true);
            }
            m::DESIGN_RENDER_DONE => {
                let done: m::DesignRenderDone = params(p)?;
                self.renders.done(conn.id, done)?;
                return ok(true);
            }
            _ => {}
        }
        let store = self.design.clone();
        // Design folders belong to a moonlet workspace (ADR 0013). Which
        // gate a call meets is its method's, never a key it carries: a call
        // that names a design is let through by the design it names, which
        // `locate` finds once (a session design's workspace is its
        // session's, never one the call claims), and `design.check` and
        // `design.file` gate what their parsed params name (X65).
        let workspace = p.get("workspace").and_then(Value::as_str).unwrap_or_default().to_string();
        if !DESIGN_ADDRESSED.contains(&method) && !DESIGN_SELF_GATED.contains(&method) {
            self.workspace_exists(&workspace)?;
        }
        // Another member's design system or design is read only here (X71).
        if let Some(item) = changed_item(method, &p)
            && let Some((_, owner, _)) = self.copies.owner_of(&item)
        {
            return Err(RpcError::new(
                "not_owner",
                format!("{} is a copy from {owner}: change it there, or move it here", item.slug),
            ));
        }
        match method {
            m::DESIGN_MOVE => {
                // The user's choice, never an agent's.
                app_only(conn, "moving a design")?;
                let r: m::DesignMove = params(p)?;
                let item = match r.kind.as_str() {
                    "system" => moonlet_core::design::replica::Item::system(&r.workspace, &r.slug),
                    "design" => moonlet_core::design::replica::Item::design(&r.workspace, &r.slug),
                    _ => return Err(RpcError::new("invalid_params", "kind is system or design")),
                };
                self.copies.move_here(&item, r.force).await?;
                ok(true)
            }
            m::DESIGN_SYSTEMS => {
                let r: m::DesignWorkspace = params(p)?;
                // The store reads (the list, each system's record and config)
                // run off the async workers; the chats give only their pending asks.
                let terminals = self.terminals.list();
                let ws = r.workspace.clone();
                let systems = blocking(move || {
                    let list = store.systems(&r.workspace)?;
                    Ok(list
                        .into_iter()
                        .map(|sys| {
                            let agent = system_agent(&store, &terminals, &r.workspace, &sys.slug);
                            (sys, agent)
                        })
                        .collect::<Vec<_>>())
                })
                .await?;
                // Who owns each copy, read once for the list, off the async workers.
                let copies = self.copies.clone();
                let owners = tokio::task::spawn_blocking(move || copies.owners()).await.map_err(internal)?;
                let list: Vec<Value> = systems
                    .into_iter()
                    .map(|(sys, agent)| {
                        let waiting = agent
                            .and_then(|id| self.chats.pending(id).ok())
                            .and_then(|pending| moonlet_core::design::agent::needs_you(&pending));
                        let mut v = serde_json::to_value(&sys).unwrap_or_default();
                        v["needs_you"] = serde_json::to_value(waiting).unwrap_or_default();
                        let item = moonlet_core::design::replica::Item::system(&ws, &sys.slug);
                        add_owner(&mut v, owners.get(&item).cloned());
                        v
                    })
                    .collect();
                ok(list)
            }
            m::DESIGN_SYSTEM_CREATE => {
                let r: m::DesignSystemCreate = params(p)?;
                let projects = self.sessions.list_projects();
                let mut sources = Vec::new();
                for pick in &r.sources {
                    let Some(p) = projects.iter().find(|p| p.id == pick.project) else {
                        return Err(RpcError::new("invalid_params", format!("no project {}", pick.project)));
                    };
                    let source = Source {
                        project: p.id.clone(),
                        path: p.path.clone(),
                        identity: p.identity.clone(),
                        subdir: pick.subdir.clone(),
                        commit: None,
                    };
                    // A sub-folder only inside the project, never one out of it.
                    store::source_root(&source).map_err(|e| RpcError::new("invalid_params", format!("{e:#}")))?;
                    sources.push(source);
                }
                let cover: store::Cover = serde_json::from_value(Value::String(r.cover.clone().unwrap_or_else(|| "core".into())))
                    .map_err(|_| RpcError::new("invalid_params", "cover is core, all or none"))?;
                let (workspace, start) = (r.workspace.clone(), r.agent);
                let slug = blocking(move || store.create_system(&r.workspace, &r.name, sources, cover, now_ms())).await?;
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
                // After a start running now, so its agent is the one stopped.
                let lock = self.design_lock(&r.workspace, &r.slug);
                let _held = lock.lock().await;
                self.stop_sync_agent(&r.workspace, &r.slug);
                blocking(move || store.remove_system(&r.workspace, &r.slug)).await?;
                ok(true)
            }
            m::DESIGN_SYSTEM_PROGRESS => {
                let r: m::DesignProgress = params(p)?;
                let lock = self.design_lock(&r.workspace, &r.slug);
                let _held = lock.lock().await;
                blocking(move || store.progress(&r.workspace, &r.slug, &r.step, r.summary.as_deref())).await?;
                ok(true)
            }
            m::DESIGN_SYSTEM_SYNCED => {
                let r: m::DesignSystemRef = params(p)?;
                // The record is read, changed and written whole: never while
                // a start writes its agent into it.
                let lock = self.design_lock(&r.workspace, &r.slug);
                let _held = lock.lock().await;
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
                let r: m::DesignCheck = params(p)?;
                // A design's pages (X65): their ids and stylesheets.
                if let Some(design) = r.design.clone() {
                    if r.render {
                        return Err(RpcError::new("invalid_params", "render checks a design system's cards"));
                    }
                    let at = self.locate(&design).await?;
                    // `--fix` saves pages: never between a save's check of
                    // its version and its replace.
                    let lock = self.lock_of(&at, DesignLock::Pages);
                    let _held = if r.fix { Some(lock.lock().await) } else { None };
                    return ok(blocking(move || store.check_design(&at, r.fix)).await?);
                }
                if r.fix {
                    return Err(RpcError::new("invalid_params", "fix checks a design's pages"));
                }
                let workspace = r.workspace.clone().unwrap_or_default();
                self.workspace_exists(&workspace)?;
                let (ws, slug) = (workspace.clone(), r.slug.clone());
                let problems = {
                    let store = store.clone();
                    blocking(move || store.check_system(&ws, &slug)).await?
                };
                if !r.render {
                    return ok(problems);
                }
                // Without the app, the problems still come, with why nothing rendered.
                match self.render_check(&workspace, &r.slug).await {
                    Ok(counts) => ok(serde_json::json!({"problems": problems, "render": counts, "render_error": null})),
                    Err(crate::render::RenderError::NoApp) => {
                        ok(serde_json::json!({"problems": problems, "render": null, "render_error": moonlet_core::design::render::NO_APP}))
                    }
                    Err(e) => Err(e.into()),
                }
            }
            m::DESIGN_SNAP => {
                let r: m::DesignSnap = params(p)?;
                let (ws, slug, path, variant) = (r.workspace.clone(), r.slug.clone(), r.path.clone(), r.variant.clone());
                let target = {
                    let store = store.clone();
                    blocking(move || store.snap_target(&ws, &slug, &path, variant.as_deref(), r.viewport)).await?
                };
                let done = self
                    .renders
                    .render(crate::render::Ask {
                        workspace: r.workspace.clone(),
                        slug: r.slug.clone(),
                        path: target.path.clone(),
                        viewport: target.viewport,
                        variant: target.variant.clone(),
                        want: m::RenderWant::Png,
                    })
                    .await?;
                if let Some(e) = done.error {
                    return Err(RpcError::new("failed", e));
                }
                use base64::Engine;
                let png = base64::engine::general_purpose::STANDARD
                    .decode(done.png_base64.unwrap_or_default())
                    .map_err(|e| RpcError::new("failed", format!("the app sent no PNG: {e}")))?;
                let blank = png.len() < moonlet_core::design::render::BLANK_BELOW;
                let path = blocking(move || store.write_screenshot(&r.workspace, &r.slug, &target, &png)).await?;
                ok(serde_json::json!({"path": path, "blank": blank}))
            }
            m::DESIGN_CARDS => {
                let r: m::DesignSystemRef = params(p)?;
                ok(blocking(move || store.cards(&r.workspace, &r.slug)).await?)
            }
            m::DESIGN_FILE => {
                let r: m::DesignFile = params(p)?;
                // A project design's (X65 entry 12c): its bytes from the base
                // branch, as there is no file on disk.
                if let Some(id) = r.project {
                    if r.workspace.is_some() || r.session.is_some() {
                        return Err(RpcError::new("invalid_params", "name a design file by its project alone"));
                    }
                    let Some(project) = self.sessions.list_projects().into_iter().find(|p| p.id == id) else {
                        return Err(RpcError::new("invalid_params", format!("no project \"{id}\"")));
                    };
                    let repo = Path::new(&project.path);
                    let folder = moonlet_core::design::session::design_folder(&moonlet_core::session::read_config(repo))
                        .map_err(|e| RpcError::new("invalid_params", format!("{e:#}")))?;
                    let bytes = moonlet_core::design::project::project_file(repo, &project.base_branch, &folder, &r.path)
                        .await
                        .map_err(|e| match e.downcast_ref::<moonlet_core::design::project::NoProjectFile>() {
                            Some(no) => RpcError::new("invalid_params", no.to_string()),
                            None => store_error(e),
                        })?;
                    use base64::Engine;
                    let content = base64::engine::general_purpose::STANDARD.encode(bytes);
                    return ok(serde_json::json!({"content": content, "content_type": store::content_type(Path::new(&r.path))}));
                }
                match (r.workspace, r.session) {
                    (Some(workspace), None) => {
                        self.workspace_exists(&workspace)?;
                        let path = blocking(move || store.resolve(&workspace, &r.path)).await?;
                        ok(serde_json::json!({"path": path, "content_type": store::content_type(&path)}))
                    }
                    // A session design's (X65): its bytes, read through its
                    // folder opened once, as its worktree is writable and a
                    // folder swapped for a link after a path was given
                    // would lead the reader out of it.
                    (None, Some(session)) => {
                        let (s, folder) = self.design_session(&session)?;
                        self.workspace_exists(s.workspace_id.as_deref().unwrap_or_default())?;
                        let rel = r.path.clone();
                        let bytes = blocking(move || moonlet_core::design::session::session_file(Path::new(&s.path), &folder, &rel))
                            .await
                            .map_err(|_| RpcError::new("invalid_params", format!("{} is no file of a session design", r.path)))?;
                        use base64::Engine;
                        let content = base64::engine::general_purpose::STANDARD.encode(bytes);
                        ok(serde_json::json!({"content": content, "content_type": store::content_type(Path::new(&r.path))}))
                    }
                    (Some(_), Some(_)) => Err(RpcError::new("invalid_params", "name a design file by its workspace or by its session, not both")),
                    (None, None) => Err(RpcError::new("invalid_params", "name a design file by its workspace or by its session")),
                }
            }
            m::DESIGN_DETECT => {
                let r: m::DesignDetect = params(p)?;
                ok(blocking(move || Ok(moonlet_core::design::stack::detect(&path(&r.path)))).await?)
            }
            m::DESIGN_LIST => {
                let r: m::DesignWorkspace = params(p)?;
                let ws = r.workspace.clone();
                let mut designs = blocking(move || store.designs(&ws)).await?;
                // A workspace design built in a session: that session's project.
                for d in &mut designs {
                    if let Some(built) = &mut d.built_in {
                        built.project = self.sessions.session(&built.session).ok().map(|s| s.project_id);
                    }
                }
                designs.extend(self.session_designs_of_workspace(&r.workspace).await);
                designs.extend(self.project_designs_of_workspace(&r.workspace).await);
                let terminals = self.terminals.list();
                let copies = self.copies.clone();
                let owners = tokio::task::spawn_blocking(move || copies.owners()).await.map_err(internal)?;
                let list: Vec<Value> = designs
                    .into_iter()
                    .map(|d| {
                        let d = self.design_info(d, &terminals);
                        let owner = (d.kind == moonlet_proto::types::DesignKind::Workspace)
                            .then(|| owners.get(&moonlet_core::design::replica::Item::design(&r.workspace, &d.slug)).cloned())
                            .flatten();
                        let mut v = serde_json::to_value(&d).unwrap_or_default();
                        add_owner(&mut v, owner);
                        v
                    })
                    .collect();
                ok(list)
            }
            m::DESIGN_CREATE => {
                let r: m::DesignCreate = params(p)?;
                // A session design: the session's agent writes it (X65).
                if let Some(session) = r.session.clone() {
                    let (s, folder) = self.design_session(&session)?;
                    if s.workspace_id.as_deref() != Some(r.workspace.as_str()) {
                        return Err(RpcError::new("invalid_params", format!("session \"{session}\" is not in workspace \"{}\"", r.workspace)));
                    }
                    let (made, r, watched) = (store.clone(), r.clone(), session.clone());
                    let at = blocking(move || {
                        made.create_session_design(&r.workspace, &r.system, &session, Path::new(&s.path), &folder, &r.name, &r.brief, now_ms())
                    })
                    .await?;
                    // Its folders are there now: watch them.
                    let _ = self.design_session(&watched);
                    let design = self.session_design_info(at).await?;
                    return ok(moonlet_proto::types::DesignCreated { design, agent_error: None });
                }
                // The agent that asked for it (X22), and its session.
                let spawner = match r.spawned_by {
                    Some(t) => match self.terminals.list().into_iter().find(|i| i.id == t) {
                        Some(i) => Some((t, i.session_id)),
                        None => return Err(RpcError::new("invalid_params", format!("no terminal {t}"))),
                    },
                    None => None,
                };
                let slug = {
                    let (store, r) = (store.clone(), r.clone());
                    blocking(move || store.create_design(&r.workspace, &r.name, &r.system, &r.brief, now_ms())).await?
                };
                let at = self.locate(&m::DesignRef::Workspace { workspace: r.workspace.clone(), slug: slug.clone() }).await?;
                // The design exists either way; the app shows why its agent did not start.
                let agent_error = self.start_design_agent(&at, None).await.err().map(|e| format!("{e:#}"));
                let design = blocking(move || store.design(&at)).await?;
                let name = design.name.clone();
                let created = moonlet_proto::types::DesignCreated { design: self.design_info(design, &self.terminals.list()), agent_error };
                // An agent's `design new`: the app shows a toast, the focus stays (X22).
                if let Some((t, session)) = spawner {
                    let opened = m::DesignOpened { workspace: r.workspace, slug, name, spawned_by: Some(t), session, kind: None };
                    self.terminals.emit(Message::event(m::EV_DESIGN_OPEN, opened));
                }
                ok(created)
            }
            m::DESIGN_SYSTEM_UPDATE => {
                let r: m::DesignRef = params(p)?;
                let at = self.locate(&r).await?;
                if !matches!(at.place, Place::Session(_)) {
                    return Err(RpcError::new("invalid_params", "only a session design has a copy of its design system to update"));
                }
                // One update of its copies at a time.
                let lock = self.lock_of(&at, DesignLock::System);
                let _held = lock.lock().await;
                let workspace = self.workspace_of(&at);
                ok(blocking(move || store.update_session_system(&at, &workspace)).await?)
            }
            m::DESIGN_COPY => {
                let r: m::DesignCopy = params(p)?;
                let Some(project) = self.workspace_projects(&r.workspace).into_iter().find(|p| p.id == r.from.project) else {
                    return Err(RpcError::new("invalid_params", format!("no project \"{}\" in the workspace", r.from.project)));
                };
                let (repo, base, path) = (Path::new(&project.path), project.base_branch.clone(), r.from.path.clone());
                // Only a design the project's listing gives: one of its design folder's.
                let folder = moonlet_core::design::session::design_folder(&moonlet_core::session::read_config(repo))
                    .map_err(|e| RpcError::new("invalid_params", format!("{e:#}")))?;
                let from = moonlet_core::design::project::read_project_design(repo, &base, &folder, &path).await.map_err(store_error)?;
                // Its agent starts from the pages it has, never over them.
                let intro = format!(
                    "This design starts as a copy of the design \"{}\" at {path} on {base} of the project {}: its pages are written already. Read them, then wait for what the user asks. Its brief was: {}",
                    from.config.name,
                    project.name,
                    from.config.brief.trim()
                );
                let (made, ws, name) = (store.clone(), r.workspace.clone(), r.name.clone());
                let slug = blocking(move || made.create_from_project(&ws, &name, &from, now_ms())).await?;
                let at = self.locate(&m::DesignRef::Workspace { workspace: r.workspace.clone(), slug }).await?;
                // The design exists either way; the app shows why its agent did not start.
                let agent_error = self.start_design_agent(&at, Some(intro)).await.err().map(|e| format!("{e:#}"));
                let design = blocking(move || store.design(&at)).await?;
                ok(moonlet_proto::types::DesignCreated { design: self.design_info(design, &self.terminals.list()), agent_error })
            }
            m::DESIGN_REMOVE => {
                let r: m::DesignRef = params(p)?;
                let at = self.locate(&r).await?;
                // After a start running now, so its agent is the one stopped.
                let lock = self.lock_of(&at, DesignLock::Agent);
                let _held = lock.lock().await;
                // No save, snapshot or restore of it meanwhile, and none to come.
                let pages = self.lock_of(&at, DesignLock::Pages);
                let _pages = pages.lock().await;
                let history = self.lock_of(&at, DesignLock::History);
                let _history = history.lock().await;
                self.take_hand_edits(&at);
                // A session design's agent is the session's: it stays.
                if matches!(at.place, Place::Workspace(_))
                    && let Some(agent) = self.design_agent(&at).await?
                {
                    let _ = self.terminals.kill(agent.id, true);
                }
                blocking(move || store.remove_design(&at)).await?;
                ok(true)
            }
            m::DESIGN_OPEN => {
                let r: m::DesignRef = params(p)?;
                let at = self.locate(&r).await?;
                let (session, kind) = match &at.place {
                    Place::Session(s) => (Some(s.clone()), Some(at.kind())),
                    Place::Workspace(_) => (None, None),
                };
                let workspace = self.workspace_of(&at);
                let config = blocking(move || store.design_config(&at)).await?;
                let opened = m::DesignOpened { workspace, slug: r.slug().to_string(), name: config.name, spawned_by: None, session, kind };
                self.terminals.emit(Message::event(m::EV_DESIGN_OPEN, opened));
                ok(true)
            }
            m::DESIGN_VIEWPORT => {
                let r: m::DesignViewport = params(p)?;
                let at = self.locate(&r.design).await?;
                blocking(move || store.set_design_viewport(&at, &r.viewport)).await?;
                ok(true)
            }
            m::DESIGN_COMMENTS => {
                let at = self.locate(&params(p)?).await?;
                ok(blocking(move || store.comments(&at)).await?)
            }
            m::DESIGN_COMMENT_PUT => {
                let r: m::DesignCommentPut = params(p)?;
                let at = self.locate(&r.design).await?;
                let lock = self.lock_of(&at, DesignLock::Comments);
                let _held = lock.lock().await;
                ok(blocking(move || store.put_comment(&at, &r.change, now_ms())).await?)
            }
            m::DESIGN_COMMENT_RESOLVE => {
                let r: m::DesignCommentRef = params(p)?;
                let at = self.locate(&r.design).await?;
                let lock = self.lock_of(&at, DesignLock::Comments);
                let _held = lock.lock().await;
                ok(blocking(move || store.resolve_comment(&at, r.n)).await?)
            }
            m::DESIGN_PAGE => {
                let r: m::DesignPageRef = params(p)?;
                let at = self.locate(&r.design).await?;
                ok(blocking(move || store.page(&at, &r.page, r.parse)).await?)
            }
            m::DESIGN_WRITE_PAGE => {
                let r: m::DesignWritePage = params(p)?;
                let at = self.locate(&r.design).await?;
                let lock = self.lock_of(&at, DesignLock::Pages);
                let _held = lock.lock().await;
                let (written, edits) = (at.clone(), r.edits.clone());
                let version = blocking(move || store.write_page(&written, &r.page, &r.html, &r.base_version)).await?;
                // Saved while the agent works, or asks the user: within its turn.
                let in_turn = self.design_agent_in_turn(&at).await.unwrap_or(false);
                self.edited_by_hand(&at, edits, in_turn);
                ok(m::DesignPageWritten { version })
            }
            m::DESIGN_KIT => {
                let at = self.locate(&params(p)?).await?;
                ok(blocking(move || store.design_kit(&at)).await?)
            }
            m::DESIGN_HISTORY => {
                let at = self.locate(&params(p)?).await?;
                ok(blocking(move || store.history(&at)).await?)
            }
            m::DESIGN_SNAPSHOT_RESTORE => {
                let r: m::DesignSnapshotRef = params(p)?;
                let at = self.locate(&r.design).await?;
                // No save of a page, and no other snapshot, meanwhile.
                let pages = self.lock_of(&at, DesignLock::Pages);
                let _pages = pages.lock().await;
                let history = self.lock_of(&at, DesignLock::History);
                let _history = history.lock().await;
                // Never within the agent's turn, at work or asking the user,
                // its pages maybe half written.
                if self.design_agent_in_turn(&at).await? {
                    return Err(RpcError::new("busy", "Claude is changing the design; restore once it stops"));
                }
                // What is not kept yet is kept first, as edits by hand. They
                // are taken only once the restore is done: one that fails
                // leaves them, and their wait, as they were.
                let edits = self.pending_hand_edits(&at);
                let restoring = at.clone();
                let restored = blocking(move || store.restore_snapshot(&restoring, r.n, Take::EditsByHand(edits), now_ms())).await?;
                self.take_hand_edits(&at);
                ok(restored)
            }
            m::DESIGN_SETTLE => {
                let r: m::DesignSettle = params(p)?;
                let choice: Settle = serde_json::from_value(Value::String(r.choice.clone()))
                    .map_err(|_| RpcError::new("invalid_params", format!("unknown choice {}", r.choice)))?;
                let lock = self.design_lock(&r.workspace, &r.slug);
                let _held = lock.lock().await;
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
        let lock = self.design_lock(workspace, slug);
        let _held = lock.lock().await;
        // The folders and the chat come from the record moonlet keeps outside
        // the system's folder, never from files the agent can edit. Reading and
        // hashing the sources runs off the async workers.
        let (store, ws, sl) = (self.design.clone(), workspace.to_string(), slug.to_string());
        let (record, launch, name) = blocking(move || {
            let dir = store.system_dir(&ws, &sl)?.canonicalize()?;
            let config = store.config(&ws, &sl)?;
            let record = store.record(&ws, &sl)?;
            let mut sources = Vec::new();
            // Each a real folder inside its project, whatever the record says.
            for s in &record.sources {
                sources.push(store::source_root(s)?.display().to_string());
            }
            let bin = moonlet_cli_path()?;
            let synced = dir.join(anchor::FILE).is_file();
            let status = if synced { anchor::status(&dir, &store::source_roots(&record), &config.exceptions())? } else { Vec::new() };
            let task = if synced { agent::Task::Resync(&status) } else { agent::Task::Build };
            let launch = agent::sync_launch(&dir, &config, &sources, &bin, task)?;
            // The cards as they are now: what the user changed before this
            // sync is not among the changes it records.
            store.begin_sync(&ws, &sl)?;
            Ok((record, launch, config.name))
        })
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        // What the chat starts with: a chat started with other folders or
        // rules (a source moved) is replaced, not reused.
        let fingerprint = format!("{}\n{}", launch.settings, launch.add_dirs.join("\n"));
        if let Some(id) = self.agent_of(workspace, slug) {
            if record.agent_launch.as_deref() == Some(fingerprint.as_str()) {
                self.chats.send(id, &launch.prompt, &[])?;
                return Ok(id);
            }
            let _ = self.terminals.kill(id, true);
        }
        let tag = moonlet_proto::types::DesignAgent {
            kind: moonlet_proto::types::DesignAgentKind::Sync,
            workspace: workspace.to_string(),
            slug: slug.to_string(),
            name,
        };
        self.agent_chat(&launch, tag, |id| match id {
            Some(id) => self.design.set_agent(workspace, slug, id, &fingerprint),
            None => self.design.clear_agent(workspace, slug),
        })
    }

    /// A design as `design.list` gives it (X65): its agent only while that
    /// chat is still its design's, with the agent's state and what it waits
    /// for from the user.
    fn design_info(&self, mut d: moonlet_proto::types::DesignInfo, terminals: &[moonlet_proto::types::TerminalInfo]) -> moonlet_proto::types::DesignInfo {
        use moonlet_proto::types::DesignKind;
        d.agent = match d.kind {
            DesignKind::Workspace => folder_agent(terminals, d.agent, Path::new(&d.path)),
            // A session design's agent is its session's (X65).
            DesignKind::Session => d.session.as_deref().and_then(|s| session_agent(terminals, s)),
            DesignKind::Project => None,
        };
        d.agent_state = d.agent.and_then(|id| terminals.iter().find(|t| t.id == id)).map(|t| t.agent_state);
        d.needs_you = d
            .agent
            .and_then(|id| self.chats.pending(id).ok())
            .and_then(|pending| moonlet_core::design::agent::needs_you(&pending));
        d
    }

    /// Starts a workspace design's agent (X65): Claude Code in the design's
    /// folder, in the workspace's Claude profile, with its design system's
    /// folder read only, and the brief with the design system's README and the
    /// design rules as its first message.
    /// `intro`, when given, is the first message's opening in place of the
    /// brief, such as what a copied design starts from.
    async fn start_design_agent(&self, at: &DesignAt, intro: Option<String>) -> anyhow::Result<u32> {
        use moonlet_core::design::agent;
        use moonlet_proto::types::{DesignAgent, DesignAgentKind};
        let lock = self.lock_of(at, DesignLock::Agent);
        let _held = lock.lock().await;
        let Place::Workspace(workspace) = at.place.clone() else {
            anyhow::bail!("a session design's agent is its session's");
        };
        let slug = at.slug.clone();
        // The folders come from the store, never from what the agent edits:
        // `design.toml` names the design system, which must be the workspace's.
        let (store, ws, design) = (self.design.clone(), workspace.clone(), at.clone());
        let (launch, name) = blocking(move || {
            let dir = design.folder().canonicalize()?;
            let mut config = store.design_config(&design)?;
            if let Some(intro) = intro {
                config.brief = intro;
            }
            let system = store.system_dir(&ws, &config.system)?.canonicalize()?;
            let readme = store.readme(&ws, &config.system)?;
            let launch = agent::design_launch(&dir, &config, &system, &readme, &moonlet_cli_path()?)?;
            Ok((launch, config.name))
        })
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        let tag = DesignAgent { kind: DesignAgentKind::Design, workspace: workspace.clone(), slug: slug.clone(), name };
        self.agent_chat(&launch, tag, |id| self.design.set_design_agent(at, id))
    }

    /// Starts the chat of a Design mode agent (X64, X65): Claude Code, with
    /// no session, in the Claude profile of the workspace its tag names,
    /// started as `launch` says and tagged so. `record` saves the chat as its
    /// system's or design's agent (`Some`), or forgets it (`None`); then the
    /// chat gets `launch.prompt` as its first message. When saving the record
    /// or sending that message fails, the chat is stopped and removed and the
    /// record forgotten, so a failed start leaves no agent behind.
    fn agent_chat(&self, launch: &moonlet_core::design::agent::Launch, tag: moonlet_proto::types::DesignAgent, record: impl Fn(Option<u32>) -> anyhow::Result<()>) -> anyhow::Result<u32> {
        let info = self.chats.create(ChatCreate {
            cwd: launch.cwd.clone(),
            agent: "claude".into(),
            model: None,
            effort: None,
            mode: Some(launch.mode.clone()),
            name: launch.title.clone(),
            title: Some(launch.title.clone()),
            session_id: None,
            env: Default::default(),
            add_dirs: launch.add_dirs.clone(),
            settings: Some(launch.settings.clone()),
            workspace: Some(tag.workspace.clone()),
            design: Some(tag),
        })?;
        let id = info.id;
        let started = record(Some(id)).and_then(|()| {
            self.chats.send(id, &launch.prompt, &[]).inspect_err(|_| {
                let _ = record(None);
            })
        });
        if started.is_err() {
            let _ = self.terminals.kill(id, true);
        }
        started.map(|()| id)
    }

    /// Has the app render every card of a design system, one at a time, and
    /// writes what it found to `.cache/render-check.json` (X64). A card the
    /// app could not render is `bad`, with why; without the app, nothing is
    /// written and it fails with `NoApp`.
    async fn render_check(&self, workspace: &str, slug: &str) -> Result<moonlet_core::design::render::RenderCounts, crate::render::RenderError> {
        use crate::render::{Ask, RenderError};
        use moonlet_core::design::render::RenderResult;
        if !self.renders.has_app() {
            return Err(RenderError::NoApp);
        }
        let (store, ws, sl) = (self.design.clone(), workspace.to_string(), slug.to_string());
        let cards = blocking(move || store.render_cards(&ws, &sl)).await.map_err(RenderError::Failed)?;
        let mut results = Vec::new();
        for card in cards {
            let ask = Ask {
                workspace: workspace.to_string(),
                slug: slug.to_string(),
                path: card.path.clone(),
                viewport: card.viewport,
                variant: None,
                want: m::RenderWant::Metrics,
            };
            let answer = match self.renders.render(ask).await {
                Ok(done) => done.metrics(),
                Err(RenderError::NoApp) => return Err(RenderError::NoApp),
                Err(e) => Err(e.to_string()),
            };
            results.push(RenderResult::new(card.path, answer));
        }
        let (store, ws, sl) = (self.design.clone(), workspace.to_string(), slug.to_string());
        blocking(move || store.write_render_check(&ws, &sl, &results)).await.map_err(RenderError::Failed)
    }

    /// The lock of one design system (see `design_locks`).
    fn design_lock(&self, workspace: &str, slug: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.design_locks.lock().unwrap().entry(design_key(workspace, slug)).or_default().clone()
    }

    /// One of a design's locks (X65), by what it guards (see [`DesignLock`]).
    /// A design's key has a `w/` or `s/` and two `/`s more than a design
    /// system's `<workspace>/<slug>`, so the two never meet.
    fn lock_of(&self, at: &DesignAt, what: DesignLock) -> Arc<tokio::sync::Mutex<()>> {
        self.design_locks.lock().unwrap().entry(format!("{}#{what:?}", at.key())).or_default().clone()
    }

    /// Finds a design (X65): the one resolver every design RPC goes
    /// through, which gives its folders and its key.
    async fn locate(&self, r: &m::DesignRef) -> Result<DesignAt, RpcError> {
        let store = self.design.clone();
        match r.clone() {
            m::DesignRef::Workspace { workspace, slug } => {
                self.workspace_exists(&workspace)?;
                blocking(move || store.workspace_design(&workspace, &slug)).await
            }
            m::DesignRef::Session { session, slug } => {
                let (s, folder) = self.design_session(&session)?;
                self.workspace_exists(s.workspace_id.as_deref().unwrap_or_default())?;
                blocking(move || moonlet_core::design::session::session_design(&session, Path::new(&s.path), &folder, &slug)).await
            }
        }
    }

    /// Refuses a workspace moonlet does not have.
    fn workspace_exists(&self, workspace: &str) -> Result<(), RpcError> {
        if !self.sessions.list_workspaces().iter().any(|w| w.id == workspace) {
            return Err(RpcError::new("invalid_params", format!("no workspace \"{workspace}\"")));
        }
        Ok(())
    }

    /// The workspace a design is in: a workspace design's own, a session
    /// design's session's.
    fn workspace_of(&self, at: &DesignAt) -> String {
        match &at.place {
            Place::Workspace(w) => w.clone(),
            Place::Session(s) => self.sessions.session(s).ok().and_then(|s| s.workspace_id).unwrap_or_default(),
        }
    }

    /// A session that may hold session designs (X65), and the folder of
    /// its project's session designs, from the worktree's own config.
    fn design_session(&self, id: &str) -> Result<(moonlet_proto::types::Session, String), RpcError> {
        let s = self.sessions.session(id).map_err(|_| RpcError::new("invalid_params", format!("no session \"{id}\"")))?;
        let config = moonlet_core::session::read_config(Path::new(&s.path));
        let folder = moonlet_core::design::session::design_folder(&config).map_err(|e| RpcError::new("invalid_params", format!("{e:#}")))?;
        self.watch_session_designs(&s, &folder);
        Ok((s, folder))
    }

    /// Watches an open session's worktree for its session designs'
    /// changes, and announces them as `design.changed` with the design, its
    /// session and its workspace (X65). A design folder not there yet is
    /// watched for from the nearest folder above it, so a design another
    /// tool makes there later is announced too. Every design call that reaches a session's designs, and their
    /// listing, starts it, so once the session is unarchived it starts
    /// again as the app lists the designs; after a restart the daemon starts
    /// it (see `watch_saved_session_designs`). An archived
    /// session's designs are not watched (see `prune_session_watches`).
    fn watch_session_designs(&self, s: &moonlet_proto::types::Session, folder: &str) {
        let worktree = Path::new(&s.path);
        let roots = [worktree.join(folder), worktree.join(moonlet_core::design::session::SIDE_DIR)];
        let mut watches = self.session_watches.lock().unwrap();
        // A watch started while a folder was not there arms it only once
        // the watch hears it made; a design call coming once both are there
        // while it has not armed them yet starts the watch again, armed on
        // them before it returns.
        let there = roots.iter().all(|r| r.is_dir());
        if s.archived || watches.get(&s.id).is_some_and(|w| !there || roots.iter().all(|r| w.watches_whole(r))) {
            return;
        }
        let (terminals, workspace, session) = (self.terminals.clone(), s.workspace_id.clone(), s.id.clone());
        let watching = moonlet_core::design::watch::start_session(worktree, folder, move |changes| {
            for c in changes {
                let data = serde_json::json!({"workspace": workspace, "system": null, "design": c.design, "session": session, "paths": c.paths});
                terminals.emit(Message::event(m::EV_DESIGN_CHANGED, data));
            }
        });
        match watching {
            Ok(watching) => {
                watches.insert(s.id.clone(), watching);
            }
            Err(e) => tracing::warn!("cannot watch the designs of session {}: {e:#}", s.id),
        }
    }

    /// Watches the designs of every open session that has session designs,
    /// a `.moonlet/design/` in its worktree (X65), as the daemon starts, so
    /// after a restart their edits are announced before any design call.
    pub fn watch_saved_session_designs(&self) {
        for s in self.sessions.list_sessions() {
            if !s.archived
                && Path::new(&s.path).join(moonlet_core::design::session::SIDE_DIR).is_dir()
                && let Err(e) = self.design_session(&s.id)
            {
                tracing::warn!("cannot watch the designs of session {}: {}", s.id, e.message);
            }
        }
    }

    /// Stops watching the designs of sessions that are archived or gone
    /// (X65): their watches end with them.
    fn prune_session_watches(&self) {
        let open: std::collections::HashSet<String> =
            self.sessions.list_sessions().into_iter().filter(|s| !s.archived).map(|s| s.id).collect();
        self.session_watches.lock().unwrap().retain(|id, _| open.contains(id));
    }

    /// A session design as `design.list` gives it: with its session and
    /// project, and whether its design system was synced since it pinned it.
    async fn session_design_info(&self, at: DesignAt) -> Result<moonlet_proto::types::DesignInfo, RpcError> {
        let Place::Session(session) = at.place.clone() else {
            return Err(internal("not a session design"));
        };
        let s = self.sessions.session(&session).map_err(internal)?;
        let (store, ws) = (self.design.clone(), s.workspace_id.clone().unwrap_or_default());
        let mut d = blocking(move || Ok(store.session_design_info(&at, &ws))).await?;
        d.project = Some(s.project_id);
        Ok(self.design_info(d, &self.terminals.list()))
    }

    /// The session designs of a workspace's open sessions (X65). A session
    /// whose designs cannot be listed is left out, and logged.
    async fn session_designs_of_workspace(&self, workspace: &str) -> Vec<moonlet_proto::types::DesignInfo> {
        let mut out = Vec::new();
        for s in self.sessions.list_sessions() {
            if s.archived || s.workspace_id.as_deref() != Some(workspace) {
                continue;
            }
            let Ok((_, folder)) = self.design_session(&s.id) else { continue };
            let id = s.id.clone();
            let (store, ws) = (self.design.clone(), workspace.to_string());
            let listed = blocking(move || {
                let mut out = store.session_designs(&s.id, Path::new(&s.path), &folder, &ws)?;
                for d in &mut out {
                    d.project = Some(s.project_id.clone());
                }
                Ok(out)
            })
            .await;
            match listed {
                Ok(list) => out.extend(list),
                Err(e) => tracing::warn!("cannot list the designs of session {id}: {}", e.message),
            }
        }
        out
    }

    /// The projects in a workspace's sections, each once.
    fn workspace_projects(&self, workspace: &str) -> Vec<moonlet_proto::types::Project> {
        let Some(ws) = self.sessions.list_workspaces().into_iter().find(|w| w.id == workspace) else { return Vec::new() };
        let ids: std::collections::BTreeSet<String> = self
            .sessions
            .list_sections()
            .into_iter()
            .filter(|s| ws.section_ids.contains(&s.id))
            .flat_map(|s| s.project_ids)
            .collect();
        self.sessions.list_projects().into_iter().filter(|p| ids.contains(&p.id)).collect()
    }

    /// The project designs of a workspace's projects (X65): their session
    /// designs merged into their base branches, read from git's objects. A
    /// project whose designs cannot be read is left out, and logged.
    async fn project_designs_of_workspace(&self, workspace: &str) -> Vec<moonlet_proto::types::DesignInfo> {
        let mut out = Vec::new();
        for p in self.workspace_projects(workspace) {
            let repo = Path::new(&p.path);
            let Ok(folder) = moonlet_core::design::session::design_folder(&moonlet_core::session::read_config(repo)) else { continue };
            match moonlet_core::design::project::project_designs(repo, &p.base_branch, &folder, &p.id).await {
                Ok(list) => out.extend(list),
                Err(e) => tracing::debug!("no designs of project {}: {e:#}", p.id),
            }
        }
        out
    }

    /// Takes a snapshot of a design's pages and assets, if they changed
    /// since its last (X65), by one that holds the locks of its pages and
    /// history, so no save falls in it. A failure is logged: it never fails
    /// what took it.
    async fn snapshot(&self, at: &DesignAt, take: Take) {
        let (store, design) = (self.design.clone(), at.clone());
        if let Err(e) = blocking(move || store.take_snapshot(&design, take, now_ms())).await {
            tracing::warn!("cannot take a snapshot of {}: {}", at.key(), e.message);
        }
    }

    /// The terminal of a workspace design's agent, while that chat is
    /// still the design's (X65).
    async fn design_agent(&self, at: &DesignAt) -> Result<Option<moonlet_proto::types::TerminalInfo>, RpcError> {
        // A session design's agent is its session's (X65).
        let terminals = self.terminals.list();
        let agent = match &at.place {
            Place::Session(session) => session_agent(&terminals, session),
            Place::Workspace(_) => {
                let (store, design) = (self.design.clone(), at.clone());
                let recorded = blocking(move || Ok(store.design_record(&design)?.agent)).await?;
                folder_agent(&terminals, recorded, &at.folder())
            }
        };
        Ok(agent.and_then(|id| terminals.into_iter().find(|t| t.id == id)))
    }

    /// Whether a design's agent is within a turn: at work, or asking the
    /// user, as the snapshots' watch counts a turn (X65).
    async fn design_agent_in_turn(&self, at: &DesignAt) -> Result<bool, RpcError> {
        use moonlet_proto::types::AgentState;
        Ok(self.design_agent(at).await?.is_some_and(|t| matches!(t.agent_state, AgentState::Working | AgentState::Blocked)))
    }

    /// What a design's edits by hand not kept yet did, leaving them and
    /// their wait in place.
    fn pending_hand_edits(&self, at: &DesignAt) -> Vec<String> {
        self.hand_edits.lock().unwrap().get(&at.key()).map(HandEdits::all).unwrap_or_default()
    }

    /// Takes a design's edits by hand not kept yet, with what they did, and
    /// cancels the wait for them to stop; `None` when there are none.
    fn take_hand_edits(&self, at: &DesignAt) -> Option<Vec<String>> {
        let taken = self.hand_edits.lock().unwrap().remove(&at.key())?;
        if let Some(quiet) = &taken.quiet {
            quiet.abort();
        }
        Some(taken.all())
    }

    /// Takes the edits by hand a design's agent did not work during, as it
    /// starts a turn; `None` when there are none. Those saved while it
    /// worked stay, with their wait: the daemon heard it start after them,
    /// and they go with the turn's snapshot.
    fn take_hand_edits_before_turn(&self, at: &DesignAt) -> Option<Vec<String>> {
        let key = at.key();
        let mut all = self.hand_edits.lock().unwrap();
        let pending = all.get_mut(&key)?;
        if !pending.before {
            return None;
        }
        if pending.in_turn {
            let (during, before): (Vec<_>, Vec<_>) = std::mem::take(&mut pending.edits).into_iter().partition(|(in_turn, _)| *in_turn);
            pending.edits = during;
            pending.before = false;
            return Some(before.into_iter().map(|(_, e)| e).collect());
        }
        let taken = all.remove(&key)?;
        if let Some(quiet) = &taken.quiet {
            quiet.abort();
        }
        Some(taken.all())
    }

    /// A design's page saved by its editor (X65): what its edits did is
    /// kept for the snapshot, taken once its saves stop for
    /// [`EDITS_QUIET`], each save's wait cancelling the one before. The
    /// daemon sees every save, so the snapshot comes also when the app
    /// closes meanwhile. While the design's agent is within a turn, at work
    /// or asking the user, the wait takes nothing: the edits were kept as the agent started (see
    /// [`Self::snapshot_agent_turns`]), and any made since go with the
    /// turn's own snapshot, `in_turn`, even when the daemon hears the
    /// agent start only after them.
    fn edited_by_hand(self: &Arc<Self>, at: &DesignAt, edits: Vec<String>, in_turn: bool) {
        let key = at.key();
        let mut all = self.hand_edits.lock().unwrap();
        let pending = all.entry(key.clone()).or_default();
        pending.edits.extend(edits.into_iter().map(|e| (in_turn, e)));
        match in_turn {
            true => pending.in_turn = true,
            false => pending.before = true,
        }
        pending.saves += 1;
        if let Some(quiet) = pending.quiet.take() {
            quiet.abort();
        }
        let (d, at, saves) = (self.clone(), at.clone(), pending.saves);
        let quiet = tokio::spawn(async move {
            tokio::time::sleep(d.edits_quiet).await;
            // As a save holds them: one in progress ends first, its edits
            // with it, and the edits are read and taken only under them.
            let (pages, history) = (d.lock_of(&at, DesignLock::Pages), d.lock_of(&at, DesignLock::History));
            let _pages = pages.lock().await;
            let _history = history.lock().await;
            // Within the agent's turn, at work or asking the user, its pages
            // may be half written: the turn keeps them.
            if d.design_agent_in_turn(&at).await.unwrap_or(false) {
                return;
            }
            let edits = {
                let mut all = d.hand_edits.lock().unwrap();
                // A later save waits on.
                if all.get(&key).is_none_or(|e| e.saves != saves) {
                    return;
                }
                all.remove(&key).map(|e| e.all()).unwrap_or_default()
            };
            d.snapshot(&at, Take::EditsByHand(edits)).await;
        });
        pending.quiet = Some(quiet.abort_handle());
    }

    /// A design's snapshots as its agent works (X65): a workspace design's
    /// agent's, and a session's agent's for that session's designs (entry
    /// 12). When the agent starts working, the edits by hand not kept yet
    /// are kept, if `chat.send` did not keep them already (see
    /// [`Self::keep_before_message`]), so the turn's snapshot holds only
    /// the agent's work; when its turn ends, done, stopped (idle) or
    /// failed (error), the turn's snapshot is taken. Each is
    /// taken in the order its event came, one after the other, without
    /// holding up the events. A turn that starts without `chat.send` keeps
    /// the edits only once the daemon hears the agent works, so its first
    /// writes could go with them; none does on a design with edits waiting
    /// (the first message comes as the design is made, and a queued one
    /// after the turn's snapshot). Runs for the daemon's life.
    /// Moves the design systems and designs of each merged workspace into
    /// the one it merged into (X71): now, and whenever the workspaces
    /// change, as they do when a merge comes from another member. Runs for
    /// the daemon's life.
    pub fn follow_merges(self: &Arc<Self>) {
        let mut events = self.terminals.subscribe_events();
        let d = self.clone();
        tokio::spawn(async move {
            d.move_merged_designs().await;
            // Again every minute, for a move that failed.
            let mut retry = tokio::time::interval(std::time::Duration::from_secs(60));
            retry.tick().await;
            loop {
                tokio::select! {
                    event = events.recv() => match event {
                        // A lagged watch may have missed the change: look again.
                        Ok(Message::Event { name, .. }) if name == m::EV_WORKSPACES_CHANGED => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Ok(_) => continue,
                        Err(_) => return,
                    },
                    _ = retry.tick() => {}
                }
                d.move_merged_designs().await;
            }
        });
    }

    async fn move_merged_designs(&self) {
        for (from, into) in self.sessions.merged_workspaces() {
            self.stop_agents_in(&from).await;
            match self.copies.merge(&from, &into).await {
                Ok(moved) if !moved.is_empty() => {
                    tracing::info!(%from, %into, "moved {} design items of a merged workspace", moved.len());
                    self.copies.kick();
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(%from, %into, "cannot move a merged workspace's designs: {e:#}"),
            }
        }
    }

    /// Stops the agents of workspace `from`'s design systems and designs,
    /// whose folders a merge is about to move: their records forget them,
    /// and a new one starts in the new place.
    async fn stop_agents_in(&self, from: &str) {
        let store = self.design.clone();
        let ws = from.to_string();
        let (systems, designs) = blocking(move || {
            let systems: Vec<String> = store.systems(&ws).unwrap_or_default().into_iter().map(|s| s.slug).collect();
            let designs: Vec<String> = store.designs(&ws).unwrap_or_default().into_iter().map(|d| d.slug).collect();
            Ok((systems, designs))
        })
        .await
        .unwrap_or_default();
        // Each only while it is still that item's agent, as its terminal
        // says: a record's id may name a terminal since given to another.
        for slug in systems {
            self.stop_sync_agent(from, &slug);
        }
        for slug in designs {
            let store = self.design.clone();
            let (ws, s) = (from.to_string(), slug.clone());
            let Ok(at) = blocking(move || store.workspace_design(&ws, &s)).await else { continue };
            if let Ok(Some(agent)) = self.design_agent(&at).await {
                let _ = self.terminals.kill(agent.id, true);
            }
        }
    }

    /// Continues another member's session on this host, the central host,
    /// from its copy (X73): this host becomes its owner, its copy becomes
    /// its worktree on the session's own branch, and each copied chat goes
    /// on, resuming its conversation. A turn the member had running when it
    /// went away goes on with a note to the agent. `why` says why it moved.
    async fn continue_here(self: &Arc<Self>, session: &str, why: &str) -> Result<moonlet_proto::types::Session, RpcError> {
        let me = self.link.info().worker;
        let record = self
            .sessions
            .session_records()
            .remove(session)
            .ok_or_else(|| RpcError::new("not_found", "no such session in the account"))?;
        let text = |f: &str| record.get(f).and_then(Value::as_str).map(str::to_string);
        let owner = text("owner").unwrap_or_default();
        if owner == me.id {
            return Err(RpcError::new("invalid_params", "that session is this host's own"));
        }
        // An archived session is over, and its copy on its way out.
        if record.get("archived").and_then(Value::as_bool).unwrap_or(false) {
            return Err(RpcError::new("archived", "that session is archived"));
        }
        if self.workers.conn(&owner).is_some() {
            return Err(RpcError::new("reachable", "the member running that session is reachable"));
        }
        // Not for a short drop: only once it has been away for 30 s. Tests
        // set a shorter wait.
        let wait: u64 = std::env::var("MOONLET_TEST_UNREACHABLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(30_000);
        if self.workers.unreachable_since(&owner).is_some_and(|t| now_ms().saturating_sub(t) < wait) {
            let name = self.sessions.member_names().remove(&owner).unwrap_or(owner);
            return Err(RpcError::new("not_yet", format!("{name} has been unreachable for less than 30 s")));
        }
        if text("pinned").is_some_and(|p| p != me.id) {
            return Err(RpcError::new("pinned", "that session is kept on its member"));
        }
        if self.sessions.session(session).is_ok() {
            return Err(RpcError::new("invalid_params", "this host already has that session"));
        }
        let branch = text("branch").unwrap_or_default();
        let info = self.session_copies.copy_info(session)?;
        if info.path.is_empty() {
            return Err(RpcError::new("no_copy", "this host has no copy of that session yet"));
        }
        // The copy's branch becomes the session's own, unless this host has
        // a branch of that name of its own: that one is never touched.
        let copy_path = Path::new(&info.path);
        let copy_branch = format!("moonlet-copy/{session}");
        let rename = !branch.is_empty() && branch != copy_branch;
        if rename {
            // The name comes from the member: only one git takes as a branch.
            let valid = !branch.starts_with('-')
                && moonlet_core::git::git(copy_path, &["check-ref-format", "--branch", &branch]).await.is_ok();
            if !valid {
                return Err(RpcError::new("invalid_params", "the session's branch is not a branch name"));
            }
            if moonlet_core::sync::branch_exists(copy_path, &branch).await {
                return Err(RpcError::new("branch_taken", format!("{branch} is a branch of this host's own")));
            }
        }
        // From here no offer moves the copy. Until the session is this
        // host's, a step that fails gives the copy back, to try again.
        let taken = self.session_copies.take_copy(session, rename.then_some(branch.as_str())).await?;
        let adopted = match self.adopt_copy(session, &record, &taken, &me.id).await {
            Ok(adopted) => adopted,
            Err(e) => {
                self.session_copies.give_back(session, taken).await;
                return Err(e);
            }
        };
        self.session_copies.forget_copy(session, &taken).await;
        let from = self.sessions.member_names().remove(&owner).unwrap_or(owner);
        for mut chat in info.chats {
            let cut_off = matches!(chat.state.status.as_str(), "working" | "blocked");
            // Folders it was given inside the member's worktree are the
            // same ones in the copy.
            chat.state.add_dirs = moonlet_core::chat::moved_dirs(&chat.state.add_dirs, &taken.from_path, &adopted.path);
            // One chat that cannot go on never holds back the others.
            let started = match self.sessions.continue_chat(&adopted, chat.state) {
                Ok(started) => started,
                Err(e) => {
                    tracing::warn!(%session, terminal = chat.terminal, "cannot continue a copied chat: {e:#}");
                    continue;
                }
            };
            if cut_off {
                let note = crate::session_copies::cut_off_note(&from, &me.name, why, &taken.from_path, &adopted.path);
                if let Err(e) = self.chats.send(started.id, &note, &[]) {
                    tracing::warn!(%session, "cannot tell the agent its turn was cut off: {e:#}");
                }
            }
        }
        self.sessions.session(session).map_err(internal)
    }

    /// Makes the copy [`Self::continue_here`] took session `session` of
    /// this host, owned by `me`, as `record` describes it (X73). The session
    /// is in this host's state before its record names this host, so no
    /// change ends that record meanwhile; one whose new owner cannot be
    /// recorded leaves the state again.
    async fn adopt_copy(
        self: &Arc<Self>,
        session: &str,
        record: &moonlet_core::account::Record,
        taken: &crate::session_copies::TakenCopy,
        me: &str,
    ) -> Result<moonlet_proto::types::Session, RpcError> {
        let text = |f: &str| record.get(f).and_then(Value::as_str).map(str::to_string);
        // The copy's repository is a project here; a clone made for copies
        // is added as one.
        let projects = self.sessions.list_projects();
        let project = match projects.iter().find(|p| Path::new(&p.path) == taken.repo) {
            Some(p) => p.clone(),
            None => self.sessions.add_project(&taken.repo.display().to_string()).await.map_err(internal)?,
        };
        // The member came back, or the session moved, meanwhile.
        let now = self.sessions.session_records().remove(session);
        let epoch = record.get("epoch").and_then(Value::as_u64).unwrap_or(1);
        let still = now.as_ref().is_some_and(|r| {
            r.get("owner") == record.get("owner") && r.get("epoch").and_then(Value::as_u64).unwrap_or(1) == epoch
        });
        if !still {
            return Err(RpcError::new("stale", "that session moved meanwhile"));
        }
        if self.workers.conn(&text("owner").unwrap_or_default()).is_some() {
            return Err(RpcError::new("reachable", "the member running that session is reachable"));
        }
        let adopted = self
            .sessions
            .adopt_session(moonlet_proto::types::Session {
                id: session.to_string(),
                project_id: project.id.clone(),
                name: text("name").unwrap_or_default(),
                branch: text("branch").unwrap_or_default(),
                base: project.base_branch.clone(),
                path: taken.path.display().to_string(),
                agent: Some("claude".into()),
                archived: false,
                created_at: record.get("created_at").and_then(Value::as_u64).unwrap_or(0),
                workspace_id: text("workspace"),
                // The member's word: a name as agents take them, or none.
                model: text("model").filter(|m| moonlet_core::chat::plain_setting(m)),
                effort: text("effort").filter(|e| moonlet_core::chat::plain_setting(e)),
                mode: None,
                pr: None,
                spawned_by: None,
                task: None,
                task_unlinked: false,
                cloud: false,
                terminals: Vec::new(),
                layout: Value::Null,
                restore: Vec::new(),
                owner: None,
            })
            .map_err(internal)?;
        if !self.sessions.set_session_owner(session, me, epoch + 1, None) {
            if let Err(e) = self.sessions.unadopt_session(session) {
                tracing::warn!(%session, "cannot undo taking the session in: {e:#}");
            }
            return Err(RpcError::new("internal", "cannot record this host as the session's owner"));
        }
        Ok(adopted)
    }

    /// `session.forward` on the central host (X72): the request goes to the
    /// member that owns the session while it is linked. Otherwise reads are
    /// answered from this host's copy, and the rest with `owner_offline`.
    async fn forward(self: &Arc<Self>, conn: &Arc<Conn>, r: m::SessionForward) -> HandlerResult {
        use crate::session_copies::scope;
        let record = self
            .sessions
            .session_records()
            .remove(&r.session)
            .ok_or_else(|| RpcError::new("not_found", "no such session in the account"))?;
        let owner = record.get("owner").and_then(Value::as_str).unwrap_or_default().to_string();
        if owner.is_empty() || owner == self.link.info().worker.id {
            return Err(RpcError::new("invalid_params", "that session is this host's own"));
        }
        if let Some(member) = self.workers.conn(&owner) {
            return member
                .request(m::SESSION_FORWARD, serde_json::to_value(&r).map_err(internal)?, std::time::Duration::from_secs(60))
                .await;
        }
        let offline = || {
            let name = self.sessions.member_names().remove(&owner).unwrap_or(owner.clone());
            RpcError::new("owner_offline", format!("{name} is not reachable"))
        };
        match r.method.as_str() {
            m::CHAT_STATE => {
                let id = r.params.get("id").and_then(Value::as_u64).ok_or_else(|| RpcError::new("invalid_params", "a chat's id"))?;
                let state = u32::try_from(id)
                    .ok()
                    .and_then(|id| self.session_copies.copy_chat(&r.session, id))
                    .ok_or_else(|| RpcError::new("not_found", "the copy has no such chat"))?;
                ok(state)
            }
            m::CHAT_SUMMARIES => {
                let info = self.session_copies.copy_info(&r.session)?;
                ok(info
                    .chats
                    .into_iter()
                    .map(|c| serde_json::json!({ "id": c.terminal, "state": c.state }))
                    .collect::<Vec<_>>())
            }
            // The PR's status too, so the phone's PR tab is never left waiting.
            m::GIT_STATUS | m::GIT_DIFF | m::GIT_LOG | m::GH_PRS | m::GH_PR_STATUS => {
                let path = self.session_copies.copy_path(&r.session).ok_or_else(offline)?;
                let p = scope(&r.method, r.params, &r.session, &path, "", &[])?;
                Box::pin(self.handle(conn, &r.method, p)).await
            }
            _ => Err(offline()),
        }
    }

    /// `session.relay` from the central host (X72): attaches to a terminal
    /// of one of this member's sessions for a client there, or detaches.
    pub async fn relayed(self: &Arc<Self>, r: m::SessionRelay) -> HandlerResult {
        if r.op == "detach" {
            self.session_copies.relay_detach(r.relay);
            return ok(true);
        }
        let s = self
            .sessions
            .list_sessions()
            .into_iter()
            .find(|s| s.id == r.session && s.owner.is_none() && !s.archived)
            .ok_or_else(|| RpcError::new("not_found", "no such session here"))?;
        if !s.terminals.contains(&r.terminal) {
            return Err(RpcError::new("forbidden", "that terminal is not one of the session's"));
        }
        self.session_copies.relay_attach(r.relay, r.terminal, r.cols.zip(r.rows))
    }

    /// A request the central host passes on for one of this member's
    /// sessions (X72): only what [`scope`] lets through, aimed at that
    /// session, handled as for a paired device, never as the Mac's app.
    pub async fn forwarded(self: &Arc<Self>, r: m::SessionForward) -> HandlerResult {
        use crate::session_copies::{only_terminals, scope};
        let s = self
            .sessions
            .list_sessions()
            .into_iter()
            .find(|s| s.id == r.session && s.owner.is_none() && !s.archived)
            .ok_or_else(|| RpcError::new("not_found", "no such session here"))?;
        let p = scope(&r.method, r.params, &s.id, &s.path, &s.branch, &s.terminals)?;
        // A file named in a forwarded call stays inside the worktree, links
        // resolved, so a link in the session can't reach the rest of the Mac.
        crate::session_copies::files_inside(&p, Path::new(&s.path))?;
        let conn = Conn::detached(self.terminals.new_client_id(), "moonlet-forwarded", Some("forwarded".to_string()));
        let reply = Box::pin(self.handle(&conn, &r.method, p)).await?;
        Ok(only_terminals(&r.method, reply, &s.terminals))
    }

    /// Lets go of this member's sessions that the central host gave
    /// another member (X73). What this member did meanwhile that the
    /// central host never got is kept: files in a leftovers folder, the
    /// conversation as a fork. The session's agent and terminals end, its
    /// worktree goes, and a live copy of it is kept in sync from the
    /// central host in its place (X60), so typing here can bring it back.
    async fn let_go_of_lost(self: &Arc<Self>) {
        let _one = self.letting_go.lock().await;
        let info = self.link.info();
        if info.central.is_none() || info.worker.cloud {
            return;
        }
        let records = self.sessions.session_records();
        for s in self.sessions.list_sessions().into_iter().filter(|s| s.owner.is_none() && !s.archived) {
            let Some(owner) = records.get(&s.id).and_then(|r| r.get("owner")).and_then(Value::as_str) else {
                continue;
            };
            if owner == info.worker.id {
                continue;
            }
            match self.session_copies.keep_gap(&s).await {
                Ok(Some(folder)) => tracing::info!(session = %s.id, "kept what was done here meanwhile in {}", folder.display()),
                Ok(None) => {}
                Err(e) => {
                    // Nothing is let go of until what it holds is kept.
                    tracing::warn!(session = %s.id, "cannot keep what was done here meanwhile: {e:#}");
                    continue;
                }
            }
            if let Err(e) = self.sessions.let_go_session(&s.id).await {
                tracing::warn!(session = %s.id, "cannot let go of a session another member owns: {e:#}");
                continue;
            }
            tracing::info!(session = %s.id, %owner, "another member runs this session now; keeping a copy of it");
            if let Err(e) = self.sync.start(s.id.clone()) {
                tracing::warn!(session = %s.id, "cannot keep a copy of it: {}", e.message);
            }
        }
    }

    /// Sends this member's sessions to the central host, and keeps the
    /// central host's copies to the sessions that are still live (X72).
    pub fn keep_session_copies(self: &Arc<Self>) {
        let copies = Arc::downgrade(&self.session_copies);
        self.sessions.on_account_applied(move |changes| {
            if let Some(c) = copies.upgrade()
                && changes.iter().any(|c| c.kind == "session")
            {
                tokio::spawn(async move { c.drop_ended().await });
            }
        });
        // Sessions the central host gave another member, now and as the
        // news comes (X73).
        let d = Arc::downgrade(self);
        self.sessions.on_account_applied(move |changes| {
            if let Some(d) = d.upgrade()
                && changes.iter().any(|c| c.kind == "session")
            {
                tokio::spawn(async move { d.let_go_of_lost().await });
            }
        });
        let d = self.clone();
        tokio::spawn(async move { d.let_go_of_lost().await });
        let d = Arc::downgrade(self);
        self.link.set_forwarder(Arc::new(move |r| {
            let d = d.clone();
            Box::pin(async move {
                let d = d.upgrade().ok_or_else(|| RpcError::new("gone", "the daemon is stopping"))?;
                d.forwarded(r).await
            })
        }));
        let d = Arc::downgrade(self);
        self.link.set_relayer(Arc::new(move |r| {
            let d = d.clone();
            Box::pin(async move {
                let d = d.upgrade().ok_or_else(|| RpcError::new("gone", "the daemon is stopping"))?;
                d.relayed(r).await
            })
        }));
        self.session_copies.spawn();
    }

    /// Keeps this member's design copies (X71): a round when the design
    /// folders change, when the link changes, and when another member's
    /// change to a design's record comes.
    pub fn keep_design_copies(self: &Arc<Self>) {
        let copies = Arc::downgrade(&self.copies);
        self.sessions.on_account_applied(move |changes| {
            if let Some(c) = copies.upgrade()
                && changes.iter().any(|c| c.kind == "design")
            {
                c.kick();
            }
        });
        // Its record says while its agent works, so another member's Move
        // here can tell the owner looks busy.
        let d = Arc::downgrade(self);
        self.copies.on_busy(move |item| {
            let Some(d) = d.upgrade() else { return false };
            let agent = match item.kind {
                moonlet_core::design::replica::Kind::System => d.design.record(&item.workspace, &item.slug).ok().and_then(|r| r.agent),
                moonlet_core::design::replica::Kind::Design => d
                    .design
                    .workspace_design(&item.workspace, &item.slug)
                    .and_then(|at| d.design.design_record(&at))
                    .ok()
                    .and_then(|r| r.agent),
            };
            agent.is_some_and(|id| {
                d.terminals.list().iter().any(|t| {
                    t.id == id && matches!(t.agent_state, moonlet_proto::types::AgentState::Working | moonlet_proto::types::AgentState::Blocked)
                })
            })
        });
        // An item another member owns now: its agent here stops.
        let d = Arc::downgrade(self);
        self.copies.on_lost(move |item| {
            let Some(d) = d.upgrade() else { return };
            match item.kind {
                moonlet_core::design::replica::Kind::System => d.stop_sync_agent(&item.workspace, &item.slug),
                moonlet_core::design::replica::Kind::Design => {
                    let agent = d
                        .design
                        .workspace_design(&item.workspace, &item.slug)
                        .and_then(|at| d.design.design_record(&at))
                        .ok()
                        .and_then(|r| r.agent);
                    if let Some(id) = agent {
                        let _ = d.terminals.kill(id, true);
                    }
                }
            }
        });
        let mut events = self.terminals.subscribe_events();
        let copies = self.copies.clone();
        tokio::spawn(async move {
            loop {
                use moonlet_core::design::replica::Item;
                match events.recv().await {
                    // The item whose folder changed is read again.
                    Ok(Message::Event { name, data }) if name == m::EV_DESIGN_CHANGED => {
                        let ws = data.get("workspace").and_then(Value::as_str).unwrap_or_default();
                        let text = |f: &str| data.get(f).and_then(Value::as_str);
                        match (text("system"), text("design")) {
                            (Some(slug), _) => copies.changed(Item::system(ws, slug)),
                            (None, Some(slug)) => copies.changed(Item::design(ws, slug)),
                            _ => {}
                        }
                        copies.kick();
                    }
                    Ok(Message::Event { name, .. }) if name == m::EV_LINK_CHANGED => {
                        copies.link_changed();
                        copies.kick();
                    }
                    // A design or sync agent starting or stopping: its
                    // record says so soon, for another member's Move here.
                    Ok(Message::Event { name, data }) if name == m::EV_TERMINAL_UPDATED => {
                        if data.get("design").is_some_and(|d| !d.is_null()) {
                            copies.kick();
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return,
                }
            }
        });
        self.copies.spawn();
    }

    pub fn snapshot_agent_turns(self: &Arc<Self>) {
        use moonlet_proto::types::{AgentState, TerminalInfo};
        let mut events = self.terminals.subscribe_events();
        let (steps, mut todo) = tokio::sync::mpsc::unbounded_channel::<(TurnOf, AgentStep)>();
        let d = self.clone();
        tokio::spawn(async move {
            while let Some((of, step)) = todo.recv().await {
                while d.turns_held.as_deref().is_some_and(Path::exists) {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                for at in d.designs_of_turn(&of).await {
                    d.agent_snapshot(&at, step).await;
                }
            }
        });
        // The agents in a turn: from working until done, idle (stopped) or
        // error; asking the user is still within it. One already at work or
        // asking as the watch starts, such as a question kept through a
        // restart, is in its turn, as is one first heard asking.
        let mut in_turn: std::collections::HashSet<_> = self
            .terminals
            .list()
            .into_iter()
            .filter(|t| turn_of(t).is_some() && matches!(t.agent_state, AgentState::Working | AgentState::Blocked))
            .map(|t| t.id)
            .collect();
        tokio::spawn(async move {
            loop {
                let message = match events.recv().await {
                    Ok(m) => m,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                };
                let Message::Event { name, data } = message else { continue };
                if name != m::EV_TERMINAL_UPDATED {
                    continue;
                }
                let Ok(t) = serde_json::from_value::<TerminalInfo>(data) else { continue };
                let Some(of) = turn_of(&t) else { continue };
                let step = match t.agent_state {
                    AgentState::Working if in_turn.insert(t.id) => AgentStep::Starts,
                    AgentState::Blocked => {
                        in_turn.insert(t.id);
                        continue;
                    }
                    AgentState::Done | AgentState::Idle | AgentState::Error if in_turn.remove(&t.id) => AgentStep::EndsTurn,
                    _ => continue,
                };
                if steps.send((of, step)).is_err() {
                    return;
                }
            }
        });
    }

    /// The designs a turn of an agent changes: a workspace design's agent's
    /// own design, or every session design of a session's agent's session.
    async fn designs_of_turn(&self, of: &TurnOf) -> Vec<DesignAt> {
        match of {
            TurnOf::Design { workspace, slug } => self.design.workspace_design(workspace, slug).into_iter().collect(),
            TurnOf::Session(session) => self.session_designs_at(session).await,
        }
    }

    /// The snapshot a step of a design's agent takes (X65), under the
    /// locks of the design's pages and history, so the edits by hand not
    /// kept yet are read and taken only under them: as it starts, they are
    /// kept on their own, those saved while it did not work, if there are
    /// any; as it ends a turn, everything since is kept, edits saved while
    /// it worked with it.
    async fn agent_snapshot(&self, at: &DesignAt, step: AgentStep) {
        let (pages, history) = (self.lock_of(at, DesignLock::Pages), self.lock_of(at, DesignLock::History));
        let _pages = pages.lock().await;
        let _history = history.lock().await;
        let take = match step {
            AgentStep::EndsTurn => {
                self.take_hand_edits(at);
                Take::AgentTurn
            }
            AgentStep::Starts => match self.take_hand_edits_before_turn(at) {
                Some(edits) => Take::EditsByHand(edits),
                None => return,
            },
        };
        self.snapshot(at, take).await;
    }

    /// Before a message reaches a design's agent that is not in a turn
    /// (X65), a workspace design's agent or a session's agent with session
    /// designs, its designs' edits by hand not kept yet are kept on their
    /// own: the agent can change the pages the moment it has the message,
    /// before the daemon hears that it works. One at work, or asking the
    /// user, is within its turn, its pages maybe half written: the edits go
    /// with that turn.
    async fn keep_before_message(&self, id: moonlet_proto::TerminalId) {
        use moonlet_proto::types::AgentState;
        let Some(info) = self.terminals.get(id).map(|t| t.info()) else { return };
        if matches!(info.agent_state, AgentState::Working | AgentState::Blocked) {
            return;
        }
        let Some(of) = turn_of(&info) else { return };
        for at in self.designs_of_turn(&of).await {
            self.agent_snapshot(&at, AgentStep::Starts).await;
        }
    }

    /// The session designs in a session's worktree (X65), found as the
    /// resolver finds them; none when they cannot be listed.
    async fn session_designs_at(&self, session: &str) -> Vec<DesignAt> {
        let Ok((s, folder)) = self.design_session(session) else { return Vec::new() };
        let (store, id) = (self.design.clone(), session.to_string());
        blocking(move || store.session_design_ats(&id, Path::new(&s.path), &folder)).await.unwrap_or_default()
    }

    /// The chat of a design system's sync agent, while it still is that system's.
    fn agent_of(&self, workspace: &str, slug: &str) -> Option<u32> {
        system_agent(&self.design, &self.terminals.list(), workspace, slug)
    }

    /// Stops a design system's sync agent, when it still is that system's.
    fn stop_sync_agent(&self, workspace: &str, slug: &str) {
        if let Some(id) = self.agent_of(workspace, slug) {
            let _ = self.terminals.kill(id, true);
        }
    }

    /// The sessions other members of the account own, from their records
    /// (X72), each with its owner and whether this host reaches it.
    fn member_sessions(&self) -> Vec<moonlet_proto::types::Session> {
        use moonlet_proto::types::{ProjectIdentity, Session, SessionOwner};
        let me = self.link.info().worker.id;
        let names = self.sessions.member_names();
        let projects = self.sessions.list_projects();
        self.sessions
            .session_records()
            .into_iter()
            .filter_map(|(id, r)| {
                let owner = r.get("owner")?.as_str()?.to_string();
                if owner == me || r.get("archived").and_then(Value::as_bool).unwrap_or(false) {
                    return None;
                }
                let text = |f: &str| r.get(f).and_then(Value::as_str).map(str::to_string);
                let identity: Option<ProjectIdentity> =
                    r.get("project").and_then(|v| serde_json::from_value(v.clone()).ok());
                let project_id = identity
                    .and_then(|i| {
                        projects
                            .iter()
                            .find(|p| moonlet_core::identity::same_project(&p.identity, &i))
                    })
                    .map(|p| p.id.clone())
                    .unwrap_or_default();
                let path = self.session_copies.copy_path(&id).unwrap_or_default();
                Some(Session {
                    id,
                    project_id,
                    name: text("name").unwrap_or_default(),
                    branch: text("branch").unwrap_or_default(),
                    base: String::new(),
                    path,
                    agent: None,
                    archived: false,
                    created_at: r.get("created_at").and_then(Value::as_u64).unwrap_or(0),
                    workspace_id: text("workspace"),
                    model: None,
                    effort: None,
                    mode: None,
                    pr: None,
                    spawned_by: None,
                    task: None,
                    task_unlinked: false,
                    cloud: false,
                    terminals: Vec::new(),
                    layout: Value::Null,
                    restore: Vec::new(),
                    owner: Some(SessionOwner {
                        name: names.get(&owner).cloned().unwrap_or_else(|| owner.clone()),
                        reachable: self.workers.conn(&owner).is_some(),
                        unreachable_since: self.workers.unreachable_since(&owner),
                        worker: owner,
                    }),
                })
            })
            .collect()
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
                // Done already: a board file left behind is pruned on the next read.
                if let Err(e) = self.forget_boards(&r.id) {
                    tracing::warn!("cannot remove the boards of workspace {}: {}", r.id, e.message);
                }
                ok(true)
            }
            m::WORKSPACE_MERGE => {
                let r: m::WorkspaceMerge = params(p)?;
                w.merge_workspace(&r.id, &r.into).map_err(internal)?;
                // Done already: a board file left behind is pruned on the next read.
                if let Err(e) = self.forget_boards(&r.id) {
                    tracing::warn!("cannot remove the boards of workspace {}: {}", r.id, e.message);
                }
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
                // Its sessions are gone: so are their designs' watches.
                self.prune_session_watches();
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
            m::SESSION_CREATE => {
                let mut req: m::SessionCreate = params(p)?;
                let Some(pick) = req.design.clone() else {
                    return ok(w.create_session(req).await.map_err(internal)?);
                };
                // Build it (X65): the workspace design, its pages and the
                // session's workspace checked before any worktree is made…
                let from = self.locate(&m::DesignRef::Workspace { workspace: pick.workspace.clone(), slug: pick.slug.clone() }).await?;
                match req.workspace_id.as_deref() {
                    None => req.workspace_id = Some(pick.workspace.clone()),
                    Some(ws) if ws == pick.workspace => {}
                    Some(_) => return Err(RpcError::new("invalid_params", "a session builds a design of its own workspace")),
                }
                if !self.workspace_projects(&pick.workspace).iter().any(|p| p.id == req.project_id) {
                    return Err(RpcError::new("invalid_params", "the project is not in the design's workspace"));
                }
                let (store, checked, pages) = (self.design.clone(), from.clone(), pick.pages.clone());
                blocking(move || store.has_pages(&checked, &pages)).await?;
                // …then copied into the worktree before its agent starts…
                let (store, copied) = (self.design.clone(), from.clone());
                let prepare = move |s: moonlet_proto::types::Session| async move {
                    let folder = moonlet_core::design::session::design_folder(&moonlet_core::session::read_config(Path::new(&s.path)))?;
                    blocking(move || store.copy_to_session(&copied, &pick.pages, &s.id, Path::new(&s.path), &folder, now_ms())).await?;
                    Ok(())
                };
                // …and recorded as built there once the session is saved,
                // before its terminals start: the design never names a session
                // that was not made, and names one whose agent then failed to
                // start. The session is made either way: what cannot be
                // recorded is logged.
                let store = self.design.clone();
                let saved = move |s: moonlet_proto::types::Session| async move {
                    if let Err(e) = blocking(move || store.record_build(&from, &s.id)).await {
                        tracing::warn!("cannot record a session in the design it builds: {}", e.message);
                    }
                };
                let made = w.create_session_prepared(req, prepare, saved).await;
                // The copy's own refusal as it said it; anything else failed.
                let made = made.map_err(|e| e.downcast::<RpcError>().unwrap_or_else(store_error))?;
                // Its design folder is there now: watch it.
                let _ = self.design_session(&made.id);
                ok(made)
            }
            m::SESSION_COPY => {
                let r: m::SessionCopyReq = params(p)?;
                ok(self.session_copies.copy_info(&r.session)?)
            }
            m::SESSION_LIST => {
                let r: m::SessionList = serde_json::from_value(p).unwrap_or_default();
                let mut list = w.list_sessions();
                if r.copies {
                    list.extend(self.member_sessions());
                }
                ok(list)
            }
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
                // Its designs are watched again once it is unarchived.
                self.prune_session_watches();
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
            m::TASKS_APP => ok(m::TasksApp { open: !self.apps.lock().unwrap().is_empty() }),
            m::TASKS_SNAPSHOT => {
                let r: m::TasksSnapshotQuery = params(p)?;
                self.prune_boards();
                ok(self.task_snapshots.get(r.workspace.as_deref()))
            }
            m::TASKS_SET_SNAPSHOT if !self.is_app(conn) => Err(RpcError::new("forbidden", "only the moonlet app shares boards")),
            m::TASKS_ANSWER if !self.is_app(conn) => Err(RpcError::new("forbidden", "only the moonlet app answers task requests")),
            // The app acts as the user on the tracker: only for a paired phone,
            // never a local client, whatever name it gives (X76).
            m::TASKS_REQUEST if !conn.phone.as_deref().is_some_and(|d| self.is_phone(d)) => {
                Err(RpcError::new("forbidden", "only a paired phone asks the app to change tasks"))
            }
            m::TASKS_SET_SNAPSHOT => {
                let r: m::TasksSetSnapshot = params(p)?;
                if !self.sessions.list_workspaces().iter().any(|ws| ws.id == r.workspace) {
                    return Err(RpcError::new("not_found", format!("no workspace {}", r.workspace)));
                }
                let snapshot = r.snapshot.clone();
                let workspace = r.workspace.clone();
                let store = self.task_snapshots.clone();
                // Up to 4 MB written and synced: off the async workers.
                tokio::task::spawn_blocking(move || store.set(&workspace, snapshot))
                    .await
                    .map_err(internal)?
                    .map_err(internal)?;
                // Deleted while it was written: its boards go after all.
                if !self.sessions.list_workspaces().iter().any(|ws| ws.id == r.workspace) {
                    self.forget_boards(&r.workspace)?;
                    return Err(RpcError::new("not_found", format!("no workspace {}", r.workspace)));
                }
                self.terminals.emit(Message::event(m::EV_TASKS_CHANGED, &r));
                ok(true)
            }
            m::TASKS_REQUEST => {
                let r: m::TasksRequest = params(p)?;
                // One app does it, the longest connected: two would create two issues.
                // Registered under the apps' lock, so the app leaving ends it (X76).
                let started = {
                    let apps = self.apps.lock().unwrap();
                    apps.iter().next().map(|(id, tx)| (*id, tx.clone(), self.task_relay.start(*id, r.workspace, r.action)))
                };
                let Some((app, tx, waiting)) = started else {
                    return Err(RpcError::new("failed", "Open moonlet on the Mac to change tasks."));
                };
                if !tx.send(moonlet_proto::Frame::Json(Message::event(m::EV_TASKS_REQUEST, &waiting.event))) {
                    self.task_relay.closed(app);
                }
                let result = self.task_relay.wait(waiting).await.map_err(|e| RpcError::new("failed", e.to_string()))?;
                ok(result)
            }
            m::TASKS_ANSWER => {
                let r: m::TasksAnswer = params(p)?;
                match self.task_relay.answer(conn.id, r) {
                    Ok(()) => {}
                    Err(moonlet_core::tasks::AnswerRefused::NotWaiting) => return Err(RpcError::new("failed", "already answered")),
                    Err(moonlet_core::tasks::AnswerRefused::NotYours) => return Err(RpcError::new("forbidden", "another app was asked")),
                }
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
