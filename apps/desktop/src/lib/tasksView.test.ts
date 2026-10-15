import { describe, expect, it } from "vitest";
import type { Task } from "./tasks";
import { type Board, type BoardSession, tasksBoard } from "./tasksBoard";
import { boardSummary, filterBoard, modeSwitch, sessionTaskLines, sourceLabels, syncedLabel, viewBoard, viewCounts } from "./tasksView";

const task = (key: string, column: Task["column"]): Task => ({
  connection: "github:github.com",
  key,
  title: key,
  url: "",
  column,
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
});
const session = (name: string, branch: string, o: Partial<BoardSession> = {}): BoardSession => ({
  id: name,
  name,
  branch,
  path: `/w/${branch}`,
  archived: false,
  task: null,
  task_unlinked: false,
  state: "idle",
  pr: null,
  additions: 0,
  subagents: 0,
  originRepo: null,
  ...o,
});
const merged = { number: 128, url: "", state: "merged", title: "", checks: [], review_decision: null };
const board = tasksBoard({
  tasks: [task("MOON-151", "todo"), task("MOON-142", "in_progress"), task("MOON-144", "in_review"), task("MOON-139", "in_review"), task("MOON-131", "done")],
  sessions: [session("Hosts", "moon-142-hosts"), session("Tabs", "moon-144-tabs", { pr: merged }), session("Themes", "themes")],
  worktrees: [],
  sessionStartRule: "auto",
});
const keys = (b: ReturnType<typeof viewBoard>) => Object.values(b).flat().map((c) => c.task.key);

describe("Tasks mode views (X45)", () => {
  it("counts each view: open tasks, In Review, out of sync, sessions without a task", () => {
    expect(viewCounts(board, 1)).toEqual({ mine: 4, review: 2, drift: 1, unlinked: 1 });
  });

  it("filters the board for a view, keeping the columns", () => {
    expect(keys(viewBoard(board, "mine"))).toEqual(["MOON-151", "MOON-142", "MOON-144", "MOON-139", "MOON-131"]);
    expect(keys(viewBoard(board, "review"))).toEqual(["MOON-144", "MOON-139"]);
    expect(keys(viewBoard(board, "drift"))).toEqual(["MOON-144"]);
  });

  it("sums up the board in the header", () => {
    expect(boardSummary(board)).toBe("5 tasks · 2 sessions");
  });
});

describe("syncedLabel", () => {
  it("says when the tracker last synced, or that it is syncing", () => {
    expect(syncedLabel("GitHub", null, 0)).toBe("Syncing GitHub…");
    expect(syncedLabel("GitHub", 1_000, 41_000)).toBe("GitHub synced just now");
    expect(syncedLabel("GitHub", 0, 180_000)).toBe("GitHub synced 3 min ago");
  });
});

describe("sessionTaskLines (X46 sidebar)", () => {
  it("gives each linked session its task's key, title and state, out of sync when it is", () => {
    expect(sessionTaskLines(board)).toEqual({
      Hosts: { key: "MOON-142", title: "MOON-142", column: "in_progress", text: "In Progress", outOfSync: false },
      Tabs: { key: "MOON-144", title: "MOON-144", column: "in_review", text: "In Review · out of sync", outOfSync: true },
    });
  });
});

describe("sourceLabels (X45 card)", () => {
  const t = (connection: string, key: string, source?: string, repo?: string): Task => ({
    connection,
    key,
    title: key,
    url: "",
    column: "todo",
    priority: 0,
    assignees: [],
    labels: [],
    description: "",
    updatedMs: 0,
    ...(source && { tracker: { id: key, state: "Todo", source } }),
    ...(repo && { github: { repo, number: 1, closingPrs: [] } }),
  });
  it("names each task's source only when the workspace's tasks come from more than one", () => {
    const oneTeam = sourceLabels([t("linear:acme", "ENG-1", "ENG"), t("linear:acme", "ENG-2", "ENG")]);
    expect(oneTeam(t("linear:acme", "ENG-1", "ENG"))).toBe(undefined);
    // One connection, two teams.
    const twoTeams = sourceLabels([t("linear:acme", "ENG-1", "ENG"), t("linear:acme", "DES-1", "DES")]);
    expect(twoTeams(t("linear:acme", "DES-1", "DES"))).toBe("DES");
    const mixed = sourceLabels([t("linear:acme", "ENG-1", "ENG"), t("github:github.com", "acme/web#7", undefined, "acme/web")]);
    expect(mixed(t("github:github.com", "acme/web#7", undefined, "acme/web"))).toBe("web");
  });

  it("names a source in full when two sources share a short name", () => {
    const repos = sourceLabels([t("github:github.com", "acme/web#7", undefined, "acme/web"), t("github:github.com", "other/web#2", undefined, "other/web")]);
    expect(repos(t("github:github.com", "other/web#2", undefined, "other/web"))).toBe("other/web");
    const teams = sourceLabels([t("linear:acme", "ENG-1", "ENG"), t("linear:globex", "ENG-2", "ENG")]);
    expect(teams(t("linear:globex", "ENG-2", "ENG"))).toBe("globex ENG");
  });
});

describe("modeSwitch (X45 mode switch)", () => {
  it("titles both buttons with the shortcut as bound, and names what is out of sync", () => {
    expect(modeSwitch("⌃⌘T", 0)).toEqual({ sessions: "Sessions ⌃⌘T", tasks: "Tasks ⌃⌘T", label: "Tasks", dot: false });
    expect(modeSwitch("⌥T", 3)).toEqual({ sessions: "Sessions ⌥T", tasks: "Tasks ⌥T", label: "Tasks, 3 out of sync", dot: true });
    // Unbound in Settings › Shortcuts: no key in the titles.
    expect(modeSwitch("", 0)).toMatchObject({ sessions: "Sessions", tasks: "Tasks" });
  });
});

describe("filterBoard (X45 header filters)", () => {
  const t = (key: string, column: Task["column"], mine: boolean): Task => ({ connection: "linear:acme", key, title: key, url: "", column, priority: 0, assignees: [], labels: [], description: "", updatedMs: 0, mine });
  const card = (task: Task, rows = 0, orphans = 0) => ({ task, column: task.column === "done" ? ("done" as const) : ("todo" as const), rows: Array.from({ length: rows }, () => ({}) as never), needsYou: false, orphans: Array.from({ length: orphans }, () => ({}) as never), empty: null, drift: null });
  const board = {
    todo: [card(t("ENG-1", "todo", true)), card(t("ENG-2", "todo", false))],
    in_progress: [],
    in_review: [],
    done: [card(t("ENG-3", "done", true)), card(t("ENG-4", "done", true), 1), card(t("ENG-5", "done", true), 0, 1)],
  } as Board;
  const keys = (b: Board) => Object.values(b).flat().map((c) => c.task.key);
  it("Assignee: me keeps the user's tasks; Hide empty Done drops done tasks with no session or worktree", () => {
    expect(keys(filterBoard(board, { mine: false, hideEmptyDone: false }))).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
    expect(keys(filterBoard(board, { mine: true, hideEmptyDone: false }))).toEqual(["ENG-1", "ENG-3", "ENG-4", "ENG-5"]);
    expect(keys(filterBoard(board, { mine: false, hideEmptyDone: true }))).toEqual(["ENG-1", "ENG-2", "ENG-4", "ENG-5"]);
  });

  it("Assignee: me keeps someone else's task you have a session on", () => {
    const yours = { todo: [card(t("ENG-6", "todo", false), 1)], in_progress: [], in_review: [], done: [] } as Board;
    expect(keys(filterBoard(yours, { mine: true, hideEmptyDone: false }))).toEqual(["ENG-6"]);
  });
});
