// TypeScript mirror of crates/moonlet-proto/src/types.rs and methods.rs.
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
  /** `node --version` on the shell's PATH (T8 chips). */
  node_version?: string;
  /** At a shell prompt (OSC 133); undefined until the shell reports marks. */
  prompt?: boolean;
  alt_screen?: boolean;
  /** Structured agent (X6): render the chat view, not a terminal. */
  chat?: boolean;
  /** Shell keeps its own prompt; no Blocks-mode editor (T7). */
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
  /** On the final assistant message of a completed turn (X16). */
  turn?: TurnTime | null;
}

/** When a turn started and ended, in ms since the epoch. */
export interface TurnTime {
  started_at: number;
  ended_at: number;
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
  /** The agent's subagents (X29). */
  agents?: NamedItem[];
  /** Directories added with `chat.add_dir` (X29). */
  add_dirs?: string[];
  /** The agent's MCP servers; null until the agent has answered (X29). */
  mcp_servers?: McpServer[] | null;
  queued: string[];
  /** How full the agent's context window is; null until it has said (X34). */
  context?: ContextUsage | null;
}

/** The agent's context window, from Claude's `get_context_usage` (X34). */
export interface ContextUsage {
  used: number;
  max: number;
  /** Where the agent compacts on its own; null when auto-compact is off. */
  auto_compact_at?: number | null;
  categories: { name: string; tokens: number }[];
}

export interface McpServer {
  name: string;
  status: "connected" | "needs-auth" | "authing" | "failed" | "pending" | "disabled" | string;
  transport: string;
  endpoint?: string | null;
  scope?: string | null;
  error?: string | null;
  tools: string[];
  auth_url?: string | null;
}

export interface NamedItem {
  name: string;
  description: string;
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

/** `.moonlet/config.toml` as the Project settings dialog edits it (X8). */
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
  /** The workspace the session belongs to (X32). */
  workspace_id?: string | null;
  model?: string | null;
  effort?: string | null;
  /** The session whose agent started this one (X22). */
  spawned_by?: string | null;
  terminals: number[];
  layout: unknown;
}

/** A named, coloured scope with its own sections and sessions (X32). */
export interface Workspace {
  id: string;
  name: string;
  color: WorkspaceColor;
  /** Its sections, in sidebar order. */
  section_ids: string[];
  /** The Claude profile its sessions use (X33); null for the default. */
  claude_profile?: string | null;
  created_at: number;
}

/** A Claude Code config folder (X33). */
export interface ClaudeProfile {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

/** Who a profile is signed in as (`claude auth status`). */
export interface ProfileAccount {
  logged_in: boolean;
  email: string | null;
  org_name: string | null;
}

export interface ProfileInfo extends ClaudeProfile {
  /** Unknown until `profile.status` has run. */
  account: ProfileAccount | null;
  hooks_installed: boolean;
}

export type WorkspaceColor = "clay" | "blue" | "violet" | "sand" | "grey";

/** A named set of projects shown as one sidebar block (X5's workspace, X32). */
export interface Section {
  id: string;
  name: string;
  project_ids: string[];
  view: SectionView;
  created_at: number;
}

export interface SectionView {
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

/** The project's base branch against `origin` (spec X13). */
export interface BaseStatus {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  /** Incoming commits, newest first, at most 20. */
  commits: Commit[];
  /** The work tree that has the branch checked out. */
  checkout: string | null;
  fetch_error: string | null;
}

export interface BasePull {
  pulled: number;
  head: string;
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

/** A GitHub stack of dependent PRs (spec X11); `prs` is bottom first. */
export interface PrStack {
  number: number;
  base: string;
  position: number;
  size: number;
  prs: StackPr[];
}

export interface StackPr {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  branch: string;
}

export interface Attention {
  terminal: number;
  session_id: string | null;
  state: AgentState;
  title: string;
  message: string | null;
}

/** An agent asks to read a terminal of its session (X31). `text` is
 * exactly what it gets on Allow. */
export interface ReadRequest {
  request_id: number;
  session_id: string;
  caller: number;
  agent?: string;
  terminal_id: number;
  title: string;
  command?: string;
  exit?: number;
  lines: number;
  text: string;
}

export interface HookStatus {
  claude_settings: string;
  claude_installed: boolean;
  claude_missing_events: string[];
  codex_config: string;
  codex_installed: boolean;
  codex_conflict: string | null;
  /** The `moonlet` skill is in place (X22); `*_installed` include it. */
  claude_skill?: boolean;
  codex_skill?: boolean;
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
  gitBaseStatus: "git.base_status",
  gitPullBase: "git.pull_base",
  gitOriginUrl: "git.origin_url",
  prCreate: "gh.pr_create",
  ghIssues: "gh.issues",
  shellHistory: "shell.history",
  shellCommands: "shell.commands",
  ghPrs: "gh.prs",
  workspaceList: "workspace.list",
  workspaceCreate: "workspace.create",
  workspaceUpdate: "workspace.update",
  workspaceDelete: "workspace.delete",
  profileList: "profile.list",
  profileCreate: "profile.create",
  profileUpdate: "profile.update",
  profileDelete: "profile.delete",
  profileStatus: "profile.status",
  claudeVersion: "claude.version",
  claudeUpdate: "claude.update",
  sectionList: "section.list",
  sectionCreate: "section.create",
  sectionUpdate: "section.update",
  sectionDelete: "section.delete",
  sectionMove: "section.move",
  sectionAddProject: "section.add_project",
  sectionRemoveProject: "section.remove_project",
  prStatus: "gh.pr_status",
  prStack: "gh.pr_stack",
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
  chatAddDir: "chat.add_dir",
  chatMcp: "chat.mcp",
  terminalReadAnswer: "terminal.read_answer",
  terminalReadRequests: "terminal.read_requests",
  terminalReadGrants: "terminal.read_grants",
  terminalReadGrantClear: "terminal.read_grant_clear",
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
  sectionsChanged: "sections.changed",
  profilesChanged: "profiles.changed",
  claudeUpdateOutput: "claude.update_output",
  claudeUpdateDone: "claude.update_done",
  fsChanged: "fs.changed",
  chatItem: "chat.item",
  chatState: "chat.state",
  terminalReadRequest: "terminal.read_request",
  terminalReadDone: "terminal.read_done",
  terminalReadGrant: "terminal.read_grant",
} as const;
