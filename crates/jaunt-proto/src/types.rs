//! Domain types shared by the daemon and its clients. TypeScript mirrors
//! live in `apps/desktop/src/lib/protocol.ts`; keep both in sync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::SessionId;

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
pub enum SessionKind {
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
pub struct SessionInfo {
    pub id: SessionId,
    pub kind: SessionKind,
    pub title: String,
    pub cwd: String,
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
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
    pub created_at: u64,
    pub last_output_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub base_branch: String,
}

/// Per-repo settings, read from `<repo>/.jaunt/config.toml`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoConfig {
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

/// One task: a git worktree on its own branch, with its terminals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub base: String,
    pub path: String,
    pub agent: Option<String>,
    pub archived: bool,
    pub created_at: u64,
    #[serde(default)]
    pub sessions: Vec<SessionId>,
    /// Opaque UI layout (tabs, splits), owned by the client.
    #[serde(default)]
    pub layout: serde_json::Value,
    /// Commands to restart after a daemon restart (S4).
    #[serde(default)]
    pub restore: Vec<RestoreEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RestoreEntry {
    pub kind: SessionKind,
    pub title: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub agent: Option<String>,
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
    pub sessions: usize,
}
