// Details of a task on its card and in the detail panel (X45, X46).

import type { Column, Task } from "./tasks";
import type { Board, Card } from "./tasksBoard";

/** "SR" for "Sam Rivera": first letters of the first and last name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (words[0][0] + last).toUpperCase();
}

export interface StateOption {
  label: string;
  /** The column to move to; null leaves a GitHub issue open. */
  column: Exclude<Column, "hidden"> | null;
  current: boolean;
}

/** The state menu: a tracker issue's four columns, or a GitHub issue open or closed. */
export function stateOptions(task: Task): StateOption[] {
  if (task.github) {
    const closed = task.column === "done" || task.column === "hidden";
    return [
      { label: "Open", column: null, current: !closed },
      { label: "Closed", column: "done", current: closed },
    ];
  }
  return (
    [
      ["Todo", "todo"],
      ["In Progress", "in_progress"],
      ["In Review", "in_review"],
      ["Done", "done"],
    ] as const
  ).map(([label, column]) => ({ label, column, current: task.column === column }));
}

/** The cards whose key or title has `query` (Find a task, ⌘K in Tasks mode). */
export function findTasks(board: Board, query: string): Board {
  const q = query.trim().toLowerCase();
  if (!q) return board;
  const keep = (cards: Card[]) => cards.filter((c) => c.task.key.toLowerCase().includes(q) || c.task.title.toLowerCase().includes(q));
  return { todo: keep(board.todo), in_progress: keep(board.in_progress), in_review: keep(board.in_review), done: keep(board.done) };
}

export interface ActivityEntry {
  at: number;
  text: string;
}

/** A task's activity with `entry` added: newest first, at most 20. */
export function appendActivity(list: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [entry, ...list].slice(0, 20);
}
