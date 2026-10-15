import { describe, expect, it } from "vitest";
import type { Task } from "./tasks";
import { type BoardSession, tasksBoard } from "./tasksBoard";
import { boardSummary, syncedLabel, viewBoard, viewCounts } from "./tasksView";

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
