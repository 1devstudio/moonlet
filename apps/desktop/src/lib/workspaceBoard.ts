import { asBoard, mapCards, shownBoardOf, workspaceViews } from "./boardScreen";
import { workspaceBoards } from "./boards";
import { withoutPutOffCard, withRules } from "./keepInStep";
import { hostWorkspaces, type useStore } from "./store";
import { type Card, sessionsWithoutTask } from "./tasksBoard";
import { boardInput, type Moving, rulesFor, type TasksData, type TrackersConfig } from "./tasksStore";
import { workspaceMembers, wsKey, type WorkspaceRef } from "./workspaces";

/** What a workspace's board reads besides its tasks: Tasks-mode state from `useTasks`. */
export interface BoardKnobs {
  notNow: Record<string, true>;
  config: TrackersConfig;
  paused: Record<string, true>;
  moving: Record<string, Moving>;
  shownId: string | null;
}

/** The parts of the main store a board reads; other changes (terminal output) leave it as it is. */
export const boardDeps = (s: StoreState) => [s.sessions, s.prs, s.git, s.terminals, s.reads, s.accounts, s.workspaces];

function build(st: StoreState, ws: WorkspaceRef | null, data: TasksData | undefined, k: BoardKnobs) {
  if (!ws || !data) return { ws, data, board: null, unlinked: [], shown: null, all: [] };
  const key = wsKey(ws.host, ws.id);
  // Every member's sessions of the workspace (X68).
  const input = boardInput(st, ws.host, ws.id, data, k.config, workspaceMembers(ws, hostWorkspaces(st)));
  // A chip whose rule is Off, or that the user put off with Not now, is not shown.
  const clean = (c: Card) => withoutPutOffCard(withRules(c, (x) => rulesFor(k.config, x.task)), k.notNow);
  const all = workspaceViews(workspaceBoards(k.config.boards, key, k.shownId), data, input).map((b) => ({ ...b, views: mapCards(b.views, clean) }));
  const shownBoard = shownBoardOf(k.config.boards, key, k.shownId);
  const shown = shownBoard ? { board: shownBoard, views: all.find((b) => b.board.id === shownBoard.id)?.views ?? [] } : null;
  return { ws, data, board: asBoard(all), unlinked: sessionsWithoutTask(input.sessions, data.tasks, input.link), shown, all };
}

export type WorkspaceBoard = ReturnType<typeof build>;

type StoreState = ReturnType<typeof useStore.getState>;

const built = new Map<string, { inputs: unknown[]; board: WorkspaceBoard }>();

/**
 * A workspace's boards laid out (X50), built once for the same inputs however
 * many components show them: the sidebar, the mode switch, a session's task
 * and Tasks mode each ask on every store change (X78).
 */
export function workspaceBoard(st: StoreState, ws: WorkspaceRef | null, data: TasksData | undefined, k: BoardKnobs): WorkspaceBoard {
  const key = ws ? `${ws.account ?? ""}|${ws.host}|${ws.id}` : "";
  const inputs = [data, k.notNow, k.config, k.paused, k.moving, k.shownId, ...boardDeps(st)];
  const last = built.get(key);
  if (last && last.inputs.length === inputs.length && last.inputs.every((x, i) => x === inputs[i])) return last.board;
  const board = build(st, ws, data, k);
  built.set(key, { inputs, board });
  return board;
}
