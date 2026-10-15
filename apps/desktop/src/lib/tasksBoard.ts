// The Tasks mode board (X45): tasks with the sessions, PRs and worktrees
// working on them. Nothing here is stored; it is worked out on each render.

import type { AgentState, PullRequest, TaskRef } from "./protocol";
import { type Column, DEFAULT_LINK, type LinkRules, type Task, taskForSession } from "./tasks";

/** What the board needs of a session. */
export interface BoardSession {
  id: string;
  name: string;
  branch: string;
  path: string;
  archived: boolean;
  task: TaskRef | null;
  task_unlinked: boolean;
  /** The agent's state, or null with no agent. */
  state: AgentState | null;
  pr: PullRequest | null;
  additions: number;
  deletions?: number;
  /** The project's name, for `project/branch` on its card. */
  project?: string;
  /** Each agent of the session, its state and since when (its last output). */
  agents?: { name: string; state: AgentState; since: number }[];
  /** Running subagents (X42). */
  subagents: number;
  /** The project's `owner/repo` on GitHub, if any. */
  originRepo: string | null;
}

/** A worktree of a project, with the project's GitHub repository. */
export interface BoardWorktree {
  path: string;
  branch: string | null;
  originRepo: string | null;
  /** The project it belongs to. */
  project?: string;
}

type StartRule = "auto" | "suggest" | "off";

export interface BoardInput {
  tasks: Task[];
  sessions: BoardSession[];
  worktrees: BoardWorktree[];
  /** The "session starts" Keep in step rule (X46), or each task's tracker's. */
  sessionStartRule: StartRule | ((task: Task) => StartRule);
  /** What links a session to a task without a stored link (X44); all on when absent. */
  link?: LinkRules;
}

export interface RowMeta {
  text: string;
  tone: "blocked" | "open" | "merged" | "error" | "muted" | "faint";
}

export interface CardRow {
  session: BoardSession;
  meta: RowMeta;
}

export interface Card {
  task: Task;
  column: Exclude<Column, "hidden">;
  rows: CardRow[];
  /** A session waits on the user: the card is outlined amber. */
  needsYou: boolean;
  /** Worktrees whose branch carries the task and that no session uses. */
  orphans: BoardWorktree[];
  /** The line shown instead of rows when no session works on the task. */
  empty: string | null;
  drift: Drift | null;
}

/** How a task's tracker state disagrees with its work, and the fix (X45). */
export interface Drift {
  kind: "merged" | "started" | "pr_open" | "done_open";
  text: string;
  fix: string;
}

export type Board = Record<Exclude<Column, "hidden">, Card[]>;

const PASSING = new Set(["success", "neutral", "skipped"]);

/** The most useful fact about a session on its card, first match wins (X45). */
function rowMeta(s: BoardSession): RowMeta {
  if (s.state === "blocked") return { text: "needs you", tone: "blocked" };
  if (s.pr) {
    if (s.pr.state === "merged") return { text: `#${s.pr.number} merged`, tone: "merged" };
    if (s.pr.checks.some((c) => c.conclusion && !PASSING.has(c.conclusion))) return { text: `#${s.pr.number} ✕`, tone: "error" };
    return { text: `#${s.pr.number}`, tone: s.pr.state === "closed" ? "error" : "open" };
  }
  if (s.subagents) return { text: `◑ ${s.subagents}`, tone: "muted" };
  return { text: `+${s.additions}`, tone: "faint" };
}

/** An open PR that is ready for review; a draft does not count (X46). */
const isOpen = (pr: PullRequest | null | undefined) => pr?.state === "open" && !pr.draft;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function drift(column: Card["column"], trackerColumn: Task["column"], sessions: BoardSession[], orphans: BoardWorktree[], rule: StartRule): Drift | null {
  const prs = sessions.map((s) => s.pr);
  if (column !== "done" && prs.length && prs.every((p) => p?.state === "merged")) {
    const last = prs[prs.length - 1];
    return { kind: "merged", text: `#${last?.number} merged`, fix: "Move to Done" };
  }
  const open = prs.find(isOpen);
  if (open && (trackerColumn === "todo" || trackerColumn === "in_progress")) {
    return { kind: "pr_open", text: `#${open.number} open`, fix: "Move to In Review" };
  }
  // Under Automatically too: a session linked by its branch was not started
  // from the task, so nothing moved it (X46).
  if (trackerColumn === "todo" && sessions.length && rule !== "off") {
    const running = sessions.some((s) => s.state === "working" || s.state === "blocked");
    return { kind: "started", text: running ? "Session running" : "Session open", fix: "In Progress" };
  }
  const worktrees = sessions.length + orphans.length;
  if (column === "done" && worktrees) {
    const parts = [sessions.length ? count(sessions.length, "session") : "", count(worktrees, "worktree")].filter(Boolean);
    return { kind: "done_open", text: parts.join(", "), fix: "Clean up" };
  }
  return null;
}

/** Where an open GitHub issue goes: by the work on it (X44 "States"). */
function workColumn(sessions: BoardSession[]): Card["column"] {
  if (sessions.some((s) => isOpen(s.pr))) return "in_review";
  return sessions.length ? "in_progress" : "todo";
}

export function tasksBoard(input: BoardInput): Board {
  const board: Board = { todo: [], in_progress: [], in_review: [], done: [] };
  const live = input.sessions.filter((s) => !s.archived);
  const used = new Set(live.map((s) => s.path));
  const loose = input.worktrees.filter((w) => w.branch && !used.has(w.path));
  for (const task of input.tasks) {
    if (task.column === "hidden") continue;
    const sessions = live.filter((s) => taskForSession(s, s.pr, s.originRepo, input.tasks, input.link) === task);
    const column = task.column === "open" ? workColumn(sessions) : task.column;
    const orphans = loose.filter((w) => taskForSession({ branch: w.branch ?? "" }, null, w.originRepo, input.tasks, input.link) === task);
    board[column].push({
      task,
      column,
      rows: sessions.map((session) => ({ session, meta: rowMeta(session) })),
      needsYou: sessions.some((s) => s.state === "blocked"),
      orphans,
      drift: drift(column, task.column, sessions, orphans, typeof input.sessionStartRule === "function" ? input.sessionStartRule(task) : input.sessionStartRule),
      empty: sessions.length ? null : orphans.length ? `${orphans.length} ${orphans.length === 1 ? "worktree" : "worktrees"}, no session` : "No sessions",
    });
  }
  return board;
}

/** The cards with an out-of-sync chip (the Out of sync view and the Tasks button's count). */
export function outOfSync(board: Board): Card[] {
  return Object.values(board)
    .flat()
    .filter((c) => c.drift);
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Live sessions no task claims (X45 "Sessions without a task"), each with a
 * hint: a task whose title is the session's name, or "No matching issue".
 * The hint only ever suggests a link (X44 link rules).
 */
export function sessionsWithoutTask(sessions: BoardSession[], tasks: Task[], link: LinkRules = DEFAULT_LINK): { session: BoardSession; hint: string }[] {
  return sessions
    // A stored link counts even when its task is not among the loaded ones.
    .filter((s) => !s.archived && !s.task && !taskForSession(s, s.pr, s.originRepo, tasks, link))
    .map((session) => {
      if (!link.title) return { session, hint: "" };
      const like = tasks.find((t) => words(t.title) === words(session.name));
      return { session, hint: like ? `Looks like ${like.key} ${like.title}` : "No matching issue" };
    });
}
