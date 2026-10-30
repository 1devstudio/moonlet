// Tasks mode's data: each workspace's tasks and worktrees, and the switch
// between Sessions and Tasks (X44, X45).

import { NO_STATUS, type Assignee, type ProjectMeta, projectMove, assigneeOf, type AssigneePick, EVERY_BOARD, pickAssignee, type BoardColumn, type BoardConfig, type Category, type ColumnShow, GITHUB_REPO_COLUMNS, migrateSources, syncedColumns, taskFromBoardIssue, withColumnShow, workspaceBoards } from "./boards";
import { categorize, placeOnBoards, statusFor, withStatus } from "./boardColumns";
import { create } from "zustand";
import { DaemonError, hostsApi, rpc } from "./daemon";
import { focusThrottle, latestPerKey } from "./prPoll";
import { type GhCreated, type GhCreateChoices, type GhProjectBoard, type GhTask, M, type MobileStatus, type Project, type ProjectConfig, type Worktree } from "./protocol";
import { errorMessage, errorToast, notify, sesKey, sessionState, sessionTerminals, shownWorkspace, switchWorkspace, toast, useStore } from "./store";
import { askConfirm } from "./confirm";
import { applyRules, autoFixes, cleanUpMessage, DEFAULT_RULES, driftFix, driftKey, outsideMoves, prComments, type Rules, startAction } from "./keepInStep";
import { modeOf, setMode, toggleMode } from "./mode";
import { readStored, writeStored } from "./storage";
import { type ActivityEntry, appendActivity } from "./taskDetails";
import type { Pasted } from "./taskLinking";
import { type Column, DEFAULT_LINK, githubRepo, type LinkRules, sourceKey, type Task, type TaskStart, taskFromGh, taskFromProjectItem, taskId, taskStart, trackerOf } from "./tasks";
import { parseTrackerLink } from "./trackerSources";
import { boardShows, type Created, createTarget, githubRepoOf, isJira, type NewIssue, withCreated } from "./newIssue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Board, type BoardInput, type BoardSession, type BoardWorktree, type Card, tasksBoard } from "./tasksBoard";
import type { BoardFilters } from "./tasksView";
import { parseWsKey, wsKey } from "./workspaces";
import { resolveTaskRequest, type TaskRequestEvent } from "./tasksRelay";
import { snapshotsToShare } from "./taskSnapshot";

/** GitHub Issues through `gh` on the project's host (X44). */
export const GITHUB = "github:github.com";

export interface TasksData {
  tasks: Task[];
  worktrees: BoardWorktree[];
  /** The workspace's task sources: the GitHub repositories of its projects. */
  sources: string[];
  /** Each project's GitHub `owner/repo`, by project id. */
  repos: Record<string, string | null>;
  /** The projects that link a tracker source in Project settings, by `connection source` (X44). */
  sourceProjects?: Record<string, string[]>;
  /** The last good sync; null before the first. */
  syncedAt: number | null;
  /** Why the last sync failed; the last good list stays. */
  error: string | null;
  /** Each synced board's tasks (`connection key`) and active sprint or cycle (X50). */
  boards?: Record<string, BoardData>;
}

/** What a sync read for one board (X50). */
export interface BoardData {
  keys: string[];
  /** The sprint or cycle it follows: null once a sync found none, absent before the board ever read. */
  sprint?: { id: number; name: string; startMs: number; endMs: number } | null;
  /** A Jira board's type as its last sync read it: `scrum`, `kanban`, `simple`. */
  kind?: string;
  /** Why the board's last sync failed (a Jira board deleted, a team archived); its last good tasks stay. */
  error?: string;
  /** A GitHub Project's id, Status field and options, for moving its items (X50). */
  project?: ProjectMeta;
}

interface TasksState {
  /** Per workspace, `host/workspaceId`. */
  data: Record<string, TasksData>;
  /** The task the detail panel shows, `connection key`. */
  selected: string | null;
  /** Out-of-sync chips put off with "Not now", by `driftKey` (X45). */
  notNow: Record<string, true>;
  /** `trackers.toml`; null until read. */
  config: TrackersConfig | null;
  /** Why `trackers.toml` could not be read, if it could not. */
  configError: string | null;
  /** Board or List (X45). */
  layout: "board" | "list";
  /** List rows open, by `connection key`. */
  expanded: Record<string, boolean>;
  /** Hide empty Done in the header, kept across restarts (X45). */
  filters: Omit<BoardFilters, "mine">;
  /** gh's token scopes on each host, as its last GitHub Project sync read them (X50 moves need `project`). */
  ghScopes: Record<string, string[]>;
  /** Assignee picked in the header, by board id, kept in the app across restarts, not written to the board (X50). */
  assignee: Record<string, AssigneePick>;
  /** Connections whose token stopped working, with what to do (X44). */
  attention: Record<string, string>;
  /** What moonlet did about each task, by `connection key` (X45 Activity). */
  activity: Record<string, ActivityEntry[]>;
  /** Find a task: the text the board is filtered by. */
  query: string;
  /** Tasks whose Keep in step switch is off, by `connection key` (X46 Task tab). */
  paused: Record<string, true>;
  /** The last action on a task that failed, with its error (X46), by `connection key`. */
  failures: Record<string, string>;
  /**
   * Moves under way (X53), by `connection key`: the status and column a card
   * shows in before the tracker answers. `done` once the tracker took it;
   * dropped when a sync that started after that lands, or when refused.
   */
  moving: Record<string, Moving>;
  /** The board each workspace shows, by `host/workspaceId` (X50); kept across restarts. */
  shownBoard: Record<string, string>;
}

/** One tracker's branch names and rules. */
export interface TrackerSettings {
  branch_template: string;
  max_length: number;
  rules: Rules;
}

/** A team, project or list shown in a workspace (X44 Sources). */
export interface Source {
  key: string;
  name: string;
  /** `host/workspaceId`. */
  workspace: string;
}

/** A signed-in Linear, Jira or ClickUp account (its token is in the Keychain). */
export interface Connection {
  id: string;
  kind: "linear" | "jira" | "clickup";
  site: string;
  account: string;
  auth: string;
  /** Jira's sign-in email, kept so Reconnect asks only for a new token. */
  email?: string;
  sources: Source[];
  /** Tracker state name → column, where the user changed the default (X44). */
  states?: Record<string, Column>;
}

/** `~/.moonlet/trackers.toml` as `moonlet-trackers` reads it (X44). */
export interface TrackersConfig {
  sync: { interval: number; notify: boolean };
  github: TrackerSettings;
  linear?: TrackerSettings;
  jira?: TrackerSettings;
  clickup?: TrackerSettings;
  connections?: Connection[];
  link?: LinkRules;
  /** What Tasks mode shows, one board at a time (X50). */
  boards?: BoardConfig[];
}

const DEFAULT_TRACKER: TrackerSettings = { branch_template: "", max_length: 48, rules: DEFAULT_RULES };

export const DEFAULT_CONFIG: TrackersConfig = { sync: { interval: 60, notify: true }, github: DEFAULT_TRACKER };

/** A tracker's branch names and rules (GitHub's, or a connection's tracker). */
export function trackerSettings(config: TrackersConfig, connection: string): TrackerSettings {
  const kind = trackerOf(connection);
  return (kind && config[kind]) || DEFAULT_TRACKER;
}

export const useTasks = create<TasksState>(() => ({
  data: {},
  selected: null,
  notNow: {},
  config: null,
  configError: null,
  layout: storedLayout(),
  expanded: storedExpanded(),
  filters: storedFilters(),
  assignee: storedAssignee(),
  ghScopes: {},
  attention: {},
  activity: {},
  query: "",
  paused: storedPaused(),
  failures: {},
  moving: {},
  shownBoard: storedShownBoard(),
}));

/** A move under way (X53): the status a card shows in, of column `name`. */
export interface Moving {
  status: string;
  name: string;
  done: boolean;
}

function storedShownBoard(): Record<string, string> {
  try {
    return JSON.parse(readStored("tasks.board") ?? "{}");
  } catch {
    return {};
  }
}

/** Removes `board` after asking (X50): it goes from Tasks mode; sessions keep their links. False when the user keeps it. */
export async function removeBoard(board: Pick<BoardConfig, "id" | "name">): Promise<boolean> {
  const sure = await askConfirm({ title: `Remove ${board.name}?`, message: "It goes from Tasks mode. Sessions keep their links.", action: "Remove", variant: "danger" });
  if (!sure) return false;
  await saveTrackersConfig((c) => ({ ...c, boards: (c.boards ?? []).filter((b) => b.id !== board.id) }));
  return true;
}

/**
 * Opens Add a board for workspace `workspace` of `host`, starting on
 * `connection` when given (the Connect dialog's end), or with `board` that
 * board's settings (X50). Settings close behind it.
 */
export function openAddBoard(host: string, workspace: string, open: { board?: string; connection?: string; build?: "repo" } = {}) {
  useStore.setState({ settingsPage: null, dialog: { kind: "add-board", host, workspace, ...open } });
}

/** Opens board `id` from the board switcher (X50): another workspace's is shown there, in Tasks mode. */
export function openBoard(host: string, workspaceId: string, id: string) {
  const shown = shownWorkspace(useStore.getState());
  if (shown?.host !== host || shown.id !== workspaceId) switchWorkspace({ host, id: workspaceId });
  const key = wsKey(host, workspaceId);
  useStore.setState((s) => ({ mode: { ...s.mode, [key]: "tasks" } }));
  showBoard(host, workspaceId, id);
}

/** Shows board `id` in workspace `workspaceId` of `host` (X50), and syncs it if it is not pinned. */
export function showBoard(host: string, workspaceId: string, id: string) {
  const shownBoard = { ...useTasks.getState().shownBoard, [wsKey(host, workspaceId)]: id };
  useTasks.setState({ shownBoard });
  writeStored("tasks.board", JSON.stringify(shownBoard));
  void refreshTasks(host, workspaceId);
}

function storedFilters(): Omit<BoardFilters, "mine"> {
  try {
    return { hideEmptyDone: JSON.parse(readStored("tasks.filters") ?? "{}").hideEmptyDone === true };
  } catch {
    return { hideEmptyDone: false };
  }
}

/** Hide empty Done in the header (X45). */
export function setFilters(filters: Omit<BoardFilters, "mine">) {
  useTasks.setState({ filters });
  writeStored("tasks.filters", JSON.stringify(filters));
}

// A function, not a const: the store reads the picks while this module loads.
function isAssignee(v: unknown): v is Assignee {
  return v === "me" || v === "anyone";
}

/** The header's Assignee picks; X45's one switch, left off, becomes anyone for every board at me (X50). */
function storedAssignee(): Record<string, AssigneePick> {
  try {
    const raw = readStored("tasks.assignee");
    if (raw === null) return JSON.parse(readStored("tasks.filters") ?? "{}").mine === false ? { [EVERY_BOARD]: { to: "anyone", over: "me" } } : {};
    const picks = JSON.parse(raw) as Record<string, Partial<AssigneePick>>;
    return Object.fromEntries(Object.entries(picks).filter((e): e is [string, AssigneePick] => isAssignee(e[1]?.to) && isAssignee(e[1]?.over)));
  } catch {
    return {};
  }
}

/** The header's Assignee for `board` (X50), kept in the app, not written to the board; its workspace syncs again for whose issues it now fetches. */
export function setAssignee(board: Pick<BoardConfig, "id" | "assignee" | "workspace">, to: Assignee) {
  const ids = (trackersConfig(useTasks.getState()).boards ?? []).map((b) => b.id);
  const assignee = pickAssignee(useTasks.getState().assignee, board, to, [...ids, board.id]);
  useTasks.setState({ assignee });
  writeStored("tasks.assignee", JSON.stringify(assignee));
  const { host, id } = parseWsKey(board.workspace);
  void refreshTasks(host, id);
}

function storedExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(readStored("tasks.expanded") ?? "{}");
  } catch {
    return {};
  }
}

/** The List layout's open rows by task id, kept across restarts (X45). */
export function setExpanded(expanded: Record<string, boolean>) {
  const open = Object.fromEntries(Object.entries(expanded).filter(([, on]) => on));
  useTasks.setState({ expanded: open });
  writeStored("tasks.expanded", JSON.stringify(open));
}

export function toggleExpanded(id: string) {
  const now = useTasks.getState().expanded;
  setExpanded({ ...now, [id]: !now[id] });
}

function storedLayout(): "board" | "list" {
  try {
    return readStored("tasks.layout") === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}

/** Board or List; remembered across restarts. */
export function setLayout(layout: "board" | "list") {
  writeStored("tasks.layout", layout);
  useTasks.setState({ layout });
}

/** The settings in effect: the file's, or the defaults before it is read. */
export const trackersConfig = (t: { config: TrackersConfig | null }) => t.config ?? DEFAULT_CONFIG;

/** The file leaves out trackers at their defaults; put them back. */
function withDefaults(c: Partial<TrackersConfig>): TrackersConfig {
  return { ...c, sync: { ...DEFAULT_CONFIG.sync, ...c.sync }, github: c.github ?? DEFAULT_TRACKER, connections: c.connections ?? [], link: { ...DEFAULT_LINK, ...c.link } };
}

let sourcesMigrated = false;

/** Reads `trackers.toml` once; a broken file shows its error and the defaults apply. */
export async function loadTrackersConfig(force = false) {
  if (useTasks.getState().config && !force) return;
  try {
    const config = withDefaults(await hostsApi.trackersConfig());
    useTasks.setState({ config, configError: null });
    // X44's sources become boards as soon as the file is read (X50), once a run.
    if (!sourcesMigrated && migrateSources(config) !== config) {
      sourcesMigrated = true;
      await saveTrackersConfig(migrateSources).catch((e) => errorToast(e));
    }
  } catch (e) {
    useTasks.setState({ configError: errorMessage(e) });
    errorToast(e);
  }
}

let saving: Promise<void> = Promise.resolve();
let saveRound = 0;

/**
 * Changes `trackers.toml`. `update` gets the settings as they are when it
 * runs, so quick changes in a row all land; writes go out in order. A file
 * that could not be read is never written over with the defaults.
 */
export function saveTrackersConfig(update: (c: TrackersConfig) => TrackersConfig): Promise<void> {
  const { config, configError } = useTasks.getState();
  if (configError) return Promise.reject(new Error(`~/.moonlet/trackers.toml could not be read (${configError}), so it is left as it is`));
  if (!config) return Promise.reject(new Error("Task tracker settings are still loading"));
  const next = update(config);
  useTasks.setState({ config: next });
  // A write that fails drops the changes queued behind it, which were built
  // on it, and shows the file as it is again.
  const asOf = saveRound;
  const write = saving.then(async () => {
    if (asOf !== saveRound) throw new Error("An earlier change to the task tracker settings could not be saved");
    try {
      await hostsApi.trackersSave(next);
    } catch (e) {
      await loadTrackersConfig(true);
      // After the reload: a change made while it ran was built on the failed one.
      saveRound++;
      throw e;
    }
  });
  saving = write.catch(() => {});
  return write;
}

/** Resolves once every write queued so far has landed or failed, including
 * those nobody waits for, such as the board columns a sync saves. */
export function settleSaves(): Promise<void> {
  return saving;
}

/** Fixes moonlet already made by itself, by `driftKey`, so each happens once (X46). */
const AUTO_KEY = "tasks.autoFixed";
export function autoFixed(): Record<string, true> {
  try {
    return JSON.parse(readStored(AUTO_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export function markAutoFixed(key: string) {
  writeStored(AUTO_KEY, JSON.stringify({ ...autoFixed(), [key]: true }));
}

type StoreState = ReturnType<typeof useStore.getState>;

/** Whether the shown workspace is in Tasks mode. */
export function isTasksMode(s: StoreState): boolean {
  return modeOf(s) === "tasks";
}

/** ⌃⌘T: Sessions ⇄ Tasks for the shown workspace. */
export function toggleTasksMode() {
  toggleMode("tasks");
}

/** Back to Sessions mode in the shown workspace, to work on a session (X45, X46). */
export function leaveTasksMode() {
  if (isTasksMode(useStore.getState())) setMode("sessions");
}

/** The projects in a workspace's sections. */
export function workspaceProjects(s: StoreState, host: string, workspaceId: string): Project[] {
  const ws = s.workspaces[host]?.find((w) => w.id === workspaceId);
  const ids = new Set((s.sections[host] ?? []).filter((sec) => ws?.section_ids.includes(sec.id)).flatMap((sec) => sec.project_ids));
  return (s.projects[host] ?? []).filter((p) => ids.has(p.id));
}

const syncs = latestPerKey();

/**
 * Reads a workspace's boards (X50): its pinned ones and the one shown, each
 * by its origin, with the projects' worktrees. A repository is a board only
 * once the user adds it. A board that fails keeps its last good tasks.
 */
export async function refreshTasks(host: string, workspaceId: string, now = Date.now()) {
  const key = wsKey(host, workspaceId);
  const isLatest = syncs.start(key);
  // Moves the tracker took before this sync started: its answer places those it reads (X53).
  const settled = Object.entries(useTasks.getState().moving).filter(([, m]) => m.done);
  const readNow = new Set<string>();
  await loadTrackersConfig();
  const projects = workspaceProjects(useStore.getState(), host, workspaceId);
  let error: string | null = null;
  const per = await Promise.all(
    projects.map(async (p) => {
      const repo = githubRepo(await rpc<string | null>(host, M.gitOriginUrl, { path: p.path }).catch(() => null));
      const worktrees = await rpc<Worktree[]>(host, M.projectWorktrees, { id: p.id }).catch(() => []);
      // The tracker projects its sessions start from (X44 Project settings › Task trackers).
      const trackers = await rpc<ProjectConfig>(host, M.projectConfig, { id: p.id })
        .then((c) => c.trackers ?? [])
        .catch(() => []);
      return { id: p.id, path: p.path, repo, trackers, worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, originRepo: repo, project: p.id })) };
    }),
  );
  // A repository is a board only once the user adds it (X50); with trackers.toml unreadable, there is none.
  const boards = useTasks.getState().configError
    ? []
    : workspaceBoards(trackersConfig(useTasks.getState()).boards, key, useTasks.getState().shownBoard[key] ?? null);
  const chosen = useTasks.getState().assignee;
  // One sync: a connection's boards share its lookups within it (X50).
  const sync = ++lastSync;
  const read = await Promise.all(boards.map((b) => readBoard(host, b, per, assigneeOf(b, chosen) === "anyone", sync)));
  if (!isLatest()) return;
  const prev = useTasks.getState().data[key];
  const tasks = new Map<string, Task>();
  const boardData: Record<string, BoardData> = {};
  const fresh: Record<string, BoardColumn[]> = {};
  for (const [i, b] of boards.entries()) {
    const r = read[i];
    if (r.error !== null) {
      // A connection that needs attention says so on its own row (X44), not as the workspace's error.
      if (r.error) error = r.error;
      // The board keeps its last good tasks, and says why it failed.
      const last = prev?.boards?.[b.id];
      if (last) for (const t of prev?.tasks ?? []) if (last.keys.includes(taskId(t)) && !tasks.has(taskId(t))) tasks.set(taskId(t), t);
      // A board that never read has no sprint yet, rather than none.
      const { error: _, ...kept } = last ?? { keys: [] };
      boardData[b.id] = { ...kept, ...(r.error && { error: r.error }) };
      continue;
    }
    const cols = syncedColumns(b, r.columns);
    if (r.columns && JSON.stringify(cols) !== JSON.stringify(b.columns ?? [])) fresh[b.id] = r.columns;
    // Before a board's columns are known, a task keeps its tracker category.
    const placed = cols.length ? categorize(cols, r.tasks) : r.tasks;
    for (const t of placed) if (!tasks.has(taskId(t))) tasks.set(taskId(t), t);
    for (const t of placed) readNow.add(taskId(t));
    boardData[b.id] = { keys: placed.map(taskId), sprint: r.sprint, ...(r.kind && { kind: r.kind }), ...(r.project && { project: r.project }) };
  }
  // A board whose columns changed in its tracker keeps them, matched to the
  // board as it is when the write runs, so a change made meanwhile stays.
  if (Object.keys(fresh).length && !useTasks.getState().configError)
    void saveTrackersConfig((c) => ({ ...c, boards: c.boards?.map((b) => (fresh[b.id] ? { ...b, columns: syncedColumns(b, fresh[b.id]) } : b)) })).catch(() => {});
  const sources = [...new Set(boards.map((b) => (b.origin.kind === "github_repo" ? b.origin.repo : b.connection)))];
  const repos = Object.fromEntries(per.map((x) => [x.id, x.repo]));
  const sourceProjects: Record<string, string[]> = {};
  for (const x of per)
    for (const t of x.trackers) {
      const link = parseTrackerLink(t);
      const source = link && sourceKey(link.connection, link.key);
      if (source) sourceProjects[source] = [...(sourceProjects[source] ?? []), x.id];
    }
  // The issues moonlet created stay on their boards until a sync has them (X52).
  const merged = withCreated({ tasks: [...tasks.values()], boards: boardData }, created.filter((c) => c.ws === key), now);
  created = [...created.filter((c) => c.ws !== key), ...merged.pending.map((c) => ({ ...c, ws: key }))];
  for (const c of merged.gone) notShown(c.task);
  const next: TasksData = {
    tasks: merged.tasks,
    worktrees: per.flatMap((x) => x.worktrees),
    sources,
    repos,
    sourceProjects,
    syncedAt: error ? (prev?.syncedAt ?? null) : now,
    error,
    boards: merged.boards ?? boardData,
  };
  useTasks.setState((st) => ({ data: { ...st.data, [key]: next }, moving: withoutMoves(st.moving, settled.filter(([id]) => readNow.has(id))) }));
  // Compared as the board shows them: with its columns as saved now.
  const mapped = { ...next, tasks: placedTasks(next) };
  if (!error && trackersConfig(useTasks.getState()).sync.notify) notifyOutsideMoves(host, workspaceId, prev ? placedTasks(prev) : null, mapped);
  else forgetSeenMoves(mapped.tasks);
}

/**
 * A board that is not saved yet (Add a board's preview, X50): its issues,
 * everyone's with the user's own marked, the tracker's columns, or why the
 * tracker refused it.
 */
/** A board's issues before it is saved (X50 step 2 and Board settings). */
export interface BoardPreview {
  tasks: Task[];
  columns: BoardColumn[] | null;
  error: string | null;
  /** A GitHub Project's first number field, which Cards show offers; null for any other board. */
  numberField: string | null;
  /** Status names by id for step 3: a JQL board's site's, a GitHub Project's options'; empty for any other board. */
  statusNames: Record<string, string>;
}

/** A preview that could not be read: no issues, and why. */
export const previewFailed = (error: string): BoardPreview => ({ tasks: [], columns: null, error, numberField: null, statusNames: {} });

export async function previewBoard(host: string, workspaceId: string, board: BoardConfig): Promise<BoardPreview> {
  const repos = useTasks.getState().data[wsKey(host, workspaceId)]?.repos ?? {};
  const projects = workspaceProjects(useStore.getState(), host, workspaceId).map((p) => ({ path: p.path, repo: repos[p.id] ?? null }));
  const r = await readBoard(host, board, projects, true);
  const error = r.error === "" ? (useTasks.getState().attention[board.connection] ?? "Reconnect this tracker") : r.error;
  return { tasks: r.tasks, columns: r.columns, error, numberField: r.project?.numberField ?? null, statusNames: r.statusNames ?? {} };
}

interface BoardRead {
  tasks: Task[];
  /** The tracker's columns now, or null when it gave none (GitHub's are fixed). */
  columns: BoardColumn[] | null;
  sprint: BoardData["sprint"];
  kind?: string;
  project?: ProjectMeta;
  /** Status names by id: a JQL board's site's, a GitHub Project's options'. */
  statusNames?: Record<string, string>;
  /** Why it failed; null when it worked. */
  error: string | null;
}

/** The issues moonlet created, per workspace, until a sync has them (X52). */
let created: (Created & { ws: string })[] = [];

/** The notice for a new issue the board doesn't show (X52), with a link to it. */
function notShown(task: Task) {
  toast(`Created ${task.key}; this board doesn't show it`, "info", { label: "Open", run: () => void openUrl(task.url) });
}

/** Asks the board's tracker to create the issue in `status` (X52): GitHub through gh on the host, the others through the app. */
/** What creating left (X52): the issue, what failed once it existed (the notice after "Created <key>"), and whether the board can't show it (`off`). */
interface CreateResult {
  task: Task;
  failed?: string;
  off?: boolean;
}

async function createInTracker(host: string, workspaceId: string, board: BoardConfig, column: BoardColumn, draft: NewIssue, status: string): Promise<CreateResult> {
  const repo = githubRepoOf(board, draft.place);
  if (board.origin.kind === "github_repo" || board.origin.kind === "github_project") {
    if (!repo) throw new Error("Pick the repository the issue goes in");
    // A Project's issue needs the Project the board read: checked before anything is created.
    const meta = useTasks.getState().data[wsKey(host, workspaceId)]?.boards?.[board.id]?.project;
    if (board.origin.kind === "github_project" && !meta) throw new Error("The board hasn't read its Project yet; refresh it first");
    const req = { repo, title: draft.title, body: draft.description, assignee: draft.assignee, labels: draft.labels };
    const created = await rpc<GhCreated>(host, M.ghIssueCreate, req);
    const task = taskFromGh(created.task, GITHUB);
    return meta && board.origin.kind === "github_project" ? addToProject(host, meta, created.node, task, status) : { task };
  }
  const sprint = board.finished === "sprint" ? useTasks.getState().data[wsKey(host, workspaceId)]?.boards?.[board.id]?.sprint?.id : undefined;
  const answer = await hostsApi.trackerCreate({
    id: board.connection,
    place: placeOf(board, draft.place),
    issue: { ...draft, status },
    inCycle: board.finished === "sprint",
    statuses: column.statuses,
    column: column.name,
    ...(sprint !== undefined && { sprint }),
  });
  return { task: taskFromBoardIssue(answer.issue), ...(answer.failed && { failed: answer.failed }) };
}

/**
 * A new issue added to the board's GitHub Project and given the column's
 * Status (X52); `""` (No Status) sets none. Once the issue exists a failure
 * is reported, not thrown: not added, the board can't show it (`off`).
 */
async function addToProject(host: string, meta: ProjectMeta, node: string, task: Task, status: string): Promise<CreateResult> {
  let item: string;
  try {
    item = await rpc<string>(host, M.ghProjectAdd, { project: meta.id, content: node });
  } catch (e) {
    return { task, failed: `; adding it to the Project failed: ${errorMessage(e)}`, off: true };
  }
  const inProject = (option: string | null): Task => ({ ...task, github: { ...task.github!, project: { id: meta.id, item, status: meta.options.find((o) => o.id === option)?.name ?? null, option } } });
  const req = status === "" ? null : projectMove(meta, item, status);
  if (!req && status !== "") return { task: inProject(null), failed: `; setting its Status failed: ${meta.field ? "the Project has no such option" : "the Project has no Status field"}` };
  if (!req) return { task: inProject(null) };
  try {
    await rpc(host, M.ghProjectMove, req);
    return { task: inProject(req.option) };
  } catch (e) {
    return { task: inProject(null), failed: `; setting its Status failed: ${errorMessage(e)}` };
  }
}

/** Where a new issue goes in the tracker (X52): a Linear team, a ClickUp list, or the Jira project picked. */
function placeOf(board: BoardConfig, place?: string): string {
  if (board.origin.kind === "linear_team") return board.origin.team;
  if (board.origin.kind === "clickup_list") return board.origin.list;
  if (isJira(board)) {
    if (!place) throw new Error("Pick the project the issue goes in");
    return place;
  }
  throw new Error("moonlet can't create issues on this board yet");
}

/** The new-issue form's lists for a board (X52): the user, the people and the labels, and whether they can be set. */
export async function createOptions(
  host: string,
  board: BoardConfig,
  place?: string,
  issueType?: string,
): Promise<{ me: string; people: { id: string; name: string }[]; labels: { id: string; name: string }[]; canSet: boolean; issueTypes?: { id: string; name: string }[]; missing?: string[]; fields?: string[] }> {
  if (board.origin.kind === "github_repo" || board.origin.kind === "github_project") {
    // GitHub through gh on the workspace's host; people and labels by login and name. A Project's, of the repository picked.
    const repo = githubRepoOf(board, place);
    if (!repo) return { me: "", people: [], labels: [], canSet: true };
    const o = await rpc<GhCreateChoices>(host, M.ghCreateOptions, { repo });
    const named = (xs: string[]) => xs.map((x) => ({ id: x, name: x }));
    return { me: o.me, people: named(o.people), labels: named(o.labels), canSet: o.can_set };
  }
  // A Jira project's lists come with its issue types and what the type's create screen requires.
  if (isJira(board) && !place) return { me: "", people: [], labels: [], canSet: true };
  return { ...(await hostsApi.trackerCreateOptions(board.connection, placeOf(board, place), issueType)), canSet: true };
}

/**
 * Creates an issue from `column`'s + (X52), in its first status. Its card
 * shows there at once, selected, with "moonlet created it" in its Activity;
 * when the board can't show it, a notice says so. A tracker's refusal is
 * thrown, for the form to show.
 */
export async function createIssue(host: string, workspaceId: string, board: BoardConfig, column: BoardColumn, draft: NewIssue, onFailed?: (text: string) => void): Promise<Task> {
  const target = createTarget(board, column);
  if (!target) throw new Error(`${column.name} takes no new issues`);
  const result = await createInTracker(host, workspaceId, board, column, draft, target.status);
  // When the tracker answered: a sync that started before this may not have it yet.
  const now = Date.now();
  const columns = syncedColumns(board, null);
  // The card shows the Markdown typed until a sync reads the tracker's own copy (ClickUp answers with plain text).
  const [task] = categorize(columns, [{ ...result.task, ...(draft.description && { description: draft.description }), mine: draft.assignee === "me" }]);
  // Once the issue exists, a later step that failed is said, with what was done (X52).
  if (result.failed) {
    toast(`Created ${task.key}${result.failed}`, "error", { label: "Open", run: () => void openUrl(task.url) });
    onFailed?.(`Created ${task.key}${result.failed}`);
  }
  // Not on the board: nothing of it to show or record here.
  if (result.off) return task;
  recordActivity(task, "moonlet created it", now);
  // Its column is moonlet's doing, not a move made outside it (X44).
  movedByMoonlet.set(taskId(task), task.column);
  if (!boardShows(board, assigneeOf(board, useTasks.getState().assignee), columns, task)) {
    notShown(task);
    return task;
  }
  const key = wsKey(host, workspaceId);
  const entry = { boardId: board.id, task, at: now };
  created.push({ ...entry, ws: key });
  useTasks.setState((st) => {
    const d = st.data[key];
    const merged = d ? withCreated({ tasks: d.tasks, boards: d.boards }, [entry], now) : null;
    return { selected: taskId(task), ...(d && merged && { data: { ...st.data, [key]: { ...d, tasks: merged.tasks, boards: merged.boards } } }) };
  });
  return task;
}

/** When each host's gh scopes were last read. */
const scopesReadAt = new Map<string, number>();

/** Refresh reads everything again: gh's scopes too, at the next GitHub Project sync. */
export function forgetGhScopes(host: string) {
  scopesReadAt.delete(host);
}

/** The user's own items, then the others' that `keep` lets join (Assignee: anyone), each once by `key`. */
function ownAndOthers<T>(own: T[], all: T[] | null, key: (t: T) => string | number, keep: (t: T) => boolean = () => true): { it: T; mine: boolean }[] {
  const ownKeys = new Set(own.map(key));
  return [...own.map((it) => ({ it, mine: true })), ...(all ?? []).filter((t) => !ownKeys.has(key(t)) && keep(t)).map((it) => ({ it, mine: false }))];
}

/**
 * One board's tasks (X50): a GitHub repository's through `gh` on a project
 * with that origin, a tracker's through the app. The account's own, and with
 * Assignee: me off, everyone's open ones too.
 */
/** The last sync's id; from the clock, so a reloaded window starts past the app's earlier syncs. */
let lastSync = Date.now();

/** A board's issues; `sync` names the sync it is read in, none for a preview, which reads everything afresh. */
async function readBoard(host: string, b: BoardConfig, projects: { path: string; repo: string | null }[], everyoneToo: boolean, sync?: number): Promise<BoardRead> {
  const r = await readOrigin(host, b, projects, everyoneToo, sync);
  // A label filter keeps the issues with any of its labels (X50 Issues).
  const labels = new Set((b.labels ?? []).map((l) => l.toLowerCase()));
  return labels.size ? { ...r, tasks: r.tasks.filter((t) => t.labels.some((l) => labels.has(l.toLowerCase()))) } : r;
}

async function readOrigin(host: string, b: BoardConfig, projects: { path: string; repo: string | null }[], everyoneToo: boolean, sync?: number): Promise<BoardRead> {
  const none = (error: string | null): BoardRead => ({ tasks: [], columns: null, sprint: null, error });
  if (b.origin.kind === "github_repo") {
    const repo = b.origin.repo.toLowerCase();
    const p = projects.find((x) => x.repo?.toLowerCase() === repo);
    if (!p) return { ...none(null), columns: b.columns?.length ? null : GITHUB_REPO_COLUMNS };
    const ask = (mine: boolean) => rpc<GhTask[]>(host, M.ghTasks, { path: p.path, mine });
    try {
      const [own, all] = await Promise.all([ask(true), everyoneToo ? ask(false) : []]);
      // `gh.tasks` without `mine` also gives closed issues: only others' open ones join.
      const list = ownAndOthers(own, all, (gh) => gh.number, (gh) => !gh.closed);
      return { tasks: list.map(({ it, mine }) => ({ ...taskFromGh(it, GITHUB), mine })), columns: b.columns?.length ? null : GITHUB_REPO_COLUMNS, sprint: null, error: null };
    } catch (e) {
      return none(errorMessage(e));
    }
  }
  if (b.origin.kind === "github_project") {
    // A GitHub Project (X50): its issues with their Status, its columns from the Status options.
    const { owner, number } = b.origin;
    const ask = (mine: boolean) => rpc<GhProjectBoard>(host, M.ghProjectItems, { owner, number, mine });
    try {
      const [own, all] = await Promise.all([ask(true), everyoneToo ? ask(false) : null]);
      const list = ownAndOthers(own.items, all?.items ?? null, (i) => i.item);
      const columns = await hostsApi.githubProjectColumns(own.options);
      // Whether its items can be moved: gh's project scope (X50), read at most once a minute.
      if (Date.now() - (scopesReadAt.get(host) ?? 0) > 60_000) {
        scopesReadAt.set(host, Date.now());
        void rpc<string[]>(host, M.ghScopes, {}).then(
          (scopes) => useTasks.setState((t) => ({ ghScopes: { ...t.ghScopes, [host]: scopes } })),
          () => scopesReadAt.delete(host),
        );
      }
      const project = { id: own.id, field: own.status_field, options: own.options, numberField: own.number_field ?? null };
      // Its columns hold option ids; step 3 names them by the options' names.
      const statusNames = { "": NO_STATUS, ...Object.fromEntries(own.options.map((o) => [o.id, o.name])) };
      return { tasks: list.map(({ it, mine }) => ({ ...taskFromProjectItem(it, GITHUB, own.id, own.options), mine })), columns, sprint: null, project, statusNames, error: null };
    } catch (e) {
      return none(errorMessage(e));
    }
  }
  // A rejected token is not tried again until the user reconnects (X44).
  if (useTasks.getState().attention[b.connection] !== undefined) return none("");
  const query = (mine: boolean) => hostsApi.trackerBoardTasks({ id: b.connection, origin: b.origin, narrow: b.narrow, mine, finished: b.finished ?? 14, ...(sync !== undefined && { sync }) });
  try {
    const own = await query(true);
    const everyone = everyoneToo ? await query(false) : null;
    const ownKeys = new Set(own.issues.map((t) => t.key));
    const seen = new Set((everyone?.issues ?? []).map((t) => t.key));
    const tasks = [
      ...(everyone?.issues ?? []).map((t) => ({ ...taskFromBoardIssue(t), mine: ownKeys.has(t.key) })),
      ...own.issues.filter((t) => !seen.has(t.key)).map((t) => ({ ...taskFromBoardIssue(t), mine: true })),
    ];
    return { tasks, columns: own.columns, sprint: own.sprint, ...(own.kind && { kind: own.kind }), ...(own.statusNames && { statusNames: own.statusNames }), error: null };
  } catch (e) {
    const err = e as { auth?: boolean; message?: string };
    const text = err.message ?? errorMessage(e);
    if (!err.auth) return none(text);
    // Its own row says what to do (X44); the workspace shows no sync error for it.
    useTasks.setState((t) => ({ attention: { ...t.attention, [b.connection]: text } }));
    return none("");
  }
}

/**
 * Tasks moonlet itself moved, `connection key` → the column it moved them to.
 * Their move is not news; each entry stays until a sync shows that column, so
 * a sync that started before the move cannot report it.
 */
const movedByMoonlet = new Map<string, Task["column"]>();

/** "Notify when a task changes state outside moonlet" (X44): linked tasks only. */
function notifyOutsideMoves(host: string, workspaceId: string, before: Task[] | null, data: TasksData) {
  const board = tasksBoard(boardInput(useStore.getState(), host, workspaceId, data));
  const linked = new Set(Object.values(board).flat().filter((c) => c.rows.length).map((c) => `${c.task.connection} ${c.task.key}`));
  for (const m of outsideMoves(before, data.tasks, linked, movedByMoonlet)) {
    void notify(m.text, m.title);
    const t = data.tasks.find((x) => `${x.connection} ${x.key}` === m.id);
    if (t) recordActivity(t, `Outside moonlet: ${m.text}`);
  }
  forgetSeenMoves(data.tasks);
}

function forgetSeenMoves(tasks: Task[]) {
  for (const t of tasks) {
    const id = `${t.connection} ${t.key}`;
    const to = movedByMoonlet.get(id);
    if (to && (to === t.column || (to === "done" && t.column === "hidden"))) movedByMoonlet.delete(id);
  }
}

/** Tasks in the columns the user's state mapping puts them in (X44). */
export function placedTasks(data: Pick<TasksData, "tasks" | "boards">, config: TrackersConfig = trackersConfig(useTasks.getState())): Task[] {
  return placeOnBoards(data.tasks, data.boards, config.boards);
}

/** `moving` less the `settled` moves, unless one moved again since. A task no board has any more is not read again either, so its move goes too. */
function withoutMoves(moving: Record<string, Moving>, settled: [string, Moving][]): Record<string, Moving> {
  const left = { ...moving };
  for (const [id, m] of settled) if (left[id] === m) delete left[id];
  return left;
}

/** Tasks with their moves under way shown done (X53). */
function shownMoved(tasks: Task[]): Task[] {
  const moving = useTasks.getState().moving;
  return tasks.map((t) => {
    const m = moving[taskId(t)];
    return m ? withStatus(t, m.status, m.name) : t;
  });
}

/**
 * The GitHub repository of project `projectId` on host `h`, from the tasks of
 * workspace data kept under `host`: on another member, that of `host`'s
 * project of the same identity (X68).
 */
export function originRepoOf(s: Pick<StoreState, "projects">, host: string, data: Pick<TasksData, "repos">, h: string, projectId: string): string | null {
  if (h === host) return data.repos[projectId] ?? null;
  const identity = s.projects[h]?.find((p) => p.id === projectId)?.identity;
  const own = identity?.root ? s.projects[host]?.find((p) => p.identity?.root === identity.root && p.identity?.origin === identity.origin) : undefined;
  return own ? (data.repos[own.id] ?? null) : null;
}

/** What the board needs of a workspace's sessions (X45). */
/**
 * What a workspace's board is built from. `members` are the hosts of the
 * workspace's account that list it, its own host first (X68): their sessions
 * show too, each with its host, and with the GitHub repository of the
 * board's own project of the same identity.
 */
export function boardInput(s: StoreState, host: string, workspaceId: string, data: TasksData, config: TrackersConfig = DEFAULT_CONFIG, members: string[] = [host]): BoardInput {
  const repoOf = (h: string, projectId: string) => originRepoOf(s, host, data, h, projectId);
  const sessions: BoardSession[] = members.flatMap((h) =>
    (s.sessions[h] ?? [])
      .filter((x) => x.workspace_id === workspaceId)
      .map((x) => ({
        id: x.id,
        ...(h !== host && { host: h }),
        name: x.name,
        branch: x.branch,
        path: x.path,
        archived: x.archived,
        task: x.task ?? null,
        task_unlinked: !!x.task_unlinked,
        state: sessionState(s, h, x.id),
        pr: s.prs[sesKey(h, x.id)] ?? null,
        additions: s.git[sesKey(h, x.id)]?.additions ?? 0,
        deletions: s.git[sesKey(h, x.id)]?.deletions ?? 0,
        project: s.projects[h]?.find((p) => p.id === x.project_id)?.name,
        agents: sessionTerminals(s, h, x.id)
          .filter((t) => t.kind === "agent")
          .map((t) => ({ name: t.agent ?? "agent", state: t.agent_state, since: t.last_output_at })),
        subagents: sessionTerminals(s, h, x.id).reduce((n, t) => n + (t.subagents ?? 0), 0),
        originRepo: repoOf(h, x.project_id),
      })),
  );
  return {
    // The board's columns as saved now, so a change shows without a sync (X44, X50).
    tasks: placedTasks({ ...data, tasks: shownMoved(data.tasks) }, config),
    sessions,
    worktrees: data.worktrees,
    sessionStartRule: (t) => rulesFor(config, t).session_starts,
    link: config.link ?? DEFAULT_LINK,
  };
}

/**
 * Where a move of `task` to `category` lands (X50): on the board the task
 * came from, `status` or else the first status of its first column of that
 * category, and that column's name; no status when the task is on no board
 * with columns.
 */
function boardTarget(host: string, workspaceId: string, task: Pick<Task, "connection" | "key" | "github">, category: Category, status?: string): { status?: string; name: string } {
  const columns = taskColumns(host, workspaceId, task);
  const to = status ?? statusFor(columns, category) ?? undefined;
  // Named as the tracker names the column (X50).
  return { status: to, name: columns.find((c) => to !== undefined && c.statuses.includes(to))?.name ?? COLUMN_LABEL[category] };
}

/** Sets a GitHub Project item's Status to `status` (X50), through gh on `host`. */
async function moveProjectItem(host: string, workspaceId: string, task: Task, status: string) {
  const data = useTasks.getState().data[wsKey(host, workspaceId)];
  // The item's own Project: the same issue can be on two.
  const own = task.github?.project;
  const meta = Object.values(data?.boards ?? {}).find((b) => b.project && b.project.id === own?.id)?.project;
  const item = own?.item;
  const req = meta && item ? projectMove(meta, item, status) : null;
  if (!req) throw new Error("The Project no longer has that Status option");
  await rpc(host, M.ghProjectMove, req);
}

/** The columns of the board `task` came from (X50), or none. */
export function taskColumns(host: string, workspaceId: string, task: Pick<Task, "connection" | "key" | "github">): BoardColumn[] {
  const data = useTasks.getState().data[wsKey(host, workspaceId)];
  // A GitHub Project's item belongs to its own Project's board.
  const projectId = task.github?.project?.id;
  const board = trackersConfig(useTasks.getState()).boards?.find((b) => {
    const d = data?.boards?.[b.id];
    return projectId ? d?.project?.id === projectId : d?.keys.includes(taskId(task));
  });
  return board ? syncedColumns(board, null) : [];
}

/** Shows, folds or hides a column of board `boardId` (X50). */
export function setColumnShow(boardId: string, name: string, show: ColumnShow) {
  void saveTrackersConfig((c) => ({ ...c, boards: c.boards?.map((b) => (b.id === boardId ? withColumnShow(b, name, show) : b)) })).catch((e) => errorToast(e));
}

/** The project path of a workspace project in GitHub repository `repo`. */
export function repoPath(host: string, workspaceId: string, repo: string): string | null {
  const repos = useTasks.getState().data[wsKey(host, workspaceId)]?.repos ?? {};
  const id = Object.keys(repos).find((p) => repos[p]?.toLowerCase() === repo.toLowerCase());
  return useStore.getState().projects[host]?.find((p) => p.id === id)?.path ?? null;
}

/**
 * The task a pasted key or URL names when it is not among the loaded ones
 * (X46 link dialog): GitHub through the project's `gh` (`#7` is that number
 * in `originRepo`), else each connection of the named tracker and site.
 * Null when none has it.
 */
export async function lookUpPasted(host: string, projectPath: string, p: Pasted, originRepo: string | null): Promise<Task | null> {
  if (p.kind === "github") {
    const m = /^(?:(.+))?#(\d+)$/.exec(p.key);
    const repo = m?.[1] ?? originRepo;
    if (!m || !repo) return null;
    const gh = await rpc<GhTask>(host, M.ghTask, { path: projectPath, repo, number: Number(m[2]) }).catch(() => null);
    // Whose it is is not known for a pasted issue.
    return gh ? { ...taskFromGh(gh, GITHUB), mine: undefined } : null;
  }
  const site = p.site?.toLowerCase();
  const conns = (trackersConfig(useTasks.getState()).connections ?? []).filter((c) => (!p.kind || c.kind === p.kind) && (!site || c.site.toLowerCase() === site));
  for (const c of conns) {
    const found = await hostsApi.trackerTask(c.id, p.key).catch(() => null);
    if (found) return found;
  }
  return null;
}

/** "Not now" on a chip: hidden until the task or its sessions change. */
export function putOffDrift(card: Card) {
  useTasks.setState((t) => ({ notNow: { ...t.notNow, [driftKey(card)]: true } }));
}

const COLUMN_LABEL = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" } as const;

/** The "session starts" rule after a session started from a task with the box ticked (X46):
 *  a GitHub issue is assigned; a tracker issue moves to In Progress and is assigned. */
/** Returns why the task could not be moved or assigned, or null. */
export async function startedFromTask(host: string, workspaceId: string, start: TaskStart, opts: { session: string; assign: boolean }, now = Date.now()): Promise<string | null> {
  recordActivity({ connection: start.ref.connection, key: start.key }, `Session “${opts.session}” started from it`, now);
  // Keep in step: the "session starts" rule, as the composer's box was left.
  if (!opts.assign) return null;
  if (start.github) return assignToMe(host, workspaceId, start.github);
  if (!start.tracker) return null;
  const id = `${start.ref.connection} ${start.key}`;
  movedByMoonlet.set(id, "in_progress");
  try {
    const { status, name } = boardTarget(host, workspaceId, { connection: start.ref.connection, key: start.key }, "in_progress");
    await hostsApi.trackerUpdate({
      id: start.ref.connection,
      task: start.tracker.id,
      source: start.tracker.source,
      column: "in_progress",
      ...(status && { status }),
      assign_me: true,
    });
    recordActivity({ connection: start.ref.connection, key: start.key }, `moonlet moved it to ${name} and assigned it to you`, now + 1);
    return null;
  } catch (e) {
    movedByMoonlet.delete(id);
    toast(`${start.key}: ${errorMessage(e)}`, "error");
    return `${start.key}: ${errorMessage(e)}`;
  }
}

/** Assigns a GitHub issue to the user, as the "session starts" rule does (X46); returns why it could not, or null. */
export async function assignToMe(host: string, workspaceId: string, github: { repo: string; number: number }): Promise<string | null> {
  const key = `${github.repo}#${github.number}`;
  try {
    const path = repoPath(host, workspaceId, github.repo);
    if (!path) throw new Error(`No project in this workspace has ${github.repo} as its origin`);
    await rpc(host, M.ghTaskUpdate, { path, number: github.number, assign_me: true });
    recordActivity({ connection: GITHUB, key }, "moonlet assigned it to you");
    return null;
  } catch (e) {
    toast(`${key}: ${errorMessage(e)}`, "error");
    return `${key}: ${errorMessage(e)}`;
  }
}

// A gh login that worked, per host, and when it was asked: asked again after a minute.
const ghLogins = new Map<string, { login: string; at: number }>();

/**
 * `{user}` in branch names (X44): the first name of the tracker account,
 * lower case, or the `gh` login on the host (asked once per host).
 */
export async function branchUser(host: string, connection: string, now = Date.now()): Promise<string> {
  if (trackerOf(connection) === "github") {
    const known = ghLogins.get(host);
    if (known && now - known.at < 60_000) return known.login;
    try {
      const login = await rpc<string>(host, M.ghWhoami, {});
      ghLogins.set(host, { login, at: now });
      return login;
    } catch {
      // Not signed in (yet): nothing to remember.
      return "";
    }
  }
  const account = trackersConfig(useTasks.getState()).connections?.find((c) => c.id === connection)?.account ?? "";
  return account.split(/\s+/)[0].toLowerCase();
}

/** A connection the user signed in to again, or forgot: its attention dot goes (X44). */
export function reconnected(id: string) {
  useTasks.setState((t) => ({ attention: Object.fromEntries(Object.entries(t.attention).filter(([k]) => k !== id)) }));
}

/** A task's card on the workspace's board as it is now. */
function currentCard(host: string, workspaceId: string, id: string): Card | undefined {
  const data = useTasks.getState().data[wsKey(host, workspaceId)];
  if (!data) return undefined;
  const config = trackersConfig(useTasks.getState());
  const board = applyRules(tasksBoard(boardInput(useStore.getState(), host, workspaceId, data, config)), (c) => rulesFor(config, c.task));
  return Object.values(board)
    .flat()
    .find((c) => `${c.task.connection} ${c.task.key}` === id);
}

/** Runs a chip's fix; true when it was done (a declined Clean up is not). */
export async function fixDrift(host: string, workspaceId: string, card: Card, opts: { confirmed?: boolean } = {}): Promise<boolean> {
  const plan = driftFix(card);
  if (!plan) return false;
  const id = `${card.task.connection} ${card.task.key}`;
  // Retry looks again: the task may have moved since, or need another fix.
  retries.set(id, async () => {
    const now = currentCard(host, workspaceId, id);
    // Retry on the Mac asks as the Mac does, whoever asked first.
    if (now?.drift) await fixDrift(host, workspaceId, now);
    else setFailure(card.task, null);
  });
  try {
    if (plan.kind === "github") {
      const path = repoPath(host, workspaceId, plan.repo);
      if (!path) throw new Error(`No project in this workspace has ${plan.repo} as its origin`);
      movedByMoonlet.set(id, "done");
      await rpc(host, M.ghTaskUpdate, { path, number: plan.number, close: true });
      recordActivity(card.task, "moonlet closed it: every session's PR is merged");
      toast(`Closed ${card.task.key}`);
    } else if (plan.kind === "project") {
      movedByMoonlet.set(id, plan.column);
      await moveProjectItem(host, workspaceId, card.task, plan.status);
      recordActivity(card.task, `moonlet moved it to ${plan.name}`);
      toast(`Moved ${card.task.key} to ${plan.name}`);
    } else if (plan.kind === "move") {
      const t = card.task.tracker;
      if (!t) return false;
      movedByMoonlet.set(id, plan.column);
      const target = boardTarget(host, workspaceId, card.task, plan.column, plan.status);
      const status = target.status;
      await hostsApi.trackerUpdate({ id: card.task.connection, task: t.id, source: t.source, column: plan.column, ...(status && { status }) });
      const to = plan.name ?? target.name;
      recordActivity(card.task, `moonlet moved it to ${to}`);
      toast(`Moved ${card.task.key} to ${to}`);
    } else {
      const sessions = useStore.getState().sessions[host]?.filter((s) => plan.sessions.includes(s.id)) ?? [];
      const paths = [...sessions.map((s) => s.path), ...plan.worktrees];
      const dirty: string[] = [];
      const unchecked: string[] = [];
      for (const path of paths) {
        const st = await rpc<{ files: unknown[] }>(host, M.gitStatus, { path }).catch(() => null);
        if (!st) unchecked.push(path);
        else if (st.files.length) dirty.push(path);
      }
      if (opts.confirmed && unchecked.length) throw new Error(`${card.task.key}: moonlet could not check ${unchecked.join(", ")} for uncommitted changes. Clean it up in moonlet on the Mac.`);
      // A phone asked on its own screen first (X76), but cannot know about
      // uncommitted changes: those are left for the Mac's own warning.
      if (opts.confirmed && dirty.length) throw new Error(`${card.task.key} has uncommitted changes in ${dirty.join(", ")}. Clean it up in moonlet on the Mac.`);
      const ok =
        opts.confirmed ||
        (await askConfirm({
          title: `Clean up ${card.task.key}?`,
          message: cleanUpMessage(sessions.length, plan.worktrees.length, dirty),
          action: "Clean up",
          variant: dirty.length ? "danger" : "primary",
        }));
      if (!ok) return false;
      for (const s of sessions) await rpc(host, M.sessionArchive, { id: s.id, remove_worktree: true });
      for (const w of card.orphans) if (w.project) await rpc(host, M.projectWorktreeRemove, { id: w.project, path: w.path });
      recordActivity(card.task, "moonlet archived its sessions and removed their worktrees");
    }
    setFailure(card.task, null);
    await refreshTasks(host, workspaceId);
    return true;
  } catch (e) {
    movedByMoonlet.delete(id);
    setFailure(card.task, errorMessage(e));
    return false;
  }
}

// Automatic fixes tried since the app started: a failure shows on its task
// with Retry instead of being tried again on every board change.
// Failures are kept across restarts, so "not tried again by itself" holds.
const AUTO_FAILED_KEY = "tasks.autoFailed";
const autoTried = new Set<string>(storedList(AUTO_FAILED_KEY));

function storedList(name: string): string[] {
  try {
    const v = JSON.parse(readStored(name) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** An automatic fix or comment that failed: shown with Retry, not tried again by itself. */
function autoFailed(key: string) {
  autoTried.add(key);
  writeStored(AUTO_FAILED_KEY, JSON.stringify([...new Set([...storedList(AUTO_FAILED_KEY), key])].slice(-200)));
}

/**
 * The rules at Automatically, run once each (X46): chips' fixes and PR-link
 * comments. Each is remembered across restarts only when it worked.
 */
export async function runAutoFixes(host: string, workspaceId: string, board: Board, rulesOf: (c: Card) => Rules, now = Date.now()) {
  const done = autoFixed();
  // "PR opened" in each task's Activity, once per PR (X45).
  for (const card of Object.values(board).flat())
    for (const { session } of card.rows) {
      const pr = session.pr;
      const key = `opened ${card.task.connection} ${card.task.key} ${pr?.url}`;
      if (pr?.state !== "open" || pr.draft || done[key]) continue;
      markAutoFixed(key);
      recordActivity(card.task, `PR #${pr.number} opened: ${pr.title}`, now);
    }
  for (const card of autoFixes(board, rulesOf, done)) {
    const key = driftKey(card);
    if (autoTried.has(key)) continue;
    autoTried.add(key);
    if (await fixDrift(host, workspaceId, card)) markAutoFixed(key);
    else autoFailed(key);
  }
  for (const c of prComments(board, rulesOf, done)) {
    const t = c.card.task.tracker;
    if (!t || autoTried.has(c.key)) continue;
    autoTried.add(c.key);
    const id = `${c.card.task.connection} ${c.card.task.key}`;
    // A task shows one failure: the comment's own only when nothing else failed.
    const comment = async () => {
      try {
        await hostsApi.trackerUpdate({ id: c.card.task.connection, task: t.id, source: t.source, comment: c.text });
        markAutoFixed(c.key);
        if (failedBy.get(id) === "comment") setFailure(c.card.task, null);
        recordActivity(c.card.task, "moonlet commented with the pull request's link");
      } catch (e) {
        autoFailed(c.key);
        // The task already shows another failure: its Retry sends the comment too.
        const before = failureOf(c.card.task) ? retries.get(id) : undefined;
        retries.set(id, async () => {
          await before?.();
          await comment();
        });
        if (!before) setFailure(c.card.task, errorMessage(e), "comment");
      }
    };
    await comment();
  }
}

/**
 * Keeps a workspace's tasks fresh while Tasks mode shows it (X44 Sync): now,
 * every `interval` seconds and when the window comes to the front, at most
 * every 15 s. Manual (0) refreshes only now and on demand. Returns the stop.
 */
export function syncTasks(host: string, workspaceId: string, interval: number): () => void {
  const sync = () => void refreshTasks(host, workspaceId);
  sync();
  if (interval <= 0) return () => {};
  const due = focusThrottle(15_000);
  const onFocus = () => due(Date.now()) && sync();
  window.addEventListener("focus", onFocus);
  const timer = setInterval(sync, interval * 1000);
  return () => {
    window.removeEventListener("focus", onFocus);
    clearInterval(timer);
  };
}

/** The out-of-sync dot needs the tasks: asked for now and every 5 minutes, also in Sessions mode (X45). Returns the stop. */
export function pollTasks(host: string, workspaceId: string): () => void {
  ensureTasks(host, workspaceId);
  const timer = setInterval(() => ensureTasks(host, workspaceId), 300_000);
  return () => clearInterval(timer);
}

/** Loads a workspace's tasks when a linked session opens outside Tasks mode, at most once a minute (X46). */
export function ensureTasks(host: string, workspaceId: string, now = Date.now()) {
  const key = wsKey(host, workspaceId);
  if (ensuring.has(key)) return;
  const d = useTasks.getState().data[key];
  // Once there is a list: never by itself under manual Sync, else at most a
  // minute after the last try, whether or not it worked.
  const last = Math.max(ensuredAt.get(key) ?? -Infinity, d?.syncedAt ?? -Infinity);
  if (d && (trackersConfig(useTasks.getState()).sync.interval === 0 || now - last < 60_000)) return;
  ensuring.add(key);
  ensuredAt.set(key, now);
  void refreshTasks(host, workspaceId, now).finally(() => ensuring.delete(key));
}
const ensuring = new Set<string>();
const ensuredAt = new Map<string, number>();

/** Links a session to a task, or unlinks it with null (X46). */
export async function linkTask(host: string, sessionId: string, task: Task | null) {
  try {
    await rpc(host, M.sessionUpdate, { id: sessionId, task: task ? { connection: task.connection, key: task.key, url: task.url } : null });
    toast(task ? `Linked to ${task.key}` : "Unlinked the task");
  } catch (e) {
    errorToast(e);
  }
}

const ACTIVITY_KEY = "tasks.activity";

function readActivity(): Record<string, ActivityEntry[]> {
  try {
    return JSON.parse(readStored(ACTIVITY_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** What moonlet did about a task, newest first (the detail panel's Activity, X45). */
export function activityOf(task: Pick<Task, "connection" | "key">): ActivityEntry[] {
  return useTasks.getState().activity[`${task.connection} ${task.key}`] ?? readActivity()[`${task.connection} ${task.key}`] ?? [];
}

/** Records something moonlet did about a task, kept across restarts. */
export function recordActivity(task: Pick<Task, "connection" | "key">, text: string, now = Date.now()) {
  const id = `${task.connection} ${task.key}`;
  const all = { ...readActivity(), ...useTasks.getState().activity };
  const next = { ...all, [id]: appendActivity(all[id] ?? [], { at: now, text }) };
  try {
    writeStored(ACTIVITY_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  useTasks.setState({ activity: next });
}

/**
 * The state menu (X45 detail, X46 task bar) and a card's drop (X53): move a
 * tracker issue, or close or reopen a GitHub issue. The card shows in its
 * new column at once, and goes back if the move is refused.
 */
export async function moveTask(host: string, workspaceId: string, task: Task, column: Exclude<Column, "hidden"> | null, now = Date.now(), toStatus?: string) {
  const id = taskId(task);
  retries.set(id, () => moveTask(host, workspaceId, task, column, Date.now(), toStatus));
  // The move under way, shown on the board at once (X53).
  let move: Moving | null = null;
  const start = (status: string | undefined, name: string): Moving | null => {
    if (status === undefined) return null;
    const m = { status, name, done: false };
    useTasks.setState((t) => ({ moving: { ...t.moving, [id]: m } }));
    return m;
  };
  try {
    if (task.github?.project) {
      // A GitHub Project's item: its Status, set to the column's (X50); never the issue itself.
      if (!column) return;
      const { status, name } = boardTarget(host, workspaceId, task, column, toStatus);
      if (status === undefined) throw new Error(`The Project has no ${name} column`);
      movedByMoonlet.set(id, column);
      move = start(status, name);
      await moveProjectItem(host, workspaceId, task, status);
      recordActivity(task, `moonlet moved it to ${name}`, now);
    } else if (task.github) {
      const path = repoPath(host, workspaceId, task.github.repo);
      if (!path) throw new Error(`No project in this workspace has ${task.github.repo} as its origin`);
      const close = column === "done";
      movedByMoonlet.set(id, close ? "done" : "open");
      move = start(close ? "completed" : "open", close ? "Closed" : "Open");
      await rpc(host, M.ghTaskUpdate, close ? { path, number: task.github.number, close: true } : { path, number: task.github.number, reopen: true });
      recordActivity(task, close ? "moonlet closed it" : "moonlet reopened it", now);
    } else if (task.tracker && column) {
      movedByMoonlet.set(id, column);
      const { status, name } = boardTarget(host, workspaceId, task, column, toStatus);
      move = start(status, name);
      await hostsApi.trackerUpdate({ id: task.connection, task: task.tracker.id, source: task.tracker.source, column, ...(status && { status }) });
      recordActivity(task, `moonlet moved it to ${name}`, now);
    } else return;
    // Taken: the next sync to read the task places its card (X53).
    const taken = move;
    if (taken) useTasks.setState((t) => (t.moving[id] === taken ? { moving: { ...t.moving, [id]: { ...taken, done: true } } } : {}));
    setFailure(task, null);
    void refreshTasks(host, workspaceId);
  } catch (e) {
    const refused = move;
    if (refused)
      useTasks.setState((t) => {
        if (t.moving[id] !== refused) return {};
        const moving = { ...t.moving };
        delete moving[id];
        return { moving };
      });
    movedByMoonlet.delete(id);
    const why = errorMessage(e);
    setFailure(task, why);
    toast(`${task.key}: ${why}`, "error");
  }
}

/** What to run again for a task whose last action failed. */
const retries = new Map<string, () => Promise<void>>();

/** What made a task's shown failure: a chip fix or move, or a PR-link comment. */
const failedBy = new Map<string, "action" | "comment">();

function setFailure(task: Pick<Task, "connection" | "key">, error: string | null, by: "action" | "comment" = "action") {
  const id = `${task.connection} ${task.key}`;
  if (error) failedBy.set(id, by);
  else failedBy.delete(id);
  useTasks.setState((t) => {
    const failures = { ...t.failures };
    if (error) failures[id] = error;
    else delete failures[id];
    return { failures };
  });
}

/** The error of a task's last failed action, if it failed. */
export function failureOf(task: Pick<Task, "connection" | "key">): string | undefined {
  return useTasks.getState().failures[`${task.connection} ${task.key}`];
}

/** Retry on a task's failed action. */
export async function retryTask(task: Pick<Task, "connection" | "key">) {
  await retries.get(`${task.connection} ${task.key}`)?.();
}

const OFF: Rules = { session_starts: "off", pr_opens: "off", all_merged: "off", pr_comment: "off", issue_done: "off" };

/** The rules for a task: its tracker's, or all off when its Keep in step switch is off (X46). */
export function rulesFor(config: TrackersConfig, task: Pick<Task, "connection" | "key">): Rules {
  return useTasks.getState().paused[`${task.connection} ${task.key}`] ? OFF : trackerSettings(config, task.connection).rules;
}

/**
 * What the new-session composer starts with for `task` in a workspace (X46):
 * the link, the description, the "session starts" checkbox and the branch
 * template. Tasks mode's Start and the composer's Link a task use it (X54).
 */
export function composerTask(host: string, workspaceId: string, task: Task): TaskStart {
  const state = useTasks.getState();
  const data = state.data[wsKey(host, workspaceId)];
  const settings = trackerSettings(trackersConfig(state), task.connection);
  return {
    ...taskStart(task, data?.repos ?? {}, data?.sourceProjects ?? {}),
    assign: startAction(task, rulesFor(trackersConfig(state), task).session_starts),
    template: settings.branch_template || undefined,
    maxLen: settings.max_length,
  };
}

function storedPaused(): Record<string, true> {
  try {
    return JSON.parse(readStored("tasks.paused") ?? "{}");
  } catch {
    return {};
  }
}

/** The Task tab's "Keep <tracker> in step" switch for one task. */
export function setKeepInStep(task: Pick<Task, "connection" | "key">, on: boolean) {
  const id = `${task.connection} ${task.key}`;
  const paused = { ...useTasks.getState().paused };
  if (on) delete paused[id];
  else paused[id] = true;
  try {
    writeStored("tasks.paused", JSON.stringify(paused));
  } catch {
    /* storage unavailable */
  }
  useTasks.setState({ paused });
}

/**
 * A phone's request (X76): moves, creates and starts as this app's own
 * Tasks mode does, then answers through the daemon.
 */
export async function answerTaskRequest(host: string, ev: TaskRequestEvent) {
  const answer = (ok: boolean, result?: unknown, error?: string) => rpc(host, M.tasksAnswer, { request_id: ev.request_id, ok, ...(result !== undefined && { result }), ...(error && { error }) }).catch(() => {});
  try {
    const key = wsKey(host, ev.workspace);
    // A workspace this app has not synced yet is read first, for at most 10 s: the phone waits 30.
    if (!useTasks.getState().data[key]) await Promise.race([refreshTasks(host, ev.workspace), new Promise((r) => setTimeout(r, 10_000))]);
    const st = useTasks.getState();
    const config = trackersConfig(st);
    const data = st.data[key];
    const r = resolveTaskRequest(ev.action, {
      boards: (config.boards ?? []).filter((b) => b.workspace === key),
      tasks: data ? placedTasks(data, config) : [],
      repos: data?.repos,
      boardKeys: Object.fromEntries(Object.entries(data?.boards ?? {}).map(([id, b]) => [id, b.keys])),
    });
    if ("error" in r) return answer(false, undefined, r.error);
    switch (r.kind) {
      case "move": {
        await moveTask(host, ev.workspace, r.task, r.category, Date.now(), r.status);
        const why = useTasks.getState().failures[taskId(r.task)];
        return why ? answer(false, undefined, why) : answer(true, { task: taskId(r.task) });
      }
      case "fix": {
        const card = currentCard(host, ev.workspace, taskId(r.task));
        if (!card?.drift) return answer(false, undefined, `${r.task.key} is in step now.`);
        // Only the fix the phone showed and confirmed: another one now is looked at again.
        if (driftKey(card) !== r.plan) return answer(false, undefined, `${r.task.key} changed on the Mac: look again.`);
        const done = await fixDrift(host, ev.workspace, card, { confirmed: true });
        const why = useTasks.getState().failures[taskId(r.task)];
        return done ? answer(true, {}) : answer(false, undefined, why ?? `moonlet on the Mac could not fix ${r.task.key}.`);
      }
      case "sync": {
        await refreshTasks(host, ev.workspace);
        const failed = useTasks.getState().data[key]?.error;
        return failed ? answer(false, undefined, failed) : answer(true, {});
      }
      case "comments":
      case "comment": {
        const { commentFrom, commentsFor } = await import("./taskComments");
        const at = { host, path: r.task.github ? repoPath(host, ev.workspace, r.task.github.repo) : null };
        if (r.kind === "comments") return answer(true, await commentsFor(r.task, at));
        await commentFrom(r.task, at, r.body);
        return answer(true, {});
      }
      case "create_options":
        return answer(true, await createOptions(host, r.board, r.place, r.issueType));
      case "create": {
        let failed = null as string | null;
        const created = await createIssue(host, ev.workspace, r.board, r.column, r.issue, (text) => (failed = text));
        return answer(true, { task: taskId(created), ...(failed && { failed }) });
      }
      case "started":
        const why = await startedFromTask(host, ev.workspace, taskStart(r.task, data?.repos ?? {}, data?.sourceProjects), { session: r.session, assign: r.assign });
        return why ? answer(false, undefined, why) : answer(true, {});
    }
  } catch (e) {
    return answer(false, undefined, errorMessage(e));
  }
}

/** What each workspace's daemon has of its boards, as JSON by `host/workspaceId` (X76). */
const shared: Record<string, string> = {};

// One share at a time, so a newer snapshot never lands before an older one.
let sharing: Promise<void> = Promise.resolve();

/** The workspaces each daemon has boards for (`host/workspaceId`), read when the app starts and a host connects (X76). */
const onDaemons = new Set<string>();

/** Reads which workspaces `host`'s daemon keeps boards for, so ones removed meanwhile get emptied. */
async function readDaemonBoards(host: string) {
  const list = await rpc<{ workspace: string }[]>(host, M.tasksSnapshot, {}).catch(() => []);
  for (const k of [...onDaemons]) if (k.startsWith(`${host}/`)) onDaemons.delete(k);
  for (const w of list) onDaemons.add(`${host}/${w.workspace}`);
}

/** Saves the workspaces' board snapshots that changed in their daemons (X76), after any share under way. */
export function shareTasks(): Promise<void> {
  sharing = sharing.then(shareChanged, shareChanged);
  return sharing;
}

async function shareChanged() {
  const t = useTasks.getState();
  if (!t.config) return;
  const from = useStore.getState().hosts.local?.hostname ?? "this Mac";
  // Activity of earlier runs too: the store holds only this run's until a line is added.
  const activity = { ...readActivity(), ...t.activity };
  for (const s of snapshotsToShare({ config: t.config, data: t.data, moving: t.moving, activity, attention: t.attention, shownBoard: t.shownBoard, from }, shared, [...onDaemons])) {
    if (useStore.getState().hosts[s.host]?.status !== "connected") continue;
    try {
      await rpc(s.host, M.tasksSetSnapshot, { workspace: s.workspace, snapshot: s.snapshot });
      shared[`${s.host}/${s.workspace}`] = s.json;
    } catch (e) {
      // A daemon from before X76 has no snapshots: not asked again until the boards change.
      if (e instanceof DaemonError && e.code === "unknown_method") shared[`${s.host}/${s.workspace}`] = s.json;
    }
  }
}

/**
 * Shares the boards with the phone (X76): each change is saved in its
 * workspace's daemon a second later, and while a phone is paired, every
 * workspace with a board syncs every 5 minutes, as the shown one does.
 * Returns the stop.
 */
export function shareTasksWithPhones(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void shareTasks(), 1000);
  };
  const poll = async () => {
    const status = await rpc<MobileStatus>("local", M.mobileStatus).catch(() => null);
    const hosts = Object.fromEntries(Object.values(useStore.getState().hosts).map((h) => [h.id, h.status]));
    for (const { host, id } of workspacesToPoll(trackersConfig(useTasks.getState()).boards ?? [], pairedPhones(status), hosts)) ensureTasks(host, id);
  };
  const unsubscribe = useTasks.subscribe((now, prev) => {
    // The boards read from the file: the workspaces not shown sync now, not in 5 minutes.
    if (now.config && !prev.config) void poll();
    if (now.data === prev.data && now.moving === prev.moving && now.activity === prev.activity && now.config === prev.config && now.attention === prev.attention && now.shownBoard === prev.shownBoard) return;
    later();
  });
  // A host that connects again gets what changed meanwhile, or failed to send.
  const offHosts = useStore.subscribe((now, prev) => {
    const back = Object.values(now.hosts).filter((h) => h.status === "connected" && prev.hosts[h.id]?.status !== "connected");
    if (!back.length) return;
    for (const h of back) for (const k of Object.keys(shared)) if (k.startsWith(`${h.id}/`)) delete shared[k];
    // What it still has, so boards removed meanwhile are emptied there too.
    void Promise.all(back.map((h) => readDaemonBoards(h.id))).then(later);
    void poll();
  });
  void poll();
  // Hosts already connected: what their daemons kept from the app's last run.
  void Promise.all(Object.values(useStore.getState().hosts).filter((h) => h.status === "connected").map((h) => readDaemonBoards(h.id))).then(later);
  const every = setInterval(() => void poll(), 300_000);
  return () => {
    unsubscribe();
    offHosts();
    clearInterval(every);
    if (timer) clearTimeout(timer);
  };
}

/** The phones among the Mac's paired devices: Macs and cloud machines do not count (X76). */
export function pairedPhones(status: { devices: { kind?: string }[] } | null): number {
  return status?.devices.filter((d) => (d.kind ?? "phone") === "phone").length ?? 0;
}

/** The workspaces the app keeps synced for a paired phone (X76): each with a board, on a connected host; none without a phone. */
export function workspacesToPoll(boards: Pick<BoardConfig, "workspace">[], phones: number, hosts: Record<string, string>): { host: string; id: string }[] {
  if (!phones) return [];
  return [...new Set(boards.map((b) => b.workspace))].map(parseWsKey).filter((w) => hosts[w.host] === "connected");
}
