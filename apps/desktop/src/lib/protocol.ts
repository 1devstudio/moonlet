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
  /** A design system's sync agent (X64) or a design's agent (X65). */
  design?: DesignTag;
  /** Running subagents of a chat terminal (X42). */
  subagents?: number;
  created_at: number;
  last_output_at: number;
}

/** What a Design mode agent works on (X64, X65): a design system's sync
 * agent, or a workspace design's agent. */
export interface DesignAgent {
  kind: "sync" | "design";
  workspace: string;
  /** The design system's or the design's slug. */
  slug: string;
  /** For `Design · <name>`. */
  name: string;
}

/** A terminal's design tag. `true` comes from a daemon before X65 entry 7a,
 * which marked only sync agents. */
export type DesignTag = DesignAgent | boolean;

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
  /** On an `error` item: the agent's code for the cause, e.g. `authentication_failed`. */
  cause?: string | null;
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
  /** When the agent asked, ms (X40). */
  asked_at?: number | null;
  /** The task id of the subagent that asks; absent for the main agent (X42). */
  agent?: string | null;
}

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** A subagent the main agent launched with its `Agent` tool (X42). */
export interface Subagent {
  /** Claude's task id. */
  id: string;
  /** The `Agent` tool call that launched it. */
  tool_use_id: string;
  description: string;
  /** The subagent type, e.g. `general-purpose`. */
  kind?: string | null;
  /** The brief the main agent gave it. */
  prompt: string;
  status: SubagentStatus;
  started_at: number;
  ended_at?: number | null;
  /** How long it ran by Claude's count, once it ended. */
  duration_ms?: number | null;
  /** What it does now, e.g. "Running pnpm test". */
  activity?: string | null;
  tokens: number;
  tool_uses: number;
  model?: string | null;
  /** Its final message, once done. */
  report?: string | null;
  error?: string | null;
  /** Its latest tool calls, without their output. */
  tools: SubagentTool[];
}

/** One tool call of a subagent (X42). */
export interface SubagentTool {
  id: string;
  name: string;
  summary: string;
  status: ToolStatus;
  /** Lines added and removed by an edit. */
  added?: number | null;
  removed?: number | null;
}

/** A side question's answer from `chat.aside` (X49). */
export interface AsideAnswer {
  text: string;
  cost_usd: number;
  duration_ms: number;
}

/** A message waiting in the agent's queue (X49). */
export interface QueuedMessage {
  /** The uuid the message was sent to the agent with. */
  id: string;
  text: string;
  /** Send now was asked for it, and the agent has not read it yet. */
  sending?: boolean;
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
  /** Messages sent during a turn that the agent has not read yet, oldest first (X49). */
  queued: QueuedMessage[];
  /** How full the agent's context window is; null until it has said (X34). */
  context?: ContextUsage | null;
  /** Subagents the agent launched, oldest first (X42). */
  subagents?: Subagent[];
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
  /** Absent from daemons older than X41. */
  identity?: ProjectIdentity;
}

/** The same repository on any machine (X41): normalized origin and root commit. */
export interface ProjectIdentity {
  origin: string | null;
  root: string | null;
}

/** gh on a host (X59). */
export interface GhStatus {
  installed: boolean;
  login: string | null;
}

/** A repository's details for the Add project card (X59); found through git, only `repo` and `default_branch`. */
export interface RepoInfo {
  repo: string;
  private: boolean | null;
  description: string | null;
  default_branch: string | null;
  pushed_at: string | null;
  /** gh's `diskUsage`, in KB. */
  disk_kb: number | null;
}

/** One of the user's repositories (X59). */
export interface RepoSummary {
  repo: string;
  description: string | null;
  private: boolean;
  pushed_at: string | null;
  /** A project on the host already has it as `origin`. */
  added: boolean;
}

/** The folder a clone would go to (X59). */
export interface CloneTarget {
  path: string;
  exists: boolean;
  same_repo: boolean;
  branch: string | null;
  free_name: string;
}

export interface CloneJob {
  id: string;
  repo: string;
  path: string;
}

export type CloneStep = "counting" | "receiving" | "resolving";

/** `repo.clone_progress` (X59). */
export interface CloneProgress extends CloneJob {
  step: CloneStep;
  current: number;
  total: number;
  size: string | null;
  speed: string | null;
}

/** `repo.clone_done` (X59). */
export interface CloneDone extends CloneJob {
  project: Project | null;
  error: string | null;
  cancelled: boolean;
}

/** `daemon.info`, as the Git page reads it. */
export interface DaemonInfo {
  version: string;
  /** The user's home folder on the host. */
  home: string;
  /** The daemon's data folder (`~/.moonlet` or `$MOONLET_HOME`); absent before X55. */
  data_dir?: string;
}

/** `session.archive`'s result (X55); older daemons answer `true`. */
export interface SessionArchived {
  /** Why origin refused to delete the branch, if it did. */
  remote_error?: string | null;
}

/** Work in a session that is only on its host (X55). */
export interface UnpushedWork {
  /** Uncommitted files with git's one-letter status (`M`, `A`, `D`, `R`, `?`). */
  files: { status: string; path: string }[];
  /** Commits not on origin. */
  commits: number;
  /** The branch's upstream, such as `origin/moonlet/fix`, if it has one. */
  upstream: string | null;
}

/** A host's Git settings, kept by its daemon in `~/.moonlet/git.toml` (X55). */
export interface GitSettings {
  /** Put before every branch a new session derives from its name; empty for none. */
  branch_prefix: string;
  /** Where new session branches start: the local base, or `origin/<base>` after a fetch. */
  start_from: "local" | "origin";
  /** How the Commit dialog's "Stage all changes first" starts. */
  stage_all: boolean;
  /** How the Create pull request dialog's "Draft" starts. */
  draft_prs: boolean;
  /** What archiving a session does with its worktree folder. */
  archive_worktree: "remove" | "keep";
  /** What archiving a session does with its local branch. */
  archive_branch: "ask" | "keep" | "merged" | "always";
  /** Also delete a merged PR's branch on origin. */
  delete_remote_branch: boolean;
  /** Before archiving, list uncommitted files and commits not on origin. */
  warn_unpushed: boolean;
  /** How often projects fetch their base branch from origin; 0: manually. */
  fetch_minutes: number;
  /** Pull a base branch that is only behind origin without a click. */
  fast_forward_base: boolean;
}

export interface ProjectConfig {
  setup?: string | null;
  run?: string | null;
  archive?: string | null;
  default_agent?: string | null;
  base_branch?: string | null;
  /** Put before new session branches here, over the host's (X55). */
  branch_prefix?: string | null;
  agents: Record<string, string>;
  /** Tracker projects this project's sessions start from, `<connection>/<key>` (X44). */
  trackers?: string[];
  /** Commands that may run on another machine, `[heavy]` (X62). */
  heavy?: HeavyConfig;
}

/** Which workers may take a project's heavy commands (X62). */
export type HeavyOs = "any" | "macos" | "linux";

/** A project's `[heavy]` table (X62). */
export interface HeavyConfig {
  commands: string[];
  os: HeavyOs;
  env: string[];
  outputs: string[];
  /** A script run as root on each new cloud machine (X63); kept when the page saves the rest. */
  machine_setup?: string | null;
}

/** What the user approved of a project's heavy commands: both lists, together. */
export interface HeavyApproval {
  commands: string[];
  env: string[];
}

/** `heavy.get`: the project's `[heavy]` table and its approval. */
export interface HeavyInfo {
  config: HeavyConfig;
  approved: HeavyApproval | null;
  /** Why the table cannot be used; nothing is routed then. */
  error: string | null;
}

/** A worker linked to the central host, from `worker.list` (X41, X62). */
export interface WorkerInfo {
  id: string;
  name: string;
  os: string;
  arch: string;
  cores: number;
  version: string;
  slots: number;
  /** It takes heavy commands. */
  heavy: boolean;
  connected_since: number;
  rtt_ms?: number | null;
  load?: number | null;
}

/** A routed command of a session (X62), from `job.list` and `job.changed`. */
export interface Job {
  id: string;
  session: string;
  command: string;
  tool_use_id?: string | null;
  state: JobState;
  started_at: number;
  ended_at?: number | null;
  phases: { name: string; took_ms?: number | null }[];
  timeline: { at: number; text: string; detail?: string | null }[];
  /** `kind`: mac, host, central or cloud. */
  worker?: { name: string; kind: string; load: number; cores: number; slot: number; slots: number; rtt_ms?: number | null; copy?: string | null } | null;
  brought: { path: string; added: number; removed: number }[];
  outputs: { path: string; bytes: number }[];
  leftovers: string[];
  leftovers_folder?: string | null;
  env: string[];
  summary?: string | null;
  output_bytes: number;
}

export type JobState =
  | { kind: "waiting"; for: string }
  | { kind: "running"; worker: string }
  | { kind: "bringing_back" }
  | { kind: "done"; exit: number }
  | { kind: "stopped"; exit: number }
  | { kind: "lost" };

/** Part of a job's output: stream 1 is stdout, 2 stderr. */
export interface JobChunk {
  stream: 1 | 2;
  text: string;
}

/** A settings field of a cloud provider (X63). */
export interface CloudField {
  name: string;
  label: string;
  secret: boolean;
  help: string;
}

export interface CloudKind {
  id: string;
  label: string;
  fields: CloudField[];
  /** It bills every started this many seconds (3600: by the hour). */
  billing_unit_secs?: number;
}

/** How cloud machines get a Tailscale key: one-off from the OAuth client, or a pasted auth key. */
export type TailscaleMode = "oauth" | "auth_key";

/** A project's cloud setting, by its identity key. */
export interface ProjectCloud {
  overflow: boolean;
  provider: string;
  type: string;
  location: string;
  image: string;
}

/** `cloud.get`: a secret field `x` shows as `has_x: true`, never its value. */
export interface CloudInfo {
  host_id: string;
  providers: Record<string, Record<string, string | boolean>>;
  tailscale: { mode: TailscaleMode; client_id: string; has_client_secret: boolean; has_auth_key: boolean; tag: string };
  idle_minutes: number;
  max_machines: number;
  max_hours_month: number;
  projects: Record<string, ProjectCloud>;
  kinds: CloudKind[];
}

/** `cloud.set`: what changes; null removes a provider or project. */
export interface CloudSet {
  providers?: Record<string, Record<string, string | null> | null>;
  tailscale?: { mode?: TailscaleMode; auth_key?: string; client_id?: string; client_secret?: string; tag?: string };
  idle_minutes?: number;
  max_machines?: number;
  max_hours_month?: number;
  projects?: Record<string, ProjectCloud | null>;
}

export interface CloudStep {
  step: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  took_ms?: number | null;
  error?: string | null;
}

/** A cloud machine (X63). */
export interface CloudMachine {
  id: string;
  name: string;
  project: string;
  project_key: string;
  provider: string;
  type: string;
  location: string;
  state: "creating" | "starting" | "ready" | "removing" | "removed" | "failed";
  since: number;
  steps: CloudStep[];
  deadline?: number | null;
  idle_until?: number | null;
  for_session?: string | null;
  running: number;
  error?: string | null;
  error_since?: number | null;
  error_at?: number | null;
  reason?: string | null;
  /** Its worker's id in `worker.list`, once it has registered. */
  worker?: string | null;
}

export interface CloudMachines {
  machines: CloudMachine[];
  removed: CloudMachine[];
  hours_this_month: number;
  max_hours_month: number;
  max_machines: number;
}

export interface MachineType {
  name: string;
  cores: number;
  memory_gb: number;
  arch: string;
}

/** A routing copy's setup waiting for the user's approval (X62), from `exec.setups` and `exec.setup`. */
export interface ExecSetup {
  copy: string;
  /** The central host's name. */
  host: string;
  project: string;
  command: string;
}

/** `exec.status` (X62): this machine, the routed commands going on, and why workers were skipped. */
export interface ExecStatus {
  host: { name: string; os: string; cores: number; load: number | null; slots: number; used: number };
  running: { job: string; session: string; command: string; worker: string; started_at: number }[];
  skips: { worker: string; project: string; reason: string; detail?: string | null }[];
  /** Commands this machine runs for its central host. */
  routed: number;
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
  /** Its heavy commands go to the project's cloud machine first (X63). */
  cloud?: boolean;
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
  /** The tracker issue linked by hand or started from (X46). */
  task?: TaskRef | null;
  /** The user unlinked the task: no linking from the branch or PR either (X46). */
  task_unlinked?: boolean;
  terminals: number[];
  layout: unknown;
}

/** A tracker issue a session is linked to (X46). */
export interface TaskRef {
  /** The app's id for the tracker connection (X44). */
  connection: string;
  key: string;
  url: string;
}

/** A GitHub issue for Tasks mode (X44). */
/** An open GitHub Project (X50 Add a board): its Status options are the board's columns. */
export interface GhProject {
  id: string;
  owner: string;
  number: number;
  title: string;
  status_field: string | null;
  options: { id: string; name: string }[];
}

/** A new issue from a board column (X52): the issue, and its node id for a GitHub Project. */
export interface GhCreated {
  task: GhTask;
  node: string;
}

/** What the new-issue form offers for a repository (X52). */
export interface GhCreateChoices {
  me: string;
  people: string[];
  labels: string[];
  /** Whether gh's user can set assignees and labels; GitHub drops them otherwise. */
  can_set: boolean;
}

/** A GitHub Project as a board reads it (X50 Sync): its Status options and its items that are issues. */
export interface GhProjectBoard {
  id: string;
  status_field: string | null;
  options: { id: string; name: string }[];
  /** Its first number field's name; each item's `estimate` is its value there. */
  number_field?: string | null;
  items: { item: string; status: string | null; option?: string | null; estimate?: number | null; task: GhTask }[];
}

export interface GhTask {
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  closed: boolean;
  /** `completed`, `not_planned`, `duplicate` or `reopened`. */
  state_reason: string | null;
  /** Logins. */
  assignees: string[];
  labels: string[];
  updated_ms: number;
  /** Pull requests in the same repository that close the issue. */
  closing_prs: number[];
}

/** A GitHub issue's comments (X66): oldest first, the newest 100, and whether it has more. */
export interface GhComments {
  comments: { id: string; /** `@login`; empty when GitHub gives none. */ author: string; /** Markdown. */ body: string; created_ms: number }[];
  more: boolean;
}

/** A linked git work tree of a project (X45). */
export interface Worktree {
  path: string;
  /** null on a detached HEAD. */
  branch: string | null;
  last_commit_ms: number;
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
  group_by: "project" | "task" | "status" | "none";
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
  draft?: boolean;
  /** The PR branch's last commit; GitHub keeps it after a merge (X55). */
  head_oid?: string | null;
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
  /** From a design system's sync agent (X64) or a design's agent (X65). */
  design?: DesignTag;
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
  /** When the agent asked, ms (X40). */
  asked_at?: number | null;
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

export type HostStatus = "connecting" | "connected" | "reconnecting" | "needs_install" | "needs_update" | "refused" | "error";

/** How the desktop app reaches a host: its own daemon, SSH (R1) or the tailnet (X57). */
export type HostKind = "local" | "ssh" | "tailnet";

export interface HostInfo {
  id: string;
  label: string;
  remote: boolean;
  /** Set by the desktop app; the phone app does not send it. */
  kind?: HostKind;
  status: HostStatus;
  message: string | null;
  daemon_version: string | null;
  hostname: string | null;
  home: string | null;
  /** `macos` or `linux`, known for a tailnet host that needs an update (X58). */
  os?: string | null;
}

/** What paired: a phone (X39) or another Mac's app (X57). */
export type DeviceKind = "phone" | "desktop" | "cloud";

/** A paired device (X39, X57). */
export interface MobileDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  created_at: number;
  last_seen: number | null;
  connected: boolean;
}

/** Phone access over Tailscale (X39). */
export interface MobileStatus {
  enabled: boolean;
  port: number;
  /** The Mac has a Tailscale address. */
  tailscale: boolean;
  addresses: string[];
  /** Where the daemon listens for phones, `ip:port`; empty while off. */
  listening: string[];
  host: string;
  devices: MobileDevice[];
}

/** This Mac's link to its central host, from `link.get` (X41); never the token. */
export type LinkState =
  | { kind: "off" }
  | { kind: "connecting" }
  | { kind: "connected"; since: number }
  | { kind: "reconnecting" }
  | { kind: "needs_update"; daemon_version: string }
  | { kind: "refused" }
  | { kind: "error"; message: string };

export interface LinkInfo {
  central: { name: string; addrs: string[] } | null;
  /** `slots`: how many routed commands it runs at once (X62). */
  worker: { id: string; name: string; enabled: boolean; slots?: number };
  state: LinkState;
}

/** Where a live copy is (X60). */
export type CopyState =
  | { kind: "copying" }
  | { kind: "in_sync" }
  | { kind: "syncing"; files: number }
  | { kind: "waiting" }
  | { kind: "paused"; reason: string };

/** Where a copy's setup is (X60). */
export type SetupState = { kind: "needs_approval" } | { kind: "running" } | { kind: "done" } | { kind: "failed"; exit: number } | { kind: "skipped" };

/** A live copy on this Mac of a session on its central host, from this Mac's daemon (X60). */
export interface Copy {
  id: string;
  /** The central host's name, which is its host id in the app. */
  host: string;
  /** The session's id on the central host. */
  session: string;
  /** Where the copy is on this Mac; empty until it is made. */
  path: string;
  state: CopyState;
  /** The copy's setup: the command its `.moonlet/config.toml` has now, and
   * whether this exact command was approved for the project on this
   * central host, so Run setup again asks first when it was not. */
  setup: { state: SetupState; command: string; approved: boolean } | null;
  differs: string[];
  too_big: string[];
  diverged: { ahead: number; behind: number } | null;
}

/** What turning a copy off saved, relative to `folder` (X60). */
export interface SyncStopped {
  folder: string;
  leftovers: string[];
}

/** A card the last sync added, rewrote or removed (X64). */
export interface DesignSyncChange {
  path: string;
  change: "new" | "rewritten" | "removed";
  sources: string[];
}

/** One design system of a workspace, from `design.systems` (X64). */
export interface DesignSystem {
  slug: string;
  name: string;
  /** The source projects' folders. */
  sources: string[];
  synced_at: number | null;
  synced_commit: string | null;
  /** Component cards, not foundations or layouts. */
  cards: number;
  layouts: number;
  /** Source files changed since the last sync. */
  changed_sources: string[];
  check_problems: number;
  /** Proposed changes and orphaned cards waiting for the user. */
  to_settle: number;
  /** The step a running sync reported last. */
  step: DesignStep | null;
  step_summary: string | null;
  /** Each step the running sync reported, in step order, with its summary. */
  steps: { step: DesignStep; summary: string | null }[];
  /** A sync started and not yet recorded: its agent's turns are the sync's. */
  sync_running: boolean;
  /** Why the system could not be read. */
  error: string | null;
  /** Its sync agent's chat, once one was started. */
  agent: number | null;
  last_sync: DesignSyncChange[];
  /** What its sync agent waits for from the user. */
  needs_you: { kind: "question" | "approval"; text: string } | null;
}

/** A sync's steps, in order (X64). */
export type DesignStep = "inventory" | "tokens" | "cards" | "layouts";

/** One card of a design system, from `design.cards` (X64). */
export interface DesignCard {
  group: string;
  name: string;
  /** Relative to the design system's folder. */
  path: string;
  /** Width and height. */
  viewport: [number, number];
  /** The source files it was made from, relative to their project. */
  source: string[];
  /** Its snippets' ids. */
  snippets: string[];
  /** Its `@dsCard` line. */
  marker: string;
  problems: { path: string; line: number; kind: string; message: string }[];
  /** Its sources changed since the last sync. */
  changed_sources: string[];
  /** The proposals a sync wrote beside it (it was edited by hand), relative to the system. */
  proposals: string[];
  edited_by_hand: boolean;
  /** Its sources are gone. */
  orphaned: boolean;
  /** An orphan the user keeps for now. */
  kept: boolean;
}

/** What a design system covers: the components that matter most, all of them, or none yet. */
export type DesignCover = "core" | "all" | "none";

/** `design.system.create`'s answer: the agent's chat, or why it did not start. */
export interface DesignSystemCreated {
  slug: string;
  agent: number | null;
  agent_error: string | null;
}

/** `design.changed`: files changed in a workspace's design folder (X64, X65). */
export interface DesignChanged {
  workspace: string;
  /** The design system they are in, if any. */
  system: string | null;
  /** The workspace design they are in, if any (X65). */
  design?: string | null;
  /** Relative to the design system's or the design's folder, else the workspace's. */
  paths: string[];
}

/** `sync.changed`: a copy, the paths that just started to differ, and why it went. */
export interface CopyChanged extends Copy {
  newly_differing?: string[];
  removed?: { reason: "stopped" | "archived" } & SyncStopped;
}

/** A one-time pairing code and the link its QR code holds (X39). */
export interface MobilePairing {
  code: string;
  url: string;
  expires_at: number;
  addresses: string[];
  host: string;
}

export interface FsChanged {
  root: string;
  paths: string[];
}

export const M = {
  daemonInfo: "daemon.info",
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
  projectIdentity: "project.identity",
  projectRemove: "project.remove",
  projectConfig: "project.config",
  projectConfigFile: "project.config_file",
  projectSetConfig: "project.set_config",
  projectWorktrees: "project.worktrees",
  projectWorktreeRemove: "project.worktree_remove",
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
  gitSettings: "git.settings",
  gitSetSettings: "git.set_settings",
  gitUnpushed: "git.unpushed",
  gitPush: "git.push",
  prCreate: "gh.pr_create",
  shellHistory: "shell.history",
  shellCommands: "shell.commands",
  ghPrs: "gh.prs",
  ghPrContext: "gh.pr_context",
  ghTasks: "gh.tasks",
  ghProjects: "gh.projects",
  ghProjectItems: "gh.project_items",
  ghCreateOptions: "gh.create_options",
  ghIssueCreate: "gh.issue_create",
  ghProjectAdd: "gh.project_add",
  ghProjectMove: "gh.project_move",
  ghScopes: "gh.scopes",
  ghTask: "gh.task",
  ghTaskUpdate: "gh.task_update",
  ghIssueComments: "gh.issue_comments",
  ghIssueComment: "gh.issue_comment",
  ghWhoami: "gh.whoami",
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
  repoGhStatus: "repo.gh_status",
  repoLookup: "repo.lookup",
  repoList: "repo.list",
  repoCloneTarget: "repo.clone_target",
  repoClone: "repo.clone",
  repoCloneCancel: "repo.clone_cancel",
  prStatus: "gh.pr_status",
  prStack: "gh.pr_stack",
  fsList: "fs.list",
  fsFiles: "fs.files",
  fsRead: "fs.read",
  fsWrite: "fs.write",
  fsWriteInside: "fs.write_inside",
  fsWatch: "fs.watch",
  fsUnwatch: "fs.unwatch",
  chatState: "chat.state",
  /** Every chat's state without its items (X40). */
  chatSummaries: "chat.summaries",
  chatSend: "chat.send",
  chatPermission: "chat.permission",
  chatInterrupt: "chat.interrupt",
  /** Stops one running subagent: `{ id, agent }` (X42). */
  chatStopAgent: "chat.stop_agent",
  /** Asks Claude to read a queued message now: `{ id, message? }` (X49). */
  chatSendNow: "chat.send_now",
  /** Takes a message out of Claude's queue: `{ id, message }` (X49). */
  chatUnqueue: "chat.unqueue",
  /** A side question answered from the conversation: `{ id, text }` → AsideAnswer (X49). */
  chatAside: "chat.aside",
  chatSettings: "chat.settings",
  chatAddDir: "chat.add_dir",
  chatMcp: "chat.mcp",
  terminalReadAnswer: "terminal.read_answer",
  terminalReadRequests: "terminal.read_requests",
  terminalReadGrants: "terminal.read_grants",
  terminalReadGrantClear: "terminal.read_grant_clear",
  mobileStatus: "mobile.status",
  mobileSetEnabled: "mobile.set_enabled",
  mobilePairStart: "mobile.pair_start",
  mobilePairCancel: "mobile.pair_cancel",
  mobileRevoke: "mobile.revoke",
  mobileHosts: "mobile.hosts",
  linkGet: "link.get",
  linkSet: "link.set",
  linkRetry: "link.retry",
  linkPair: "link.pair",
  syncStart: "sync.start",
  syncList: "sync.list",
  syncRetry: "sync.retry",
  syncResolve: "sync.resolve",
  syncUseCentralBranch: "sync.use_central_branch",
  syncStop: "sync.stop",
  syncRunSetup: "sync.run_setup",
  syncSkipSetup: "sync.skip_setup",
  syncProjectGet: "sync.project_get",
  syncProjectSet: "sync.project_set",
  syncDecline: "sync.decline",
  heavyGet: "heavy.get",
  heavySet: "heavy.set",
  heavyApprove: "heavy.approve",
  workerList: "worker.list",
  execStatus: "exec.status",
  execSetups: "exec.setups",
  cloudGet: "cloud.get",
  cloudSet: "cloud.set",
  cloudTypes: "cloud.types",
  cloudMachines: "cloud.machines",
  cloudUp: "cloud.up",
  cloudDown: "cloud.down",
  cloudCheck: "cloud.check",
  jobList: "job.list",
  jobOutput: "job.output",
  jobStop: "job.stop",
  jobStopAll: "job.stop_all",
  jobRunHere: "job.run_here",
  designSystems: "design.systems",
  designSystemCreate: "design.system.create",
  designSystemSync: "design.system.sync",
  designSystemRemove: "design.system.remove",
  designDetect: "design.detect",
  designFile: "design.file",
  designSettle: "design.settle",
  designCards: "design.cards",
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
  gitSettingsChanged: "git.settings_changed",
  claudeUpdateOutput: "claude.update_output",
  claudeUpdateDone: "claude.update_done",
  repoCloneProgress: "repo.clone_progress",
  repoCloneDone: "repo.clone_done",
  fsChanged: "fs.changed",
  chatItem: "chat.item",
  chatState: "chat.state",
  terminalReadRequest: "terminal.read_request",
  terminalReadDone: "terminal.read_done",
  terminalReadGrant: "terminal.read_grant",
  mobileChanged: "mobile.changed",
  mobilePaired: "mobile.paired",
  mobilePairEnded: "mobile.pair_ended",
  linkChanged: "link.changed",
  syncChanged: "sync.changed",
  workersChanged: "workers.changed",
  jobChanged: "job.changed",
  execSetup: "exec.setup",
  cloudChanged: "cloud.changed",
  jobOutput: "job.output",
  designChanged: "design.changed",
} as const;

/**
 * What starts the daemon at login, from the `daemon_service` command: the
 * app's login item (X56), or in builds without one the plist that
 * `moonletd service` writes (S1b).
 */
export type DaemonService =
  | { mechanism: "login_item"; state: "enabled" | "requires_approval" | "not_registered" | "not_found" }
  | { mechanism: "plist"; state: "loaded" | "installed" | "not_installed"; plist: string };
