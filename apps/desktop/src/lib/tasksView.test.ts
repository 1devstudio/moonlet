import { describe, expect, it } from "vitest";
import type { Task } from "./tasks";
import { type Board, type BoardSession, tasksBoard } from "./tasksBoard";
import { filterBoard, modeSwitch, sessionTaskLines, syncedLabel } from "./tasksView";

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

  it("names a board column as the tracker does (X50)", () => {
    const named = { ...board, in_progress: board.in_progress.map((c) => ({ ...c, columnName: "Doing" })) };
    expect(sessionTaskLines(named).Hosts.text).toBe("Doing");
  });
});

describe("modeSwitch (X45, X65 mode switch)", () => {
  const keys = { tasks: "⌃⌘T", design: "⌃⌘D" };
  it("titles each button with the shortcut as bound, and names what is out of sync", () => {
    expect(modeSwitch(keys, "sessions", 0)).toEqual({ sessions: "Sessions", tasks: "Tasks ⌃⌘T", design: "Design ⌃⌘D", label: "Tasks", dot: false, designLabel: "Design", designDot: false });
    expect(modeSwitch({ tasks: "⌥T", design: "⌃⌘D" }, "sessions", 3)).toMatchObject({ tasks: "Tasks ⌥T", label: "Tasks, 3 out of sync", dot: true });
    // Unbound in Settings › Shortcuts: no key in the titles.
    expect(modeSwitch({ tasks: "", design: "" }, "sessions", 0)).toMatchObject({ tasks: "Tasks", design: "Design" });
  });

  it("puts an accent dot on Design while a design an agent started from a session is unseen", () => {
    expect(modeSwitch(keys, "sessions", 0, 1)).toMatchObject({ designLabel: "Design, 1 new design", designDot: true });
    expect(modeSwitch(keys, "tasks", 0, 2)).toMatchObject({ designLabel: "Design, 2 new designs", designDot: true });
    expect(modeSwitch(keys, "sessions", 0, 0)).toMatchObject({ designLabel: "Design", designDot: false });
  });

  it("titles Sessions with the key that goes back to it: the shown mode's", () => {
    expect(modeSwitch(keys, "tasks", 0).sessions).toBe("Sessions ⌃⌘T");
    expect(modeSwitch(keys, "design", 0).sessions).toBe("Sessions ⌃⌘D");
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
