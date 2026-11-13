import { asBoard, mapCards, shownBoardOf, workspaceViews } from "./boardScreen";
import { workspaceBoards } from "./boards";
import { withoutPutOffCard, withRules } from "./keepInStep";
import { hostWorkspaces, type useStore } from "./store";
import { type Board, type BoardInput, type Card, drawn, sessionsWithoutTask, tasksBoard } from "./tasksBoard";
import { taskId } from "./tasks";
import { boardInput, type Moving, rulesFor, type TasksData, type TrackersConfig } from "./tasksStore";
import { workspaceMembers, wsKey, type WorkspaceRef } from "./workspaces";

/** What a workspace's board depends on besides its tasks: Tasks-mode state
 *  from `useTasks`. `paused` and `moving` are read through `useTasks` while
 *  the board is built; they are here so that a change builds it again. */
export interface BoardKnobs {
  notNow: Record<string, true>;
  config: TrackersConfig;
  paused: Record<string, true>;
  moving: Record<string, Moving>;
  shownId: string | null;
}

/** The parts of the main store a board reads, its workspace's members
 *  (hosts, sections, profiles) and projects included; other changes (terminal
 *  output) leave it as it is. */
export type BoardStore = Pick<StoreState, "sessions" | "prs" | "git" | "terminals" | "reads" | "accounts" | "workspaces" | "projects" | "hosts" | "sections" | "profiles">;

/** [`BoardStore`] out of the whole store: a selector, with `useShallow`. */
export const boardStore = (s: BoardStore): BoardStore => ({
  sessions: s.sessions,
  prs: s.prs,
  git: s.git,
  terminals: s.terminals,
  reads: s.reads,
  accounts: s.accounts,
  workspaces: s.workspaces,
  projects: s.projects,
  hosts: s.hosts,
  sections: s.sections,
  profiles: s.profiles,
});

function layOut(st: BoardStore, ws: WorkspaceRef | null, data: TasksData | undefined, knobs: BoardKnobs) {
  if (!ws || !data) return { ws, data, board: null, unlinked: [], shown: null, all: [] };
  const key = wsKey(ws.host, ws.id);
  // Every member's sessions of the workspace (X68).
  const input = boardInput(st, ws.host, ws.id, data, knobs.config, workspaceMembers(ws, hostWorkspaces(st)));
  // A chip whose rule is Off, or that the user put off with Not now, is not shown.
  const clean = (c: Card) => withoutPutOffCard(withRules(c, (x) => rulesFor(knobs.config, x.task)), knobs.notNow);
  const all = workspaceViews(workspaceBoards(knobs.config.boards, key, knobs.shownId), data, input).map((b) => ({ ...b, views: mapCards(b.views, clean) }));
  const shownBoard = shownBoardOf(knobs.config.boards, key, knobs.shownId);
  const shown = shownBoard ? { board: shownBoard, views: all.find((b) => b.board.id === shownBoard.id)?.views ?? [] } : null;
  return { ws, data, board: withLinked(asBoard(all), input, data, clean), unlinked: sessionsWithoutTask(input.sessions, data.tasks, input.link), shown, all };
}

/**
 * `board` with a card for each task a session is linked to by hand that no
 * board shows (X46): an Epic, someone else's issue, one outside every board's
 * query or in a hidden column. Its session works on it, in its tracker's
 * column; no board's columns show it.
 */
function withLinked(board: Board, input: BoardInput, data: TasksData, clean: (c: Card) => Card | null): Board {
  // Those a board reads into a hidden column (a Backlog) have no card there either.
  const shown = new Set(input.tasks.filter(drawn).map(taskId));
  const wanted = new Set(input.sessions.flatMap((s) => (s.task ? [taskId(s.task)] : [])));
  // One its tracker closed as not planned is finished work.
  const tasks = (data.linked ?? []).filter((t) => wanted.has(taskId(t)) && !shown.has(taskId(t))).map((t) => (drawn(t) ? t : { ...t, column: "done" as const }));
  if (!tasks.length) return board;
  const extra = tasksBoard({ ...input, tasks });
  const add = (column: keyof Board) => [...board[column], ...extra[column].flatMap((c) => clean({ ...c, offBoard: true }) ?? [])];
  return { todo: add("todo"), in_progress: add("in_progress"), in_review: add("in_review"), done: add("done") };
}

export type WorkspaceBoard = ReturnType<typeof layOut>;

type StoreState = ReturnType<typeof useStore.getState>;

/** The last board of each workspace shown lately, newest last. */
const recent = new Map<string, { inputs: unknown[]; board: WorkspaceBoard }>();
/** How many workspaces' boards are kept: each holds on to whole store slices. */
const KEPT_BOARDS = 8;

/**
 * A workspace's boards laid out (X50), built once for the same inputs however
 * many components show them: the sidebar, the mode switch, a session's task
 * and Tasks mode each ask on every store change (X78).
 */
export function workspaceBoard(st: BoardStore, ws: WorkspaceRef | null, data: TasksData | undefined, knobs: BoardKnobs): WorkspaceBoard {
  const key = ws ? wsKey(ws.host, ws.id) : "";
  // The workspace itself counts too: two that share a key never share a board.
  const inputs = [ws?.account, ws?.host, ws?.id, data, knobs.notNow, knobs.config, knobs.paused, knobs.moving, knobs.shownId, ...Object.values(boardStore(st))];
  const last = recent.get(key);
  if (last && last.inputs.length === inputs.length && last.inputs.every((x, i) => x === inputs[i])) return last.board;
  const board = layOut(st, ws, data, knobs);
  recent.delete(key);
  recent.set(key, { inputs, board });
  const oldest = recent.keys().next().value;
  if (recent.size > KEPT_BOARDS && oldest !== undefined) recent.delete(oldest);
  return board;
}
