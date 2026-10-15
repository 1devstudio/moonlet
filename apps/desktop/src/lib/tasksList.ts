// Tasks mode's List layout (X45): groups by column and one summary per task.

import type { AgentState } from "./protocol";
import type { Board, Card } from "./tasksBoard";

export interface ListGroup {
  name: string;
  column: Card["column"];
  cards: Card[];
  /** What needs attention in the group, or "". */
  note: string;
  noteTone: "blocked" | "accent" | "faint";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** In Progress, In Review, Todo, then Done (collapsed in the UI), with their notes. */
export function listGroups(board: Board): ListGroup[] {
  const needs = board.in_progress.filter((c) => c.needsYou).length;
  const drift = board.in_review.filter((c) => c.drift).length;
  const leftovers = board.done.filter((c) => c.drift?.kind === "done_open").length;
  return [
    { name: "In Progress", column: "in_progress", cards: board.in_progress, note: needs ? `${needs} needs you` : "", noteTone: "blocked" },
    { name: "In Review", column: "in_review", cards: board.in_review, note: drift ? `${drift} out of sync` : "", noteTone: "accent" },
    { name: "Todo", column: "todo", cards: board.todo, note: "", noteTone: "faint" },
    {
      name: "Done",
      column: "done",
      cards: board.done,
      note: leftovers ? `${leftovers} done ${leftovers === 1 ? "task still has an open session" : "tasks still have open sessions"} · Clean up` : "",
      noteTone: "accent",
    },
  ];
}

export interface ListRow {
  glyphs: (AgentState | null)[];
  sum: string;
  sumTone: "blocked" | "faint";
  pr: string;
  prTone: "open" | "merged" | "error" | "faint";
  worktrees: number;
  /** A session waits on the user: the row is tinted amber. */
  needsYou: boolean;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

/** A task's row: its sessions' glyphs and a summary, its PR, its worktrees. */
export function listRow(card: Card): ListRow {
  const sessions = card.rows.map((r) => r.session);
  const working = sessions.filter((s) => s.state === "working").length;
  const sum = card.needsYou
    ? "needs you"
    : working
      ? `${working} working`
      : sessions.length
        ? plural(sessions.length, "session")
        : card.orphans.length
          ? plural(card.orphans.length, "worktree")
          : "none";
  const p = sessions.map((s) => s.pr).find(Boolean) ?? null;
  let pr: Pick<ListRow, "pr" | "prTone"> = { pr: "no PR", prTone: "faint" };
  if (p?.state === "merged") pr = { pr: `#${p.number} merged`, prTone: "merged" };
  else if (p?.state === "closed") pr = { pr: `#${p.number} closed`, prTone: "error" };
  else if (p) {
    const failing = p.checks.filter((c) => c.conclusion && !PASSING.has(c.conclusion)).length;
    const passed = p.checks.filter((c) => c.conclusion && PASSING.has(c.conclusion)).length;
    pr = failing
      ? { pr: `#${p.number} · ${failing} failing`, prTone: "error" }
      : { pr: p.checks.length ? `#${p.number} · ${passed}/${p.checks.length} ✓` : `#${p.number}`, prTone: "open" };
  }
  return {
    glyphs: sessions.map((s) => s.state),
    sum,
    sumTone: card.needsYou ? "blocked" : "faint",
    ...pr,
    worktrees: sessions.length + card.orphans.length,
    needsYou: card.needsYou,
  };
}
