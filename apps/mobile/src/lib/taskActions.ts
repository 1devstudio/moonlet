// What the phone asks the Mac to do with tasks (X76), through the daemon's
// relay, and the moves shown at once until the Mac's snapshot has them.

import { create } from "zustand";
import type { BoardConfig } from "@desktop/lib/boards";
import { rpc } from "@desktop/lib/daemon";
import type { NewIssue } from "@desktop/lib/newIssue";
import { M } from "@desktop/lib/protocol";
import { readStored, writeStored } from "@desktop/lib/storage";
import { type Task, taskId } from "@desktop/lib/tasks";
import type { TaskAction } from "@desktop/lib/tasksRelay";
import { type CommentsEntry, type TaskComment, canPost } from "@desktop/lib/commentsView";
import { useApp } from "./app";
import type { Moving, PhoneBoard } from "./board";
import { pruneMoves } from "./taskView";

export const moveAction = (board: BoardConfig, task: Task, to: { label: string; status: string }): TaskAction => ({ kind: "move", board: board.id, task: taskId(task), column: to.label, status: to.status });
export const createAction = (board: BoardConfig, column: string, issue: NewIssue): TaskAction => ({ kind: "create", board: board.id, column, issue });
export const startedAction = (board: BoardConfig, task: Task, session: string, assign: boolean): TaskAction => ({ kind: "started", board: board.id, task: taskId(task), session, assign });
/** `plan`: the chip the phone showed, so the Mac runs only that fix. */
export const fixAction = (board: BoardConfig, task: Task, plan: string): TaskAction => ({ kind: "fix", board: board.id, task: taskId(task), plan });
export const syncAction = (board: BoardConfig): TaskAction => ({ kind: "sync", board: board.id });
export const commentsAction = (board: BoardConfig, task: Task): TaskAction => ({ kind: "comments", board: board.id, task: taskId(task) });
export const commentAction = (board: BoardConfig, task: Task, body: string): TaskAction => ({ kind: "comment", board: board.id, task: taskId(task), body });

/** Asks the Mac's app to do `action` in `b`'s workspace; rejects with its reason. */
export const askMac = <T = unknown>(b: Pick<PhoneBoard, "host" | "workspace">, action: TaskAction) => rpc<T>(b.host, M.tasksRequest, { workspace: b.workspace, action });

/** A move shown on the board until the Mac's snapshot has it; `waiting` while moonlet is closed there. */
type Move = { status: string; name: string; at: number; waiting?: boolean };

/** A move kept on the phone until moonlet opens on its Mac. */
interface Waiting {
  host: string;
  workspace: string;
  id: string;
  action: TaskAction;
  move: Move;
}

const WAITING = "mobile.tasks.waiting";

function loadWaiting(): Waiting[] {
  try {
    const v = JSON.parse(readStored(WAITING) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const saveWaiting = (list: Waiting[]) => writeStored(WAITING, JSON.stringify(list));
type MoveState = { moving: Record<string, Move>; failures: Record<string, string> };

/** The Mac refused `move` of task `id`: it goes back, and says why; a newer move of it is left alone. */
export function moveRefused(s: MoveState, id: string, move: Move, why: string): MoveState {
  if (s.moving[id] !== move) return s;
  return { moving: without(s.moving, id), failures: { ...s.failures, [id]: why } };
}

export const useTaskStore = create<MoveState>(() => ({
  // The moves that waited for the Mac when the phone app last ran.
  moving: Object.fromEntries(loadWaiting().map((w) => [w.id, w.move])),
  failures: {},
}));

/** Moves the phone asked for and the Mac has not shared yet. */
export const useTaskMoves = (): Moving => useTaskStore((s) => s.moving);

/** Why the last request about a task failed, by `connection key`. */
export const useTaskFailures = () => useTaskStore((s) => s.failures);

/**
 * Moves `task` on `b` to `to`, shown there at once; back where it was if the
 * Mac refuses. While moonlet is closed on the Mac, the move waits on the
 * phone, kept across restarts, and goes when the Mac's app opens.
 */
export async function moveOnMac(b: Pick<PhoneBoard, "host" | "workspace" | "board">, task: Task, to: { label: string; status: string }) {
  const id = taskId(task);
  const action = moveAction(b.board, task, to);
  const open = !!useApp.getState().data[b.host]?.macOpen;
  const move: Move = { status: to.status, name: to.label, at: Date.now(), ...(!open && { waiting: true }) };
  useTaskStore.setState((s) => ({ moving: { ...s.moving, [id]: move }, failures: without(s.failures, id) }));
  // A task's waiting move, by where it goes: the same task on two workspaces' boards stays apart.
  const other = (w: Waiting) => w.id !== id || w.host !== b.host || w.workspace !== b.workspace;
  if (!open) {
    saveWaiting([...loadWaiting().filter(other), { host: b.host, workspace: b.workspace, id, action, move }]);
    return;
  }
  // This move replaces one still stored, and is stored itself until the Mac
  // answers: a phone app that quits meanwhile sends it on its next start.
  const entry: Waiting = { host: b.host, workspace: b.workspace, id, action, move };
  saveWaiting([...loadWaiting().filter(other), entry]);
  const key = keyOf(entry);
  const ours = (w: Waiting) => keyOf(w) === key && w.move.at === move.at;
  sending.add(key);
  try {
    await send(b.host, b.workspace, id, action, move);
    saveWaiting(loadWaiting().filter((w) => !ours(w)));
  } catch (e) {
    if (refusedByMac(e)) {
      saveWaiting(loadWaiting().filter((w) => !ours(w)));
      throw e;
    }
    // The Mac did not take it (closed meanwhile, or no answer): it waits for the next open.
    const waiting: Move = { ...move, waiting: true };
    useTaskStore.setState((s) => (s.moving[id] === move ? { moving: { ...s.moving, [id]: waiting } } : s));
    saveWaiting(loadWaiting().map((w) => (ours(w) ? { ...w, move: waiting } : w)));
  } finally {
    sending.delete(key);
  }
}

/** The relay's own errors: the Mac did not take the request, so it never refused it. */
const NOT_TAKEN = new Set(["moonlet on the Mac did not answer.", "moonlet on the Mac closed before it answered.", "Open moonlet on the Mac to change tasks."]);

/** Whether `e` says the Mac's app answered and refused, rather than that the request did not get there. */
const refusedByMac = (e: unknown) => {
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "failed";
  return code === "failed" && !NOT_TAKEN.has(e instanceof Error ? e.message : String(e));
};

// Each task's last move on its way: a newer one goes after it, so the tracker ends where the user chose.
const inFlight = new Map<string, Promise<unknown>>();

/** Sends a move after any of the same task on its way; a refusal moves the card back and says why. */
function send(host: string, workspace: string, id: string, action: TaskAction, move: Move): Promise<void> {
  const before = inFlight.get(id) ?? Promise.resolve();
  const p = before
    .catch(() => {})
    .then(() => askMac({ host, workspace }, action))
    .then(
      () => {},
      (e) => {
        if (refusedByMac(e)) useTaskStore.setState((s) => moveRefused(s, id, move, e instanceof Error ? e.message : String(e)));
        throw e;
      },
    );
  inFlight.set(id, p);
  void p.catch(() => {}).finally(() => inFlight.get(id) === p && inFlight.delete(id));
  return p;
}

// Waiting moves being sent now, by `keyOf`.
const sending = new Set<string>();

/** Sends the moves that waited for moonlet on `host`, now open there. */
function sendWaiting(host: string) {
  const now = loadWaiting().filter((w) => w.host === host && !sending.has(keyOf(w)));
  for (const w of now) {
    // Shown from now on as any move, until the snapshot has it.
    const move: Move = { ...w.move, waiting: false, at: Date.now() };
    useTaskStore.setState((s) => (s.moving[w.id] === undefined || s.moving[w.id].at === w.move.at ? { moving: { ...s.moving, [w.id]: move } } : s));
    sending.add(keyOf(w));
    // Kept until the Mac answered: a phone app that quits meanwhile sends it again on its next start.
    const done = () => saveWaiting(loadWaiting().filter((x) => keyOf(x) !== keyOf(w) || x.move.at !== w.move.at));
    void send(w.host, w.workspace, w.id, w.action, move)
      .then(done, (e) => {
        // Refused: it went back on the board; no point sending it again.
        if (refusedByMac(e)) return done();
        // Not taken (the Mac closed, or did not answer): it waits again for the next open.
        useTaskStore.setState((s) => (s.moving[w.id] === move ? { moving: { ...s.moving, [w.id]: { ...w.move, waiting: true } } } : s));
      })
      .finally(() => {
        sending.delete(keyOf(w));
        // A newer move of it, stored while this one was on its way, goes now.
        if (useApp.getState().data[host]?.macOpen && loadWaiting().some((x) => keyOf(x) === keyOf(w) && x.move.at !== w.move.at)) sendWaiting(host);
      });
  }
}

/** A waiting move's place: its Mac, workspace and task. */
const keyOf = (w: Pick<Waiting, "host" | "workspace" | "id">) => `${w.host}/${w.workspace} ${w.id}`;

/** Tells the Mac a session started from `task`, for Keep in step (X46); a failure shows on the task. */
export async function startedOnMac(b: Pick<PhoneBoard, "host" | "workspace" | "board">, task: Task, session: string, assign: boolean) {
  try {
    await askMac(b, startedAction(b.board, task, session, assign));
  } catch (e) {
    useTaskStore.setState((s) => ({ failures: { ...s.failures, [taskId(task)]: e instanceof Error ? e.message : String(e) } }));
  }
}

/** Runs a card's out-of-sync fix on the Mac (X76): Clean up, or a fix that is not a move. */
export async function fixOnMac(b: Pick<PhoneBoard, "host" | "workspace" | "board">, task: Task, plan: string) {
  const id = taskId(task);
  useTaskStore.setState((s) => ({ failures: without(s.failures, id) }));
  try {
    await askMac(b, fixAction(b.board, task, plan));
  } catch (e) {
    useTaskStore.setState((s) => ({ failures: { ...s.failures, [id]: e instanceof Error ? e.message : String(e) } }));
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
// moonlet opening on a Mac sends the moves that waited for it.
useApp.subscribe((now, prev) => {
  if (now.data === prev.data) return;
  for (const [host, d] of Object.entries(now.data)) if (d.macOpen && !prev.data[host]?.macOpen) sendWaiting(host);
  settle();
});
setInterval(settle, 15_000);

/** A task's comments as the Mac read them (X66, X76), and the box under them. */
export interface PhoneComments extends CommentsEntry {
  draft?: string;
}

export const useComments = create<{ byTask: Record<string, PhoneComments> }>(() => ({ byTask: {} }));

const NO_COMMENTS: PhoneComments = { more: false, loading: false, error: null };
const putComments = (task: Task, patch: Partial<PhoneComments>) =>
  useComments.setState((s) => ({ byTask: { ...s.byTask, [taskId(task)]: { ...NO_COMMENTS, ...s.byTask[taskId(task)], ...patch } } }));
const commentsOf = (task: Task) => useComments.getState().byTask[taskId(task)];

// The latest load per task: an older one's answer is dropped.
const latestLoad = new Map<string, number>();
let loads = 0;

/** Reads the task's comments through the Mac, keeping the ones shown meanwhile. */
export async function loadComments(b: Pick<PhoneBoard, "host" | "workspace" | "board">, task: Task) {
  const n = ++loads;
  latestLoad.set(taskId(task), n);
  putComments(task, { loading: true });
  try {
    const got = await askMac<{ comments: TaskComment[]; more: boolean }>(b, commentsAction(b.board, task));
    if (latestLoad.get(taskId(task)) === n) putComments(task, { comments: got.comments, more: got.more, loading: false, error: null });
  } catch (e) {
    if (latestLoad.get(taskId(task)) === n) putComments(task, { loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export const setCommentDraft = (task: Task, text: string) => putComments(task, { draft: text });

/** Posts the box's text through the Mac, then reads the comments again; a refused one stays with the reason. */
export async function postComment(b: Pick<PhoneBoard, "host" | "workspace" | "board">, task: Task): Promise<boolean> {
  const text = commentsOf(task)?.draft ?? "";
  if (!canPost(text) || commentsOf(task)?.posting) return false;
  putComments(task, { posting: true, postError: null });
  try {
    await askMac(b, commentAction(b.board, task, text));
  } catch (e) {
    putComments(task, { posting: false, postError: e instanceof Error ? e.message : String(e) });
    return false;
  }
  await loadComments(b, task);
  putComments(task, { posting: false, draft: commentsOf(task)?.draft === text ? "" : commentsOf(task)?.draft });
  return true;
}
