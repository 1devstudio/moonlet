// Tasks on the phone (X76): what the app shares of a workspace's boards,
// saved in the workspace's daemon for the phone to read. Pure: built from
// the Tasks store's state, and read back by the phone with the same types.

import { placeOnBoards, withStatus } from "./boardColumns";
import { type BoardConfig, workspaceBoards } from "./boards";
import type { LinkRules, Task, TrackerKind } from "./tasks";
import { DEFAULT_LINK, taskId } from "./tasks";
import type { ActivityEntry } from "./taskDetails";
import type { BoardWorktree } from "./tasksBoard";
import type { BoardData, TasksData, TrackerSettings, TrackersConfig } from "./tasksStore";
import { parseWsKey } from "./workspaces";

/** A workspace's boards as the phone reads them (`version` 1). It holds no token and no account. */
export interface TaskSnapshot {
  version: 1;
  /** The last good sync, ms; null before the first. */
  syncedAt: number | null;
  /** The Mac whose app shared it. */
  from: string;
  /** The workspace's boards: its pinned ones and the one shown. */
  boards: BoardConfig[];
  /** The board the app shows in this workspace. */
  shownBoard: string | null;
  /** The tasks where their boards put them, moves under way shown done (X53). */
  tasks: Task[];
  /** What each board's last sync read: its keys, sprint or cycle, kind, error. */
  boardData: Record<string, BoardData>;
  worktrees: BoardWorktree[];
  /** Each project's GitHub `owner/repo`, by project id. */
  repos: Record<string, string | null>;
  /** The projects that link a tracker source, by `connection source` (X44). */
  sourceProjects: Record<string, string[]>;
  /** Why the last sync failed, if it did. */
  error: string | null;
  /** What moonlet did about each task, by `connection key`. */
  activity: Record<string, ActivityEntry[]>;
  /** The boards' connections that need the user, with what to do (X44). */
  attention: Record<string, string>;
  /** Branch templates and Keep in step rules: GitHub's and each tracker's (X44, X46). */
  trackers: { github: TrackerSettings } & Partial<Record<Exclude<TrackerKind, "github">, TrackerSettings>>;
  link: LinkRules;
}

export interface ShareInput {
  config: TrackersConfig;
  moving: Record<string, { status: string; name: string; done?: boolean }>;
  activity: Record<string, ActivityEntry[]>;
  attention: Record<string, string>;
  from: string;
}

export function taskSnapshot(o: ShareInput & { wsKey: string; data: TasksData | undefined; shownBoard: string | null }): TaskSnapshot {
  const boards = workspaceBoards(o.config.boards, o.wsKey, o.shownBoard);
  // Only the tasks the shared boards show: not other boards', nor any board's.
  const onBoards = new Set(boards.flatMap((b) => o.data?.boards?.[b.id]?.keys ?? []));
  const moved = (o.data?.tasks ?? []).filter((t) => onBoards.has(taskId(t))).map((t) => {
    const m = o.moving[taskId(t)];
    return m ? withStatus(t, m.status, m.name) : t;
  });
  const tasks = boards.length ? placeOnBoards(moved, o.data?.boards, o.config.boards) : [];
  const ids = new Set(tasks.map(taskId));
  const connections = new Set(boards.map((b) => b.connection));
  const { github, linear, jira, clickup } = o.config;
  return {
    version: 1,
    syncedAt: o.data?.syncedAt ?? null,
    from: o.from,
    boards,
    shownBoard: o.shownBoard,
    tasks,
    boardData: Object.fromEntries(Object.entries(o.data?.boards ?? {}).filter(([id]) => boards.some((b) => b.id === id))),
    worktrees: boards.length ? (o.data?.worktrees ?? []) : [],
    repos: o.data?.repos ?? {},
    sourceProjects: o.data?.sourceProjects ?? {},
    error: o.data?.error ?? null,
    activity: Object.fromEntries(Object.entries(o.activity).filter(([id]) => ids.has(id))),
    attention: Object.fromEntries(Object.entries(o.attention).filter(([c]) => connections.has(c))),
    trackers: { github, ...(linear && { linear }), ...(jira && { jira }), ...(clickup && { clickup }) },
    link: o.config.link ?? DEFAULT_LINK,
  };
}

/** A snapshot to save in `host`'s daemon for `workspace`, and its JSON. */
export interface Share {
  host: string;
  workspace: string;
  snapshot: TaskSnapshot;
  json: string;
}

/**
 * The snapshots that changed since `shared` (JSON by `host/workspaceId`):
 * every workspace with a board once its tasks loaded, and one shared before,
 * or that a daemon still has (`onDaemons`), whose boards are gone, emptied.
 */
export function snapshotsToShare(s: ShareInput & { data: Record<string, TasksData>; shownBoard: Record<string, string> }, shared: Record<string, string>, onDaemons: string[] = []): Share[] {
  const withBoards = new Set((s.config.boards ?? []).map((b) => b.workspace));
  // `onDaemons`: workspaces the daemons have boards for, which this run may not have shared.
  const keys = new Set([...withBoards, ...Object.keys(shared), ...onDaemons]);
  const out: Share[] = [];
  for (const key of keys) {
    // Not before its tasks loaded: an empty board would blank the phone's last one.
    if (withBoards.has(key) && !s.data[key]) continue;
    const snapshot = taskSnapshot({ ...s, wsKey: key, data: s.data[key], shownBoard: s.shownBoard[key] ?? null });
    const json = JSON.stringify(snapshot);
    if (shared[key] === json) continue;
    const { host, id } = parseWsKey(key);
    out.push({ host, workspace: id, snapshot, json });
  }
  return out;
}
