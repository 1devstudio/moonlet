// Tasks mode's data: each workspace's tasks and worktrees, and the switch
// between Sessions and Tasks (X44, X45).

import { create } from "zustand";
import { hostsApi, rpc } from "./daemon";
import { latestPerKey } from "./prPoll";
import { type GhTask, M, type Project, type Worktree } from "./protocol";
import { errorToast, notify, sesKey, sessionState, sessionTerminals, shownWorkspace, toast, useStore } from "./store";
import { askConfirm } from "./confirm";
import { autoFixes, cleanUpMessage, DEFAULT_RULES, driftFix, driftKey, outsideMoves, prComments, type Rules } from "./keepInStep";
import { readStored, writeStored } from "./storage";
import { type ActivityEntry, appendActivity } from "./taskDetails";
import { type Column, DEFAULT_LINK, githubRepo, type LinkRules, type Task, type TaskStart, taskFromGh, trackerOf } from "./tasks";
import { workspaceConnections } from "./trackerSources";
import { applyStateMapping, targetState } from "./stateMapping";
import { type Board, type BoardInput, type BoardSession, type BoardWorktree, type Card, tasksBoard } from "./tasksBoard";
import type { TaskView } from "./tasksView";
import { wsKey } from "./workspaces";

/** GitHub Issues through `gh` on the project's host (X44). */
export const GITHUB = "github:github.com";

export interface TasksData {
  tasks: Task[];
  worktrees: BoardWorktree[];
  /** The workspace's task sources: the GitHub repositories of its projects. */
  sources: string[];
  /** Each project's GitHub `owner/repo`, by project id. */
  repos: Record<string, string | null>;
  /** The project a tracker source's sessions start in, by `connection source`. */
  sourceProjects?: Record<string, string>;
  /** The last good sync; null before the first. */
  syncedAt: number | null;
  /** Why the last sync failed; the last good list stays. */
  error: string | null;
}

interface TasksState {
  /** Per workspace, `host/workspaceId`. */
  data: Record<string, TasksData>;
  view: TaskView;
  /** The task the detail panel shows, `connection key`. */
  selected: string | null;
  /** Out-of-sync chips put off with "Not now", by `driftKey` (X45). */
  notNow: Record<string, true>;
  /** `trackers.toml`; null until read. */
  config: TrackersConfig | null;
  /** Board or List (X45). */
  layout: "board" | "list";
  /** List rows open, by `connection key`. */
  expanded: Record<string, boolean>;
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
  /** The project its sessions start in. */
  project: string;
  /** `host/workspaceId`. */
  workspace: string;
  /** All open issues rather than only the account's (X44 Shows). */
  all?: boolean;
}

/** A signed-in Linear, Jira or ClickUp account (its token is in the Keychain). */
export interface Connection {
  id: string;
  kind: "linear" | "jira" | "clickup";
  site: string;
  account: string;
  auth: string;
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
  view: "mine",
  selected: null,
  notNow: {},
  config: null,
  layout: storedLayout(),
  expanded: {},
  attention: {},
  activity: {},
  query: "",
  paused: storedPaused(),
  failures: {},
}));

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

/** Reads `trackers.toml` once; a broken file shows its error and the defaults apply. */
export async function loadTrackersConfig(force = false) {
  if (useTasks.getState().config && !force) return;
  try {
    useTasks.setState({ config: withDefaults(await hostsApi.trackersConfig()) });
  } catch (e) {
    errorToast(e);
  }
}

export async function saveTrackersConfig(config: TrackersConfig) {
  await hostsApi.trackersSave(config);
  useTasks.setState({ config });
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
  const ws = shownWorkspace(s);
  return !!ws && !!s.tasksMode[wsKey(ws.host, ws.id)];
}

/** ⌃⌘T and the sidebar's mode switch: Sessions ⇄ Tasks for the shown workspace. */
export function toggleTasksMode() {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  if (!ws) return;
  const key = wsKey(ws.host, ws.id);
  useStore.setState({ tasksMode: { ...s.tasksMode, [key]: !s.tasksMode[key] }, showHistory: false });
}

/** Back to Sessions mode in the shown workspace, to work on a session (X45, X46). */
export function leaveTasksMode() {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  if (ws && s.tasksMode[wsKey(ws.host, ws.id)]) useStore.setState({ tasksMode: { ...s.tasksMode, [wsKey(ws.host, ws.id)]: false } });
}

/** The projects in a workspace's sections. */
export function workspaceProjects(s: StoreState, host: string, workspaceId: string): Project[] {
  const ws = s.workspaces[host]?.find((w) => w.id === workspaceId);
  const ids = new Set((s.sections[host] ?? []).filter((sec) => ws?.section_ids.includes(sec.id)).flatMap((sec) => sec.project_ids));
  return (s.projects[host] ?? []).filter((p) => ids.has(p.id));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const syncs = latestPerKey();

/** Reads a workspace's GitHub issues and worktrees. A failed read keeps the last good list. */
export async function refreshTasks(host: string, workspaceId: string, now = Date.now()) {
  const key = wsKey(host, workspaceId);
  const isLatest = syncs.start(key);
  const projects = workspaceProjects(useStore.getState(), host, workspaceId);
  let error: string | null = null;
  // Sources that failed this time keep their last good tasks; the others are fresh.
  const failed = new Set<string>();
  const per = await Promise.all(
    projects.map(async (p) => {
      const repo = githubRepo(await rpc<string | null>(host, M.gitOriginUrl, { path: p.path }).catch(() => null));
      const issues = repo
        ? await rpc<GhTask[]>(host, M.ghTasks, { path: p.path, mine: true }).catch((e) => {
            error = message(e);
            failed.add(GITHUB);
            return [];
          })
        : [];
      const worktrees = await rpc<Worktree[]>(host, M.projectWorktrees, { id: p.id }).catch(() => []);
      return { id: p.id, repo, issues, worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, originRepo: repo, project: p.id })) };
    }),
  );
  // Linear, Jira and ClickUp sources of this workspace (X44).
  const conns = workspaceConnections(trackersConfig(useTasks.getState()).connections, key);
  const fromTrackers = await Promise.all(
    conns.map(async (c) => {
      // A rejected token is not tried again until the user reconnects (X44).
      const rejected = useTasks.getState().attention[c.id];
      if (rejected !== undefined) {
        error = rejected;
        failed.add(c.id);
        return [];
      }
      try {
        // A source set to "All open issues" needs everyone's; the others keep the account's.
        const mine = c.all.length === 0;
        const fetched = await hostsApi.trackerTasks(c.id, mine);
        const list = mine ? fetched : fetched.filter((t) => c.all.includes(t.tracker?.source ?? "") || t.assignees.includes(c.account));
        return applyStateMapping(
          list.filter((t) => t.tracker && c.keys.includes(t.tracker.source)),
          trackersConfig(useTasks.getState()).connections,
        );
      } catch (e) {
        const err = e as { auth?: boolean; message?: string };
        error = err.message ?? message(e);
        failed.add(c.id);
        if (err.auth) useTasks.setState((t) => ({ attention: { ...t.attention, [c.id]: error ?? "" } }));
        return [];
      }
    }),
  );
  if (!isLatest()) return;
  const sources = [...new Set(per.flatMap((x) => (x.repo ? [x.repo] : []))), ...conns.map((c) => c.id)];
  const repos = Object.fromEntries(per.map((x) => [x.id, x.repo]));
  const sourceProjects = Object.fromEntries(conns.flatMap((c) => Object.entries(c.projects).map(([k, p]) => [`${c.id} ${k}`, p])));
  const tasks = new Map<string, Task>();
  for (const x of per) for (const gh of x.issues) tasks.set(`${GITHUB} ${gh.repo}#${gh.number}`, taskFromGh(gh, GITHUB));
  for (const t of fromTrackers.flat()) tasks.set(`${t.connection} ${t.key}`, t);
  const prev = useTasks.getState().data[key];
  for (const t of prev?.tasks ?? []) if (failed.has(t.connection) && !tasks.has(`${t.connection} ${t.key}`)) tasks.set(`${t.connection} ${t.key}`, t);
  const next: TasksData = {
    tasks: [...tasks.values()],
    worktrees: per.flatMap((x) => x.worktrees),
    sources,
    repos,
    sourceProjects,
    syncedAt: error ? (prev?.syncedAt ?? null) : now,
    error,
  };
  useTasks.setState((st) => ({ data: { ...st.data, [key]: next } }));
  if (!error && trackersConfig(useTasks.getState()).sync.notify) notifyOutsideMoves(host, workspaceId, prev?.tasks ?? null, next);
  else forgetSeenMoves(next.tasks);
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

/** What the board needs of a workspace's sessions (X45). */
export function boardInput(s: StoreState, host: string, workspaceId: string, data: TasksData, config: TrackersConfig = DEFAULT_CONFIG): BoardInput {
  const sessions: BoardSession[] = (s.sessions[host] ?? [])
    .filter((x) => x.workspace_id === workspaceId)
    .map((x) => ({
      id: x.id,
      name: x.name,
      branch: x.branch,
      path: x.path,
      archived: x.archived,
      task: x.task ?? null,
      task_unlinked: !!x.task_unlinked,
      state: sessionState(s, host, x.id),
      pr: s.prs[sesKey(host, x.id)] ?? null,
      additions: s.git[sesKey(host, x.id)]?.additions ?? 0,
      subagents: sessionTerminals(s, host, x.id).reduce((n, t) => n + (t.subagents ?? 0), 0),
      originRepo: data.repos[x.project_id] ?? null,
    }));
  return {
    tasks: data.tasks,
    sessions,
    worktrees: data.worktrees,
    sessionStartRule: (t) => rulesFor(config, t).session_starts,
    link: config.link ?? DEFAULT_LINK,
  };
}

/** The project path of a workspace project in GitHub repository `repo`. */
function repoPath(host: string, workspaceId: string, repo: string): string | null {
  const repos = useTasks.getState().data[wsKey(host, workspaceId)]?.repos ?? {};
  const id = Object.keys(repos).find((p) => repos[p]?.toLowerCase() === repo.toLowerCase());
  return useStore.getState().projects[host]?.find((p) => p.id === id)?.path ?? null;
}

/** "Not now" on a chip: hidden until the task or its sessions change. */
export function putOffDrift(card: Card) {
  useTasks.setState((t) => ({ notNow: { ...t.notNow, [driftKey(card)]: true } }));
}

const COLUMN_LABEL = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" } as const;

/** The "session starts" rule after a session started from a task with the box ticked (X46):
 *  a GitHub issue is assigned; a tracker issue moves to In Progress and is assigned. */
export async function startedFromTask(host: string, workspaceId: string, start: TaskStart) {
  if (start.github) return assignToMe(host, workspaceId, start.github);
  if (!start.tracker) return;
  const id = `${start.ref.connection} ${start.key}`;
  movedByMoonlet.set(id, "in_progress");
  try {
    await hostsApi.trackerUpdate({
      id: start.ref.connection,
      task: start.tracker.id,
      source: start.tracker.source,
      column: "in_progress",
      state: stateFor(start.ref.connection, "in_progress"),
      assign_me: true,
    });
    recordActivity({ connection: start.ref.connection, key: start.key }, "moonlet moved it to In Progress and assigned it to you");
  } catch (e) {
    movedByMoonlet.delete(id);
    errorToast((e as { message?: string }).message ?? e);
  }
}

/** Assigns a GitHub issue to the user, as the "session starts" rule does (X46). */
export async function assignToMe(host: string, workspaceId: string, github: { repo: string; number: number }) {
  const path = repoPath(host, workspaceId, github.repo);
  if (!path) return;
  try {
    await rpc(host, M.ghTaskUpdate, { path, number: github.number, assign_me: true });
    recordActivity({ connection: GITHUB, key: `${github.repo}#${github.number}` }, "moonlet assigned it to you");
  } catch (e) {
    errorToast(e);
  }
}

/** The chip's button (X45): close the issue, move it, or clean up after a done task. */
/** A connection the user signed in to again: its tasks load once more (X44). */
export function reconnected(id: string) {
  useTasks.setState((t) => ({ attention: Object.fromEntries(Object.entries(t.attention).filter(([k]) => k !== id)) }));
}

/** Runs a chip's fix; true when it was done (a declined Clean up is not). */
export async function fixDrift(host: string, workspaceId: string, card: Card): Promise<boolean> {
  const plan = driftFix(card);
  if (!plan) return false;
  const id = `${card.task.connection} ${card.task.key}`;
  retries.set(id, async () => void (await fixDrift(host, workspaceId, card)));
  try {
    if (plan.kind === "github") {
      const path = repoPath(host, workspaceId, plan.repo);
      if (!path) throw new Error(`No project in this workspace has ${plan.repo} as its origin`);
      movedByMoonlet.set(id, "done");
      await rpc(host, M.ghTaskUpdate, { path, number: plan.number, close: true });
      recordActivity(card.task, "moonlet closed it: every session's PR is merged");
      toast(`Closed ${card.task.key}`);
    } else if (plan.kind === "move") {
      const t = card.task.tracker;
      if (!t) return false;
      movedByMoonlet.set(id, plan.column);
      await hostsApi.trackerUpdate({ id: card.task.connection, task: t.id, source: t.source, column: plan.column, state: stateFor(card.task.connection, plan.column) });
      recordActivity(card.task, `moonlet moved it to ${COLUMN_LABEL[plan.column]}`);
      toast(`Moved ${card.task.key} to ${COLUMN_LABEL[plan.column]}`);
    } else {
      const sessions = useStore.getState().sessions[host]?.filter((s) => plan.sessions.includes(s.id)) ?? [];
      const paths = [...sessions.map((s) => s.path), ...plan.worktrees];
      const dirty: string[] = [];
      for (const path of paths) {
        const st = await rpc<{ files: unknown[] }>(host, M.gitStatus, { path }).catch(() => null);
        if (st?.files.length) dirty.push(path);
      }
      const ok = await askConfirm({
        title: `Clean up ${card.task.key}?`,
        message: cleanUpMessage(sessions.length, plan.worktrees.length, dirty),
        action: "Clean up",
        variant: dirty.length ? "danger" : "primary",
      });
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
    setFailure(card.task, (e as { message?: string }).message ?? message(e));
    return false;
  }
}

// Automatic fixes tried since the app started: a failure shows on its task
// with Retry instead of being tried again on every board change.
const autoTried = new Set<string>();

/**
 * The rules at Automatically, run once each (X46): chips' fixes and PR-link
 * comments. Each is remembered across restarts only when it worked.
 */
export async function runAutoFixes(host: string, workspaceId: string, board: Board, rulesOf: (c: Card) => Rules) {
  const done = autoFixed();
  for (const card of autoFixes(board, rulesOf, done)) {
    const key = driftKey(card);
    if (autoTried.has(key)) continue;
    autoTried.add(key);
    if (await fixDrift(host, workspaceId, card)) markAutoFixed(key);
  }
  for (const c of prComments(board, rulesOf, done)) {
    const t = c.card.task.tracker;
    if (!t || autoTried.has(c.key)) continue;
    autoTried.add(c.key);
    const comment = async () => {
      try {
        await hostsApi.trackerUpdate({ id: c.card.task.connection, task: t.id, source: t.source, comment: c.text });
        markAutoFixed(c.key);
        setFailure(c.card.task, null);
        recordActivity(c.card.task, "moonlet commented with the pull request's link");
      } catch (e) {
        setFailure(c.card.task, (e as { message?: string }).message ?? message(e));
      }
    };
    retries.set(`${c.card.task.connection} ${c.card.task.key}`, comment);
    await comment();
  }
}

/** Loads a workspace's tasks when a linked session opens outside Tasks mode, at most once a minute (X46). */
export function ensureTasks(host: string, workspaceId: string, now = Date.now()) {
  const d = useTasks.getState().data[wsKey(host, workspaceId)];
  if (!d || d.syncedAt === null || now - d.syncedAt > 60_000) void refreshTasks(host, workspaceId, now);
}

/** Links a session to a task, or unlinks it with null (X46). */
export async function linkTask(host: string, sessionId: string, task: Task | null) {
  try {
    await rpc(host, M.sessionUpdate, { id: sessionId, task: task ? { connection: task.connection, key: task.key, url: task.url } : null });
    toast(task ? `Linked to ${task.key}` : "Unlinked the task");
  } catch (e) {
    errorToast(e);
  }
}

/** Tasks mode with `task` open in the detail panel (the task bar's way back, X46). */
export function openInTasksMode(task: Task) {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  if (!ws) return;
  useTasks.setState({ selected: `${task.connection} ${task.key}`, view: "mine" });
  useStore.setState({ tasksMode: { ...s.tasksMode, [wsKey(ws.host, ws.id)]: true }, showHistory: false });
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

/** The state menu (X45 detail, X46 task bar): move a tracker issue, or close or reopen a GitHub issue. */
export async function moveTask(host: string, workspaceId: string, task: Task, column: Exclude<Column, "hidden"> | null, now = Date.now()) {
  const id = `${task.connection} ${task.key}`;
  retries.set(id, () => moveTask(host, workspaceId, task, column));
  try {
    if (task.github) {
      const path = repoPath(host, workspaceId, task.github.repo);
      if (!path) throw new Error(`No project in this workspace has ${task.github.repo} as its origin`);
      const close = column === "done";
      movedByMoonlet.set(id, close ? "done" : "open");
      await rpc(host, M.ghTaskUpdate, close ? { path, number: task.github.number, close: true } : { path, number: task.github.number, reopen: true });
      recordActivity(task, close ? "moonlet closed it" : "moonlet reopened it", now);
    } else if (task.tracker && column) {
      movedByMoonlet.set(id, column);
      await hostsApi.trackerUpdate({ id: task.connection, task: task.tracker.id, source: task.tracker.source, column, state: stateFor(task.connection, column) });
      recordActivity(task, `moonlet moved it to ${COLUMN_LABEL[column]}`, now);
    } else return;
    setFailure(task, null);
    void refreshTasks(host, workspaceId);
  } catch (e) {
    movedByMoonlet.delete(id);
    const why = (e as { message?: string }).message ?? message(e);
    setFailure(task, why);
    toast(`${task.key}: ${why}`, "error");
  }
}

/** What to run again for a task whose last action failed. */
const retries = new Map<string, () => Promise<void>>();

function setFailure(task: Pick<Task, "connection" | "key">, error: string | null) {
  const id = `${task.connection} ${task.key}`;
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

/** The state a move to `column` uses for a connection, from its state mapping (X44). */
function stateFor(connection: string, column: Exclude<Column, "hidden">): string | null {
  return targetState(trackersConfig(useTasks.getState()).connections?.find((c) => c.id === connection), column);
}

const OFF: Rules = { session_starts: "off", pr_opens: "off", all_merged: "off", pr_comment: "off", issue_done: "off" };

/** The rules for a task: its tracker's, or all off when its Keep in step switch is off (X46). */
export function rulesFor(config: TrackersConfig, task: Pick<Task, "connection" | "key">): Rules {
  return useTasks.getState().paused[`${task.connection} ${task.key}`] ? OFF : trackerSettings(config, task.connection).rules;
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
