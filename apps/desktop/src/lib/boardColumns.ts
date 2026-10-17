// A board's columns as the tracker has them (X50): each task in the column
// that holds its status, folded and hidden columns, and WIP.

import type { BoardColumn, BoardConfig, Origin } from "./boards";
import type { AgentState } from "./protocol";
import { type Column, type Task, trackerName, trackerOf } from "./tasks";
import { type BoardInput, type Card, type Drift, tasksBoard } from "./tasksBoard";

export interface ColumnView {
  name: string;
  category: Column;
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
function statusKey(task: Task): string {
  if (task.github) return task.column === "open" ? "open" : task.column === "done" ? "completed" : "not_planned";
  return task.tracker?.statusId ?? task.tracker?.state ?? "";
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
  const cards = Object.values(tasksBoard({ ...input, tasks: [...placed.keys()] })).flat();
  return columns.flatMap((c, i) => {
    if (c.show === "hide") return [];
    const here = cards.filter((card) => placed.get(card.task) === i).map((card) => ({ ...card, drift: onBoard(columns, i, card.drift) }));
    const wip = c.wip ? { count: here.length, max: c.wip, full: here.length >= c.wip } : undefined;
    return [{ name: c.name, category: c.category, folded: c.show === "fold", cards: here, ...(wip ? { wip } : {}) }];
  });
}

const RANK: Record<Column, number> = { hidden: -1, todo: 0, in_progress: 1, in_review: 2, done: 3 };

/**
 * X45's out-of-sync chip on a board (X50): a merged PR is expected in any
 * In review column of a board with several; work started and PR open need a
 * column of that kind on the board. The fix moves to the next column, named
 * as the tracker names it, or there is none when that column is behind the work.
 */
function onBoard(columns: BoardColumn[], i: number, drift: Drift | null): Drift | null {
  if (!drift || drift.kind === "done_open") return drift;
  const drawn = columns.filter((c) => c.show !== "hide");
  const reviews = drawn.filter((c) => c.category === "in_review").length;
  const has = (category: Column) => drawn.some((c) => c.category === category);
  if (drift.kind === "merged" && reviews > 1 && columns[i].category === "in_review") return null;
  if (drift.kind === "pr_open" && !has("in_review")) return null;
  if (drift.kind === "started" && !has("in_progress")) return null;
  const need: Column = drift.kind === "started" ? "in_progress" : drift.kind === "pr_open" || reviews > 1 ? "in_review" : "done";
  const next = columns.slice(i + 1).find((c) => c.show !== "hide");
  if (!next || RANK[next.category] < RANK[need]) return { ...drift, fix: "" };
  return { ...drift, fix: `Move to ${next.name}`, to: { column: next.name, category: next.category, statuses: next.statuses } };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The header's subtitle (X50): `Jira · acme.atlassian.net · Oct 9 – Oct 23 ·
 * 12 issues · 5 sessions`. The dates show only while the board follows a
 * sprint, cycle or iteration; Jira counts issues, the others tasks.
 */
export function boardSubtitle(connection: string, site: string, sprint: { startMs: number; endMs: number } | null, tasks: number, sessions: number): string {
  const dates = sprint ? [`${day(sprint.startMs)} – ${day(sprint.endMs)}`] : [];
  const noun = trackerOf(connection) === "jira" ? "issue" : "task";
  return [trackerName(connection), site, ...dates, plural(tasks, noun), plural(sessions, "session")].join(" · ");
}

const KIND: Record<Origin["kind"], string> = {
  jira_board: "Jira board",
  jql: "JQL",
  linear_team: "Team",
  github_project: "Project",
  github_repo: "Repository",
  clickup_list: "List",
};

/** What the switcher's search matches besides the name: the team, project, repository, list or board. */
function originKey(o: Origin): string {
  switch (o.kind) {
    case "jira_board":
      return String(o.board);
    case "jql":
      return o.query;
    case "linear_team":
      return o.team;
    case "github_project":
      return `${o.owner}/${o.number}`;
    case "github_repo":
      return o.repo;
    case "clickup_list":
      return o.list;
  }
}

/** A board's counts once its tasks have loaded, and its most urgent agent state. */
export interface BoardStats {
  tasks: number;
  sessions: number;
  state: AgentState | null;
}

export interface SwitcherRow {
  board: BoardConfig;
  kind: string;
  /** One bar per shown or folded column, by category. */
  bars: Column[];
  /** `6 columns · 12 issues`, as much as is known. */
  meta: string;
  /** Null until its tasks have loaded. */
  sessions: { text: string; state: AgentState | null } | null;
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
): { workspace: string; name: string; hint: string; rows: SwitcherRow[] }[] {
  const q = query.trim().toLowerCase();
  const name = (ws: string) => workspaceNames[ws] ?? ws;
  const found = boards.filter((b) => !q || [b.name, originKey(b.origin), name(b.workspace)].some((t) => t.toLowerCase().includes(q)));
  const order = [wsKey, ...new Set(found.map((b) => b.workspace).filter((w) => w !== wsKey))];
  return order.flatMap((ws) => {
    const rows = found
      .filter((b) => b.workspace === ws)
      .map((board): SwitcherRow => {
        const bars = (board.columns ?? []).filter((c) => c.show !== "hide").map((c) => c.category);
        const live = stats[board.id];
        const noun = trackerOf(board.connection) === "jira" ? "issue" : "task";
        return {
          board,
          kind: KIND[board.origin.kind],
          bars,
          meta: [bars.length ? plural(bars.length, "column") : "", live ? plural(live.tasks, noun) : ""].filter(Boolean).join(" · "),
          sessions: live ? { text: live.sessions ? plural(live.sessions, "session") : "no sessions", state: live.state } : null,
        };
      });
    return rows.length ? [{ workspace: ws, name: name(ws), hint: ws === wsKey ? "this workspace" : "switches workspace", rows }] : [];
  });
}
