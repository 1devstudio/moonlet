// Details of a task on its card and in the detail panel (X45, X46).

import type { Column, Task } from "./tasks";
import { ago } from "./mobile";
import { type Board, type BoardSession, type Card, checkCounts } from "./tasksBoard";

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

/** Whether Find a task's `query` finds `task`, by key or title. */
export function findsTask(task: Pick<Task, "key" | "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || task.key.toLowerCase().includes(q) || task.title.toLowerCase().includes(q);
}

/** The cards whose key or title has `query` (Find a task, ⌘K in Tasks mode). */
export function findTasks(board: Board, query: string): Board {
  if (!query.trim()) return board;
  const keep = (cards: Card[]) => cards.filter((c) => findsTask(c.task, query));
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

const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

/** A session's card in the task detail (X45): where it works, its diff, its agents and its PR. */
export function sessionCard(s: BoardSession, project: string, now: number): { where: string; diff: string; agents: string[]; pr: string } {
  const diff = s.additions || s.deletions ? `+${s.additions} −${s.deletions ?? 0}` : "";
  const agents = (s.agents ?? []).map((a) => `${a.name} · ${a.state} · ${ago(now - a.since).replace(/ ago$/, "")}`);
  let pr = "No pull request · Create PR ⇧⌘P";
  if (s.pr) {
    const checks = s.pr.checks.length ? `${checkCounts(s.pr.checks).passed}/${s.pr.checks.length} checks` : "";
    const review = s.pr.review_decision ? REVIEW[s.pr.review_decision] : "";
    pr = [`#${s.pr.number} ${s.pr.state}`, checks, review].filter(Boolean).join(" · ");
  }
  return { where: `${project}/${s.branch}`, diff, agents, pr };
}

/** Whether a key press opens the detail's first session: ↵ outside a field, a button or an editor (X45). */
export function enterOpensFirst(e: {
  key: string;
  tagName: string;
  isContentEditable: boolean;
  /** ⌘, ⌥, ⌃ or ⇧ held. */
  modifier?: boolean;
  defaultPrevented?: boolean;
  /** A dialog, the composer or Settings is over Tasks mode. */
  covered?: boolean;
}): boolean {
  if (e.key !== "Enter" || e.modifier || e.defaultPrevented || e.covered || e.isContentEditable) return false;
  return !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(e.tagName);
}
