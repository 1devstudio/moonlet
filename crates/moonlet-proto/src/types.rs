//! Domain types shared by the daemon and its clients. TypeScript mirrors
//! live in `apps/desktop/src/lib/protocol.ts`; keep both in sync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::TerminalId;

/// What the agent in a session is doing, as far as moonlet can tell.
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
    /// Exit code of the last command the shell ran (OSC 133 `D`, X31).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<i32>,
    /// A full-screen program (vim, htop, less) holds the alternate screen.
    #[serde(default)]
    pub alt_screen: bool,
    /// Structured agent (X6): no PTY, the UI shows the chat view.
    #[serde(default)]
    pub chat: bool,
    /// Shell shows its own prompt instead of the app's editor (T7).
    #[serde(default)]
    pub classic: bool,
    /// `node --version` of the `node` on the shell's PATH, reported by the
    /// prompt hook when that `node` changes (T8 context chips).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    /// Subagents of a chat terminal that are still running (X42).
    #[serde(default)]
    pub subagents: u32,
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

/// Per-repo settings, read from `<repo>/.moonlet/config.toml`.
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

/// A project's `.moonlet/config.toml` as the Project settings dialog sees it (X8).
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
    /// The workspace the session belongs to (X32). Only absent while a
    /// state file from before X32 is being migrated.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Last agent model and effort chosen for this session.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude permission mode chosen when the session was created (X7).
    #[serde(default)]
    pub mode: Option<String>,
    /// The session's pull request, kept by number because branch names get
    /// reused and an old PR may still head a branch of the same name.
    #[serde(default)]
    pub pr: Option<u64>,
    /// The session whose agent started this one (X22).
    #[serde(default)]
    pub spawned_by: Option<String>,
    /// The tracker issue this session works on, when linked by hand or
    /// started from it (X46). Links found from the branch name or the PR are
    /// worked out by the app and not stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskRef>,
    /// The user unlinked the session's task: the app no longer links it
    /// from its branch name or PR either (X46).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub task_unlinked: bool,
    #[serde(default, alias = "sessions")]
    pub terminals: Vec<TerminalId>,
    /// Opaque UI layout (tabs, splits), owned by the client.
    #[serde(default)]
    pub layout: serde_json::Value,
    /// Commands to restart after a daemon restart (S4).
    #[serde(default)]
    pub restore: Vec<RestoreEntry>,
}

/// A named, coloured scope with its own sections, sessions and (X33) Claude
/// profile. The sidebar shows one workspace at a time (X32).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub color: WorkspaceColor,
    /// The workspace's sections, in sidebar order.
    #[serde(default)]
    pub section_ids: Vec<String>,
    /// The Claude profile its sessions use (X33); `None` is the default
    /// profile, `~/.claude`.
    #[serde(default)]
    pub claude_profile: Option<String>,
    pub created_at: u64,
}

/// A Claude Code config folder, passed to Claude as `CLAUDE_CONFIG_DIR` (X33).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeProfile {
    pub id: String,
    pub name: String,
    /// Absolute path of the folder.
    pub path: String,
    pub created_at: u64,
}

/// Who a profile is signed in as, from `claude auth status --json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileAccount {
    pub logged_in: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
}

/// What `claude.version` returns: `None` when `claude` is missing or its
/// output is not a version (X36).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeVersion {
    pub version: Option<String>,
    /// A `claude.update` is running, perhaps started by another window.
    #[serde(default)]
    pub updating: bool,
}

/// What `claude.update` returns once `claude update` exits, also sent to
/// every client as `claude.update_done` (X36).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeUpdateResult {
    /// It exited with 0. Some failures, such as another Claude holding the
    /// update lock, exit with 0 too: the output tells.
    pub ok: bool,
    pub output: String,
}

/// A line of `claude update`'s output, sent while it runs (X36).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeUpdateLine {
    pub line: String,
}

/// A profile as `profile.list` returns it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileInfo {
    #[serde(flatten)]
    pub profile: ClaudeProfile,
    /// Last known account; `None` until `profile.status` has run.
    #[serde(default)]
    pub account: Option<ProfileAccount>,
    /// moonlet's hooks and skill are in the folder (A2).
    #[serde(default)]
    pub hooks_installed: bool,
}

/// The colours a workspace can have, as the design names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceColor {
    Clay,
    Blue,
    Violet,
    Sand,
    Grey,
}

/// A named set of projects shown as one block in the sidebar (X5's
/// workspace, renamed in X32).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub view: SectionView,
    pub created_at: u64,
}

/// Sidebar presentation of a section, persisted with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionView {
    /// `project` (default), `task` (X46), `status` or `none`.
    #[serde(default = "default_group")]
    pub group_by: String,
    /// `recent` (default), `created` or `name`.
    #[serde(default = "default_sort")]
    pub sort_by: String,
    /// Project ids to show; empty means all.
    #[serde(default)]
    pub filter: Vec<String>,
}

impl Default for SectionView {
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

/// A GitHub issue for Tasks mode (X44): a repository source's task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GhTask {
    /// `owner/repo`.
    pub repo: String,
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub url: String,
    pub closed: bool,
    /// `completed`, `not_planned`, `duplicate` or `reopened`; `None` when
    /// GitHub gives none.
    #[serde(default)]
    pub state_reason: Option<String>,
    /// Logins.
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub updated_ms: u64,
    /// Pull requests in the same repository that close the issue.
    #[serde(default)]
    pub closing_prs: Vec<u64>,
}

/// A linked git work tree of a project (X45).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    /// `None` when the work tree is on a detached HEAD.
    pub branch: Option<String>,
    pub last_commit_ms: u64,
}

/// A tracker issue a session is linked to (X46). `connection` is the app's
/// id for the tracker connection (X44); the daemon never talks to trackers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRef {
    pub connection: String,
    pub key: String,
    pub url: String,
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
    /// The Claude profile folder the agent ran in (X33); its conversation
    /// can only be continued there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
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
    /// A draft does not count as opened for Keep in step (X46).
    #[serde(default)]
    pub draft: bool,
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
    /// On the final assistant message of a completed turn (X16).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnTime>,
    /// On an `error` item: the agent's code for what went wrong, e.g.
    /// `authentication_failed` when its login is missing or expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

/// When a turn started and ended, in milliseconds since the epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnTime {
    pub started_at: u64,
    pub ended_at: u64,
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
    /// When the agent asked (ms), for "waiting 2m" (X40).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_at: Option<u64>,
    /// The task id of the subagent that asks; `None` for the main agent (X42).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// A subagent the main agent launched with its `Agent` tool (X42).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Subagent {
    /// Claude's task id.
    pub id: String,
    /// The `Agent` tool call that launched it.
    pub tool_use_id: String,
    pub description: String,
    /// The subagent type, e.g. `general-purpose`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The brief the main agent gave it.
    #[serde(default)]
    pub prompt: String,
    /// `running`, `done`, `failed` or `stopped`.
    pub status: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// How long it ran by Claude's count, once it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// What it does now, e.g. "Running pnpm test".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default)]
    pub tool_uses: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Its final message, once done or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Its latest tool calls, without their output.
    #[serde(default)]
    pub tools: Vec<SubagentTool>,
}

/// One tool call of a subagent (X42).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SubagentTool {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// `running`, `ok`, `error` or `denied`.
    pub status: String,
    /// Lines added and removed by an edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
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
    /// The agent's subagents, for the `+` menu (X29).
    #[serde(default)]
    pub agents: Vec<NamedItem>,
    /// Directories added with `chat.add_dir` (X29).
    #[serde(default)]
    pub add_dirs: Vec<String>,
    /// The agent's MCP servers; `None` until the agent has answered (X29).
    #[serde(default)]
    pub mcp_servers: Option<Vec<McpServer>>,
    /// Messages sent while a turn was running, delivered in order.
    #[serde(default)]
    pub queued: Vec<String>,
    /// How full the agent's context window is; `None` until it has said (X34).
    #[serde(default)]
    pub context: Option<ContextUsage>,
    /// Subagents the agent launched, oldest first (X42).
    #[serde(default)]
    pub subagents: Vec<Subagent>,
}

/// The agent's context window, from Claude's `get_context_usage` (X34).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ContextUsage {
    /// Tokens in the context now.
    pub used: u64,
    /// The window size.
    pub max: u64,
    /// Where the agent compacts on its own; `None` when auto-compact is off.
    #[serde(default)]
    pub auto_compact_at: Option<u64>,
    /// What fills the context, in the agent's order.
    #[serde(default)]
    pub categories: Vec<ContextCategory>,
}

/// One part of the context, such as `System prompt` or `Messages` (X34).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ContextCategory {
    pub name: String,
    pub tokens: u64,
}

/// One of the agent's MCP servers (X29).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `connected`, `needs-auth`, `authing`, `failed`, `pending` or `disabled`.
    pub status: String,
    /// `http`, `sse`, `stdio`, `ws`, `sdk` or `claude.ai`.
    pub transport: String,
    /// The URL, or the command and its arguments.
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// The sign-in page while the server is `authing`.
    #[serde(default)]
    pub auth_url: Option<String>,
}

/// An image sent with a message (X29), base64-encoded.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ChatImage {
    pub name: String,
    pub media_type: String,
    pub data: String,
}

/// A name with a one-line description, such as a subagent.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NamedItem {
    pub name: String,
    #[serde(default)]
    pub description: String,
}
