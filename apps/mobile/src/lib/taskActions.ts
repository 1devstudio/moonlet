// What the phone asks the Mac to do with tasks (X57), through the daemon's
// relay, and the moves shown at once until the Mac's snapshot has them.

import { create } from "zustand";
import type { BoardConfig } from "@desktop/lib/boards";
import { rpc } from "@desktop/lib/daemon";
import type { NewIssue } from "@desktop/lib/newIssue";
import { M } from "@desktop/lib/protocol";
import { type Task, taskId } from "@desktop/lib/tasks";
import type { TaskAction } from "@desktop/lib/tasksRelay";
import { useApp } from "./app";
import type { Moving, PhoneBoard } from "./board";
import { pruneMoves } from "./taskView";

export const moveAction = (board: BoardConfig, task: Task, to: { label: string; status: string }): TaskAction => ({ kind: "move", board: board.id, task: taskId(task), column: to.label, status: to.status });
export const createAction = (board: BoardConfig, column: string, issue: NewIssue): TaskAction => ({ kind: "create", board: board.id, column, issue });
export const startedAction = (task: Task, session: string, assign: boolean): TaskAction => ({ kind: "started", task: taskId(task), session, assign });

/** Asks the Mac's app to do `action` in `b`'s workspace; rejects with its reason. */
export const askMac = <T = unknown>(b: Pick<PhoneBoard, "host" | "workspace">, action: TaskAction) => rpc<T>(b.host, M.tasksRequest, { workspace: b.workspace, action });

type Move = { status: string; name: string; at: number };
type MoveState = { moving: Record<string, Move>; failures: Record<string, string> };

/** The Mac refused `move` of task `id`: it goes back, and says why; a newer move of it is left alone. */
export function moveRefused(s: MoveState, id: string, move: Move, why: string): MoveState {
  if (s.moving[id] !== move) return s;
  return { moving: without(s.moving, id), failures: { ...s.failures, [id]: why } };
}

const useTaskStore = create<MoveState>(() => ({ moving: {}, failures: {} }));

/** Moves the phone asked for and the Mac has not shared yet. */
export const useTaskMoves = (): Moving => useTaskStore((s) => s.moving);

/** Why the last request about a task failed, by `connection key`. */
export const useTaskFailures = () => useTaskStore((s) => s.failures);

/** Moves `task` on `b` to `to`, shown there at once; back where it was if the Mac refuses. */
export async function moveOnMac(b: PhoneBoard, task: Task, to: { label: string; status: string }) {
  const id = taskId(task);
  const move: Move = { status: to.status, name: to.label, at: Date.now() };
  useTaskStore.setState((s) => ({ moving: { ...s.moving, [id]: move }, failures: without(s.failures, id) }));
  try {
    await askMac(b, moveAction(b.board, task, to));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    useTaskStore.setState((s) => moveRefused(s, id, move, why));
    throw e;
  }
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const out = { ...map };
  delete out[key];
  return out;
}

/** Drops the moves the snapshots show done, and those that waited too long. */
function settle() {
  const moving = useTaskStore.getState().moving;
  if (!Object.keys(moving).length) return;
  const tasks = Object.values(useApp.getState().data).flatMap((d) => Object.values(d.tasks).flatMap((s) => s.tasks));
  const left = pruneMoves(moving, tasks, Date.now());
  if (Object.keys(left).length !== Object.keys(moving).length) useTaskStore.setState({ moving: left });
}

// A new snapshot settles the moves it shows done; a move the Mac never shares goes after two minutes.
useApp.subscribe((now, prev) => now.data !== prev.data && settle());
setInterval(settle, 15_000);
