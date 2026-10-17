import { describe, expect, it } from "vitest";
import { asBoard, columnsSummary, isDimmed, shownBoardOf, sidebarBoards, stateChoices, workspaceViews } from "./boardScreen";
import type { BoardSession } from "./tasksBoard";
import type { BoardColumn, BoardConfig } from "./boards";
import type { Task } from "./tasks";

const b = (id: string, workspace: string, o: Partial<BoardConfig> = {}): BoardConfig => ({ id, name: id, connection: "jira:acme.atlassian.net", workspace, origin: { kind: "jira_board", board: 1 }, ...o });
const OPS: BoardColumn[] = [
  { name: "Backlog", statuses: ["10000"], category: "todo", show: "hide" },
  { name: "To Do", statuses: ["10001"], category: "todo" },
  { name: "In Progress", statuses: ["3"], category: "in_progress" },
  { name: "QA", statuses: ["10020"], category: "in_review" },
  { name: "Ready for Release", statuses: ["10021"], category: "in_review", show: "fold" },
  { name: "Done", statuses: ["10002"], category: "done", show: "fold" },
];
const task = (key: string, column: Task["column"]): Task => ({ connection: "jira:acme.atlassian.net", key, title: key, url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0 });

describe("shownBoardOf (X50 Tasks mode opens on the board last shown)", () => {
  it("is the board last shown in the workspace, else its first pinned one", () => {
    const boards = [b("other", "local/x"), b("plat", "local/w", { pinned: false }), b("ops", "local/w")];
    expect(shownBoardOf(boards, "local/w", "plat")?.id).toBe("plat");
    expect(shownBoardOf(boards, "local/w", "other")?.id).toBe("ops");
    expect(shownBoardOf(boards, "local/w", null)?.id).toBe("ops");
    expect(shownBoardOf(boards, "local/none", null)).toBeNull();
  });
});

describe("sidebarBoards (X50 sidebar Boards)", () => {
  it("lists the workspace's pinned boards with the sprint they follow and their open tasks, the shown one marked", () => {
    const boards = [b("ops", "local/w", { name: "OPS", finished: "sprint" }), b("plat", "local/w", { name: "PLAT · Kanban" }), b("web", "local/w", { pinned: false }), b("x", "local/x")];
    const tasks = [task("OPS-1", "todo"), task("OPS-2", "done"), task("OPS-3", "hidden"), task("PLAT-1", "in_progress")];
    const data = {
      tasks,
      boards: {
        ops: { keys: ["jira:acme.atlassian.net OPS-1", "jira:acme.atlassian.net OPS-2", "jira:acme.atlassian.net OPS-3"], sprint: { id: 1, name: "Sprint 42", startMs: 0, endMs: 0 } },
        plat: { keys: ["jira:acme.atlassian.net PLAT-1"], sprint: null },
      },
    };
    expect(sidebarBoards(boards, "local/w", "plat", data)).toEqual([
      { id: "ops", label: "OPS · Sprint 42", tracker: "jira", count: 1, current: false },
      { id: "plat", label: "PLAT · Kanban", tracker: "jira", count: 1, current: true },
    ]);
  });
});

describe("columnsSummary (X50 header)", () => {
  it("counts the shown and folded columns", () => {
    expect(columnsSummary(OPS)).toBe("Columns 5 · 2 folded");
    expect(columnsSummary(OPS.slice(1, 4))).toBe("Columns 3");
  });
});

describe("stateChoices (X50 the detail's State menu)", () => {
  it("lists a tracker board's shown and folded columns by name, each moving to its first status", () => {
    expect(stateChoices(OPS, task("OPS-1", "todo"))).toEqual([
      { label: "To Do", category: "todo", status: "10001" },
      { label: "In Progress", category: "in_progress", status: "3" },
      { label: "QA", category: "in_review", status: "10020" },
      { label: "Ready for Release", category: "in_review", status: "10021" },
      { label: "Done", category: "done", status: "10002" },
    ]);
  });
});

describe("workspaceViews and asBoard (X50 every board of the workspace, for the Tasks button, rules and session rows)", () => {
  const jira = (key: string, statusId: string): Task => ({ ...task(key, "todo"), tracker: { id: key, state: "", statusId, source: "OPS" } });
  const session = (name: string, branch: string, o: Partial<BoardSession> = {}): BoardSession => ({ id: name, name, branch, path: `/w/${branch}`, archived: false, task: null, task_unlinked: false, state: "working", pr: null, additions: 0, subagents: 0, originRepo: null, ...o });
  it("lays out each board's own tasks in its columns, and gathers their cards once by category with the board's out of sync", () => {
    const ops = b("ops", "local/w", { columns: OPS });
    const plat = b("plat", "local/w", { columns: [{ name: "Doing", statuses: ["3"], category: "in_progress" }] });
    const tasks = [jira("OPS-1", "10001"), jira("OPS-2", "3")];
    const data = { tasks, boards: { ops: { keys: ["jira:acme.atlassian.net OPS-1", "jira:acme.atlassian.net OPS-2"], sprint: null }, plat: { keys: ["jira:acme.atlassian.net OPS-2"], sprint: null } } };
    const input = { tasks, sessions: [session("Rotate", "ops-1-rotate")], worktrees: [], sessionStartRule: "auto" as const };
    const views = workspaceViews([ops, plat], data, input);
    expect(views.map((v) => [v.board.id, v.views.map((c) => [c.name, c.cards.map((x) => x.task.key)])])).toEqual([
      ["ops", [["To Do", ["OPS-1"]], ["In Progress", ["OPS-2"]], ["QA", []], ["Ready for Release", []], ["Done", []]]],
      ["plat", [["Doing", ["OPS-2"]]]],
    ]);
    const board = asBoard(views);
    expect([board.todo.map((c) => c.task.key), board.in_progress.map((c) => c.task.key)]).toEqual([["OPS-1"], ["OPS-2"]]);
    expect(board.todo[0].drift?.fix).toBe("Move to In Progress");
  });
});

describe("isDimmed (X50 Assignee: anyone)", () => {
  it("dims someone else's issue that has no session of yours", () => {
    const card = (mine: boolean | undefined, sessions: number) => ({ task: { ...task("OPS-1", "todo"), mine }, rows: Array.from({ length: sessions }, () => ({})) });
    expect([isDimmed(card(false, 0)), isDimmed(card(false, 1)), isDimmed(card(true, 0)), isDimmed(card(undefined, 0))]).toEqual([true, false, false, false]);
  });
});
