// What Tasks mode's board screen shows (X50): the board shown, the sidebar's
// Boards, the header's Columns menu and the detail's State menu.

import { boardView, type ColumnView } from "./boardColumns";
import { type BoardColumn, type BoardConfig, type Category, syncedColumns } from "./boards";
import type { Board, BoardInput, Card } from "./tasksBoard";
import { type Task, taskId, type TrackerKind, trackerOf } from "./tasks";
import type { TasksData } from "./tasksStore";

/** The board workspace `wsKey` shows: the one last shown there, else its first pinned one, else its first. */
export function shownBoardOf(boards: BoardConfig[] | undefined, wsKey: string, shownId: string | null): BoardConfig | null {
  const here = (boards ?? []).filter((b) => b.workspace === wsKey);
  return here.find((b) => b.id === shownId) ?? here.find((b) => b.pinned !== false) ?? here[0] ?? null;
}

export interface SidebarBoard {
  id: string;
  /** Its name, with the sprint or cycle it follows: `OPS · Sprint 42`. */
  label: string;
  tracker: TrackerKind;
  /** Open tasks: neither done nor hidden. */
  count: number;
  current: boolean;
}

/** The sidebar's Boards (X50): the workspace's pinned boards, the shown one marked. */
export function sidebarBoards(boards: BoardConfig[] | undefined, wsKey: string, shownId: string | null, data: Pick<TasksData, "tasks" | "boards"> | undefined): SidebarBoard[] {
  const open = new Set((data?.tasks ?? []).filter((t) => t.column !== "done" && t.column !== "hidden").map(taskId));
  return (boards ?? [])
    .filter((b) => b.workspace === wsKey && b.pinned !== false)
    .map((b) => {
      const d = data?.boards?.[b.id];
      const sprint = b.finished === "sprint" ? d?.sprint?.name : undefined;
      return {
        id: b.id,
        label: sprint ? `${b.name} · ${sprint}` : b.name,
        tracker: trackerOf(b.connection) ?? "github",
        count: (d?.keys ?? []).filter((k) => open.has(k)).length,
        current: b.id === shownId,
      };
    });
}

/** The header's Columns menu button (X50): `Columns 6 · 2 folded`. */
export function columnsSummary(columns: BoardColumn[]): string {
  const shown = columns.filter((c) => c.show !== "hide");
  const folded = shown.filter((c) => c.show === "fold").length;
  return `Columns ${shown.length}${folded ? ` · ${folded} folded` : ""}`;
}

/** The detail's State menu on a tracker board (X50): its shown and folded columns, each moving to its first status. */
export function stateChoices(columns: BoardColumn[], _task: Task): { label: string; category: Category; status: string }[] {
  return columns.filter((c) => c.show !== "hide" && c.statuses.length).map((c) => ({ label: c.name, category: c.category, status: c.statuses[0] }));
}

/** One board and its columns with their cards. */
export interface BoardViews {
  board: BoardConfig;
  views: ColumnView[];
}

/** Each of `boards` laid out with its own tasks (X50): those its last sync brought. */
export function workspaceViews(boards: BoardConfig[], data: Pick<TasksData, "boards"> | undefined, input: BoardInput): BoardViews[] {
  return boards.map((board) => {
    const keys = new Set(data?.boards?.[board.id]?.keys ?? []);
    return { board, views: boardView(syncedColumns(board, null), { ...input, tasks: input.tasks.filter((t) => keys.has(taskId(t))) }) };
  });
}

/**
 * The cards of every board by category, each task once (the first board's),
 * with its board's out of sync: what the Tasks button counts, Keep in step
 * fixes by itself and session rows show (X45, X46, X50).
 */
export function asBoard(all: BoardViews[]): Board {
  const board: Board = { todo: [], in_progress: [], in_review: [], done: [] };
  const seen = new Set<string>();
  for (const { views } of all)
    for (const v of views)
      for (const card of v.cards) {
        if (seen.has(taskId(card.task))) continue;
        seen.add(taskId(card.task));
        board[card.column].push(card);
      }
  return board;
}

/** Each column's cards through `f`, dropping those it returns null for. */
export function mapCards(views: ColumnView[], f: (c: Card) => Card | null): ColumnView[] {
  return views.map((v) => ({ ...v, cards: v.cards.flatMap((c) => f(c) ?? []) }));
}

/** A card of someone else's issue with no session on it: dimmed under Assignee: anyone (X50). */
export const isDimmed = (card: { task: Pick<Task, "mine">; rows: unknown[] }) => card.task.mine === false && card.rows.length === 0;
