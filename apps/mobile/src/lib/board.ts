// The Tasks tab (X57): the boards the app on the Mac shared, laid out with
// the desktop's own board code and the phone's live sessions.

import { switcherGroups, withStatus } from "@desktop/lib/boardColumns";
import { boardHeader, boardProblem, boardTitle, cardFace, workspaceViews } from "@desktop/lib/boardScreen";
import { type BoardConfig, type Category, cardFields } from "@desktop/lib/boards";
import type { AgentState, GitStatus, PullRequest } from "@desktop/lib/protocol";
import { type Task, taskId, trackerName, trackerOf } from "@desktop/lib/tasks";
import { count } from "@desktop/lib/workspaces";
import type { BoardInput, BoardSession, Card, RowMeta } from "@desktop/lib/tasksBoard";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { HostData } from "./app";
import type { InboxHost } from "./inbox";
import { sessionState } from "./inbox";

/** A board on a host's workspace, as the phone shows it. */
export interface PhoneBoard {
  host: string;
  hostLabel: string;
  workspace: string;
  workspaceName: string;
  /** `host/workspace/board`: how the phone remembers it. */
  key: string;
  board: BoardConfig;
  snapshot: TaskSnapshot;
}

/** The boards of the workspace shown (by name, X40), or of every one, on connected hosts. */
export function phoneBoards(hosts: Record<string, InboxHost>, data: Record<string, HostData>, workspace: string | null): PhoneBoard[] {
  const out: PhoneBoard[] = [];
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    for (const ws of d.workspaces) {
      if (workspace !== null && ws.name !== workspace) continue;
      const snapshot = d.tasks[ws.id];
      for (const board of snapshot?.boards ?? []) {
        out.push({ host: h.id, hostLabel: h.label, workspace: ws.id, workspaceName: ws.name, key: `${h.id}/${ws.id}/${board.id}`, board, snapshot });
      }
    }
  }
  return out;
}

/** What the phone has loaded of each session: its PR and diff stat. */
export interface Details {
  prs: Record<string, PullRequest | null | undefined>;
  git: Record<string, Pick<GitStatus, "additions" | "deletions"> | undefined>;
}

/** Moves the phone asked the Mac for, by `connection key`: the status and column shown until the Mac's snapshot has them. */
export type Moving = Record<string, { status: string; name: string }>;

/** What the desktop's board needs, from the snapshot and this host's live sessions. */
export function boardInput(b: PhoneBoard, d: HostData, details: Details, moving: Moving): BoardInput {
  const terminalsOf = (id: string) => Object.values(d.terminals).filter((t) => t.session_id === id);
  const sessions: BoardSession[] = d.sessions
    .filter((s) => s.workspace_id === b.workspace)
    .map((s) => ({
      id: s.id,
      name: s.name,
      branch: s.branch,
      path: s.path,
      archived: s.archived,
      task: s.task ?? null,
      task_unlinked: !!s.task_unlinked,
      state: sessionState(d, s),
      pr: details.prs[s.id] ?? null,
      additions: details.git[s.id]?.additions ?? 0,
      deletions: details.git[s.id]?.deletions ?? 0,
      project: d.projects.find((p) => p.id === s.project_id)?.name,
      agents: terminalsOf(s.id)
        .filter((t) => t.kind === "agent")
        .map((t) => ({ name: t.agent ?? "agent", state: t.agent_state, since: t.last_output_at ?? 0 })),
      subagents: terminalsOf(s.id).reduce((n, t) => n + (t.subagents ?? 0), 0),
      originRepo: b.snapshot.repos[s.project_id] ?? null,
    }));
  const trackers = b.snapshot.trackers;
  return {
    tasks: b.snapshot.tasks.map((t) => {
      const m = moving[taskId(t)];
      return m ? withStatus(t, m.status, m.name) : t;
    }),
    sessions,
    worktrees: b.snapshot.worktrees,
    sessionStartRule: (t) => ((trackers as Record<string, typeof trackers.github | undefined>)[trackerOf(t.connection) ?? "github"] ?? trackers.github).rules.session_starts,
    link: b.snapshot.link,
  };
}

export interface CardView {
  id: string;
  key: string;
  title: string;
  url: string;
  priority: number;
  initials: string | null;
  /** Parent, due date and estimate, as the board's card fields say. */
  line: string | null;
  needsYou: boolean;
  rows: { id: string; name: string; state: AgentState | null; meta: RowMeta }[];
  /** `No sessions`, or the worktrees without one; null with sessions. */
  empty: string | null;
  /** Out of sync, with its fix and the column it moves to. */
  drift: { text: string; fix: string; to: string | null } | null;
  task: Task;
  card: Card;
}

export interface ColumnTab {
  name: string;
  category: Category;
  folded: boolean;
  count: number;
  /** `3/4` under a WIP limit. */
  wip: string | null;
  /** Yellow while a session needs the user, orange while a card is out of sync. */
  dot: "blocked" | "drift" | null;
  cards: CardView[];
}

/** A connection's site: `acme` of `linear:acme`. */
const siteOf = (connection: string) => connection.slice(connection.indexOf(":") + 1);

function cardView(card: Card, board: BoardConfig, estimate: string | null | undefined): CardView {
  const face = cardFace(card.task, cardFields(board), estimate);
  const line = [face.line, face.points].filter(Boolean).join(" · ");
  return {
    id: taskId(card.task),
    key: card.task.key,
    title: card.task.title,
    url: card.task.url,
    priority: card.task.priority,
    initials: face.assignee?.initials ?? null,
    line: line || null,
    needsYou: card.needsYou,
    rows: card.rows.map((r) => ({ id: r.session.id, name: r.session.name, state: r.session.state, meta: r.meta })),
    empty: card.rows.length ? null : card.empty,
    drift: card.drift?.fix ? { text: card.drift.text, fix: card.drift.fix, to: card.drift.to?.column ?? null } : null,
    task: card.task,
    card,
  };
}

/** The Tasks tab's board: header, column tabs and cards. */
export function boardScreen(b: PhoneBoard, d: HostData, details: Details, moving: Moving, now: number) {
  const data = b.snapshot.boardData[b.board.id];
  const [{ views }] = workspaceViews([b.board], { boards: b.snapshot.boardData }, boardInput(b, d, details, moving));
  const header = boardHeader(b.board, data?.sprint, siteOf(b.board.connection), views.flatMap((v) => v.cards));
  const columns: ColumnTab[] = views.map((v) => ({
    name: v.name,
    category: v.category,
    folded: v.folded,
    count: v.cards.length,
    wip: v.wip ? `${v.wip.count}/${v.wip.max}` : null,
    dot: v.cards.some((c) => c.needsYou) ? "blocked" : v.cards.some((c) => c.drift?.fix) ? "drift" : null,
    cards: v.cards.map((c) => cardView(c, b.board, data?.project?.numberField)),
  }));
  return { ...header, problem: boardProblem(b.board, data), stale: staleLine(b.snapshot, now), attention: b.snapshot.attention[b.board.connection] ?? null, columns };
}

/** The tab a board opens on: the first column where a session needs the user, else the first In progress one, else the first. */
export function firstColumn(columns: Pick<ColumnTab, "name" | "category" | "dot">[]): string | null {
  return (columns.find((c) => c.dot === "blocked") ?? columns.find((c) => c.category === "in_progress") ?? columns[0])?.name ?? null;
}

/** Under the header once the Mac's last sync is over 15 minutes old. */
export function staleLine(s: Pick<TaskSnapshot, "syncedAt" | "from">, now: number): string | null {
  const tail = "Open moonlet on the Mac to sync.";
  if (s.syncedAt === null) return `Not synced yet on ${s.from}. ${tail}`;
  const min = Math.floor((now - s.syncedAt) / 60_000);
  if (min <= 15) return null;
  return `Synced ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`} ago on ${s.from}. ${tail}`;
}

export interface SwitcherRow {
  key: string;
  /** The tracker's letter: L, J, C, G. */
  mark: string;
  name: string;
  /** `9 tasks · 6 sessions`. */
  meta: string;
  needsYou: boolean;
  current: boolean;
}

/**
 * Boards (X57): every workspace's boards, the shown board's workspace
 * first ("this workspace"), then the others ("switches workspace"), found by
 * name, key or workspace, as the desktop's switcher groups them.
 */
export function switcher(all: PhoneBoard[], shown: string | null, query: string, data: Record<string, HostData>, details: Details, now: number): { name: string; hint: string; rows: SwitcherRow[] }[] {
  const wsOf = (b: PhoneBoard) => `${b.host}/${b.workspace}`;
  const current = all.find((b) => b.key === shown) ?? all[0];
  const byId = new Map(all.map((b) => [`${wsOf(b)}/${b.board.id}`, b]));
  const stats = Object.fromEntries(
    all.map((b) => {
      const d = data[b.host];
      const views = d ? boardScreen(b, d, details, {}, now) : null;
      const cards = views?.columns.flatMap((c) => c.cards) ?? [];
      return [`${wsOf(b)}/${b.board.id}`, { tasks: cards.length, sessions: cards.reduce((n, c) => n + c.rows.length, 0), state: cards.some((c) => c.needsYou) ? ("blocked" as const) : null }];
    }),
  );
  // The desktop's groups, with each board keyed by where it is on the phone.
  const boards = all.map((b) => ({ ...b.board, id: `${wsOf(b)}/${b.board.id}`, workspace: wsOf(b) }));
  const names = Object.fromEntries(all.map((b) => [wsOf(b), b.workspaceName]));
  return switcherGroups(boards, current ? wsOf(current) : "", query, names, stats).map((g) => ({
    name: g.name,
    hint: g.hint,
    rows: g.rows.map((r) => {
      const b = byId.get(r.board.id)!;
      const st = stats[r.board.id];
      return {
        key: b.key,
        mark: trackerName(b.board.connection).charAt(0).toUpperCase(),
        name: boardTitle(b.board, b.snapshot.boardData[b.board.id]?.sprint?.name),
        meta: `${count(st.tasks, trackerOf(b.board.connection) === "jira" ? "issue" : "task")} · ${st.sessions ? count(st.sessions, "session") : "no sessions"}`,
        needsYou: st.state === "blocked",
        current: b.key === current?.key,
      };
    }),
  }));
}
