import { describe, expect, it } from "vitest";
import { asBoard, boardHeader, boardProblem, boardStats, footerLine, cardFace, columnCounts, dropTarget, shownBoardOf, sidebarBoards, stateChoices, workspaceViews } from "./boardScreen";
import { isDimmed } from "./tasksBoard";
import type { BoardSession } from "./tasksBoard";
import { type BoardColumn, type BoardConfig, cardFields } from "./boards";
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

describe("columnCounts (X50 header)", () => {
  it("counts the shown and folded columns", () => {
    expect(columnCounts(OPS)).toEqual({ shown: 5, folded: 2 });
    expect(columnCounts(OPS.slice(1, 4))).toEqual({ shown: 3, folded: 0 });
  });
});

describe("dropTarget (X53 dragging a card onto a column)", () => {
  it("moves to the first status of a shown or folded column, and not onto the card's own column", () => {
    expect(dropTarget(OPS, "QA", "In Progress")).toEqual({ category: "in_progress", status: "3" });
    expect(dropTarget(OPS, "QA", "Done")).toEqual({ category: "done", status: "10002" });
    expect(dropTarget(OPS, "QA", "QA")).toBeNull();
  });

  it("takes no drop on a hidden column, a column with no statuses, or a column the board lacks", () => {
    const columns: BoardColumn[] = [...OPS, { name: "Empty", statuses: [], category: "todo" }];
    expect(dropTarget(columns, "QA", "Backlog")).toBeNull();
    expect(dropTarget(columns, "QA", "Empty")).toBeNull();
    expect(dropTarget(columns, "QA", "Blocked")).toBeNull();
  });

  it("closes a GitHub repository's issue as completed on Closed, and reopens it on Open", () => {
    const repo: BoardColumn[] = [
      { name: "Open", statuses: ["open"], category: "todo" },
      { name: "Closed", statuses: ["completed", "not_planned"], category: "done", show: "fold" },
    ];
    expect(dropTarget(repo, "Open", "Closed")).toEqual({ category: "done", status: "completed" });
    expect(dropTarget(repo, "Open", "Open")).toBeNull();
    expect(dropTarget(repo, "Closed", "Open")).toEqual({ category: "todo", status: "open" });
  });
});

describe("stateChoices (X50 the detail's State menu)", () => {
  it("lists a tracker board's shown and folded columns by name, each moving to its first status, with the task's own marked", () => {
    const qa = { ...task("OPS-1", "in_review"), tracker: { id: "1", state: "QA", statusId: "10020", source: "OPS" } };
    expect(stateChoices(OPS, qa)).toEqual({
      current: 2,
      choices: [
        { label: "To Do", category: "todo", status: "10001" },
        { label: "In Progress", category: "in_progress", status: "3" },
        { label: "QA", category: "in_review", status: "10020" },
        { label: "Ready for Release", category: "in_review", status: "10021" },
        { label: "Done", category: "done", status: "10002" },
      ],
    });
    // In a hidden column: no current choice.
    expect(stateChoices(OPS, { ...qa, tracker: { ...qa.tracker, statusId: "10000" } }).current).toBe(-1);
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

describe("boardHeader (X50 header)", () => {
  it("titles the board with the sprint it follows, and sums up what the filters show", () => {
    const ops = b("ops", "local/w", { name: "OPS", finished: "sprint" });
    const sprint = { id: 5, name: "Sprint 42", startMs: new Date(2026, 9, 9).getTime(), endMs: new Date(2026, 9, 23).getTime() };
    const cards = [{ rows: [1, 2] }, { rows: [] }] as unknown as Parameters<typeof boardHeader>[3];
    expect(boardHeader(ops, sprint, "acme.atlassian.net", cards)).toEqual({ title: "OPS · Sprint 42", subtitle: "Jira · acme.atlassian.net · Oct 9 – Oct 23 · 2 issues · 2 sessions" });
    expect(boardHeader({ ...ops, finished: 14 }, sprint, "acme.atlassian.net", cards).title).toBe("OPS");
    // Between sprints or cycles the board says so, once a sync has looked.
    expect(boardHeader(ops, null, "acme.atlassian.net", cards).subtitle).toBe("Jira · acme.atlassian.net · No active sprint · 2 issues · 2 sessions");
    expect(boardHeader(ops, undefined, "acme.atlassian.net", cards).subtitle).toBe("Jira · acme.atlassian.net · 2 issues · 2 sessions");
    const moon = b("moon", "local/w", { name: "Moonlet", connection: "linear:acme", origin: { kind: "linear_team", team: "MOON" }, finished: "sprint" });
    expect(boardHeader(moon, null, "acme", []).subtitle).toBe("Linear · acme · No active cycle · 0 tasks · 0 sessions");
    expect(boardHeader(b("web", "local/w", { connection: "github:github.com", origin: { kind: "github_repo", repo: "acme/web" } }), null, "", []).subtitle).toBe("GitHub · acme/web · 0 tasks · 0 sessions");
    // A GitHub Project names itself where a site would go.
    expect(boardHeader(b("site", "local/w", { connection: "github:github.com", origin: { kind: "github_project", owner: "acme", number: 2 } }), null, "", []).subtitle).toBe("GitHub · Project #2 of acme · 0 tasks · 0 sessions");
  });
});

describe("boardStats (X50 switcher rows)", () => {
  it("counts a synced board's tasks and sessions, its most urgent agent state, and names its sprint or cycle", () => {
    const ops = b("ops", "local/w", { finished: "sprint" });
    const views = [{ name: "To Do", category: "todo" as const, folded: false, cards: [{ rows: [{ session: { state: "working" } }, { session: { state: "blocked" } }] }, { rows: [] }] }];
    expect(boardStats(ops, views as never, { sprint: { id: 5, name: "Sprint 42", startMs: 0, endMs: 0 } })).toEqual({ tasks: 2, sessions: 2, state: "blocked", kind: "Sprint 42" });
    expect(boardStats(b("plat", "local/w"), [], { sprint: null })).toEqual({ tasks: 0, sessions: 0, state: null });
    // A Jira board not following a sprint is named by its type once a sync has read it.
    expect(boardStats(b("plat", "local/w"), [], { sprint: null, kind: "kanban" }).kind).toBe("Kanban");
    expect(boardStats(b("plat", "local/w"), [], { sprint: null, kind: "simple" }).kind).toBe("Team-managed");
    expect(boardStats({ ...ops, finished: 14 }, [], { sprint: null, kind: "scrum" }).kind).toBe("Scrum");
    // Following its sprint, a Jira board is still named by its type; the title names the sprint.
    expect(boardStats(ops, [], { sprint: { id: 5, name: "Sprint 42", startMs: 0, endMs: 0 }, kind: "scrum" }).kind).toBe("Scrum");
  });
});

describe("cardFace (X50 Cards show)", () => {
  const task = {
    key: "WEB-233",
    issueType: "Story",
    points: 3,
    assignees: ["Sam Rivera"],
    parent: { key: "WEB-200", title: "Pricing page" },
    due: "2026-10-20",
  };

  it("shows the fields the board's cards show, the parent and due date on a line under the title", () => {
    expect(cardFace(task, ["issue_type", "points", "assignee", "parent", "due"])).toEqual({
      type: "Story",
      points: "3 pt",
      assignee: { initials: "SR", name: "Sam Rivera" },
      line: "WEB-200 Pricing page · Due Oct 20",
    });
    expect(cardFace(task, ["points"])).toEqual({ points: "3 pt" });
    // A GitHub Project's estimate is its number field's value, by the field's name.
    expect(cardFace({ ...task, points: 0.5 }, ["points"], "Hours")).toEqual({ points: "Hours 0.5" });
    expect(cardFace({ ...task, parent: undefined }, ["parent", "due"])).toEqual({ line: "Due Oct 20" });
    // A field the issue has no value for shows nothing.
    expect(cardFace({ key: "MOON-1", assignees: [] }, ["issue_type", "points", "assignee", "parent", "due"])).toEqual({});
  });

  it("gives a board without its own choice its tracker's fields", () => {
    expect(cardFields({ connection: "jira:acme.atlassian.net" })).toEqual(["issue_type", "points", "assignee"]);
    expect(cardFields({ connection: "linear:acme" })).toEqual(["points", "assignee"]);
    expect(cardFields({ connection: "github:github.com" })).toEqual(["assignee"]);
    expect(cardFields({ connection: "linear:acme", cards: ["due"] })).toEqual(["due"]);
    expect(cardFields({ connection: "linear:acme", cards: [] })).toEqual([]);
  });
});

describe("boardProblem (X50: a board whose origin is gone)", () => {
  it("says the tracker's error for the board shown, with what is still drawn", () => {
    const ops = b("ops", "local/w", { name: "OPS board" });
    // Jira's answer for a board that is gone, as the app words it.
    const gone = "Jira: Board does not exist or you do not have permission to see it.";
    expect(boardProblem(ops, { keys: [], error: gone })).toBe("moonlet could not read OPS board: Jira: Board does not exist or you do not have permission to see it.");
    expect(boardProblem(ops, { keys: ["jira:acme.atlassian.net OPS-1"], sprint: null, error: "cannot reach Jira" })).toBe("moonlet could not read OPS board: cannot reach Jira. Its last tasks are shown.");
    expect(boardProblem(ops, { keys: [], error: "Is the site down?" })).toBe("moonlet could not read OPS board: Is the site down?");
    expect(boardProblem(ops, { keys: [], sprint: null })).toBe(null);
    expect(boardProblem(ops, undefined)).toBe(null);
  });
});

describe("footerLine (X50 sidebar footer)", () => {
  it("says the sync failed with the error, or only that when the board shown already says why", () => {
    const data = { syncedAt: 1_000, error: "cannot reach Jira", boards: { ops: { keys: [], error: "cannot reach Jira" } } };
    expect(footerLine(data, "web", "GitHub", 41_000)).toBe("Sync failed · cannot reach Jira");
    expect(footerLine(data, "ops", "Jira", 41_000)).toBe("Jira sync failed");
    expect(footerLine({ syncedAt: 1_000, error: null }, "ops", "Jira", 41_000)).toBe("Jira synced just now");
  });
});
