// Keep <tracker> in step (X46): what moonlet does in the tracker when the
// work moves, and the fixes behind the out-of-sync chips (X45).

import { type Column, type SessionLinkFacts, type Task, taskForSession } from "./tasks";
import type { Board, Card } from "./tasksBoard";

/** A rule's setting (X44 connection page; spec defaults until then). */
export type RuleSetting = "auto" | "suggest" | "off";

export type FixPlan =
  /** A GitHub repository issue: no column to move, so closing is "Done". */
  | { kind: "github"; repo: string; number: number; close: true }
  | { kind: "move"; column: Exclude<Column, "hidden"> }
  | { kind: "clean_up"; sessions: string[]; worktrees: string[] };

/** What the chip's button does. */
export function driftFix(card: Card): FixPlan | null {
  const d = card.drift;
  if (!d) return null;
  if (d.kind === "done_open") return { kind: "clean_up", sessions: card.rows.map((r) => r.session.id), worktrees: card.orphans.map((w) => w.path) };
  const column = d.kind === "merged" ? "done" : "in_progress";
  const gh = card.task.github;
  if (gh) return column === "done" ? { kind: "github", repo: gh.repo, number: gh.number, close: true } : null;
  return { kind: "move", column };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Clean up's confirm: what goes, and which worktrees would lose uncommitted changes. */
export function cleanUpMessage(sessions: number, worktrees: number, dirty: string[]): string {
  const what = [sessions ? `Archive ${plural(sessions, "session")}` : "", worktrees ? `${sessions ? "remove" : "Remove"} ${plural(worktrees, "worktree")}` : ""]
    .filter(Boolean)
    .join(" and ");
  if (!dirty.length) return `${what}?`;
  const names = dirty.length === 1 ? dirty[0] : `${dirty.slice(0, -1).join(", ")} and ${dirty[dirty.length - 1]}`;
  return `${what}? ${names} ${dirty.length === 1 ? "has" : "have"} uncommitted changes, which will be lost.`;
}

/** Names a chip's situation; "Not now" hides the chip until this changes. */
export function driftKey(card: Card): string {
  const work = card.rows.map((r) => `${r.session.id}:${r.session.pr?.number ?? ""}:${r.session.pr?.state ?? ""}`).join(",");
  return `${card.task.connection} ${card.task.key}|${card.drift?.kind}|${card.task.column}|${work}|${card.orphans.length}`;
}

/** The composer's checkbox for the "session starts" rule, or null when it does nothing here. */
export function startAction(task: Task, rule: RuleSetting): { label: string; checked: boolean } | null {
  if (rule === "off") return null;
  if (task.github) return { label: `Assign ${task.key} to me`, checked: rule === "auto" };
  // Only from Todo or a state not shown; an issue further along is left alone.
  if (task.column !== "todo" && task.column !== "hidden") return null;
  return { label: `Move ${task.key} to In Progress and assign it to me`, checked: rule === "auto" };
}

/** The board without the chips put off with "Not now". */
export function withoutPutOff(board: Board, notNow: Record<string, true>): Board {
  const strip = (cards: Card[]) => cards.map((c) => (c.drift && notNow[driftKey(c)] ? { ...c, drift: null } : c));
  return { todo: strip(board.todo), in_progress: strip(board.in_progress), in_review: strip(board.in_review), done: strip(board.done) };
}

/**
 * The GitHub issue in the project's repository that a session works on, for
 * the `Closes #N` line of its PR: from the board's tasks when loaded, else
 * from the session's stored link.
 */
export function closesIssue(s: SessionLinkFacts, originRepo: string | null, tasks: Task[]): number | null {
  if (!originRepo) return null;
  const t = taskForSession(s, null, originRepo, tasks);
  if (t?.github) return t.github.repo.toLowerCase() === originRepo.toLowerCase() ? t.github.number : null;
  const m = s.task?.connection.startsWith("github:") ? /^(.+)#(\d+)$/.exec(s.task.key) : null;
  return m && m[1].toLowerCase() === originRepo.toLowerCase() ? Number(m[2]) : null;
}

/** A PR body with `Closes #N`, so merging the PR closes the issue; added once. */
export function withCloses(body: string, issue: number | null): string {
  if (issue === null || new RegExp(`\\bCloses #${issue}\\b`, "i").test(body)) return body;
  return body.trim() ? `${body.trimEnd()}\n\nCloses #${issue}` : `Closes #${issue}`;
}

/** The five rules of a connection (`trackers.toml` `[github.rules]`, X44). */
export interface Rules {
  session_starts: RuleSetting;
  pr_opens: RuleSetting;
  all_merged: RuleSetting;
  pr_comment: RuleSetting;
  issue_done: RuleSetting;
}

/** The spec's defaults, as `moonlet-trackers` writes them for an empty file. */
export const DEFAULT_RULES: Rules = { session_starts: "auto", pr_opens: "auto", all_merged: "suggest", pr_comment: "auto", issue_done: "suggest" };

/** The board with the chips of rules turned Off removed. */
export function applyRules(board: Board, rules: Rules): Board {
  const off = (c: Card) => (c.drift?.kind === "merged" && rules.all_merged === "off") || (c.drift?.kind === "done_open" && rules.issue_done === "off");
  const strip = (cards: Card[]) => cards.map((c) => (off(c) ? { ...c, drift: null } : c));
  return { todo: strip(board.todo), in_progress: strip(board.in_progress), in_review: strip(board.in_review), done: strip(board.done) };
}

/**
 * The fixes moonlet makes by itself: a merged GitHub issue closes when
 * "every session's PR is merged" is Automatically, once per situation
 * (`done` holds the `driftKey`s already acted on).
 */
export function autoFixes(board: Board, rules: Rules, done: Record<string, true>): Card[] {
  if (rules.all_merged !== "auto") return [];
  return Object.values(board)
    .flat()
    .filter((c) => c.drift?.kind === "merged" && c.task.github && !done[driftKey(c)]);
}
