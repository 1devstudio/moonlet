import { describe, expect, it } from "vitest";
import { appendActivity, findTasks, initials, stateOptions } from "./taskDetails";
import type { Task } from "./tasks";
import { tasksBoard } from "./tasksBoard";

const task = (key: string, title: string, o: Partial<Task> = {}): Task => ({
  connection: "linear:acme",
  key,
  title,
  url: "",
  column: "todo",
  priority: 0,
  assignees: [],
  labels: [],
  description: "",
  updatedMs: 0,
  ...o,
});

describe("initials (X45 card)", () => {
  it("takes the first letters of the first and last name", () => {
    expect(["Sam Rivera", "ada", "Mia van der Krystof", "  "].map(initials)).toEqual(["SR", "A", "MK", ""]);
  });
});

describe("stateOptions (X45 detail, X46 task bar)", () => {
  it("offers a tracker issue the four columns, and a GitHub issue open or closed", () => {
    expect(stateOptions(task("MOON-1", "x", { column: "in_progress" }))).toEqual([
      { label: "Todo", column: "todo", current: false },
      { label: "In Progress", column: "in_progress", current: true },
      { label: "In Review", column: "in_review", current: false },
      { label: "Done", column: "done", current: false },
    ]);
    const gh = task("acme/web#7", "x", { connection: "github:github.com", column: "open", github: { repo: "acme/web", number: 7, closingPrs: [] } });
    expect(stateOptions(gh)).toEqual([
      { label: "Open", column: null, current: true },
      { label: "Closed", column: "done", current: false },
    ]);
  });
});

describe("findTasks (X45 Find a task)", () => {
  it("keeps the cards whose key or title has the text", () => {
    const board = tasksBoard({ tasks: [task("MOON-142", "Remote hosts sidebar"), task("MOON-144", "File tabs")], sessions: [], worktrees: [], sessionStartRule: "auto" });
    const keys = (q: string) => Object.values(findTasks(board, q)).flat().map((c) => c.task.key);
    expect(keys("tabs")).toEqual(["MOON-144"]);
    expect(keys("moon-142")).toEqual(["MOON-142"]);
    expect(keys("")).toEqual(["MOON-142", "MOON-144"]);
  });
});

describe("appendActivity (X45 activity)", () => {
  it("keeps the newest entries first, at most 20", () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ at: i, text: `e${i}` })).reverse();
    const next = appendActivity(list, { at: 99, text: "Moved to In Review" });
    expect(next.length).toBe(20);
    expect(next[0]).toEqual({ at: 99, text: "Moved to In Review" });
    expect(next[19].text).toBe("e1");
  });
});
