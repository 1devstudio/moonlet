// Tasks mode's data: each workspace's tasks and worktrees, and the switch
// between Sessions and Tasks (X44, X45).

import { create } from "zustand";
import { rpc } from "./daemon";
import { latestPerKey } from "./prPoll";
import { type GhTask, M, type Project, type Worktree } from "./protocol";
import { sesKey, sessionState, sessionTerminals, shownWorkspace, useStore } from "./store";
import { githubRepo, type Task, taskFromGh } from "./tasks";
import type { BoardInput, BoardSession, BoardWorktree } from "./tasksBoard";
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
}

export const useTasks = create<TasksState>(() => ({ data: {}, view: "mine", selected: null }));

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
      return { id: p.id, repo, issues, worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, originRepo: repo })) };
    }),
  );
  if (!isLatest()) return;
  const sources = [...new Set(per.flatMap((x) => (x.repo ? [x.repo] : [])))];
  const repos = Object.fromEntries(per.map((x) => [x.id, x.repo]));
  const tasks = new Map<string, Task>();
  for (const x of per) for (const gh of x.issues) tasks.set(`${gh.repo}#${gh.number}`, taskFromGh(gh, GITHUB));
  useTasks.setState((st) => {
    const prev = st.data[key];
    const next: TasksData =
      error && prev
        ? { ...prev, sources, repos, error }
        : { tasks: [...tasks.values()], worktrees: per.flatMap((x) => x.worktrees), sources, repos, syncedAt: error ? null : now, error };
    return { data: { ...st.data, [key]: next } };
  });
}

/** What the board needs of a workspace's sessions (X45). */
export function boardInput(s: StoreState, host: string, workspaceId: string, data: TasksData): BoardInput {
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
  return { tasks: data.tasks, sessions, worktrees: data.worktrees, sessionStartRule: "auto" };
}
