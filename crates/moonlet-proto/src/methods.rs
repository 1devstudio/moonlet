//! RPC method names and their parameter shapes. Results are the types in
//! [`crate::types`] unless noted.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::TerminalId;
use crate::types::{AgentState, ProjectConfig, StateSource, TerminalKind};

// Daemon
pub const DAEMON_INFO: &str = "daemon.info";
pub const DAEMON_SHUTDOWN: &str = "daemon.shutdown";
/// Hands every PTY to a freshly started daemon binary, then exits (S3).
pub const DAEMON_UPGRADE: &str = "daemon.upgrade";

// Sessions
pub const TERMINAL_CREATE: &str = "terminal.create";
pub const TERMINAL_LIST: &str = "terminal.list";
pub const TERMINAL_ATTACH: &str = "terminal.attach";
pub const TERMINAL_DETACH: &str = "terminal.detach";
pub const TERMINAL_RESIZE: &str = "terminal.resize";
pub const TERMINAL_KILL: &str = "terminal.kill";
pub const TERMINAL_WRITE: &str = "terminal.write";
pub const TERMINAL_SEARCH: &str = "terminal.search";
pub const TERMINAL_SET_CLASSIC: &str = "terminal.set_classic";
/// An agent reads a terminal of its own session, once the user allows (X31).
pub const TERMINAL_READ: &str = "terminal.read";
/// The terminals `terminal.read` may read for a caller: `TerminalRef`
/// of the caller, returns `[TerminalInfo]`.
pub const TERMINAL_READ_LIST: &str = "terminal.read_list";
pub const TERMINAL_READ_ANSWER: &str = "terminal.read_answer";
pub const TERMINAL_READ_REQUESTS: &str = "terminal.read_requests";
pub const TERMINAL_READ_GRANTS: &str = "terminal.read_grants";
pub const TERMINAL_READ_GRANT_CLEAR: &str = "terminal.read_grant_clear";

// Agents
pub const AGENT_REPORT: &str = "agent.report";

pub const HOOKS_STATUS: &str = "hooks.status";
pub const HOOKS_INSTALL: &str = "hooks.install";
pub const HOOKS_UNINSTALL: &str = "hooks.uninstall";

// Repos and workspaces
pub const PROJECT_ADD: &str = "project.add";
pub const PROJECT_LIST: &str = "project.list";
pub const PROJECT_REMOVE: &str = "project.remove";
pub const PROJECT_CONFIG: &str = "project.config";
pub const PROJECT_CONFIG_FILE: &str = "project.config_file";
pub const PROJECT_SET_CONFIG: &str = "project.set_config";
pub const WORKSPACE_CREATE: &str = "workspace.create";
pub const WORKSPACE_LIST: &str = "workspace.list";
pub const WORKSPACE_UPDATE: &str = "workspace.update";
pub const WORKSPACE_DELETE: &str = "workspace.delete";
pub const PROFILE_LIST: &str = "profile.list";
pub const PROFILE_CREATE: &str = "profile.create";
pub const PROFILE_UPDATE: &str = "profile.update";
pub const PROFILE_DELETE: &str = "profile.delete";
pub const PROFILE_STATUS: &str = "profile.status";
pub const SECTION_CREATE: &str = "section.create";
pub const SECTION_LIST: &str = "section.list";
pub const SECTION_UPDATE: &str = "section.update";
pub const SECTION_DELETE: &str = "section.delete";
pub const SECTION_ADD_PROJECT: &str = "section.add_project";
pub const SECTION_REMOVE_PROJECT: &str = "section.remove_project";
pub const SECTION_MOVE: &str = "section.move";
pub const SESSION_CREATE: &str = "session.create";
pub const SESSION_LIST: &str = "session.list";
pub const SESSION_ARCHIVE: &str = "session.archive";
pub const SESSION_UNARCHIVE: &str = "session.unarchive";
pub const SESSION_UPDATE: &str = "session.update";
pub const SESSION_RUN: &str = "session.run";

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
pub const GIT_BASE_STATUS: &str = "git.base_status";
pub const GIT_PULL_BASE: &str = "git.pull_base";
pub const GIT_ORIGIN_URL: &str = "git.origin_url";
pub const GH_PR_CREATE: &str = "gh.pr_create";
pub const GH_ISSUES: &str = "gh.issues";
pub const SHELL_HISTORY: &str = "shell.history";
pub const SHELL_COMMANDS: &str = "shell.commands";
pub const CHAT_STATE: &str = "chat.state";
pub const CHAT_SEND: &str = "chat.send";
pub const CHAT_PERMISSION: &str = "chat.permission";
pub const CHAT_INTERRUPT: &str = "chat.interrupt";
pub const CHAT_SETTINGS: &str = "chat.settings";
pub const CHAT_ADD_DIR: &str = "chat.add_dir";
pub const CHAT_MCP: &str = "chat.mcp";
pub const EV_CHAT_ITEM: &str = "chat.item";
pub const EV_CHAT_STATE: &str = "chat.state";
pub const GH_PRS: &str = "gh.prs";
pub const GH_PR_STATUS: &str = "gh.pr_status";
pub const GH_PR_STACK: &str = "gh.pr_stack";

// Files
pub const FS_LIST: &str = "fs.list";
pub const FS_FILES: &str = "fs.files";
pub const FS_READ: &str = "fs.read";
pub const FS_WRITE: &str = "fs.write";
pub const FS_WATCH: &str = "fs.watch";
pub const FS_UNWATCH: &str = "fs.unwatch";

// Events
pub const EV_TERMINAL_CREATED: &str = "terminal.created";
pub const EV_TERMINAL_UPDATED: &str = "terminal.updated";
pub const EV_TERMINAL_EXITED: &str = "terminal.exited";
pub const EV_TERMINAL_REMOVED: &str = "terminal.removed";
/// A [`ReadRequest`] waits for the user (X31).
pub const EV_TERMINAL_READ_REQUEST: &str = "terminal.read_request";
/// A read request was answered, withdrawn or timed out: [`ReadDone`].
pub const EV_TERMINAL_READ_DONE: &str = "terminal.read_done";
/// A session's standing permission to read changed: [`ReadGrant`].
pub const EV_TERMINAL_READ_GRANT: &str = "terminal.read_grant";
/// Sent to one client whose output queue overflowed: it was detached from
/// the terminal and must attach again for a fresh snapshot.
pub const EV_TERMINAL_RESYNC: &str = "terminal.resync";
pub const EV_AGENT_ATTENTION: &str = "agent.attention";
pub const EV_PROJECTS_CHANGED: &str = "projects.changed";
pub const EV_SESSIONS_CHANGED: &str = "sessions.changed";
pub const EV_WORKSPACES_CHANGED: &str = "workspaces.changed";
pub const EV_SECTIONS_CHANGED: &str = "sections.changed";
pub const EV_PROFILES_CHANGED: &str = "profiles.changed";
pub const EV_FS_CHANGED: &str = "fs.changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCreate {
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
    pub kind: TerminalKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, alias = "workspace_id")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    /// Run `agent` headless with the structured view (X6) instead of its TUI.
    #[serde(default)]
    pub chat: bool,
    /// Start a shell with its own prompt instead of Blocks mode (T7).
    #[serde(default)]
    pub classic: bool,
    /// Model and effort for a structured agent.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode (X7).
    #[serde(default)]
    pub mode: Option<String>,
    /// Extra directories a structured agent may work in (X29).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_dirs: Vec<String>,
}

impl Default for TerminalCreate {
    fn default() -> Self {
        Self {
            cwd: String::new(),
            command: Vec::new(),
            env: BTreeMap::new(),
            cols: default_cols(),
            rows: default_rows(),
            kind: TerminalKind::default(),
            title: None,
            session_id: None,
            agent: None,
            chat: false,
            classic: false,
            model: None,
            effort: None,
            mode: None,
            add_dirs: Vec::new(),
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
pub struct TerminalRef {
    pub id: TerminalId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalAttach {
    pub id: TerminalId,
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
    pub info: crate::types::TerminalInfo,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResize {
    pub id: TerminalId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalKill {
    pub id: TerminalId,
    /// When true the session record is removed after the process exits.
    #[serde(default)]
    pub remove: bool,
}

/// Text input over JSON, for scripts and the CLI (`moonlet pane run`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalWrite {
    pub id: TerminalId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSearch {
    pub id: TerminalId,
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

/// `terminal.read` (X31). `caller` is the reading terminal; the daemon
/// takes its session from it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRead {
    pub caller: TerminalId,
    pub id: TerminalId,
    #[serde(default)]
    pub lines: Option<usize>,
}

/// What `terminal.read` returns: the text the user allowed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadResult {
    pub terminal: TerminalId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub running: bool,
    /// Earlier output was left out.
    pub truncated: bool,
    /// Lines of output in `text`, without the `$ <command>` line or a note
    /// about omitted lines.
    #[serde(default)]
    pub lines: usize,
    pub text: String,
}

/// A read waiting for the user's answer; the `text` is exactly what the
/// agent gets on Allow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadRequest {
    pub request_id: u64,
    pub session_id: String,
    pub caller: TerminalId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub terminal_id: TerminalId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub lines: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadAnswer {
    pub request_id: u64,
    pub allow: bool,
    /// Allow every later read in the session without asking.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadDone {
    pub request_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadGrantClear {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadGrant {
    pub session_id: String,
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReport {
    pub terminal: TerminalId,
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
    pub terminal: TerminalId,
    #[serde(alias = "workspace_id")]
    pub session_id: Option<String>,
    pub state: AgentState,
    pub title: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectAdd {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdRef {
    pub id: String,
}

/// Writes a project's `.moonlet/config.toml` (X8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSetConfig {
    pub id: String,
    /// The `version` from `project.config_file`; a mismatch means the file
    /// changed on disk since, and nothing is written.
    pub version: String,
    pub config: ProjectConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreate {
    pub project_id: String,
    /// Display name; derived from the prompt's first line when absent.
    #[serde(default)]
    pub name: Option<String>,
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
    /// Model alias for the agent (e.g. `sonnet`, `opus`).
    #[serde(default)]
    pub model: Option<String>,
    /// Effort level (`low` … `max`).
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode (X7).
    #[serde(default)]
    pub mode: Option<String>,
    /// Start from this pull request's branch.
    #[serde(default)]
    pub pr: Option<u64>,
    /// Run the agent in its own terminal UI instead of the structured view
    /// (Claude Code and Codex default to the structured view, X6).
    #[serde(default)]
    pub tui: bool,
    /// The terminal of the agent asking for this session (X22). The new
    /// session records that terminal's session as its parent and starts in a
    /// permission mode no more permissive than the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<TerminalId>,
    /// Extra directories the agent may work in from the start (X29).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_dirs: Vec<String>,
    /// The workspace to create the session in (X32). Absent: the spawning
    /// agent's workspace, else the first workspace holding the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

impl SessionCreate {
    /// A request for `project_id` with every option at its default.
    pub fn new(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            name: None,
            branch: None,
            from: None,
            existing_branch: false,
            agent: None,
            prompt: None,
            model: None,
            effort: None,
            mode: None,
            pr: None,
            tui: false,
            spawned_by: None,
            add_dirs: Vec::new(),
            workspace_id: None,
            cols: default_cols(),
            rows: default_rows(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchive {
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
pub struct SessionUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCreate {
    pub name: String,
    pub color: crate::types::WorkspaceColor,
    /// Sections to move into the new workspace from the ones they are in.
    #[serde(default)]
    pub move_sections: Vec<String>,
    /// The Claude profile its sessions use (X33); absent for the default.
    #[serde(default)]
    pub claude_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<crate::types::WorkspaceColor>,
    /// The workspace's sections in their new order. It must keep the
    /// workspace's own; sections of other workspaces listed here move in.
    #[serde(default)]
    pub section_ids: Option<Vec<String>>,
    /// Absent: unchanged; `null`: the default profile; else a profile id (X33).
    #[serde(default, deserialize_with = "present")]
    pub claude_profile: Option<Option<String>>,
}

/// Tells a field sent as `null` (`Some(None)`) from one left out (`None`).
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCreate {
    pub name: String,
    /// An existing or new folder; `~/.claude-<name>` when absent.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// `id` absent: the default profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStatus {
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCreate {
    pub workspace_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub project_ids: Option<Vec<String>>,
    #[serde(default)]
    pub view: Option<crate::types::SectionView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionAddProject {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionRemoveProject {
    pub id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionMove {
    pub id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRun {
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

/// `git.base_status` and `git.pull_base` (spec X13).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBase {
    pub path: String,
    pub branch: String,
    /// `git.base_status` only: fetch `origin/<branch>` first.
    #[serde(default)]
    pub fetch: bool,
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
pub struct PrStackParams {
    pub path: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsList {
    pub path: String,
    #[serde(default)]
    pub show_ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsFiles {
    pub root: String,
    #[serde(default = "default_file_limit")]
    pub limit: usize,
}

fn default_file_limit() -> usize {
    20_000
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellHistory {
    /// `zsh`, `bash` or `fish`; the login shell when absent.
    #[serde(default)]
    pub shell: Option<String>,
}

/// `shell.commands`: names the input editor colours as known commands (T8).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellCommands {
    /// `zsh`, `bash` or `fish`; the login shell when absent.
    #[serde(default)]
    pub shell: Option<String>,
    /// A shell terminal whose own PATH (as its prompt hook reported it) to
    /// use instead of the login shell's.
    #[serde(default)]
    pub terminal: Option<TerminalId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSetClassic {
    pub id: TerminalId,
    pub classic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSend {
    pub id: TerminalId,
    pub text: String,
    /// Images sent with the message (X29).
    #[serde(default)]
    pub images: Vec<crate::types::ChatImage>,
}

/// Acts on a chat's MCP servers (X29): `refresh`, `reconnect`, `auth` or
/// `cancel`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMcp {
    pub id: TerminalId,
    pub action: String,
    #[serde(default)]
    pub server: Option<String>,
}

/// A directory the agent may work in from the next message on (X29).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAddDir {
    pub id: TerminalId,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPermission {
    pub id: TerminalId,
    pub ask: String,
    /// `allow`, `always` or `deny`.
    pub decision: String,
    #[serde(default)]
    pub message: Option<String>,
    /// Answers to Claude's `AskUserQuestion` (question text → answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<BTreeMap<String, String>>,
    /// Permission mode an approved plan switches to: `auto` or `acceptEdits` (X20, X24).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSettings {
    pub id: TerminalId,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode, see `ChatState::mode`.
    #[serde(default)]
    pub mode: Option<String>,
}

/// `chat.item` event payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatItemEvent {
    pub id: TerminalId,
    pub item: crate::types::ChatItem,
}

/// `chat.state` event payload: everything except the items.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStateEvent {
    pub id: TerminalId,
    pub state: crate::types::ChatState,
}
