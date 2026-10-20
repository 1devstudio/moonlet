import { describe, expect, it } from "vitest";
import type { BoardColumn, BoardConfig } from "@desktop/lib/boards";
import type { Task } from "@desktop/lib/tasks";
import { resolveTaskRequest } from "@desktop/lib/tasksRelay";
import { createAction, moveAction, moveRefused, startedAction } from "./taskActions";

const LINEAR = "linear:acme";
const COLUMNS: BoardColumn[] = [
  { name: "Todo", statuses: ["s-todo"], category: "todo" },
  { name: "In Progress", statuses: ["s-progress"], category: "in_progress" },
  { name: "Done", statuses: ["s-done"], category: "done", show: "fold" },
];
const board: BoardConfig = { id: "moon", name: "Moonlet", connection: LINEAR, workspace: "local/personal", origin: { kind: "linear_team", team: "MOON" }, columns: COLUMNS };
const task: Task = { connection: LINEAR, key: "MOON-151", title: "Drag sessions", url: "", column: "todo", priority: 1, assignees: [], labels: [], description: "", updatedMs: 0, tracker: { id: "i", state: "s-todo", source: "MOON" } };
const mac = { boards: [board], tasks: [task] };

describe("what the phone asks the Mac (X57)", () => {
  it("asks for moves, creates and started sessions the Mac's app understands", () => {
    expect(resolveTaskRequest(moveAction(board, task, { label: "In Progress", status: "s-progress" }), mac)).toEqual({ kind: "move", task, category: "in_progress", status: "s-progress" });
    const issue = { title: "Show host health", description: "", assignee: "me", labels: [] };
    expect(resolveTaskRequest(createAction(board, "Todo", issue), mac)).toEqual({ kind: "create", board, column: COLUMNS[0], issue });
    expect(resolveTaskRequest(startedAction(task, "Drag sessions", true), mac)).toEqual({ kind: "started", task, session: "Drag sessions", assign: true });
  });
});

describe("a move's outcome (X57)", () => {
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
