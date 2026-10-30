// The Tasks tab (X76): the boards the app on the Mac shared, laid out with
// the desktop's own board code and the phone's live sessions.

import { switcherGroups, withStatus } from "@desktop/lib/boardColumns";
import { boardHeader, boardProblem, boardTitle, cardFace, workspaceViews } from "@desktop/lib/boardScreen";
import { type BoardConfig, type Category, CATEGORY_LABEL, cardFields } from "@desktop/lib/boards";
import { driftKey, withoutPutOffCard } from "@desktop/lib/keepInStep";
import { keepCard } from "@desktop/lib/tasksView";
import type { AgentState, GitStatus, PullRequest, Session } from "@desktop/lib/protocol";
import { type Task, taskId, trackerName, trackerOf } from "@desktop/lib/tasks";
import { count } from "@desktop/lib/workspaces";
import type { BoardInput, BoardSession, Card, RowMeta } from "@desktop/lib/tasksBoard";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { HostData } from "./app";
import type { InboxHost } from "./inbox";
import type { WorkspaceRef } from "@desktop/lib/workspaces";
import { inShown } from "./workspaceChoices";
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

/**
 * The boards of the workspace shown (X40), or of every one, on connected
 * hosts. An account's workspace (X68) is on each of its members: its boards
 * show once, from the member whose snapshot synced last.
 */
export function phoneBoards(hosts: Record<string, InboxHost>, data: Record<string, HostData>, shown: WorkspaceRef | null): PhoneBoard[] {
  const byKey = new Map<string, PhoneBoard>();
  for (const h of Object.values(hosts)) {
    const d = data[h.id];
    if (h.status !== "connected" || !d) continue;
    for (const ws of d.workspaces) {
      if (!inShown(shown, h.id, d.account, ws.id)) continue;
      const snapshot = d.tasks[ws.id];
      const owner = d.account || h.id;
      for (const board of snapshot?.boards ?? []) {
        const same = `${owner}/${ws.id}/${board.id}`;
        const had = byKey.get(same);
        if (had && (had.snapshot.syncedAt ?? 0) >= (snapshot.syncedAt ?? 0)) continue;
        // Keyed by the account, so it stays the same board whichever member synced last.
        byKey.set(same, { host: h.id, hostLabel: h.label, workspace: ws.id, workspaceName: ws.name, key: same, board, snapshot });
      }
    }
  }
  return [...byKey.values()];
}

/** What the Tasks tab says when no connected host shares a board; null when one does. */
export const noBoardsLine = (boards: PhoneBoard[]) => (boards.length ? null : "No boards yet. Add one in moonlet on the Mac (Tasks › Add a board).");

/** The boards of a session's workspace: its host's, or another member's of its account (X68). */
export function sessionBoards(hosts: Record<string, InboxHost>, data: Record<string, HostData>, host: string, s: Pick<Session, "workspace_id">): PhoneBoard[] {
  if (!s.workspace_id) return [];
  return phoneBoards(hosts, data, { host, id: s.workspace_id, account: data[host]?.account ?? "" });
}

/** What the phone has loaded of each session: its PR and diff stat. */
export interface Details {
  prs: Record<string, PullRequest | null | undefined>;
  git: Record<string, Pick<GitStatus, "additions" | "deletions"> | undefined>;
}

/** Moves the phone asked the Mac for, by `connection key`: the status and column shown until the Mac's snapshot has them. */
export type Moving = Record<string, { status: string; name: string; waiting?: boolean }>;

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
  /** Jira's issue type, when the board's cards show it. */
  type: string | null;
  /** `5 pt`, when the board's cards show the estimate. */
  points: string | null;
  initials: string | null;
  /** Parent, due date and estimate, as the board's card fields say. */
  line: string | null;
  needsYou: boolean;
  rows: { id: string; name: string; state: AgentState | null; meta: RowMeta }[];
  /** `No sessions`, or the worktrees without one; null with sessions. */
  empty: string | null;
  /** Out of sync, with its fix and the column it moves to. */
  drift: { text: string; fix: string; to: string | null; kind: string } | null;
  /** What Not now remembers the chip by (the desktop's `driftKey`). */
  driftKey: string | null;
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
  /** Cards whose fix is Clean up. */
  cleanUps: number;
  /** `In progress · 3 issues · 1 needs clean-up`. */
  line: string;
  cards: CardView[];
}

/** A connection's site: `acme` of `linear:acme`. */
const siteOf = (connection: string) => connection.slice(connection.indexOf(":") + 1);

function cardView(card: Card, board: BoardConfig, estimate: string | null | undefined, column: string): CardView {
  const face = cardFace(card.task, cardFields(board), estimate);
  const line = face.line ?? "";
  return {
    id: taskId(card.task),
    key: card.task.key,
    title: card.task.title,
    url: card.task.url,
    priority: card.task.priority,
    type: face.type ?? null,
    points: face.points ?? null,
    initials: face.assignee?.initials ?? null,
    line: line || null,
    needsYou: card.needsYou,
    rows: card.rows.map((r) => ({ id: r.session.id, name: r.session.name, state: r.session.state, meta: r.meta })),
    empty: card.rows.length ? null : card.empty,
    // The design says where it still is, but for what is left after Done.
    drift: card.drift?.fix ? { text: card.drift.kind === "done_open" ? `${card.drift.text} left` : `${card.drift.text} · still ${column}`, fix: card.drift.fix, to: card.drift.to?.column ?? null, kind: card.drift.kind } : null,
    driftKey: card.drift ? driftKey(card) : null,
    task: card.task,
    card,
  };
}

/** What the board shows: Assignee: me, and the chips put off with Not now by `driftKey`. */
export interface BoardFilter {
  mine?: boolean;
  notNow?: Record<string, true>;
}

/** The Tasks tab's board: header, column tabs and cards. */
export function boardScreen(b: PhoneBoard, d: HostData, details: Details, moving: Moving, filter: BoardFilter = {}) {
  const data = b.snapshot.boardData[b.board.id];
  const [{ views }] = workspaceViews([b.board], { boards: b.snapshot.boardData }, boardInput(b, d, details, moving));
  const header = boardHeader(b.board, data?.sprint, siteOf(b.board.connection), views.flatMap((v) => v.cards));
  const noun = trackerOf(b.board.connection) === "jira" ? "issue" : "task";
  const keep = (c: Card) => keepCard(c, { mine: !!filter.mine, hideEmptyDone: false });
  const columns: ColumnTab[] = views.map((v) => {
    const cards = v.cards.filter(keep).map((c) => withoutPutOffCard(c, filter.notNow ?? {}));
    const cleanUps = cards.filter((c) => c.drift?.kind === "done_open").length;
    return {
      name: v.name,
      category: v.category,
      folded: v.folded,
      count: cards.length,
      wip: v.wip ? `${v.wip.count}/${v.wip.max}` : null,
      dot: cards.some((c) => c.needsYou) ? "blocked" : cards.some((c) => c.drift?.fix) ? "drift" : null,
      cleanUps,
      line: [CATEGORY_LABEL[v.category], count(cards.length, noun), cleanUps ? `${cleanUps} needs clean-up` : ""].filter(Boolean).join(" · "),
      cards: cards.map((c) => cardView(c, b.board, data?.project?.numberField, v.name)),
    };
  });
  const outOfSync = columns.reduce((n, c) => n + c.cards.filter((x) => x.drift).length, 0);
  return { ...header, problem: boardProblem(b.board, data), attention: b.snapshot.attention[b.board.connection] ?? null, columns, outOfSync };
}

/** The tab a board opens on: the first column where a session needs the user, else the first In progress one, else the first. */
export function firstColumn(columns: Pick<ColumnTab, "name" | "category" | "dot">[]): string | null {
  return (columns.find((c) => c.dot === "blocked") ?? columns.find((c) => c.category === "in_progress") ?? columns[0])?.name ?? null;
}

/** `5m`, `2 h`, `3 d`: how long ago, as the board's foot says it. */
export function since(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / (24 * 60))} d`;
}

/** The board's foot: which Mac synced it and when, or that moonlet is closed there and moves wait. */
export function syncLine(s: Pick<TaskSnapshot, "syncedAt" | "from">, open: boolean, now: number): { text: string; open: boolean } {
  if (s.syncedAt === null) return { text: open ? `Not synced yet by ${s.from}` : `moonlet is closed on ${s.from} · moves wait for it`, open };
  const ago = now - s.syncedAt < 60_000 ? "just now" : `${since(now - s.syncedAt)} ago`;
  return { text: open ? `Synced by ${s.from} ${ago}` : `moonlet is closed on ${s.from} · showing tasks from ${ago} · moves wait for it`, open };
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
 * Boards (X76): every workspace's boards, the shown board's workspace
 * first ("this workspace"), then the others ("switches workspace"), found by
 * name, key or workspace, as the desktop's switcher groups them.
 */
export function switcher(all: PhoneBoard[], shown: string | null, query: string, data: Record<string, HostData>, details: Details): { name: string; hint: string; rows: SwitcherRow[] }[] {
  const wsOf = (b: PhoneBoard) => `${b.host}/${b.workspace}`;
  const current = all.find((b) => b.key === shown) ?? all[0];
  const byId = new Map(all.map((b) => [`${wsOf(b)}/${b.board.id}`, b]));
  const stats = Object.fromEntries(
    all.map((b) => {
      const d = data[b.host];
      const views = d ? boardScreen(b, d, details, {}) : null;
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
