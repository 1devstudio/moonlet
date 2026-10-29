import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import type { Task } from "@desktop/lib/tasks";
import { resolveTaskRequest } from "@desktop/lib/tasksRelay";
import { emptyData, useApp } from "./app";
import { commentAction, commentsAction, createAction, fixAction, loadComments, moveAction, moveOnMac, moveRefused, postComment, setCommentDraft, startedAction, syncAction, useComments, useTaskStore } from "./taskActions";

const calls = vi.hoisted(() => [] as unknown[][]);
/** The Mac's answer per action kind; a function throws to refuse. */
const replies = vi.hoisted(() => ({}) as Record<string, () => unknown>);
vi.mock("@desktop/lib/daemon", () => ({
  rpc: vi.fn((...args: unknown[]) => {
    calls.push(args);
    const kind = (args[2] as { action?: { kind: string } })?.action?.kind ?? "";
    return Promise.resolve().then(() => (replies[kind] ? replies[kind]() : {}));
  }),
}));

const LINEAR = "linear:acme";
const COLUMNS: BoardColumn[] = [
  { name: "Todo", statuses: ["s-todo"], category: "todo" },
  { name: "In Progress", statuses: ["s-progress"], category: "in_progress" },
  { name: "Done", statuses: ["s-done"], category: "done", show: "fold" },
];
const board: BoardConfig = { id: "moon", name: "Moonlet", connection: LINEAR, workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" }, columns: COLUMNS };
const task: Task = { connection: LINEAR, key: "MOON-151", title: "Drag sessions", url: "", column: "todo", priority: 1, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i", state: "s-todo", source: "MOON" } };
const mac = { boards: [board], tasks: [task] };

describe("what the phone asks the Mac (X76)", () => {
  it("asks for moves, creates and started sessions the Mac's app understands", () => {
    expect(resolveTaskRequest(moveAction(board, task, { label: "In Progress", status: "s-progress" }), mac)).toEqual({ kind: "move", task, category: "in_progress", status: "s-progress" });
    const issue = { title: "Show host health", description: "", assignee: "me", labels: [] };
    expect(resolveTaskRequest(createAction(board, "Todo", issue), mac)).toEqual({ kind: "create", board, column: COLUMNS[0], issue });
    expect(resolveTaskRequest(startedAction(task, "Drag sessions", true), mac)).toEqual({ kind: "started", task, session: "Drag sessions", assign: true });
  });

  it("asks for fixes, syncs and comments the Mac's app understands", () => {
    expect(resolveTaskRequest(fixAction(board, task), mac)).toEqual({ kind: "fix", board, task });
    expect(resolveTaskRequest(syncAction(board), mac)).toEqual({ kind: "sync", board });
    expect(resolveTaskRequest(commentsAction(board, task), mac)).toEqual({ kind: "comments", task });
    expect(resolveTaskRequest(commentAction(board, task, "Picked this up."), mac)).toEqual({ kind: "comment", task, body: "Picked this up." });
  });
});

describe("a move's outcome (X76)", () => {
  const id = "linear:acme MOON-151";
  const first = { status: "s-progress", name: "In Progress", at: 1 };
  const second = { status: "s-done", name: "Done", at: 2 };

  it("goes back where it was and says why when the Mac refuses", () => {
    expect(moveRefused({ moving: { [id]: first }, failures: {} }, id, first, "Linear refused the move")).toEqual({ moving: {}, failures: { [id]: "Linear refused the move" } });
  });

  it("leaves a newer move alone when an older one is refused", () => {
    expect(moveRefused({ moving: { [id]: second }, failures: {} }, id, first, "Linear refused the move")).toEqual({ moving: { [id]: second }, failures: {} });
  });
});

describe("a move while moonlet is closed on the Mac (X76)", () => {
  const id = "linear:acme MOON-151";
  const b = { host: "mac", hostLabel: "studio", workspace: "personal", workspaceName: "Personal", key: "mac/personal/moon", board, snapshot: {} as never };
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    useTaskStore.setState({ moving: {}, failures: {} });
    useApp.setState({ data: { mac: { ...emptyData(), macOpen: false } } });
  });

  it("keeps a move while the app is closed and sends it when the app opens", async () => {
    await moveOnMac(b, task, { label: "In Progress", status: "s-progress" });
    expect(calls).toEqual([]);
    expect(useTaskStore.getState().moving[id]).toMatchObject({ status: "s-progress", name: "In Progress", waiting: true });
    // Kept for the phone app's next start.
    expect(JSON.parse(localStorage.getItem("moonlet.mobile.tasks.waiting") ?? "[]")).toMatchObject([{ host: "mac", workspace: "personal", id, action: { kind: "move", column: "In Progress" } }]);

    useApp.setState({ data: { mac: { ...emptyData(), macOpen: true } } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual(["mac", "tasks.request", { workspace: "personal", action: { kind: "move", board: "moon", task: id, column: "In Progress", status: "s-progress" } }]);
    expect(useTaskStore.getState().moving[id]).toMatchObject({ waiting: false });
    expect(JSON.parse(localStorage.getItem("moonlet.mobile.tasks.waiting") ?? "[]")).toEqual([]);
  });

  it("sends a move at once while the app is open", async () => {
    useApp.setState({ data: { mac: { ...emptyData(), macOpen: true } } });
    await moveOnMac(b, task, { label: "Done", status: "s-done" });
    expect(calls.map((c) => (c[2] as { action: { column: string } }).action.column)).toEqual(["Done"]);
  });
});

describe("a task's comments through the Mac (X76)", () => {
  const id = "linear:acme MOON-151";
  const b = { host: "mac", workspace: "personal", board };
  const ada = { id: "c1", author: "Ada Lovelace", body: "Prefix match should handle both.", markdown: true, createdMs: 5 };
  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(replies)) delete replies[k];
    useComments.setState({ byTask: {} });
  });

  it("reads a task's comments through the Mac, and posts one, then reads them again", async () => {
    replies.comments = () => ({ comments: [ada], more: false });
    await loadComments(b, task);
    expect(useComments.getState().byTask[id]).toMatchObject({ comments: [ada], more: false, loading: false, error: null });
    setCommentDraft(task, "Picked this up.");
    expect(await postComment(b, task)).toBe(true);
    expect(calls.map((c) => (c[2] as { action: { kind: string; body?: string } }).action)).toEqual([
      { kind: "comments", board: "moon", task: id },
      { kind: "comment", board: "moon", task: id, body: "Picked this up." },
      { kind: "comments", board: "moon", task: id },
    ]);
    expect(useComments.getState().byTask[id]).toMatchObject({ draft: "", posting: false, postError: null });
  });

  it("keeps the newest load's comments when an older answer comes last", async () => {
    let release: (v: unknown) => void = () => {};
    let n = 0;
    // The first load's answer is held back; the second answers at once.
    replies.comments = () => (n++ === 0 ? new Promise((r) => (release = r)) : { comments: [ada], more: false });
    const older = loadComments(b, task);
    await vi.waitFor(() => expect(n).toBe(1));
    await loadComments(b, task);
    release({ comments: [], more: true });
    await older;
    expect(useComments.getState().byTask[id]).toMatchObject({ comments: [ada], more: false });
  });

  it("keeps a refused comment with its reason, and says why comments did not load", async () => {
    replies.comment = () => {
      throw new Error("Linear refused the comment");
    };
    setCommentDraft(task, "Picked this up.");
    expect(await postComment(b, task)).toBe(false);
    expect(useComments.getState().byTask[id]).toMatchObject({ draft: "Picked this up.", posting: false, postError: "Linear refused the comment" });
    // A blank box posts nothing.
    setCommentDraft(task, "  ");
    expect(await postComment(b, task)).toBe(false);
    replies.comments = () => {
      throw new Error("Open moonlet on the Mac to change tasks.");
    };
    await loadComments(b, task);
    expect(useComments.getState().byTask[id]).toMatchObject({ loading: false, error: "Open moonlet on the Mac to change tasks." });
  });
});
