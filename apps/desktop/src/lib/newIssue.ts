// A new issue from a board column's + (X52): which columns have one, the
// form's defaults, and what the board does with the issue once the tracker
// has it. The requests themselves are the trackers' (tasksStore).

import { categorize } from "./boardColumns";
import type { Assignee, BoardColumn, BoardConfig } from "./boards";
import { type Task, taskId, trackerName } from "./tasks";

/**
 * Where a column's + creates its issue: the column's first status. None on
 * a folded or hidden column, one without statuses, or a GitHub repository's
 * Closed, since a new issue is open.
 */
export function createTarget(board: BoardConfig, column: BoardColumn): { status: string } | null {
  if (column.show === "fold" || column.show === "hide" || !column.statuses.length) return null;
  if (board.origin.kind === "github_repo" && !column.statuses.includes("open")) return null;
  return { status: column.statuses[0] };
}

/**
 * Why a board's + is disabled (X52), or null: its tracker needs attention
 * (X44), the host that runs gh is offline, or a GitHub Project's issues can't
 * be added without gh's `project` scope (unknown scopes don't lock it).
 */
export function createLock(board: BoardConfig, state: { attention?: string; hostOnline: boolean; scopes?: string[] }): string | null {
  if (state.attention !== undefined) return `Reconnect ${trackerName(board.connection)} to create issues: ${state.attention}`;
  const github = board.origin.kind === "github_repo" || board.origin.kind === "github_project";
  if (github && !state.hostOnline) return "The host that runs gh is offline";
  if (board.origin.kind === "github_project" && state.scopes && !state.scopes.includes("project")) return "Adding issues to a Project needs gh's project scope: run gh auth refresh -s project";
  return null;
}

/** What the form holds (X52). */
export interface NewIssue {
  title: string;
  /** Markdown. */
  description: string;
  /** `me`, `none` (Unassigned), or a person's id in the tracker. */
  assignee: string;
  labels: string[];
  /** Jira: the issue type's id. */
  issueType?: string;
  /** Where it goes when the board's issues come from several places: a Jira project key or a GitHub repository. */
  place?: string;
}

/** The form at first: assigned to the user, with the board's label filter so the issue matches it. */
export function newIssueDraft(board: BoardConfig): NewIssue {
  return { title: "", description: "", assignee: "me", labels: board.labels ?? [] };
}

/** Whether Create can be pressed: a title, and the place and issue type the board needs, while nothing is being asked. */
export function canSubmit(draft: NewIssue, state: { busy: boolean; needsPlace?: boolean; needsType?: boolean }): boolean {
  if (state.busy || !draft.title.trim()) return false;
  return !(state.needsPlace && !draft.place) && !(state.needsType && !draft.issueType);
}

/**
 * Whether the board shows a new issue (X52), as far as moonlet can tell
 * before the next sync: not someone else's on a board at Assignee: me, not
 * outside its label filter, and not in a hidden column or none. A query the
 * issue doesn't match only shows at that sync.
 */
export function boardShows(board: BoardConfig, assignee: Assignee, columns: BoardColumn[], task: Task): boolean {
  if (assignee === "me" && task.mine === false) return false;
  const labels = new Set((board.labels ?? []).map((l) => l.toLowerCase()));
  if (labels.size && !task.labels.some((l) => labels.has(l.toLowerCase()))) return false;
  return categorize(columns, [task])[0].column !== "hidden";
}

/** An issue moonlet created, on its board, until a sync has it or shows the board doesn't (X52). */
export interface Created {
  boardId: string;
  task: Task;
  /** When the tracker answered, in ms. */
  at: number;
}

/**
 * A sync's tasks and boards with the issues moonlet created (X52). One the
 * sync has is done: the tracker's copy wins. One created after the sync
 * started is kept on its board, still `pending`. One a sync started after
 * creating lacks is `gone`: the board doesn't show it. One whose board the
 * sync didn't read stays `pending`, untouched.
 */
export function withCreated<B extends { keys: string[] }>(
  synced: { tasks: Task[]; boards?: Record<string, B> },
  created: Created[],
  syncStartedAt: number,
): { tasks: Task[]; boards?: Record<string, B>; pending: Created[]; gone: Created[] } {
  const has = new Set(synced.tasks.map(taskId));
  const read = (c: Created) => !!synced.boards?.[c.boardId];
  const kept = created.filter((c) => read(c) && !has.has(taskId(c.task)) && c.at >= syncStartedAt);
  const gone = created.filter((c) => read(c) && !has.has(taskId(c.task)) && c.at < syncStartedAt);
  const pending = [...kept, ...created.filter((c) => !read(c))];
  if (!kept.length) return { ...synced, pending, gone };
  const boards = { ...synced.boards };
  for (const c of kept) boards[c.boardId] = { ...boards[c.boardId], keys: [...boards[c.boardId].keys, taskId(c.task)] };
  return { tasks: [...synced.tasks, ...kept.map((c) => c.task)], boards, pending, gone };
}

/** Whether the board's tracker is one moonlet creates issues in (X52): Linear so far; the others follow. */
export const createsIn = (board: BoardConfig) => board.origin.kind === "linear_team";
