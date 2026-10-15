// Details of a task on its card and in the detail panel (X45, X46).

import type { Column, Task } from "./tasks";
import { ago } from "./mobile";
import type { Board, BoardSession, Card } from "./tasksBoard";

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

/** How a task's state is drawn (X45): by shape, so it reads without colour. */
export function glyphShape(column: Column): "ring" | "half" | "three-quarters" | "check" {
  return column === "done" ? "check" : column === "in_progress" ? "half" : column === "in_review" ? "three-quarters" : "ring";
}

const PASSING = new Set(["success", "neutral", "skipped"]);
const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

/** A session's card in the task detail (X45): where it works, its diff, its agents and its PR. */
export function sessionCard(s: BoardSession, project: string, now: number): { where: string; diff: string; agents: string[]; pr: string } {
  const diff = s.additions || s.deletions ? `+${s.additions} −${s.deletions ?? 0}` : "";
  const agents = (s.agents ?? []).map((a) => `${a.name} · ${a.state} · ${ago(now - a.since).replace(/ ago$/, "")}`);
  let pr = "No pull request · Create PR ⇧⌘P";
  if (s.pr) {
    const checks = s.pr.checks.length ? `${s.pr.checks.filter((c) => c.conclusion && PASSING.has(c.conclusion)).length}/${s.pr.checks.length} checks` : "";
    const review = s.pr.review_decision ? REVIEW[s.pr.review_decision] : "";
    pr = [`#${s.pr.number} ${s.pr.state}`, checks, review].filter(Boolean).join(" · ");
  }
  return { where: `${project}/${s.branch}`, diff, agents, pr };
}

/** Whether a key press opens the detail's first session: ↵ outside a field, a button or an editor (X45). */
export function enterOpensFirst(e: { key: string; tagName: string; isContentEditable: boolean }): boolean {
  return e.key === "Enter" && !e.isContentEditable && !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(e.tagName);
}
