// TypeScript mirror of crates/jaunt-proto/src/types.rs and methods.rs.
// Keep in sync with the Rust definitions.

export type AgentState = "idle" | "working" | "blocked" | "done" | "error";
export type TerminalKind = "agent" | "shell" | "run" | "setup";

export interface ExitInfo {
  code: number | null;
  signal: number | null;
}

export interface TerminalInfo {
  id: number;
  kind: TerminalKind;
  title: string;
  cwd: string;
  command: string[];
  session_id?: string;
  agent?: string;
  agent_state: AgentState;
  agent_message?: string;
  cols: number;
  rows: number;
  pid: number | null;
  exit?: ExitInfo;
  reported_cwd?: string;
  /** At a shell prompt (OSC 133); undefined until the shell reports marks. */
  prompt?: boolean;
  alt_screen?: boolean;
  /** Structured agent (X6): render the chat view, not a terminal. */
  chat?: boolean;
  /** Shell keeps its own prompt; no Warp editor (T7). */
  classic?: boolean;
  created_at: number;
  last_output_at: number;
}

export type ChatKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error";
export type ToolStatus = "running" | "ok" | "error" | "denied";
export type ChatStatus = "idle" | "working" | "blocked" | "done" | "error";

export interface ToolCall {
  name: string;
  summary: string;
  input: unknown;
  output?: string | null;
  status: ToolStatus;
  diff?: string | null;
}

export interface ChatItem {
  id: string;
  kind: ChatKind;
  text: string;
  tool?: ToolCall | null;
  ts: number;
  partial?: boolean;
}

export interface PermissionAsk {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
  reason?: string | null;
  can_always: boolean;
  diff?: string | null;
}

export interface ChatState {
  items: ChatItem[];
  pending: PermissionAsk[];
  status: ChatStatus;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  turn_started_at?: number | null;
  agent_session?: string | null;
  slash_commands: string[];
  queued: string[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  base_branch: string;
}

export interface ProjectConfig {
  setup?: string | null;
  run?: string | null;
  archive?: string | null;
  default_agent?: string | null;
  base_branch?: string | null;
  agents: Record<string, string>;
}

/** `.jaunt/config.toml` as the Project settings dialog edits it (X8). */
export interface ProjectConfigFile {
  path: string;
  exists: boolean;
  version: string;
  config: ProjectConfig;
  error?: string | null;
  default_branch: string;
}

export interface Session {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  base: string;
  path: string;
  agent: string | null;
  archived: boolean;
  created_at: number;
  section?: string | null;
  model?: string | null;
  effort?: string | null;
  terminals: number[];
  layout: unknown;
}

/** A named set of projects shown as one sidebar block (X5). */
export interface Workspace {
  id: string;
  name: string;
  project_ids: string[];
  sections: Section[];
  view: WorkspaceView;
  created_at: number;
}

export interface Section {
  id: string;
  name: string;
}

export interface WorkspaceView {
  group_by: "project" | "status" | "none";
  sort_by: "recent" | "created" | "name";
  filter: string[];
}

export interface IssueRef {
  number: number;
  title: string;
  body: string;
  url: string;
  head_branch?: string | null;
}

export interface FileChange {
  path: string;
  old_path?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  against: string;
  /** Base that could not be resolved; the diff fell back to HEAD. */
  base_missing?: string;
  files: FileChange[];
  additions: number;
  deletions: number;
}

export interface FileVersions {
  original: string | null;
  modified: string | null;
  binary: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  time: number;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  ignored: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface PullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  checks: CheckRun[];
  review_decision: string | null;
}

export interface Attention {
  terminal: number;
  session_id: string | null;
  state: AgentState;
  title: string;
  message: string | null;
}

export interface HookStatus {
  claude_settings: string;
  claude_installed: boolean;
  claude_missing_events: string[];
  codex_config: string;
  codex_installed: boolean;
  codex_conflict: string | null;
}

export interface SearchHit {
  line: number;
  text: string;
}

export type HostStatus = "connecting" | "connected" | "reconnecting" | "needs_install" | "error";

export interface HostInfo {
  id: string;
  label: string;
  remote: boolean;
  status: HostStatus;
  message: string | null;
  daemon_version: string | null;
  hostname: string | null;
  home: string | null;
}

export interface FsChanged {
  root: string;
  paths: string[];
}

export const M = {
  terminalCreate: "terminal.create",
  terminalList: "terminal.list",
  terminalAttach: "terminal.attach",
  terminalDetach: "terminal.detach",
  terminalResize: "terminal.resize",
  terminalKill: "terminal.kill",
  terminalWrite: "terminal.write",
  terminalSearch: "terminal.search",
  terminalSetClassic: "terminal.set_classic",
  hooksStatus: "hooks.status",
  hooksInstall: "hooks.install",
  projectAdd: "project.add",
  projectList: "project.list",
  projectRemove: "project.remove",
  projectConfig: "project.config",
  projectConfigFile: "project.config_file",
  projectSetConfig: "project.set_config",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionArchive: "session.archive",
  sessionUnarchive: "session.unarchive",
  sessionUpdate: "session.update",
  sessionRun: "session.run",
  gitStatus: "git.status",
  gitFileVersions: "git.file_versions",
  gitDiff: "git.diff",
  gitStage: "git.stage",
  gitUnstage: "git.unstage",
  gitRevert: "git.revert",
  gitApplyPatch: "git.apply_patch",
  gitCommit: "git.commit",
  gitLog: "git.log",
  gitBranches: "git.branches",
  prCreate: "gh.pr_create",
  ghIssues: "gh.issues",
  shellHistory: "shell.history",
  ghPrs: "gh.prs",
  workspaceList: "workspace.list",
  workspaceCreate: "workspace.create",
  workspaceUpdate: "workspace.update",
  workspaceDelete: "workspace.delete",
  workspaceAddProject: "workspace.add_project",
  prStatus: "gh.pr_status",
  fsList: "fs.list",
  fsFiles: "fs.files",
  fsRead: "fs.read",
  fsWrite: "fs.write",
  fsWatch: "fs.watch",
  fsUnwatch: "fs.unwatch",
  chatState: "chat.state",
  chatSend: "chat.send",
  chatPermission: "chat.permission",
  chatInterrupt: "chat.interrupt",
  chatSettings: "chat.settings",
} as const;

export const EV = {
  terminalCreated: "terminal.created",
  terminalUpdated: "terminal.updated",
  terminalExited: "terminal.exited",
  terminalRemoved: "terminal.removed",
  terminalResync: "terminal.resync",
  attention: "agent.attention",
  projectsChanged: "projects.changed",
  sessionsChanged: "sessions.changed",
  workspacesChanged: "workspaces.changed",
  fsChanged: "fs.changed",
  chatItem: "chat.item",
  chatState: "chat.state",
} as const;
