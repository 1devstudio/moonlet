//! Domain types shared by the daemon and its clients. TypeScript mirrors
//! live in `apps/desktop/src/lib/protocol.ts`; keep both in sync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::TerminalId;

/// What the agent in a session is doing, as far as jaunt can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    #[default]
    Idle,
    Working,
    Blocked,
    Done,
    Error,
}

/// Where an agent state came from. Higher-trust sources win over lower ones
/// for a short window, so a heuristic never overrides a fresh hook report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateSource {
    Heuristic,
    Terminal,
    Process,
    Hook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKind {
    Agent,
    #[default]
    Shell,
    Run,
    Setup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: TerminalId,
    pub kind: TerminalKind,
    pub title: String,
    pub cwd: String,
    pub command: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "workspace_id"
    )]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub agent_state: AgentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ExitInfo>,
    /// Working directory reported by the shell via OSC 7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_cwd: Option<String>,
    /// Shell is waiting at a prompt (OSC 133 `A`/`D` seen, no `C` since).
    /// `None` until the shell reports prompt marks at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<bool>,
    /// A full-screen program (vim, htop, less) holds the alternate screen.
    #[serde(default)]
    pub alt_screen: bool,
    /// Structured agent (X6): no PTY, the UI shows the chat view.
    #[serde(default)]
    pub chat: bool,
    /// Shell shows its own prompt instead of the app's editor (T7).
    #[serde(default)]
    pub classic: bool,
    pub created_at: u64,
    pub last_output_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub base_branch: String,
}

/// Per-repo settings, read from `<repo>/.jaunt/config.toml`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfig {
    #[serde(default)]
    pub setup: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub archive: Option<String>,
    #[serde(default)]
    pub default_agent: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Extra agents, name to shell command.
    #[serde(default)]
    pub agents: BTreeMap<String, String>,
}

/// A project's `.jaunt/config.toml` as the Project settings dialog sees it (X8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfigFile {
    pub path: String,
    pub exists: bool,
    /// Hash of the file's bytes, `""` when it does not exist.
    pub version: String,
    /// The default when `error` is set.
    pub config: ProjectConfig,
    /// Why the file could not be read; such a file is never overwritten.
    #[serde(default)]
    pub error: Option<String>,
    /// The repo's default branch, used when `base_branch` is not set.
    pub default_branch: String,
}

/// One task: a git worktree on its own branch, with its terminals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    #[serde(alias = "repo_id")]
    pub project_id: String,
    pub name: String,
    pub branch: String,
    pub base: String,
    pub path: String,
    pub agent: Option<String>,
    pub archived: bool,
    pub created_at: u64,
    /// Section (within a workspace) the user moved this session into.
    #[serde(default)]
    pub section: Option<String>,
    /// Last agent model and effort chosen for this session.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode chosen when the session was created (X7).
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default, alias = "sessions")]
    pub terminals: Vec<TerminalId>,
    /// Opaque UI layout (tabs, splits), owned by the client.
    #[serde(default)]
    pub layout: serde_json::Value,
    /// Commands to restart after a daemon restart (S4).
    #[serde(default)]
    pub restore: Vec<RestoreEntry>,
}

/// A named set of projects shown as one block in the sidebar (X5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub view: WorkspaceView,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub id: String,
    pub name: String,
}

/// Sidebar presentation of a workspace, persisted with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceView {
    /// `project` (default), `status` or `none`.
    #[serde(default = "default_group")]
    pub group_by: String,
    /// `recent` (default), `created` or `name`.
    #[serde(default = "default_sort")]
    pub sort_by: String,
    /// Project ids to show; empty means all.
    #[serde(default)]
    pub filter: Vec<String>,
}

impl Default for WorkspaceView {
    fn default() -> Self {
        Self {
            group_by: default_group(),
            sort_by: default_sort(),
            filter: Vec::new(),
        }
    }
}

fn default_group() -> String {
    "project".into()
}

fn default_sort() -> String {
    "recent".into()
}

/// An issue or pull request a session can start from (composer source picker).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IssueRef {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub url: String,
    /// Set for pull requests.
    #[serde(default)]
    pub head_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RestoreEntry {
    pub kind: TerminalKind,
    pub title: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub agent: Option<String>,
    /// Live terminal this entry describes; reassigned on restore.
    #[serde(default, alias = "session")]
    pub terminal: Option<TerminalId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// One of `added`, `modified`, `deleted`, `renamed`, `untracked`, `conflicted`.
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Ref the diff is computed against (merge-base with the workspace base, or HEAD).
    pub against: String,
    /// The requested base could not be resolved (typo, or not fetched), so
    /// the diff fell back to HEAD and committed work is not shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_missing: Option<String>,
    pub files: Vec<FileChange>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileVersions {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub time: u64,
}

/// A project's base branch against `origin` (spec X13).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseStatus {
    pub branch: String,
    /// `origin/<branch>`.
    pub upstream: String,
    /// Local commits that are not on the upstream.
    pub ahead: u32,
    /// Upstream commits that are not local.
    pub behind: u32,
    /// The incoming commits, newest first, at most 20.
    pub commits: Vec<Commit>,
    /// The work tree that has the branch checked out, if any.
    pub checkout: Option<String>,
    /// Why the fetch asked for failed; the counts then come from the refs
    /// already there.
    pub fetch_error: Option<String>,
}

/// What `git.pull_base` did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BasePull {
    pub pulled: u32,
    /// The branch's new head.
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub title: String,
    #[serde(default)]
    pub checks: Vec<CheckRun>,
    #[serde(default)]
    pub review_decision: Option<String>,
}

/// A GitHub stack of dependent pull requests (spec X11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrStack {
    pub number: u64,
    pub base: String,
    /// 1-based position of the asked-for PR; 1 is closest to `base`.
    pub position: u64,
    pub size: u64,
    /// Bottom of the stack first.
    pub prs: Vec<StackPr>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StackPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `open`, `merged` or `closed`, as in [`PullRequest::state`].
    pub state: String,
    pub draft: bool,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub version: String,
    pub protocol: u32,
    pub pid: u32,
    pub host: String,
    pub home: String,
    pub started_at: u64,
    #[serde(alias = "sessions")]
    pub terminals: usize,
}

// ------------------------------------------------------------ chat (X6)

/// One entry in a structured agent conversation. Streaming updates replace
/// the item with the same `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatItem {
    pub id: String,
    /// `user`, `assistant`, `thinking`, `tool`, `system` or `error`.
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolCall>,
    pub ts: u64,
    /// Still streaming.
    #[serde(default)]
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    /// One line for the collapsed row, e.g. the command or file path.
    pub summary: String,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// `running`, `ok`, `error` or `denied`.
    pub status: String,
    /// Unified diff for edits, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// The agent asks to use a tool and waits for the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionAsk {
    pub id: String,
    pub tool: String,
    pub summary: String,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// "Always allow" is meaningful for this request.
    #[serde(default)]
    pub can_always: bool,
    /// Preview of a file change, when the request is an edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatState {
    #[serde(default)]
    pub items: Vec<ChatItem>,
    #[serde(default)]
    pub pending: Vec<PermissionAsk>,
    /// `idle`, `working`, `blocked`, `done` or `error`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode (`auto`, `manual`, `acceptEdits`, `plan`, `bypassPermissions`); `None` means the agent default.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    /// When the running turn started (ms), for the elapsed timer.
    #[serde(default)]
    pub turn_started_at: Option<u64>,
    /// The agent's own conversation id (Claude session id, Codex thread id).
    #[serde(default)]
    pub agent_session: Option<String>,
    #[serde(default)]
    pub slash_commands: Vec<String>,
    /// Messages sent while a turn was running, delivered in order.
    #[serde(default)]
    pub queued: Vec<String>,
}
