// Tasks mode's data: each workspace's tasks and worktrees, and the switch
// between Sessions and Tasks (X44, X45).

import { create } from "zustand";
import { hostsApi, rpc } from "./daemon";
import { latestPerKey } from "./prPoll";
import { type GhTask, M, type Project, type Worktree } from "./protocol";
import { errorToast, notify, sesKey, sessionState, sessionTerminals, shownWorkspace, toast, useStore } from "./store";
import { askConfirm } from "./confirm";
import { cleanUpMessage, DEFAULT_RULES, driftFix, driftKey, outsideMoves, type Rules } from "./keepInStep";
import { readStored, writeStored } from "./storage";
import { githubRepo, type Task, taskFromGh } from "./tasks";
import { workspaceConnections } from "./trackerSources";
import { type BoardInput, type BoardSession, type BoardWorktree, type Card, tasksBoard } from "./tasksBoard";
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
}

/** A signed-in Linear, Jira or ClickUp account (its token is in the Keychain). */
export interface Connection {
  id: string;
  kind: "linear" | "jira" | "clickup";
  site: string;
  account: string;
  auth: string;
  sources: Source[];
}

/** `~/.moonlet/trackers.toml` as `moonlet-trackers` reads it (X44). */
export interface TrackersConfig {
  sync: { interval: number; notify: boolean };
  github: TrackerSettings;
  linear?: TrackerSettings;
  jira?: TrackerSettings;
  clickup?: TrackerSettings;
  connections?: Connection[];
}

const DEFAULT_TRACKER: TrackerSettings = { branch_template: "", max_length: 48, rules: DEFAULT_RULES };

export const DEFAULT_CONFIG: TrackersConfig = { sync: { interval: 60, notify: true }, github: DEFAULT_TRACKER };

/** A tracker's branch names and rules (GitHub's, or a connection's tracker). */
export function trackerSettings(config: TrackersConfig, connection: string): TrackerSettings {
  const kind = connection.split(":")[0] as "github" | "linear" | "jira" | "clickup";
  return config[kind] ?? DEFAULT_TRACKER;
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

/** Reads `trackers.toml` once; a broken file shows its error and the defaults apply. */
export async function loadTrackersConfig(force = false) {
  if (useTasks.getState().config && !force) return;
  try {
    useTasks.setState({ config: await hostsApi.trackersConfig() });
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
  const per = await Promise.all(
    projects.map(async (p) => {
      const repo = githubRepo(await rpc<string | null>(host, M.gitOriginUrl, { path: p.path }).catch(() => null));
      const issues = repo
        ? await rpc<GhTask[]>(host, M.ghTasks, { path: p.path, mine: true }).catch((e) => {
            error = message(e);
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
      try {
        const list = await hostsApi.trackerTasks(c.id, true);
        useTasks.setState((t) => (t.attention[c.id] ? { attention: Object.fromEntries(Object.entries(t.attention).filter(([k]) => k !== c.id)) } : {}));
        return list.filter((t) => t.tracker && c.keys.includes(t.tracker.source));
      } catch (e) {
        const err = e as { auth?: boolean; message?: string };
        error = err.message ?? message(e);
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
  const next: TasksData =
    error && prev
      ? { ...prev, sources, repos, sourceProjects, error }
      : { tasks: [...tasks.values()], worktrees: per.flatMap((x) => x.worktrees), sources, repos, sourceProjects, syncedAt: error ? null : now, error };
  useTasks.setState((st) => ({ data: { ...st.data, [key]: next } }));
  if (!error && trackersConfig(useTasks.getState()).sync.notify) notifyOutsideMoves(host, workspaceId, prev?.tasks ?? null, next);
}

/** Tasks moonlet itself moved since the last sync, `connection key` (their move is not news). */
const movedByMoonlet = new Set<string>();

/** "Notify when a task changes state outside moonlet" (X44): linked tasks only. */
function notifyOutsideMoves(host: string, workspaceId: string, before: Task[] | null, data: TasksData) {
  const board = tasksBoard(boardInput(useStore.getState(), host, workspaceId, data));
  const linked = new Set(Object.values(board).flat().filter((c) => c.rows.length).map((c) => `${c.task.connection} ${c.task.key}`));
  for (const m of outsideMoves(before, data.tasks, linked, movedByMoonlet)) void notify(m.text, m.title);
  movedByMoonlet.clear();
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
  return { tasks: data.tasks, sessions, worktrees: data.worktrees, sessionStartRule: (t) => trackerSettings(config, t.connection).rules.session_starts };
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

/** Assigns a GitHub issue to the user, as the "session starts" rule does (X46). */
export async function assignToMe(host: string, workspaceId: string, github: { repo: string; number: number }) {
  const path = repoPath(host, workspaceId, github.repo);
  if (!path) return;
  try {
    await rpc(host, M.ghTaskUpdate, { path, number: github.number, assign_me: true });
  } catch (e) {
    errorToast(e);
  }
}

/** The chip's button (X45): close the issue, move it, or clean up after a done task. */
export async function fixDrift(host: string, workspaceId: string, card: Card) {
  const plan = driftFix(card);
  if (!plan) return;
  try {
    if (plan.kind === "github") {
      const path = repoPath(host, workspaceId, plan.repo);
      if (!path) return;
      await rpc(host, M.ghTaskUpdate, { path, number: plan.number, close: true });
      movedByMoonlet.add(`${card.task.connection} ${card.task.key}`);
      toast(`Closed ${card.task.key}`);
    } else if (plan.kind === "move") {
      toast(`Moving ${card.task.key} comes with its tracker's connection (X44)`);
      return;
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
      if (!ok) return;
      for (const s of sessions) await rpc(host, M.sessionArchive, { id: s.id, remove_worktree: true });
      for (const w of card.orphans) if (w.project) await rpc(host, M.projectWorktreeRemove, { id: w.project, path: w.path });
    }
    await refreshTasks(host, workspaceId);
  } catch (e) {
    errorToast(e);
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
