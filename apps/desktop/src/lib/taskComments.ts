// A task's comments (X66): read from its tracker (or gh for a GitHub issue),
// listed at the end of the Task detail and the Task tab, and posted from there.

import { create } from "zustand";
import { hostsApi, rpc } from "./daemon";
import { ago } from "./mobile";
import { type GhComments, M } from "./protocol";
import { type Task, taskId, trackerName } from "./tasks";

export interface TaskComment {
  id: string;
  /** The tracker's display name; empty when it gives none. */
  author: string;
  body: string;
  /** Whether `body` is Markdown; ClickUp's is plain text. */
  markdown: boolean;
  createdMs: number;
}

/** One task's comments as loaded. */
export interface CommentsEntry {
  /** Oldest first; undefined until the first load ends. */
  comments?: TaskComment[];
  /** The tracker has more than these. */
  more: boolean;
  loading: boolean;
  /** Why the last load failed. */
  error: string | null;
  /** What the comments were loaded for: the task's updated time and where gh runs. */
  loadedFor?: string;
  /** What the load under way is for. */
  loadingFor?: string;
}

export const useComments = create<{ byTask: Record<string, CommentsEntry> }>(() => ({ byTask: {} }));

/** Where a GitHub issue's gh runs: the host, and its project with the issue's repository as origin. */
export interface Where {
  host: string;
  path: string | null;
}

const entry = (task: Task) => useComments.getState().byTask[taskId(task)];
const NONE: CommentsEntry = { more: false, loading: false, error: null };
const put = (task: Task, patch: Partial<CommentsEntry>) =>
  useComments.setState((s) => ({ byTask: { ...s.byTask, [taskId(task)]: { ...NONE, ...s.byTask[taskId(task)], ...patch } } }));

/** The tracker's answer, in one shape for every tracker. */
async function fetchComments(task: Task, at: Where): Promise<{ comments: TaskComment[]; more: boolean }> {
  if (task.github) {
    if (!at.path) throw new Error(`No project in this workspace has ${task.github.repo} as its origin`);
    const got = await rpc<GhComments>(at.host, M.ghIssueComments, { path: at.path, number: task.github.number });
    return { comments: got.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, markdown: true, createdMs: c.created_ms })), more: got.more };
  }
  if (!task.tracker) throw new Error(`${task.key} has no comments moonlet can read`);
  return hostsApi.trackerComments(task.connection, task.tracker.id);
}

/** A task as it is now, and where its comments are read: a change in either loads them again. */
const version = (task: Task, at: Where) => `${task.updatedMs} ${at.host} ${at.path ?? ""}`;

// The latest load per task: an older one's answer is dropped.
const latest = new Map<string, number>();
let loads = 0;

/** Loads a task's comments again, keeping the ones shown meanwhile. */
export async function loadComments(task: Task, at: Where) {
  const id = taskId(task);
  const n = ++loads;
  latest.set(id, n);
  const v = version(task, at);
  put(task, { loading: true, loadingFor: v });
  try {
    const got = await fetchComments(task, at);
    if (latest.get(id) === n) put(task, { comments: got.comments, more: got.more, loading: false, error: null, loadedFor: v });
  } catch (e) {
    if (latest.get(id) === n) put(task, { loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Loads a task's comments when they were never loaded, or the task (or where
 * gh runs for it) changed since: also while an older load is under way.
 */
export function ensureComments(task: Task, at: Where): Promise<void> {
  const e = entry(task);
  const v = version(task, at);
  if (e && (e.loading ? e.loadingFor === v : e.loadedFor === v)) return Promise.resolve();
  return loadComments(task, at);
}

export interface CommentsView {
  heading: string;
  /** What shows instead of comments: loading, none, or a failed first load. */
  status: "loading" | "empty" | null;
  rows: (TaskComment & { ago: string })[];
  /** "More comments are in <tracker>", when it has more. */
  more: string | null;
}

/** What the Comments section shows. */
export function commentsView(e: CommentsEntry | undefined, task: Task, now: number): CommentsView {
  const comments = e?.comments ?? [];
  return {
    heading: `Comments ${comments.length}`,
    status: !e?.comments ? (e?.error ? null : "loading") : comments.length ? null : "empty",
    rows: comments.map((c) => ({ ...c, author: c.author || "Someone", ago: ago(Math.max(0, now - c.createdMs)) })),
    more: e?.more ? `More comments are in ${trackerName(task.connection)}` : null,
  };
}
