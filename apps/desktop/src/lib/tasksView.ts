// Views, counts and labels of the Tasks mode sidebar and header (X45).

import { ago } from "./mobile";
import { type Board, outOfSync } from "./tasksBoard";

/** The sidebar's views. Current cycle joins with trackers that have cycles. */
export type TaskView = "mine" | "review" | "drift" | "unlinked";

export const TASK_VIEWS: { id: TaskView; label: string }[] = [
  { id: "mine", label: "My issues" },
  { id: "review", label: "In review" },
  { id: "drift", label: "Out of sync" },
  { id: "unlinked", label: "Sessions without a task" },
];

/** The count beside each view: open tasks, In Review, out of sync, sessions without a task. */
export function viewCounts(board: Board, unlinked: number): Record<TaskView, number> {
  return {
    mine: board.todo.length + board.in_progress.length + board.in_review.length,
    review: board.in_review.length,
    drift: outOfSync(board).length,
    unlinked,
  };
}

/** The board a view shows, with the same columns. */
export function viewBoard(board: Board, view: TaskView): Board {
  if (view === "review") return { todo: [], in_progress: [], in_review: board.in_review, done: [] };
  if (view === "drift") {
    const keep = (cards: Board["todo"]) => cards.filter((c) => c.drift);
    return { todo: keep(board.todo), in_progress: keep(board.in_progress), in_review: keep(board.in_review), done: keep(board.done) };
  }
  return board;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "9 tasks · 6 sessions" under the view's title. */
export function boardSummary(board: Board): string {
  const cards = Object.values(board).flat();
  return `${plural(cards.length, "task")} · ${plural(
    cards.reduce((n, c) => n + c.rows.length, 0),
    "session",
  )}`;
}

/** The sidebar footer: "GitHub synced 3 min ago", or "Syncing GitHub…" before the first answer. */
export function syncedLabel(tracker: string, syncedAt: number | null, now: number): string {
  return syncedAt === null ? `Syncing ${tracker}…` : `${tracker} synced ${ago(now - syncedAt)}`;
}

const COLUMN_TEXT = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" } as const;

export interface SessionTaskLine {
  key: string;
  title: string;
  column: keyof typeof COLUMN_TEXT;
  /** "In Progress", or "In Review · out of sync". */
  text: string;
  outOfSync: boolean;
}

/** The second line of each linked session's sidebar row, by session id (X46). */
export function sessionTaskLines(board: Board): Record<string, SessionTaskLine> {
  const out: Record<string, SessionTaskLine> = {};
  for (const c of Object.values(board).flat()) {
    for (const r of c.rows) {
      out[r.session.id] = {
        key: c.task.key,
        title: c.task.title,
        column: c.column,
        text: `${COLUMN_TEXT[c.column]}${c.drift ? " · out of sync" : ""}`,
        outOfSync: !!c.drift,
      };
    }
  }
  return out;
}
