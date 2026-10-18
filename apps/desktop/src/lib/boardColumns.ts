// A board's columns as the tracker has them (X50): each task in the column
// that holds its status, folded and hidden columns, and WIP.

import { type BoardColumn, type BoardConfig, type Category, originKey, originLabel, syncedColumns } from "./boards";
import type { BoardData } from "./tasksStore";
import type { AgentState } from "./protocol";
import { type Column, type Task, trackerName, trackerOf } from "./tasks";
import { type BoardInput, type Card, checkCounts, type Drift, isDimmed, tasksBoard } from "./tasksBoard";
import { count } from "./workspaces";

export interface ColumnView {
  name: string;
  category: Category;
  folded: boolean;
  cards: Card[];
  /** Jira's column limit: `<count> of <max>`, full at or above it. */
  wip?: { count: number; max: number; full: boolean };
}

/**
 * The key a board column lists a task's status by: Jira's status id, else its
 * state's name; a GitHub repository issue's is `open`, `completed` or
 * `not_planned` (how it was closed).
 */
export function statusKey(task: Task): string {
  // A GitHub Project's item is where its Status option puts it (X50), by id, so a renamed option keeps its column; without one, `""` (No Status).
  if (task.github?.project) return task.github.project.option ?? "";
  if (task.github) return task.column === "open" ? "open" : task.column === "done" ? "completed" : "not_planned";
  return task.tracker?.statusId || task.tracker?.state || "";
}

/**
 * Tracker tasks in their board column's category (X50), so out of sync,
 * Keep in step and notices read the board's columns: a status in no column,
 * or in a hidden one, is hidden. GitHub repository issues keep theirs; a
 * GitHub Project's items go by their Status.
 */
export function categorize(columns: BoardColumn[], tasks: Task[]): Task[] {
  const index = new Map<string, BoardColumn>();
  for (const c of columns) for (const s of c.statuses) index.set(s, c);
  return tasks.map((task) => {
    if (task.github && !task.github.project) return task;
    const c = index.get(statusKey(task));
    return { ...task, column: c && c.show !== "hide" ? c.category : "hidden" };
  });
}

/**
 * The board's shown and folded columns in its order, each with its cards.
 * A task whose status no drawn column holds is left out.
 */
export function boardView(columns: BoardColumn[], input: BoardInput): ColumnView[] {
  const index = new Map<string, number>();
  columns.forEach((c, i) => c.statuses.forEach((s) => index.set(s, i)));
  // Each drawn task, as a copy whose column is its board column's category,
  // and the board column it sits in.
  const placed = new Map<Task, number>();
  for (const task of input.tasks) {
    const i = index.get(statusKey(task));
    if (i !== undefined && columns[i].show !== "hide") placed.set({ ...task, column: columns[i].category }, i);
  }
  const byColumn = columns.map((): Card[] => []);
  for (const card of Object.values(tasksBoard({ ...input, tasks: [...placed.keys()] })).flat()) byColumn[placed.get(card.task) ?? -1]?.push(card);
  const shape = boardShape(columns);
  return columns.flatMap((c, i) => {
    if (c.show === "hide") return [];
    const here = byColumn[i].map((card) => {
      const drift = onBoard(columns, i, shape, card.drift);
      const note = noteOf(card, columns, i, shape);
      return { ...card, columnName: c.name, drift, ...(note && { note }) };
    });
    const wip = c.wip ? { count: here.length, max: c.wip, full: here.length >= c.wip } : undefined;
    return [{ name: c.name, category: c.category, folded: c.show === "fold", cards: here, ...(wip ? { wip } : {}) }];
  });
}

/**
 * A card's note line (X50 Cards), the first that applies: whose issue it is
 * in place of `No sessions` when it is someone else's, a merged PR waiting
 * for the next column as expected, or the agent fixing failing checks.
 */
function noteOf(card: Card, columns: BoardColumn[], i: number, shape: ReturnType<typeof boardShape>): string | null {
  if (isDimmed(card) && !card.orphans.length && card.task.assignees[0]) return `Assigned to ${card.task.assignees[0]}`;
  const next = columns.slice(i + 1).find((c) => c.show !== "hide");
  if (mergedAsExpected(columns, i, shape, card.drift) && next) return `Merged · waiting for ${next.name}, as expected`;
  for (const { session } of card.rows) {
    const { failing } = checkCounts(session.pr?.checks ?? []);
    const agent = session.agents?.find((a) => a.state === "working");
    if (failing && agent) return `${agent.name} is fixing ${failing} failing ${failing === 1 ? "check" : "checks"}`;
  }
  return null;
}

const RANK: Record<Column, number> = { hidden: -1, todo: 0, in_progress: 1, in_review: 2, done: 3 };

/** What out of sync needs to know of a board: its In review columns, and which categories it has. */
function boardShape(columns: BoardColumn[]) {
  const drawn = columns.filter((c) => c.show !== "hide");
  return { reviews: drawn.filter((c) => c.category === "in_review").length, has: new Set<Column>(drawn.map((c) => c.category)) };
}

/** Every session's PR merged in one of a board's several In review columns: expected, not out of sync (X50). */
function mergedAsExpected(columns: BoardColumn[], i: number, shape: ReturnType<typeof boardShape>, drift: Drift | null): boolean {
  return drift?.kind === "merged" && shape.reviews > 1 && columns[i].category === "in_review";
}

/**
 * X45's out-of-sync chip on a board (X50): a merged PR is expected in any
 * In review column of a board with several; work started and PR open need a
 * column of that kind on the board. The fix moves to the next column, named
 * as the tracker names it; there is none when the next column is not a
 * later category than the task's own.
 */
function onBoard(columns: BoardColumn[], i: number, shape: ReturnType<typeof boardShape>, drift: Drift | null): Drift | null {
  if (!drift || drift.kind === "done_open") return drift;
  if (mergedAsExpected(columns, i, shape, drift)) return null;
  if (drift.kind === "pr_open" && !shape.has.has("in_review")) return null;
  if (drift.kind === "started" && !shape.has.has("in_progress")) return null;
  const next = columns.slice(i + 1).find((c) => c.show !== "hide");
  if (!next || RANK[next.category] <= RANK[columns[i].category]) return { ...drift, fix: "" };
  return { ...drift, fix: `Move to ${next.name}`, to: { column: next.name, category: next.category, statuses: next.statuses } };
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Jira counts issues; Linear, GitHub and ClickUp tasks. */
const taskNoun = (connection: string) => (trackerOf(connection) === "jira" ? "issue" : "task");

/**
 * The header's subtitle (X50): `Jira · acme.atlassian.net · Oct 9 – Oct 23 ·
 * 12 issues · 5 sessions`. The dates show only while the board follows a
 * sprint, cycle or iteration; Jira counts issues, the others tasks.
 */
export function boardSubtitle(connection: string, site: string, sprint: { startMs: number; endMs: number } | string | null, tasks: number, sessions: number): string {
  const dates = typeof sprint === "string" ? [sprint] : sprint ? [`${day(sprint.startMs)} – ${day(sprint.endMs)}`] : [];
  return [trackerName(connection), site, ...dates, count(tasks, taskNoun(connection)), count(sessions, "session")].join(" · ");
}

/** A board's counts once its tasks have loaded, and its most urgent agent state. */
export interface BoardStats {
  tasks: number;
  sessions: number;
  state: AgentState | null;
  /** What the last sync said the board is: `Scrum`, `Kanban`, `Cycle 14`. */
  kind?: string;
}

export interface BoardSwitcherRow {
  board: BoardConfig;
  kind: string;
  /** One bar per shown or folded column, by category. */
  bars: Category[];
  /** `6 columns · 12 issues`, as much as is known. */
  meta: string;
  /** Null until its tasks have loaded. */
  sessions: { text: string; state: AgentState | null } | null;
}

export interface BoardSwitcherGroup {
  workspace: string;
  name: string;
  hint: string;
  rows: BoardSwitcherRow[];
}

/**
 * The board switcher (X50): boards grouped by workspace, the current one
 * first ("this workspace"), then the others ("switches workspace"), found by
 * name, key or workspace name.
 */
export function switcherGroups(
  boards: BoardConfig[],
  wsKey: string,
  query: string,
  workspaceNames: Record<string, string>,
  stats: Record<string, BoardStats>,
): BoardSwitcherGroup[] {
  const q = query.trim().toLowerCase();
  const name = (ws: string) => workspaceNames[ws] ?? ws;
  const found = boards.filter((b) => !q || [b.name, originKey(b.origin), name(b.workspace)].some((t) => t.toLowerCase().includes(q)));
  const order = [wsKey, ...new Set(found.map((b) => b.workspace).filter((w) => w !== wsKey))];
  return order.flatMap((ws) => {
    const rows = found
      .filter((b) => b.workspace === ws)
      .map((board): BoardSwitcherRow => {
        const bars = syncedColumns(board, null).filter((c) => c.show !== "hide").map((c) => c.category);
        const live = stats[board.id];
        return {
          board,
          kind: live?.kind ?? originLabel(board.origin),
          bars,
          meta: [bars.length ? count(bars.length, "column") : "", live ? count(live.tasks, taskNoun(board.connection)) : ""].filter(Boolean).join(" · "),
          sessions: live ? { text: live.sessions ? count(live.sessions, "session") : "no sessions", state: live.state } : null,
        };
      });
    return rows.length ? [{ workspace: ws, name: name(ws), hint: ws === wsKey ? "this workspace" : "switches workspace", rows }] : [];
  });
}

/** The status a move to `category` lands on (X50): the first status of the first shown or folded column of that category. */
export function statusFor(columns: BoardColumn[], category: Category): string | null {
  return columns.find((c) => c.show !== "hide" && c.category === category)?.statuses[0] ?? null;
}

/**
 * Tasks placed by the columns of the board each came from, as saved now
 * (X50), so a changed mapping shows without waiting for a sync; a task on
 * two boards takes the first's. A task on no board keeps its category.
 */
export function placeOnBoards(tasks: Task[], data: Record<string, BoardData> | undefined, boards: BoardConfig[] | undefined): Task[] {
  const boardOf = new Map<string, BoardConfig>();
  for (const b of boards ?? []) for (const id of data?.[b.id]?.keys ?? []) if (!boardOf.has(id)) boardOf.set(id, b);
  return tasks.map((t) => {
    const b = boardOf.get(`${t.connection} ${t.key}`);
    const columns = b ? syncedColumns(b, null) : [];
    return columns.length ? categorize(columns, [t])[0] : t;
  });
}
