// A task's comments (X66): read from its tracker (or gh for a GitHub issue),
// listed in the Task detail and the Task tab, and posted from there.

import { create } from "zustand";
import { type CommentsEntry, type TaskComment, canPost } from "./commentsView";
import { hostsApi, rpc } from "./daemon";
import { type GhComments, M } from "./protocol";
import { type Task, taskId } from "./tasks";
import { errorMessage } from "./store";
import { recordActivity } from "./tasksStore";

export { type CommentsEntry, type CommentsView, type TaskComment, canPost, commentsView } from "./commentsView";

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
    if (latest.get(id) === n) put(task, { loading: false, error: errorMessage(e) });
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


/** What the user typed in a task's box. */
export function setDraft(task: Task, text: string) {
  put(task, { draft: text });
}

/**
 * Posts the task's draft, written in Markdown, then lists it (X66). Only ever
 * on the user's press: a refused comment is not sent again by itself. It stays
 * posting until the comments show it, and clears the draft only if it is
 * still the text that was sent.
 */
export async function postComment(task: Task, at: Where, now = Date.now()): Promise<boolean> {
  const text = entry(task)?.draft ?? "";
  if (!canPost(text) || entry(task)?.posting) return false;
  put(task, { posting: true, postError: null });
  try {
    await sendComment(task, at, text, now);
  } catch (e) {
    put(task, { posting: false, postError: errorMessage(e) });
    return false;
  }
  await loadComments(task, at);
  put(task, { posting: false, draft: entry(task)?.draft === text ? "" : entry(task)?.draft });
  return true;
}

/** Posts `text` on the task's issue, and notes it in Activity; throws the tracker's refusal. */
async function sendComment(task: Task, at: Where, text: string, now: number) {
  if (task.github) {
    if (!at.path) throw new Error(`No project in this workspace has ${task.github.repo} as its origin`);
    await rpc(at.host, M.ghIssueComment, { path: at.path, number: task.github.number, body: text });
  } else if (task.tracker) {
    await hostsApi.trackerComment(task.connection, task.tracker.id, text);
  } else {
    throw new Error(`${task.key} takes no comments from moonlet`);
  }
  recordActivity(task, "You commented", now);
}

/** A task's comments for a phone (X76), read as the Task detail reads them. */
export const commentsFor = (task: Task, at: Where) => fetchComments(task, at);

/** Posts a phone's comment (X76), as Comment does; throws the tracker's refusal. */
export const commentFrom = (task: Task, at: Where, body: string, now = Date.now()) => sendComment(task, at, body, now);
