//! RPC method names and their parameter shapes. Results are the types in
//! [`crate::types`] unless noted.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::SessionId;
use crate::types::{AgentState, SessionKind, StateSource};

// Daemon
pub const DAEMON_INFO: &str = "daemon.info";
pub const DAEMON_SHUTDOWN: &str = "daemon.shutdown";
/// Hands every PTY to a freshly started daemon binary, then exits (S3).
pub const DAEMON_UPGRADE: &str = "daemon.upgrade";

// Sessions
pub const SESSION_CREATE: &str = "session.create";
pub const SESSION_LIST: &str = "session.list";
pub const SESSION_ATTACH: &str = "session.attach";
pub const SESSION_DETACH: &str = "session.detach";
pub const SESSION_RESIZE: &str = "session.resize";
pub const SESSION_KILL: &str = "session.kill";
pub const SESSION_WRITE: &str = "session.write";
pub const SESSION_SEARCH: &str = "session.search";

// Agents
pub const AGENT_REPORT: &str = "agent.report";

pub const HOOKS_STATUS: &str = "hooks.status";
pub const HOOKS_INSTALL: &str = "hooks.install";
pub const HOOKS_UNINSTALL: &str = "hooks.uninstall";

// Repos and workspaces
pub const REPO_ADD: &str = "repo.add";
pub const REPO_LIST: &str = "repo.list";
pub const REPO_REMOVE: &str = "repo.remove";
pub const REPO_CONFIG: &str = "repo.config";
pub const WORKSPACE_CREATE: &str = "workspace.create";
pub const WORKSPACE_LIST: &str = "workspace.list";
pub const WORKSPACE_ARCHIVE: &str = "workspace.archive";
pub const WORKSPACE_UPDATE: &str = "workspace.update";
pub const WORKSPACE_RUN: &str = "workspace.run";

// Git
pub const GIT_STATUS: &str = "git.status";
pub const GIT_FILE_VERSIONS: &str = "git.file_versions";
pub const GIT_DIFF: &str = "git.diff";
pub const GIT_STAGE: &str = "git.stage";
pub const GIT_UNSTAGE: &str = "git.unstage";
pub const GIT_REVERT: &str = "git.revert";
pub const GIT_APPLY_PATCH: &str = "git.apply_patch";
pub const GIT_COMMIT: &str = "git.commit";
pub const GIT_LOG: &str = "git.log";
pub const GIT_BRANCHES: &str = "git.branches";
pub const GH_PR_CREATE: &str = "gh.pr_create";
pub const GH_PR_STATUS: &str = "gh.pr_status";

// Files
pub const FS_LIST: &str = "fs.list";
pub const FS_READ: &str = "fs.read";
pub const FS_WRITE: &str = "fs.write";
pub const FS_WATCH: &str = "fs.watch";
pub const FS_UNWATCH: &str = "fs.unwatch";

// Events
pub const EV_SESSION_CREATED: &str = "session.created";
pub const EV_SESSION_UPDATED: &str = "session.updated";
pub const EV_SESSION_EXITED: &str = "session.exited";
pub const EV_SESSION_REMOVED: &str = "session.removed";
pub const EV_AGENT_ATTENTION: &str = "agent.attention";
pub const EV_REPOS_CHANGED: &str = "repos.changed";
pub const EV_WORKSPACES_CHANGED: &str = "workspaces.changed";
pub const EV_FS_CHANGED: &str = "fs.changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreate {
    pub cwd: String,
    /// argv; empty means the user's login shell.
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub kind: SessionKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
}

impl Default for SessionCreate {
    fn default() -> Self {
        Self {
            cwd: String::new(),
            command: Vec::new(),
            env: BTreeMap::new(),
            cols: default_cols(),
            rows: default_rows(),
            kind: SessionKind::default(),
            title: None,
            workspace_id: None,
            agent: None,
        }
    }
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRef {
    pub id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionAttach {
    pub id: SessionId,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// Reply to `session.attach`. `snapshot` is an escape-sequence stream that
/// redraws scrollback, screen, cursor and modes on a freshly reset terminal.
/// Live output frames for the session follow the response on the same
/// connection, with nothing lost or duplicated in between.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachResult {
    pub info: crate::types::SessionInfo,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResize {
    pub id: SessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKill {
    pub id: SessionId,
    /// When true the session record is removed after the process exits.
    #[serde(default)]
    pub remove: bool,
}

/// Text input over JSON, for scripts and the CLI (`jaunt pane run`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionWrite {
    pub id: SessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSearch {
    pub id: SessionId,
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Line index counted from the oldest scrollback line.
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReport {
    pub session: SessionId,
    pub state: AgentState,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default = "default_source")]
    pub source: StateSource,
    #[serde(default)]
    pub agent: Option<String>,
}

fn default_source() -> StateSource {
    StateSource::Hook
}

/// Emitted when a session needs the user (blocked, done or error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attention {
    pub session: SessionId,
    pub workspace_id: Option<String>,
    pub state: AgentState,
    pub title: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoAdd {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdRef {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCreate {
    pub repo_id: String,
    pub name: String,
    /// New branch name; derived from `name` when absent.
    #[serde(default)]
    pub branch: Option<String>,
    /// Start point: a branch, tag or commit. Defaults to the repo base branch.
    #[serde(default)]
    pub from: Option<String>,
    /// Use an existing branch instead of creating one.
    #[serde(default)]
    pub existing_branch: bool,
    #[serde(default)]
    pub agent: Option<String>,
    /// First prompt passed to the agent.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceArchive {
    pub id: String,
    /// Remove the worktree directory (branch is kept).
    #[serde(default = "yes")]
    pub remove_worktree: bool,
    #[serde(default)]
    pub delete_branch: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRun {
    pub id: String,
    /// `run`, `setup` or `archive`.
    pub script: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitPath {
    /// Any directory inside the work tree.
    pub path: String,
    /// Diff base: a ref, or absent for HEAD.
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFile {
    pub path: String,
    pub file: String,
    #[serde(default)]
    pub base: Option<String>,
    /// For `git.diff`: index vs HEAD instead of working tree vs base.
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFiles {
    pub path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitApplyPatch {
    pub path: String,
    pub patch: String,
    /// Apply to the index (stage) instead of the work tree.
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommit {
    pub path: String,
    pub message: String,
    /// Stage every change first (`git add -A`).
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrCreate {
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsList {
    pub path: String,
    #[serde(default)]
    pub show_ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsRead {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsWrite {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsPath {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChanged {
    pub root: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksInstall {
    #[serde(default = "yes")]
    pub claude: bool,
    #[serde(default = "yes")]
    pub codex: bool,
}
