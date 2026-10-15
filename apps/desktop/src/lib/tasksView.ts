// Views, counts and labels of the Tasks mode sidebar and header (X45).

import { ago } from "./mobile";
import type { Task } from "./tasks";
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

/**
 * A card's source (X45): the repository, or the team, project or list, named
 * only when the workspace's tasks come from more than one.
 */
export function sourceLabels(tasks: Task[]): (task: Task) => string | undefined {
  const of = (t: Task) => (t.github ? `gh ${t.github.repo}` : `${t.connection} ${t.tracker?.source ?? ""}`);
  const short = (t: Task) => (t.github ? t.github.repo.split("/")[1] : (t.tracker?.source ?? ""));
  // `acme/web`, or `globex ENG` (site and team), when the short name is shared.
  const full = (t: Task) => (t.github ? t.github.repo : `${t.connection.split(":").slice(1).join(":")} ${t.tracker?.source ?? ""}`);
  const sources = new Map(tasks.map((t) => [of(t), t]));
  if (sources.size < 2) return () => undefined;
  const counts = new Map<string, number>();
  for (const t of sources.values()) counts.set(short(t), (counts.get(short(t)) ?? 0) + 1);
  return (t) => ((counts.get(short(t)) ?? 0) > 1 ? full(t) : short(t));
}

/** The mode switch's titles, with the shortcut as bound, and the Tasks button's label and dot (X45). */
export function modeSwitch(key: string, outOfSync: number): { sessions: string; tasks: string; label: string; dot: boolean } {
  const titled = (name: string) => (key ? `${name} ${key}` : name);
  return { sessions: titled("Sessions"), tasks: titled("Tasks"), label: outOfSync ? `Tasks, ${outOfSync} out of sync` : "Tasks", dot: outOfSync > 0 };
}

export interface BoardFilters {
  /** Assignee: me. */
  mine: boolean;
  /** Hide done tasks with no session or worktree left. */
  hideEmptyDone: boolean;
}

/** The board with the header's filters applied (X45). */
export function filterBoard(board: Board, f: BoardFilters): Board {
  // Assignee: me keeps a task you have a session on, whoever it is assigned to.
  const keep = (c: Board["todo"][number]) => (!f.mine || c.task.mine !== false || c.rows.length > 0) && (!f.hideEmptyDone || c.column !== "done" || c.rows.length + c.orphans.length > 0);
  return { todo: board.todo.filter(keep), in_progress: board.in_progress.filter(keep), in_review: board.in_review.filter(keep), done: board.done.filter(keep) };
}
